import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRejections, loadTasks, saveTask, type Task } from "../src/bench.js";
import { loadConfig, type Setup, SetupSchema } from "../src/config.js";
import { SourceRepo } from "../src/git.js";
import { grade, stripTestSide } from "../src/grade.js";
import { mine } from "../src/mine.js";
import { analyze, calibrationProblems, renderMarkdown } from "../src/report.js";
import { loadRun, runBenchmark } from "../src/run.js";
import { Context, collectPatch, prepareWorkspace } from "../src/tree.js";
import { removeTree } from "../src/util/fs.js";
import { quoteArg } from "../src/util/proc.js";
import { validateCandidate } from "../src/validate.js";
import { buildFixtureRepo, type FixtureRepo, fixtureConfig } from "./helpers/fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentsDir = path.join(here, "fixtures", "agents");
const agent = (file: string): string => `${quoteArg(process.execPath)} ${quoteArg(path.join(agentsDir, file))}`;
const setup = (raw: Record<string, unknown>): Setup => SetupSchema.parse(raw);

let root: string;
let fixture: FixtureRepo;
let benchDir: string;
let ctx: Context;
let tasks: Task[];
const short = (key: string): string => `fixture-lib-${fixture.commits[key]?.slice(0, 10)}`;

function gitIn(dir: string, ...args: string[]): { status: number | null; stdout: string } {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout.trim() };
}

before(async () => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "hometurf-pipeline-")));
  process.env.HOMETURF_FIXTURE_COUNTER = path.join(root, "flaky-counter");
  fixture = buildFixtureRepo(root);
  benchDir = path.join(root, "bench");
  fs.mkdirSync(benchDir);
  fs.writeFileSync(path.join(benchDir, "hometurf.json"), JSON.stringify(fixtureConfig("../fixture-lib")));
  fs.writeFileSync(path.join(benchDir, "claude-v2.md"), "Prefer small functions.\n");
  const cfg = loadConfig(benchDir);
  ctx = new Context(cfg, SourceRepo.open(cfg.repoPath));
});

after(() => {
  delete process.env.HOMETURF_FIXTURE_COUNTER;
  removeTree(root);
});

describe("mining", () => {
  it("turns first-parent steps into candidates and records why the rest were skipped", () => {
    const { candidates, summary } = mine(ctx.cfg, ctx.repo, ctx.isTestSide);
    assert.equal(summary.scanned, 11);
    assert.deepEqual(summary.skipped, { "too-large": 1, "env-change": 1, message: 1, "no-source-change": 1, "no-test-change": 1 });
    const kept = candidates.filter((c) => !c.skip).map((c) => c.id);
    assert.deepEqual(kept, [short("merge"), short("parse"), short("no-f2p"), short("slug"), short("clamp")]);

    const clamp = candidates.find((c) => c.id === short("clamp"));
    assert.equal(clamp?.description, "Fix clamp upper bound (fixes #1)\n\nclamp() returned the lower bound for values above the range.");
    assert.deepEqual(clamp?.otherChanges.map((c) => c.path), ["CHANGELOG.md"]);
    const merge = candidates.find((c) => c.id === short("merge"));
    assert.equal(merge?.isMerge, true);
    assert.equal(merge?.description, "Handle tabs in collapseSpaces");
    assert.equal(candidates.find((c) => c.commit === fixture.commits.feature)?.skip?.reason, "message");

    const all = mine(ctx.cfg, ctx.repo, ctx.isTestSide, { all: true });
    assert.equal(all.summary.candidates, 6, "--all keeps the feature commit");
    fs.writeFileSync(path.join(benchDir, "candidates.jsonl"), `${candidates.map((c) => JSON.stringify(c)).join("\n")}\n`);
  });
});

