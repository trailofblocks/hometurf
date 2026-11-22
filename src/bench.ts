import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readJson, readJsonl, writeFileAtomic, writeJson } from "./util/fs.js";

export const FileChangeSchema = z.object({ path: z.string(), status: z.enum(["A", "M", "D", "T"]) });
export type FileChange = z.infer<typeof FileChangeSchema>;

export const SKIP_REASONS = {
  merge: "merge commit with no first-parent changes",
  "no-test-change": "adds or changes no test file",
  "no-source-change": "changes no source file",
  message: "message doesn't look like a fix",
  "env-change": "changes dependency or build files",
  "too-large": "fix is larger than the size limit",
  binary: "fix changes a binary file",
} as const;
export type SkipReason = keyof typeof SKIP_REASONS;

export const CandidateSchema = z.object({
  id: z.string(),
  commit: z.string(),
  parent: z.string(),
  date: z.string(),
  subject: z.string(),
  description: z.string(),
  isMerge: z.boolean(),
  testChanges: z.array(FileChangeSchema),
  sourceChanges: z.array(FileChangeSchema),
  otherChanges: z.array(FileChangeSchema),
  sourceLines: z.number(),
  skip: z.object({ reason: z.string(), detail: z.string().optional() }).optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const REJECT_REASONS = {
  "no-runnable-test": "no changed test file matches tests.run",
  "unsafe-path": "a test path can't be passed safely through the shell",
  "setup-failed": "the setup command failed",
  "gold-patch-failed": "the reference fix doesn't apply to the parent commit",
  "tests-timed-out": "the tests ran past tests.timeoutSec",
  "before-no-report": "the test command wrote no JUnit report before the fix",
  "after-no-report": "the test command wrote no JUnit report after the fix",
  "no-fail-to-pass": "no test fails before the fix and passes after it",
} as const;
export type RejectReason = keyof typeof REJECT_REASONS;

export const RunSummarySchema = z.object({
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number(),
  counts: z.record(z.string(), z.number()),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const TaskSchema = z.object({
  id: z.string(),
  repo: z.string(),
  base: z.string(),
  fix: z.string(),
  date: z.string(),
  subject: z.string(),
  /** Paths on the test side that the fix changed. Grading writes their post-fix versions. */
  testChanges: z.array(FileChangeSchema),
  /** Test files passed as {files}. */
  runFiles: z.array(z.string()),
  failToPass: z.array(z.string()),
  passToPass: z.array(z.string()),
  flaky: z.array(z.string()),
  goldStats: z.object({ files: z.number(), added: z.number(), removed: z.number() }),
  thinDescription: z.boolean(),
  validation: z.object({
    platform: z.string(),
    at: z.string(),
    before: z.array(RunSummarySchema),
    after: z.array(RunSummarySchema),
  }),
});
export type TaskMeta = z.infer<typeof TaskSchema>;

export interface Task extends TaskMeta {
  description: string;
  goldPatch: string;
}

export const RejectionSchema = z.object({
  id: z.string(),
  reason: z.string(),
  detail: z.string().optional(),
  at: z.string(),
});
export type Rejection = z.infer<typeof RejectionSchema>;

export function benchPaths(benchDir: string) {
  return {
    candidates: path.join(benchDir, "candidates.jsonl"),
    mineSummary: path.join(benchDir, "mine.json"),
    rejections: path.join(benchDir, "rejected.jsonl"),
    tasks: path.join(benchDir, "tasks"),
    runs: path.join(benchDir, "runs"),
    task: (id: string) => path.join(benchDir, "tasks", id),
  };
}

export function loadCandidates(benchDir: string): Candidate[] {
  return readJsonl(benchPaths(benchDir).candidates).map((c) => CandidateSchema.parse(c));
}

export function saveTask(benchDir: string, task: Task): void {
  const dir = benchPaths(benchDir).task(task.id);
  const { description, goldPatch, ...meta } = task;
  writeJson(path.join(dir, "task.json"), meta);
  writeFileAtomic(path.join(dir, "description.md"), `${description.trim()}\n`);
  writeFileAtomic(path.join(dir, "gold.patch"), goldPatch);
}

/** Validated tasks, oldest first. `description.md` can be edited by hand and is read fresh each time. */
export function loadTasks(benchDir: string): Task[] {
  const dir = benchPaths(benchDir).tasks;
  if (!fs.existsSync(dir)) return [];
  const tasks: Task[] = [];
  for (const id of fs.readdirSync(dir).sort()) {
    const taskDir = path.join(dir, id);
    const metaFile = path.join(taskDir, "task.json");
    if (!fs.existsSync(metaFile)) continue;
    const meta = TaskSchema.parse(readJson(metaFile));
    tasks.push({
      ...meta,
      description: fs.readFileSync(path.join(taskDir, "description.md"), "utf8").replace(/\r\n/g, "\n").trim(),
      goldPatch: fs.readFileSync(path.join(taskDir, "gold.patch"), "utf8"),
    });
  }
  return tasks.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function loadRejections(benchDir: string): Rejection[] {
  return readJsonl(benchPaths(benchDir).rejections).map((r) => RejectionSchema.parse(r));
}
