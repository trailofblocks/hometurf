import path from "node:path";
import type { Candidate, Rejection, RejectReason, Task } from "./bench.js";
import type { TestStatus } from "./junit.js";
import { wordCount } from "./mine.js";
import { runTests, summarize, type TestRun } from "./testrun.js";
import { type Context, prepareGradingDir } from "./tree.js";
import { makeTempDir, removeTree } from "./util/fs.js";
import { matchAny } from "./util/glob.js";
import { patchStats } from "./util/patch.js";
import { quoteArg, UnsafeArgumentError } from "./util/proc.js";

export type Status = TestStatus | "missing";

export interface Classified {
  failToPass: string[];
  passToPass: string[];
  flaky: string[];
}

/**
 * Sort tests by how they behaved across repeated runs before and after the fix.
 * - fail-to-pass: not passing (failed, errored, or absent) in every run before, passing in every run after
 * - pass-to-pass: passing in every run, before and after
 * - flaky: a different result in two runs on the same code; left out of both lists
 */
export function classifyTests(before: Array<Map<string, TestStatus>>, after: Array<Map<string, TestStatus>>): Classified {
  const ids = new Set<string>();
  for (const run of [...before, ...after]) for (const id of run.keys()) ids.add(id);
  const out: Classified = { failToPass: [], passToPass: [], flaky: [] };
  for (const id of [...ids].sort()) {
    const b: Status[] = before.map((r) => r.get(id) ?? "missing");
    const a: Status[] = after.map((r) => r.get(id) ?? "missing");
    if (new Set(b).size > 1 || new Set(a).size > 1) {
      out.flaky.push(id);
      continue;
    }
    if (a[0] !== "pass") continue;
    if (b[0] === "pass") out.passToPass.push(id);
    else if (b[0] === "fail" || b[0] === "error" || b[0] === "missing") out.failToPass.push(id);
  }
  return out;
}

export interface ValidateOptions {
  keep?: boolean;
  logDir?: string;
}

export type ValidateOutcome = { task: Task } | { rejection: Rejection };

function reject(cand: Candidate, reason: RejectReason, detail?: string): ValidateOutcome {
  const rejection: Rejection = { id: cand.id, reason, at: new Date().toISOString() };
  if (detail) rejection.detail = detail.slice(0, 2_000);
  return { rejection };
}

function countLine(runs: TestRun[]): string {
  const run = runs[0];
  if (!run) return "no runs";
  let pass = 0;
  let notPass = 0;
  for (const s of run.results.values()) {
    if (s === "pass") pass++;
    else if (s !== "skipped") notPass++;
  }
  return `${pass} passing, ${notPass} failing`;
}

/** Turn a candidate into a task, or reject it with a reason. A task only counts if its tests fail before the fix and pass after. */
export async function validateCandidate(ctx: Context, cand: Candidate, opts: ValidateOptions = {}): Promise<ValidateOutcome> {
  const { cfg, repo } = ctx;
  const runFiles = cand.testChanges.filter((c) => c.status !== "D" && matchAny(cfg.runGlobs, c.path)).map((c) => c.path);
  if (cfg.tests.command.includes("{files}") && runFiles.length === 0) return reject(cand, "no-runnable-test");
  try {
    for (const f of runFiles) quoteArg(f);
  } catch (error) {
    if (error instanceof UnsafeArgumentError) return reject(cand, "unsafe-path", error.message);
    throw error;
  }

  const goldPatch = repo.diff(cand.parent, cand.commit, cand.sourceChanges.map((c) => c.path));
  const ref = { base: cand.parent, fix: cand.commit, testChanges: cand.testChanges };
  const tmp = makeTempDir(cfg.workDir, "ht-val-");
  const log = (name: string): string | undefined => (opts.logDir ? path.join(opts.logDir, `${cand.id}.${name}.log`) : undefined);
  try {
    const beforeDir = makeTempDir(tmp, "before-");
    const preparedBefore = await prepareGradingDir(ctx, ref, "", beforeDir, log("before-setup"));
    if (!preparedBefore.ok) return reject(cand, "setup-failed", preparedBefore.error);
    const before: TestRun[] = [];
    for (let i = 0; i < cfg.validate.beforeRuns; i++) {
      const run = await runTests(cfg, beforeDir, runFiles, path.join(tmp, `before-${i}.xml`), log(`before-${i}`));
      if (!run.ok) return reject(cand, run.timedOut ? "tests-timed-out" : "before-no-report", `before the fix: ${run.error}\n${run.outputTail}`);
      before.push(run);
    }

    const afterDir = makeTempDir(tmp, "after-");
    const preparedAfter = await prepareGradingDir(ctx, ref, goldPatch, afterDir, log("after-setup"));
    if (!preparedAfter.ok) {
      return reject(cand, preparedAfter.reason === "patch-failed" ? "gold-patch-failed" : "setup-failed", preparedAfter.error);
    }
    const after: TestRun[] = [];
    for (let i = 0; i < cfg.validate.afterRuns; i++) {
      const run = await runTests(cfg, afterDir, runFiles, path.join(tmp, `after-${i}.xml`), log(`after-${i}`));
      if (!run.ok) return reject(cand, run.timedOut ? "tests-timed-out" : "after-no-report", `after the fix: ${run.error}\n${run.outputTail}`);
      after.push(run);
    }

    const sets = classifyTests(
      before.map((r) => r.results),
      after.map((r) => r.results),
    );
    if (sets.failToPass.length === 0) {
      const detail = `before the fix: ${countLine(before)}; after: ${countLine(after)}; flaky: ${sets.flaky.length}`;
      return reject(cand, "no-fail-to-pass", detail);
    }
    const task: Task = {
      id: cand.id,
      repo: cfg.repoName,
      base: cand.parent,
      fix: cand.commit,
      date: cand.date,
      subject: cand.subject,
      description: cand.description,
      goldPatch,
      testChanges: cand.testChanges,
      runFiles,
      failToPass: sets.failToPass,
      passToPass: sets.passToPass,
      flaky: sets.flaky,
      goldStats: patchStats(goldPatch),
      thinDescription: wordCount(cand.description) < 6,
      validation: {
        platform: `${process.platform}-${process.arch}`,
        at: new Date().toISOString(),
        before: before.map(summarize),
        after: after.map(summarize),
      },
    };
    return { task };
  } finally {
    if (!opts.keep) removeTree(tmp);
  }
}