describe("validation", () => {
  it("keeps only candidates whose tests fail before the fix and pass after it", async () => {
    const { candidates } = mine(ctx.cfg, ctx.repo, ctx.isTestSide);
    const rejected = [];
    for (const cand of candidates.filter((c) => !c.skip)) {
      const outcome = await validateCandidate(ctx, cand);
      if ("task" in outcome) saveTask(benchDir, outcome.task);
      else rejected.push(outcome.rejection);
    }
    tasks = loadTasks(benchDir);
    assert.deepEqual(tasks.map((t) => t.id), [short("clamp"), short("slug"), short("parse"), short("merge")]);
    assert.deepEqual(rejected.map((r) => [r.id, r.reason]), [[short("no-f2p"), "no-fail-to-pass"]]);

    const [clamp, slug, parse, merge] = tasks as [Task, Task, Task, Task];
    assert.deepEqual(clamp.failToPass, ["test/lib.test.js::clamp above"]);
    assert.deepEqual(clamp.passToPass, ["test/lib.test.js::add", "test/lib.test.js::clamp below", "test/lib.test.js::slug basic"]);
    assert.ok(!clamp.goldPatch.includes("CHANGELOG"), "docs are left out of the reference fix");
    assert.deepEqual(slug.goldStats, { files: 2, added: 8, removed: 1 });
    assert.deepEqual(parse.failToPass, ["test/parse.test.js::parse empty"]);
    assert.deepEqual(parse.flaky, ["test/parse.test.js::flaky"], "a test that alternates between runs is dropped");
    assert.deepEqual(merge.failToPass, ["test/text.test.js::collapse tabs"]);
    assert.equal(merge.thinDescription, true);
    assert.equal(loadRejections(benchDir).length, 0, "the CLI writes rejected.jsonl, not validateCandidate");
  });
});

describe("workspace", () => {
  it("has one commit, no remotes, no later history, and the old tests", async () => {
    const slug = tasks.find((t) => t.id === short("slug")) as Task;
    const dir = fs.mkdtempSync(path.join(root, "ws-check-"));
    const ws = path.join(dir, "ws");
    fs.mkdirSync(ws);
    await prepareWorkspace(ctx, slug, setup({ name: "x", builtin: "noop" }), { ws, shadow: path.join(dir, "shadow.git") }, { revealTests: false });
    assert.equal(gitIn(ws, "rev-list", "--all", "--count").stdout, "1");
    assert.equal(gitIn(ws, "remote").stdout, "");
    assert.notEqual(gitIn(ws, "cat-file", "-e", `${slug.fix}^{commit}`).status, 0, "the fix commit is not in the workspace");
    assert.notEqual(gitIn(ws, "cat-file", "-e", `${slug.base}^{commit}`).status, 0, "nor is the original base commit");
    assert.equal(gitIn(ws, "status", "--porcelain").stdout, "");
    assert.ok(!fs.readFileSync(path.join(ws, "test", "lib.test.js"), "utf8").includes("slug repeated spaces"));

    const ws2 = path.join(dir, "ws2");
    fs.mkdirSync(ws2);
    await prepareWorkspace(ctx, slug, setup({ name: "x", builtin: "noop" }), { ws: ws2, shadow: path.join(dir, "shadow2.git") }, { revealTests: true });
    assert.ok(fs.readFileSync(path.join(ws2, "test", "lib.test.js"), "utf8").includes("slug repeated spaces"), "--reveal-tests shows the new test");
  });

  it("collects the agent's change and discards edits to test files and the agent's own git history", async () => {
    const clamp = tasks.find((t) => t.id === short("clamp")) as Task;
    const dir = fs.mkdtempSync(path.join(root, "collect-"));
    const ws = path.join(dir, "ws");
    fs.mkdirSync(ws);
    const w = await prepareWorkspace(ctx, clamp, setup({ name: "x", builtin: "noop" }), { ws, shadow: path.join(dir, "shadow.git") }, { revealTests: false });
    fs.writeFileSync(path.join(ws, "src", "lib.js"), fs.readFileSync(path.join(ws, "src", "lib.js"), "utf8").replace("return lo;\n  return x", "return hi;\n  return x"));
    fs.writeFileSync(path.join(ws, "test", "lib.test.js"), "// gone\n");
    fs.writeFileSync(path.join(ws, "notes.txt"), "scratch\n");
    removeTree(path.join(ws, ".git")); // the agent wrecks its own repository
    const { patch, reverted } = collectPatch(ctx, w);
    const text = patch.toString("utf8");
    assert.deepEqual(reverted, ["test/lib.test.js"]);
    assert.match(text, /\+\s+if \(x > hi\) return hi;/);
    assert.match(text, /notes\.txt/);
    assert.doesNotMatch(text, /test\/lib\.test\.js/);
    const graded = await grade(ctx, clamp, patch, { tmpParent: dir, reportFile: path.join(dir, "r.xml") });
    assert.equal(graded.resolved, true);
  });
});

