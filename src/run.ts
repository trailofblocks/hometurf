import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type AgentRun, renderPrompt, runAgent } from "./agents.js";
import { benchPaths, type Task } from "./bench.js";
import type { Setup } from "./config.js";
import { type GradeResult, type GradeStatus, grade } from "./grade.js";
import { collectPatch, type Context, prepareWorkspace } from "./tree.js";
import { appendJsonl, makeTempDir, readJson, readJsonl, removeTree, writeJson } from "./util/fs.js";
import { patchStats } from "./util/patch.js";
import { runPool } from "./util/pool.js";

export const CellResultSchema = z.object({
  task: z.string(),
  setup: z.string(),
  attempt: z.number(),
  resolved: z.boolean(),
  /** Grading outcome, or "agent-error" when no patch could be collected. */
  status: z.string(),
  error: z.string().optional(),
  agent: z.object({
    exitCode: z.number().nullable(),
    timedOut: z.boolean(),
    durationMs: z.number(),
  }),
  grade: z.object({
    durationMs: z.number(),
    failToPass: z.object({ passed: z.number(), total: z.number() }),
    passToPass: z.object({ passed: z.number(), total: z.number() }),
  }),
  patch: z.object({ files: z.number(), added: z.number(), removed: z.number(), bytes: z.number() }),
  /** Test-side files the agent changed. The changes were discarded before grading. */
  reverted: z.array(z.string()),
  usage: z.object({
    costUsd: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    turns: z.number().optional(),
  }),
  at: z.string(),
});
export type CellResult = z.infer<typeof CellResultSchema>;

export const RunMetaSchema = z.object({
  name: z.string(),
  startedAt: z.string(),
  platform: z.string(),
  node: z.string(),
  repo: z.string(),
  setups: z.array(z.object({ name: z.string(), label: z.string().optional(), builtin: z.string().optional(), command: z.string().optional() })),
  tasks: z.array(z.string()),
  repeat: z.number(),
  revealTests: z.boolean(),
  maxCostUsd: z.number().optional(),
});
export type RunMeta = z.infer<typeof RunMetaSchema>;

export interface RunOptions {
  name: string;
  setups: Setup[];
  tasks: Task[];
  repeat: number;
  jobs: number;
  maxCostUsd?: number;
  revealTests: boolean;
  resume: boolean;
  keep: boolean;
  onCell?: (result: CellResult, done: number, total: number) => void;
}

export function runPaths(benchDir: string, name: string) {
  const dir = path.join(benchPaths(benchDir).runs, name);
  return {
    dir,
    meta: path.join(dir, "run.json"),
    results: path.join(dir, "results.jsonl"),
    cell: (setup: string, task: string, attempt: number) => path.join(dir, "cells", setup, task, String(attempt)),
  };
}

export function loadRun(benchDir: string, name: string): { meta: RunMeta; results: CellResult[] } {
  const p = runPaths(benchDir, name);
  if (!fs.existsSync(p.meta)) throw new Error(`no run named "${name}" in ${path.dirname(p.dir)}`);
  const meta = RunMetaSchema.parse(readJson(p.meta));
  // On a resumed run a cell can appear twice; the last record wins.
  const byKey = new Map<string, CellResult>();
  for (const raw of readJsonl(p.results)) {
    const r = CellResultSchema.parse(raw);
    byKey.set(`${r.setup}\0${r.task}\0${r.attempt}`, r);
  }
  return { meta, results: [...byKey.values()] };
}

export function latestRun(benchDir: string): string | undefined {
  const dir = benchPaths(benchDir).runs;
  if (!fs.existsSync(dir)) return undefined;
  return fs
    .readdirSync(dir)
    .filter((n) => fs.existsSync(path.join(dir, n, "run.json")))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n, "run.json")).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0]?.n;
}

function cellFromParts(
  task: Task,
  setup: Setup,
  attempt: number,
  agent: AgentRun | undefined,
  graded: GradeResult | undefined,
  patch: Buffer,
  reverted: string[],
  error?: string,
): CellResult {
  const stats = patchStats(patch.toString("utf8"));
  const status: GradeStatus | "agent-error" = graded ? graded.status : "agent-error";
  const result: CellResult = {
    task: task.id,
    setup: setup.name,
    attempt,
    resolved: graded?.resolved ?? false,
    status,
    agent: { exitCode: agent?.exitCode ?? null, timedOut: agent?.timedOut ?? false, durationMs: agent?.durationMs ?? 0 },
    grade: {
      durationMs: graded?.durationMs ?? 0,
      failToPass: { passed: graded?.failToPass.passed ?? 0, total: task.failToPass.length },
      passToPass: { passed: graded?.passToPass.passed ?? 0, total: task.passToPass.length },
    },
    patch: { ...stats, bytes: patch.length },
    reverted,
    usage: agent?.usage ?? {},
    at: new Date().toISOString(),
  };
  const err = error ?? agent?.error ?? graded?.error;
  if (err) result.error = err.slice(0, 2_000);
  return result;
}

