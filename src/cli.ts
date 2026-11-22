#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { benchPaths, loadCandidates, loadRejections, loadTasks, type Rejection, saveTask } from "./bench.js";
import { CONFIG_FILE, loadConfig, PRESETS, presetConfig, type Setup, SetupSchema } from "./config.js";
import { SourceRepo } from "./git.js";
import { grade, stripTestSide } from "./grade.js";
import { mine, type MineSummary } from "./mine.js";
import { calibrationProblems, renderMarkdown, renderText } from "./report.js";
import { latestRun, loadRun, runBenchmark, runPaths } from "./run.js";
import { Context } from "./tree.js";
import { makeTempDir, readJson, removeTree, writeFileAtomic, writeJson } from "./util/fs.js";
import { runPool } from "./util/pool.js";
import { killAll } from "./util/proc.js";
import { validateCandidate } from "./validate.js";

const VERSION = "0.1.0";

process.on("SIGINT", () => {
  killAll();
  process.exit(130);
});

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("expected a positive whole number");
  return n;
}

function positiveNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("expected a positive number");
  return n;
}

function list(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function open(bench: string): Context {
  const cfg = loadConfig(path.resolve(bench));
  return new Context(cfg, SourceRepo.open(cfg.repoPath));
}

function readMineSummary(benchDir: string): MineSummary | undefined {
  const file = benchPaths(benchDir).mineSummary;
  return fs.existsSync(file) ? (readJson(file) as MineSummary) : undefined;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function writeReport(ctx: Context, name: string): string {
  const { meta, results } = loadRun(ctx.cfg.benchDir, name);
  const md = renderMarkdown({
    meta,
    results,
    tasks: loadTasks(ctx.cfg.benchDir),
    mine: readMineSummary(ctx.cfg.benchDir),
    rejections: loadRejections(ctx.cfg.benchDir),
  });
  const file = path.join(runPaths(ctx.cfg.benchDir, name).dir, "report.md");
  writeFileAtomic(file, md);
  return file;
}

const program = new Command()
  .name("hometurf")
  .description("Build a private SWE-bench-style benchmark from a repository's git history, then rank coding-agent setups on it.")
  .version(VERSION);

program
  .command("init")
  .description(`write ${CONFIG_FILE} for a repository into a benchmark directory`)
  .argument("<repo>", "path to the git repository")
  .option("--bench <dir>", "benchmark directory to create", "hometurf-bench")
  .option("--preset <name>", `test setup: ${Object.keys(PRESETS).join(", ")}`)
  .option("--force", "overwrite an existing config")
  .action((repoArg: string, opts: { bench: string; preset?: string; force?: boolean }) => {
    const repo = SourceRepo.open(path.resolve(repoArg));
    let presetName = opts.preset;
    if (!presetName) {
      const has = (f: string): boolean => fs.existsSync(path.join(repo.root, f));
      if (has("pyproject.toml") || has("setup.py") || has("pytest.ini")) presetName = "python-pytest";
      else if (has("package.json")) presetName = "node-test";
      else throw new Error(`can't tell which test setup ${repo.root} uses; pass --preset (${Object.keys(PRESETS).join(", ")})`);
    }
    const preset = PRESETS[presetName];
    if (!preset) throw new Error(`unknown preset "${presetName}"; choose one of ${Object.keys(PRESETS).join(", ")}`);
    fs.mkdirSync(path.resolve(opts.bench), { recursive: true });
    // Real paths on both sides, so 8.3 short names on Windows don't produce a needlessly long relative path.
    const benchDir = fs.realpathSync.native(path.resolve(opts.bench));
    const file = path.join(benchDir, CONFIG_FILE);
    if (fs.existsSync(file) && !opts.force) throw new Error(`${file} already exists (pass --force to overwrite)`);
    const rel = path.relative(benchDir, fs.realpathSync.native(repo.root)).split(path.sep).join("/") || ".";
    writeJson(file, presetConfig(preset, rel));
    console.log(`Wrote ${file} (preset ${presetName}: ${preset.description}).`);
    console.log("Check tests.command runs in your repository, then: hometurf mine, hometurf validate, hometurf calibrate.");
  });

program
  .command("mine")
  .description("scan first-parent history for commits that change both source and tests")
  .option("--bench <dir>", "benchmark directory", ".")
  .option("--since <date>", "only commits after this date (git date syntax)")
  .option("--max-commits <n>", "scan at most this many commits", positiveInt)
  .option("--all", "keep commits whose message doesn't look like a fix")
  .action((opts: { bench: string; since?: string; maxCommits?: number; all?: boolean }) => {
    const ctx = open(opts.bench);
    const { candidates, summary } = mine(ctx.cfg, ctx.repo, ctx.isTestSide, opts);
    const p = benchPaths(ctx.cfg.benchDir);
    writeFileAtomic(p.candidates, candidates.map((c) => JSON.stringify(c)).join("\n") + (candidates.length ? "\n" : ""));
    writeJson(p.mineSummary, summary);
    console.log(`Scanned ${summary.scanned} commits; ${summary.candidates} candidates.`);
    for (const [reason, n] of Object.entries(summary.skipped).sort((a, b) => b[1] - a[1])) console.log(`  skipped ${n}: ${reason}`);
    console.log("Next: hometurf validate");
  });

program
  .command("validate")
  .description("keep a candidate only if its tests fail before the fix and pass after it")
  .option("--bench <dir>", "benchmark directory", ".")
  .option("--only <ids>", "comma-separated candidate ids", list)
  .option("--force", "re-validate candidates that already became tasks or were rejected")
  .option("--jobs <n>", "candidates to validate in parallel", positiveInt, 1)
  .option("--keep", "keep temporary checkouts for debugging")
  .option("--logs", "save test output under <bench>/logs")
  .action(async (opts: { bench: string; only?: string[]; force?: boolean; jobs: number; keep?: boolean; logs?: boolean }) => {
    const ctx = open(opts.bench);
    const p = benchPaths(ctx.cfg.benchDir);
    const existingTasks = new Set(loadTasks(ctx.cfg.benchDir).map((t) => t.id));
    const rejections = new Map(loadRejections(ctx.cfg.benchDir).map((r) => [r.id, r]));
    let todo = loadCandidates(ctx.cfg.benchDir).filter((c) => !c.skip);
    if (todo.length === 0) throw new Error("no candidates; run `hometurf mine` first");
    if (opts.only) {
      const want = new Set(opts.only);
      todo = todo.filter((c) => want.has(c.id));
    }
    if (!opts.force) todo = todo.filter((c) => !existingTasks.has(c.id) && !rejections.has(c.id));
    const logDir = opts.logs ? path.join(ctx.cfg.benchDir, "logs") : undefined;
    if (logDir) fs.mkdirSync(logDir, { recursive: true });
    console.log(`Validating ${todo.length} candidate${todo.length === 1 ? "" : "s"}...`);
    let done = 0;
    let kept = 0;
    await runPool(todo, opts.jobs, async (cand) => {
      const outcome = await validateCandidate(ctx, cand, { keep: opts.keep, logDir });
      done++;
      if ("task" in outcome) {
        kept++;
        saveTask(ctx.cfg.benchDir, outcome.task);
        rejections.delete(cand.id);
        const t = outcome.task;
        console.log(`[${done}/${todo.length}] ${cand.id} task: ${t.failToPass.length} fail-to-pass, ${t.passToPass.length} pass-to-pass${t.flaky.length ? `, ${t.flaky.length} flaky dropped` : ""}`);
      } else {
        rejections.set(cand.id, outcome.rejection);
        removeTree(p.task(cand.id));
        console.log(`[${done}/${todo.length}] ${cand.id} rejected: ${outcome.rejection.reason}${outcome.rejection.detail ? ` (${outcome.rejection.detail.split("\n")[0]})` : ""}`);
      }
      const all: Rejection[] = [...rejections.values()].sort((a, b) => a.id.localeCompare(b.id));
      writeFileAtomic(p.rejections, all.map((r) => JSON.stringify(r)).join("\n") + (all.length ? "\n" : ""));
    });
    const total = loadTasks(ctx.cfg.benchDir).length;
    console.log(`Kept ${kept} of ${todo.length}. The benchmark now has ${total} task${total === 1 ? "" : "s"}. Next: hometurf calibrate`);
  });

program
  .command("tasks")
  .description("list the benchmark's tasks")
  .option("--bench <dir>", "benchmark directory", ".")
  .action((opts: { bench: string }) => {
    const ctx = open(opts.bench);
    const tasks = loadTasks(ctx.cfg.benchDir);
    for (const t of tasks) {
      console.log(`${t.id}  ${t.date.slice(0, 10)}  F2P ${t.failToPass.length}  P2P ${t.passToPass.length}  ${t.thinDescription ? "[thin description] " : ""}${t.subject}`);
    }
    console.log(`${tasks.length} task${tasks.length === 1 ? "" : "s"}.`);
  });

function builtinSetup(name: "oracle" | "noop" | "gold-first-hunk"): Setup {
  return SetupSchema.parse({ name, builtin: name });
}

program
  .command("calibrate")
  .description("run the oracle (the real fix) and a no-op agent on every task; fails if any task can't tell them apart")
  .option("--bench <dir>", "benchmark directory", ".")
  .option("--jobs <n>", "attempts to run in parallel", positiveInt, 1)
  .action(async (opts: { bench: string; jobs: number }) => {
    const ctx = open(opts.bench);
    const tasks = loadTasks(ctx.cfg.benchDir);
    if (tasks.length === 0) throw new Error("no tasks; run `hometurf validate` first");
    const name = "calibration";
    removeTree(runPaths(ctx.cfg.benchDir, name).dir);
    console.log(`Calibrating ${tasks.length} tasks with the oracle and a no-op agent...`);
    const { results } = await runBenchmark(ctx, {
      name,
      setups: [builtinSetup("oracle"), builtinSetup("noop")],
      tasks,
      repeat: 1,
      jobs: opts.jobs,
      revealTests: false,
      resume: false,
      keep: false,
    });
    const report = writeReport(ctx, name);
    const { oracleFailed, noopSolved } = calibrationProblems(results);
    for (const r of oracleFailed) console.log(`oracle did not solve ${r.task}: ${r.status}${r.error ? ` (${r.error.split("\n")[0]})` : ""}`);
    for (const r of noopSolved) console.log(`no-op agent solved ${r.task}: its tests don't detect the bug`);
    console.log(`Report: ${report}`);
    if (oracleFailed.length || noopSolved.length) {
      console.log(`Calibration failed on ${oracleFailed.length + noopSolved.length} task(s). Re-run \`hometurf validate --force --only <id>\` or delete tasks/<id>.`);
      process.exitCode = 1;
    } else {
      console.log(`Calibration passed: the oracle solved all ${tasks.length} tasks and the no-op agent solved none.`);
    }
  });

program
  .command("run")
  .description("run agent setups on the benchmark's tasks and grade every attempt")
  .option("--bench <dir>", "benchmark directory", ".")
  .option("--setups <names>", "comma-separated setup names (oracle, noop, and gold-first-hunk work without config)", list)
  .option("--tasks <ids>", "comma-separated task ids", list)
  .option("--limit <n>", "only the first n tasks, oldest first", positiveInt)
  .option("--repeat <k>", "attempts per task and setup", positiveInt, 1)
  .option("--jobs <n>", "attempts to run in parallel", positiveInt, 1)
  .option("--max-cost <usd>", "stop starting attempts once reported cost reaches this many dollars", positiveNumber)
  .option("--name <name>", "run name (default: a timestamp)")
  .option("--resume", "continue a run with the same --name, skipping finished attempts")
  .option("--reveal-tests", "put the fix's test files in the workspace (easier, test-driven tasks)")
  .option("--keep", "keep temporary checkouts for debugging")
  .action(
    async (opts: {
      bench: string;
      setups?: string[];
      tasks?: string[];
      limit?: number;
      repeat: number;
      jobs: number;
      maxCost?: number;
      name?: string;
      resume?: boolean;
      revealTests?: boolean;
      keep?: boolean;
    }) => {
      const ctx = open(opts.bench);
      let tasks = loadTasks(ctx.cfg.benchDir);
      if (opts.tasks) {
        const want = new Set(opts.tasks);
        const missing = opts.tasks.filter((id) => !tasks.some((t) => t.id === id));
        if (missing.length) throw new Error(`unknown task(s): ${missing.join(", ")}`);
        tasks = tasks.filter((t) => want.has(t.id));
      }
      if (opts.limit) tasks = tasks.slice(0, opts.limit);
      if (tasks.length === 0) throw new Error("no tasks; run `hometurf validate` first");
      const byName = new Map(ctx.cfg.setups.map((s) => [s.name, s]));
      const names = opts.setups ?? ctx.cfg.setups.map((s) => s.name);
      if (names.length === 0) throw new Error(`no setups; add some to ${CONFIG_FILE} or pass --setups`);
      const setups = names.map((n) => {
        const s = byName.get(n);
        if (s) return s;
        if (n === "oracle" || n === "noop" || n === "gold-first-hunk") return builtinSetup(n);
        throw new Error(`unknown setup "${n}"`);
      });
      const name = opts.name ?? timestamp();
      const total = tasks.length * setups.length * opts.repeat;
      console.log(`Run ${name}: ${tasks.length} tasks x ${setups.length} setups x ${opts.repeat} = ${total} attempts.`);
      const { skipped, spentUsd } = await runBenchmark(ctx, {
        name,
        setups,
        tasks,
        repeat: opts.repeat,
        jobs: opts.jobs,
        maxCostUsd: opts.maxCost,
        revealTests: opts.revealTests ?? false,
        resume: opts.resume ?? false,
        keep: opts.keep ?? false,
        onCell: (r, done, all) => {
          const cost = r.usage.costUsd !== undefined ? ` $${r.usage.costUsd.toFixed(3)}` : "";
          console.log(`[${done}/${all}] ${r.setup} ${r.task}#${r.attempt}: ${r.resolved ? "solved" : r.status} (${(r.agent.durationMs / 1000).toFixed(1)} s${cost})`);
        },
      });
      if (skipped) console.log(`Stopped: reported cost reached $${spentUsd.toFixed(2)}; ${skipped} attempts not started. Continue with --resume.`);
      const report = writeReport(ctx, name);
      const { meta, results } = loadRun(ctx.cfg.benchDir, name);
      console.log(`\n${renderText(meta, results)}\n\nReport: ${report}`);
    },
  );

program
  .command("report")
  .description("write report.md for a run and print its leaderboard")
  .option("--bench <dir>", "benchmark directory", ".")
  .option("--run <name>", "run name (default: the latest)")
  .option("--out <file>", "also write the markdown here")
  .action((opts: { bench: string; run?: string; out?: string }) => {
    const ctx = open(opts.bench);
    const name = opts.run ?? latestRun(ctx.cfg.benchDir);
    if (!name) throw new Error("no runs yet; use `hometurf run` or `hometurf calibrate`");
    const file = writeReport(ctx, name);
    if (opts.out) fs.copyFileSync(file, path.resolve(opts.out));
    const { meta, results } = loadRun(ctx.cfg.benchDir, name);
    console.log(`${renderText(meta, results)}\n\nReport: ${file}`);
  });

program
  .command("grade")
  .description("grade a patch file against one task (changes to test files are dropped first)")
  .requiredOption("--task <id>", "task id")
  .requiredOption("--patch <file>", "patch from `git diff`")
  .option("--bench <dir>", "benchmark directory", ".")
  .option("--keep", "keep the grading checkout")
  .action(async (opts: { task: string; patch: string; bench: string; keep?: boolean }) => {
    const ctx = open(opts.bench);
    const task = loadTasks(ctx.cfg.benchDir).find((t) => t.id === opts.task);
    if (!task) throw new Error(`unknown task ${opts.task}`);
    const { patch, dropped } = stripTestSide(fs.readFileSync(opts.patch, "utf8").replace(/\r\n/g, "\n"), ctx.isTestSide);
    if (dropped.length) console.log(`Dropped changes to test-side files: ${dropped.join(", ")}`);
    const tmp = makeTempDir(ctx.cfg.workDir, "ht-grade-");
    try {
      const r = await grade(ctx, task, patch, { tmpParent: tmp, reportFile: path.join(tmp, "tests.xml"), keep: opts.keep });
      console.log(`${r.resolved ? "RESOLVED" : "NOT RESOLVED"} (${r.status})`);
      console.log(`fail-to-pass: ${r.failToPass.passed}/${r.failToPass.total} passing`);
      console.log(`pass-to-pass: ${r.passToPass.passed}/${r.passToPass.total} passing`);
      for (const id of [...r.failToPass.failing, ...r.passToPass.failing].slice(0, 20)) console.log(`  failing: ${id}`);
      if (r.error) console.log(r.error);
      if (!r.resolved) process.exitCode = 1;
    } finally {
      if (!opts.keep) removeTree(tmp);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`hometurf: ${(error as Error).message}`);
  process.exitCode = 2;
});