describe("runs", () => {
  it("ranks scripted setups and catches test tampering", async () => {
    const setups = [
      setup({ name: "oracle", builtin: "oracle" }),
      setup({ name: "noop", builtin: "noop" }),
      setup({ name: "gold-first-hunk", builtin: "gold-first-hunk" }),
      setup({ name: "fix-clamp", command: agent("fix-clamp.mjs") }),
      setup({ name: "tamper", command: agent("tamper.mjs") }),
    ];
    const { results } = await runBenchmark(ctx, { name: "main", setups, tasks, repeat: 1, jobs: 4, revealTests: false, resume: false, keep: false });
    assert.equal(results.length, 20);
    const solved = (s: string) => results.filter((r) => r.setup === s && r.resolved).map((r) => r.task).sort();
    assert.deepEqual(solved("oracle"), tasks.map((t) => t.id).sort());
    assert.deepEqual(solved("noop"), []);
    assert.deepEqual(solved("gold-first-hunk"), [short("clamp"), short("merge"), short("parse")].sort());
    assert.deepEqual(solved("fix-clamp"), [short("clamp")]);
    assert.deepEqual(solved("tamper"), []);
    for (const r of results.filter((x) => x.setup === "tamper")) assert.ok(r.reverted.includes("test/lib.test.js"));
    const fixClamp = results.filter((r) => r.setup === "fix-clamp");
    assert.ok(fixClamp.every((r) => r.usage.costUsd === 0.05 && r.usage.inputTokens === 1200));
    assert.deepEqual(calibrationProblems(results), { oracleFailed: [], noopSolved: [] });

    const { meta, results: loaded } = loadRun(benchDir, "main");
    const analysis = analyze(meta, loaded);
    assert.deepEqual(analysis.rows.map((r) => [r.setup, r.solved]), [
      ["oracle", 4],
      ["gold-first-hunk", 3],
      ["fix-clamp", 1],
      ["noop", 0],
      ["tamper", 0],
    ]);
    const fc = analysis.rows.find((r) => r.setup === "fix-clamp");
    assert.ok(fc && Math.abs((fc.costPerSolved ?? 0) - 0.2) < 1e-9, "cost per solve = $0.20 over 4 attempts / 1 solve");
    const vs = analysis.comparisons.find((c) => c.a === "oracle" && c.b === "noop");
    assert.deepEqual(vs && [vs.n, vs.onlyA, vs.onlyB], [4, 4, 0]);
    assert.ok(vs && Math.abs(vs.p - 0.125) < 1e-12);

    const md = renderMarkdown({ meta, results: loaded, tasks });
    assert.match(md, /\| oracle \| 4\/4 \(100%\) \| 51–100% \|/);
    assert.match(md, /\| fix-clamp \| 1\/4 \(25\.0%\) \| 5–70% \| 25\.0% \| \$0\.05 \| \$0\.20 \|/);
    assert.match(md, /\*\*tamper\*\* on `fixture-lib-[0-9a-f]+` \(attempt 1\): edited test-side files, discarded before grading/);
  });

  it("refuses to overwrite a run, and resumes without redoing finished attempts", async () => {
    const setups = [setup({ name: "noop", builtin: "noop" })];
    await assert.rejects(runBenchmark(ctx, { name: "main", setups, tasks, repeat: 1, jobs: 1, revealTests: false, resume: false, keep: false }), /already exists/);
    let started = 0;
    const before = loadRun(benchDir, "main").results.length;
    await runBenchmark(ctx, {
      name: "main",
      setups: [setup({ name: "noop", builtin: "noop" }), setup({ name: "oracle", builtin: "oracle" })],
      tasks,
      repeat: 1,
      jobs: 1,
      revealTests: false,
      resume: true,
      keep: false,
      onCell: () => started++,
    });
    assert.equal(started, 0);
    assert.equal(loadRun(benchDir, "main").results.length, before);
  });

  it("stops starting attempts once the reported cost reaches the budget", async () => {
    const setups = [setup({ name: "fix-clamp", command: agent("fix-clamp.mjs") })];
    const r = await runBenchmark(ctx, { name: "budget", setups, tasks, repeat: 1, jobs: 1, maxCostUsd: 0.08, revealTests: false, resume: false, keep: false });
    assert.equal(r.results.length, 2);
    assert.equal(r.skipped, 2);
    assert.ok(Math.abs(r.spentUsd - 0.1) < 1e-9);
    assert.match(renderMarkdown({ ...loadRun(benchDir, "budget"), tasks }), /Incomplete:\*\* 2 of 4 attempts finished \(budget \$0\.08\)/);
  });

  it("gives an agent the prompt on stdin, the setup's files, and reads Claude Code usage", async () => {
    const out = path.join(root, "peek.json");
    const merge = tasks.find((t) => t.id === short("merge")) as Task;
    const peek = setup({
      name: "peek",
      command: agent("peek.mjs"),
      usage: "claude-code",
      files: { "CLAUDE.md": "claude-v2.md" },
      remove: ["README.md"],
      env: { PEEK_OUT: out, PEEK_FIX: merge.fix },
    });
    const { results } = await runBenchmark(ctx, { name: "peek", setups: [peek], tasks: [merge], repeat: 1, jobs: 1, revealTests: false, resume: false, keep: false });
    const seen = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(seen.commits, "1");
    assert.equal(seen.remotes, "");
    assert.equal(seen.fixReachable, false);
    assert.equal(seen.status, "", "the setup's files are part of the base commit");
    assert.equal(seen.promptFileMatches, true);
    assert.match(seen.prompt, /<issue>\nHandle tabs in collapseSpaces\n<\/issue>/);
    assert.equal(seen.claudeMd, "Prefer small functions.\n");
    assert.ok(!seen.files.includes("README.md"));
    assert.deepEqual(results[0]?.usage, { costUsd: 0.25, inputTokens: 1000, outputTokens: 50, turns: 4 });
    assert.equal(results[0]?.patch.files, 0, "overlay files are not counted as the agent's change");
  });

  it("kills an agent that runs past its timeout, with everything it started, and grades what it left", async () => {
    const pidFile = path.join(root, "hang.pid");
    const hang = setup({ name: "hang", command: agent("hang.mjs"), timeoutSec: 2, env: { HANG_PID_FILE: pidFile } });
    const started = Date.now();
    const { results } = await runBenchmark(ctx, { name: "hang", setups: [hang], tasks: tasks.slice(0, 1), repeat: 1, jobs: 1, revealTests: false, resume: false, keep: false });
    assert.ok(Date.now() - started < 30_000);
    const r = results[0];
    assert.equal(r?.agent.timedOut, true);
    assert.equal(r?.status, "unresolved");
    assert.equal(r?.patch.files, 1, "the partial work was collected");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((res) => setTimeout(res, 100));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, `grandchild ${pid} survived the timeout`);
  });
});

describe("grading outside patches", () => {
  it("drops test-file changes from a patch before grading it", async () => {
    const clamp = tasks.find((t) => t.id === short("clamp")) as Task;
    const cheat = `diff --git a/test/lib.test.js b/test/lib.test.js
--- a/test/lib.test.js
+++ b/test/lib.test.js
@@ -1 +1 @@
-const test = require("node:test");
+const test = () => {};
`;
    const { patch, dropped } = stripTestSide(cheat, ctx.isTestSide);
    assert.deepEqual(dropped, ["test/lib.test.js"]);
    const dir = fs.mkdtempSync(path.join(root, "grade-"));
    const r = await grade(ctx, clamp, patch, { tmpParent: dir, reportFile: path.join(dir, "r.xml") });
    assert.equal(r.resolved, false);
    assert.deepEqual(r.failToPass.failing, ["test/lib.test.js::clamp above"]);
    const bad = await grade(ctx, clamp, "diff --git a/src/lib.js b/src/lib.js\n--- a/src/lib.js\n+++ b/src/lib.js\n@@ -1 +1 @@\n-nope\n+nope2\n", {
      tmpParent: dir,
      reportFile: path.join(dir, "r2.xml"),
    });
    assert.equal(bad.status, "patch-failed");
  });
});