/** One agent attempt on one task: fresh workspace, agent, patch, grade. */
export async function runCell(ctx: Context, task: Task, setup: Setup, attempt: number, cellDir: string, opts: { revealTests: boolean; keep: boolean }): Promise<CellResult> {
  fs.mkdirSync(cellDir, { recursive: true });
  const tmp = makeTempDir(ctx.cfg.workDir, "ht-run-");
  let agent: AgentRun | undefined;
  let patch: Buffer = Buffer.alloc(0);
  let reverted: string[] = [];
  try {
    const scratch = makeTempDir(tmp, "agent-");
    const workspace = await prepareWorkspace(
      ctx,
      task,
      setup,
      { ws: makeTempDir(tmp, "ws-"), shadow: path.join(tmp, "shadow.git") },
      { revealTests: opts.revealTests, setupLog: path.join(cellDir, "setup.log") },
    );
    const prompt = renderPrompt(ctx.cfg, setup, task);
    fs.writeFileSync(path.join(cellDir, "prompt.md"), prompt);
    agent = await runAgent({ cfg: ctx.cfg, setup, task, workspace: workspace.dir, prompt, scratch, logDir: cellDir });
    ({ patch, reverted } = collectPatch(ctx, workspace));
    fs.writeFileSync(path.join(cellDir, "patch.diff"), patch);
    const graded = await grade(ctx, task, patch, {
      tmpParent: tmp,
      reportFile: path.join(cellDir, "tests.xml"),
      logFile: path.join(cellDir, "tests.log"),
      keep: opts.keep,
    });
    return cellFromParts(task, setup, attempt, agent, graded, patch, reverted);
  } catch (error) {
    return cellFromParts(task, setup, attempt, agent, undefined, patch, reverted, (error as Error).message);
  } finally {
    if (!opts.keep) removeTree(tmp);
  }
}

export async function runBenchmark(ctx: Context, opts: RunOptions): Promise<{ results: CellResult[]; skipped: number; spentUsd: number }> {
  const p = runPaths(ctx.cfg.benchDir, opts.name);
  const done = new Map<string, CellResult>();
  if (fs.existsSync(p.meta)) {
    if (!opts.resume) throw new Error(`run "${opts.name}" already exists; pass --resume to continue it or choose another --name`);
    for (const r of loadRun(ctx.cfg.benchDir, opts.name).results) done.set(`${r.setup}\0${r.task}\0${r.attempt}`, r);
  }
  const meta: RunMeta = {
    name: opts.name,
    startedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    repo: ctx.cfg.repoName,
    setups: opts.setups.map((s) => ({ name: s.name, label: s.label, builtin: s.builtin, command: s.command })),
    tasks: opts.tasks.map((t) => t.id),
    repeat: opts.repeat,
    revealTests: opts.revealTests,
    maxCostUsd: opts.maxCostUsd,
  };
  writeJson(p.meta, meta);

  // Task-major order: if a budget stops the run early, every setup has been tried on the same tasks.
  const cells: Array<{ task: Task; setup: Setup; attempt: number }> = [];
  for (let attempt = 1; attempt <= opts.repeat; attempt++) {
    for (const task of opts.tasks) for (const setup of opts.setups) cells.push({ task, setup, attempt });
  }
  const todo = cells.filter((c) => !done.has(`${c.setup.name}\0${c.task.id}\0${c.attempt}`));
  let spent = [...done.values()].reduce((sum, r) => sum + (r.usage.costUsd ?? 0), 0);
  const results = [...done.values()];
  let finished = results.length;

  const { skipped } = await runPool(
    todo,
    opts.jobs,
    async (cell) => {
      const result = await runCell(ctx, cell.task, cell.setup, cell.attempt, p.cell(cell.setup.name, cell.task.id, cell.attempt), opts);
      spent += result.usage.costUsd ?? 0;
      appendJsonl(p.results, result);
      results.push(result);
      opts.onCell?.(result, ++finished, cells.length);
    },
    () => opts.maxCostUsd === undefined || spent < opts.maxCostUsd,
  );
  return { results, skipped, spentUsd: spent };
}
