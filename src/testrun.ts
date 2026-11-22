import fs from "node:fs";
import type { Config } from "./config.js";
import { parseJUnit, type TestStatus } from "./junit.js";
import { quoteArg, runShell } from "./util/proc.js";

export interface TestRun {
  /** The report was found and parsed. When false, `error` says why. */
  ok: boolean;
  error?: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  results: Map<string, TestStatus>;
  messages: Map<string, string>;
  outputTail: string;
}

export function buildTestCommand(template: string, junit: string, files: string[]): string {
  return template.replace(/\{junit\}/g, () => quoteArg(junit)).replace(/\{files\}/g, () => files.map((f) => quoteArg(f)).join(" "));
}

/**
 * Environment for setup, test, and agent commands: inherited, with Python told not to leave bytecode
 * in the tree. NODE_TEST_CONTEXT is dropped: when hometurf itself runs under `node --test`, it would
 * make a nested `node --test` talk to the outer runner instead of writing its JUnit report.
 */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", HOMETURF: "1", ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** Run the configured test command in `dir` and read the JUnit report it writes to `reportFile`. */
export async function runTests(cfg: Config, dir: string, files: string[], reportFile: string, logFile?: string): Promise<TestRun> {
  fs.rmSync(reportFile, { force: true });
  const command = buildTestCommand(cfg.tests.command, reportFile, files);
  const r = await runShell(command, {
    cwd: dir,
    env: childEnv(),
    timeoutMs: cfg.tests.timeoutSec * 1000,
    stdoutFile: logFile,
    captureLimit: 8_000,
  });
  const base = {
    exitCode: r.code,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
    results: new Map<string, TestStatus>(),
    messages: new Map<string, string>(),
    outputTail: `${r.stdout}\n${r.stderr}`.trim().slice(-4_000),
  };
  if (r.timedOut) return { ...base, ok: false, error: `tests timed out after ${cfg.tests.timeoutSec}s` };
  if (!fs.existsSync(reportFile)) return { ...base, ok: false, error: `no JUnit report (exit code ${r.code})` };
  try {
    for (const t of parseJUnit(fs.readFileSync(reportFile, "utf8"), dir)) {
      base.results.set(t.id, t.status);
      if (t.message) base.messages.set(t.id, t.message);
    }
  } catch (error) {
    return { ...base, ok: false, error: `unreadable JUnit report: ${(error as Error).message}` };
  }
  return { ...base, ok: true };
}

export function countStatuses(run: TestRun): Record<string, number> {
  const counts: Record<string, number> = { pass: 0, fail: 0, error: 0, skipped: 0 };
  for (const status of run.results.values()) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

export function summarize(run: TestRun): { exitCode: number | null; timedOut: boolean; durationMs: number; counts: Record<string, number> } {
  return { exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs, counts: countStatuses(run) };
}
