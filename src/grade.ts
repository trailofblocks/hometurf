import path from "node:path";
import type { RunSummary, Task } from "./bench.js";
import { runTests, summarize } from "./testrun.js";
import { type Context, prepareGradingDir } from "./tree.js";
import { makeTempDir, removeTree } from "./util/fs.js";
import { formatPatch, parsePatch } from "./util/patch.js";

export type GradeStatus = "resolved" | "unresolved" | "patch-failed" | "setup-failed" | "no-report";

export interface GradeResult {
  resolved: boolean;
  status: GradeStatus;
  error?: string;
  failToPass: { passed: number; total: number; failing: string[] };
  passToPass: { passed: number; total: number; failing: string[] };
  durationMs: number;
  testRun?: RunSummary;
}

export interface GradeOptions {
  /** Parent for the temporary grading directory. */
  tmpParent?: string;
  reportFile: string;
  logFile?: string;
  keep?: boolean;
}

/**
 * Grade a patch against a task: base commit + patch + the fix's test files, then the test command.
 * Resolved means every fail-to-pass test and every pass-to-pass test passes. A test missing from
 * the report counts as not passing. The patch must already exclude test-side paths.
 */
export async function grade(ctx: Context, task: Task, patch: string | Buffer, opts: GradeOptions): Promise<GradeResult> {
  const started = performance.now();
  const dir = makeTempDir(opts.tmpParent ?? ctx.cfg.workDir, "grade-");
  const empty = {
    failToPass: { passed: 0, total: task.failToPass.length, failing: task.failToPass },
    passToPass: { passed: 0, total: task.passToPass.length, failing: task.passToPass },
  };
  const elapsed = (): number => Math.round(performance.now() - started);
  try {
    const prepared = await prepareGradingDir(ctx, task, patch, dir, opts.logFile ? `${opts.logFile}.setup` : undefined);
    if (!prepared.ok) {
      return { resolved: false, status: prepared.reason, error: prepared.error, ...empty, durationMs: elapsed() };
    }
    const run = await runTests(ctx.cfg, dir, task.runFiles, opts.reportFile, opts.logFile);
    if (!run.ok) {
      return { resolved: false, status: "no-report", error: run.error, ...empty, durationMs: elapsed(), testRun: summarize(run) };
    }
    const failing = (ids: string[]): string[] => ids.filter((id) => run.results.get(id) !== "pass");
    const f2pFailing = failing(task.failToPass);
    const p2pFailing = failing(task.passToPass);
    const resolved = f2pFailing.length === 0 && p2pFailing.length === 0;
    return {
      resolved,
      status: resolved ? "resolved" : "unresolved",
      failToPass: { passed: task.failToPass.length - f2pFailing.length, total: task.failToPass.length, failing: f2pFailing },
      passToPass: { passed: task.passToPass.length - p2pFailing.length, total: task.passToPass.length, failing: p2pFailing },
      durationMs: elapsed(),
      testRun: summarize(run),
    };
  } finally {
    if (!opts.keep) removeTree(dir);
  }
}

/** Paths a patch section touches, read from its `---`/`+++` lines, or from `diff --git` for binary sections. */
function sectionPaths(header: string[]): string[] {
  const paths = new Set<string>();
  for (const line of header) {
    const m = /^(?:---|\+\+\+) (?:a|b)\/(.+?)\t?$/.exec(line);
    if (m?.[1]) paths.add(m[1]);
  }
  if (paths.size === 0) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(header[0] ?? "");
    if (m?.[1]) paths.add(m[1]);
    if (m?.[2]) paths.add(m[2]);
  }
  return [...paths];
}

/** Drop the sections of a patch that touch the test side. For patches that come from outside hometurf. */
export function stripTestSide(patch: string, isTestSide: (p: string) => boolean): { patch: string; dropped: string[] } {
  const keep = [];
  const dropped: string[] = [];
  for (const file of parsePatch(patch)) {
    const paths = sectionPaths(file.header);
    if (paths.some(isTestSide)) dropped.push(...paths);
    else keep.push(file);
  }
  return { patch: formatPatch(keep), dropped };
}

export function gradeDirFor(cellDir: string): { reportFile: string; logFile: string } {
  return { reportFile: path.join(cellDir, "tests.xml"), logFile: path.join(cellDir, "tests.log") };
}
