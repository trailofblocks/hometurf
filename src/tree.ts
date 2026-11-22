import fs from "node:fs";
import path from "node:path";
import type { FileChange } from "./bench.js";
import type { Config, Setup } from "./config.js";
import { applyPatch, initOneCommitRepo, Shadow, type SourceRepo } from "./git.js";
import { childEnv } from "./testrun.js";
import { matchAny } from "./util/glob.js";
import { runShell } from "./util/proc.js";

/** Shared state for one command: the config, the source repo, and a cache of file lists per commit. */
export class Context {
  private readonly fileLists = new Map<string, string[]>();
  constructor(
    readonly cfg: Config,
    readonly repo: SourceRepo,
  ) {}

  filesAt(commit: string): string[] {
    let files = this.fileLists.get(commit);
    if (!files) {
      files = this.repo.listFiles(commit);
      this.fileLists.set(commit, files);
    }
    return files;
  }

  /** True for paths on the test side: test files and protected files. The agent can't change these. */
  isTestSide = (p: string): boolean => matchAny(this.cfg.tests.files, p) || matchAny(this.cfg.tests.protect, p);
}

export interface TaskRef {
  base: string;
  fix: string;
  testChanges: FileChange[];
}

export async function runSetupCommand(cfg: Config, dir: string, logFile?: string): Promise<{ ok: boolean; error?: string }> {
  if (!cfg.setup) return { ok: true };
  const r = await runShell(cfg.setup, { cwd: dir, env: childEnv(), timeoutMs: cfg.setupTimeoutSec * 1000, stdoutFile: logFile, captureLimit: 4_000 });
  if (r.timedOut) return { ok: false, error: `setup timed out after ${cfg.setupTimeoutSec}s` };
  if (r.code !== 0) return { ok: false, error: `setup exited ${r.code}: ${`${r.stdout}\n${r.stderr}`.trim().slice(-1_500)}` };
  return { ok: true };
}

function existing(dir: string, files: string[]): string[] {
  return files.filter((f) => fs.existsSync(path.join(dir, f)));
}

export type PrepareResult = { ok: true } | { ok: false; reason: "patch-failed" | "setup-failed"; error: string };

/**
 * A directory for grading: the base commit, plus `patch` (which must not touch the test side),
 * plus the fix's versions of the test files it changed, plus the setup command.
 */
export async function prepareGradingDir(ctx: Context, task: TaskRef, patch: string | Buffer, dir: string, logFile?: string): Promise<PrepareResult> {
  ctx.repo.exportTree(task.base, dir);
  initOneCommitRepo(dir, existing(dir, ctx.filesAt(task.base)));
  const applied = applyPatch(dir, patch);
  if (!applied.ok) return { ok: false, reason: "patch-failed", error: applied.error };
  ctx.repo.checkoutPaths(task.fix, dir, task.testChanges.map((c) => c.path));
  const setup = await runSetupCommand(ctx.cfg, dir, logFile);
  if (!setup.ok) return { ok: false, reason: "setup-failed", error: setup.error ?? "setup failed" };
  return { ok: true };
}

export interface Workspace {
  dir: string;
  shadow: Shadow;
  baseTree: string;
  /** Paths the setup put in place or removed; never part of the agent's change. */
  overlay: Set<string>;
}

/**
 * The agent's workspace: the base commit's files in a fresh one-commit repository (no history,
 * no remotes, so later commits can't be looked up), with the setup's files applied.
 */
export async function prepareWorkspace(
  ctx: Context,
  task: TaskRef,
  setup: Setup,
  dirs: { ws: string; shadow: string },
  opts: { revealTests: boolean; setupLog?: string },
): Promise<Workspace> {
  const { ws } = dirs;
  ctx.repo.exportTree(task.base, ws);
  const overlay = new Set<string>();
  for (const rel of setup.remove) {
    fs.rmSync(path.join(ws, rel), { recursive: true, force: true });
    overlay.add(rel.replace(/\\/g, "/"));
  }
  for (const [rel, source] of Object.entries(setup.files)) {
    const target = path.join(ws, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.resolve(ctx.cfg.benchDir, source), target, { recursive: true });
    overlay.add(rel.replace(/\\/g, "/"));
  }
  if (opts.revealTests) ctx.repo.checkoutPaths(task.fix, ws, task.testChanges.map((c) => c.path));
  const tracked = existing(ws, ctx.filesAt(task.base));
  initOneCommitRepo(ws, tracked);
  const setupResult = await runSetupCommand(ctx.cfg, ws, opts.setupLog);
  if (!setupResult.ok) throw new Error(setupResult.error);
  const shadow = Shadow.create(dirs.shadow, ws, ctx.cfg.scratch);
  const baseTree = shadow.snapshot(tracked);
  return { dir: ws, shadow, baseTree, overlay };
}

/** The agent's change as a patch, with edits to the test side and the setup's files removed. */
export function collectPatch(ctx: Context, workspace: Workspace): { patch: Buffer; reverted: string[] } {
  const after = workspace.shadow.snapshot();
  const isOverlay = (p: string): boolean => [...workspace.overlay].some((o) => p === o || p.startsWith(`${o}/`));
  const { tree, reverted } = workspace.shadow.restrict(workspace.baseTree, after, (p) => ctx.isTestSide(p) || isOverlay(p));
  return { patch: workspace.shadow.diff(workspace.baseTree, tree), reverted: reverted.filter((p) => !isOverlay(p)) };
}
