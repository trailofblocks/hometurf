import type { Candidate, FileChange, SkipReason } from "./bench.js";
import type { Config } from "./config.js";
import { NotUtf8Error, type CommitInfo, type SourceRepo } from "./git.js";
import { matchAny } from "./util/glob.js";

export interface MineOptions {
  since?: string;
  maxCommits?: number;
  all?: boolean;
}

export interface MineSummary {
  repo: string;
  ref: string;
  head: string;
  since: string | null;
  scanned: number;
  candidates: number;
  skipped: Record<string, number>;
  at: string;
}

const TRAILER = /^(signed-off-by|co-authored-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by|cc|change-id|bug|closes|fixes):/i;

/** A commit message cleaned up for use as a task description: trailers and CI markers removed. */
export function cleanMessage(message: string): string {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  while (lines.length) {
    const last = (lines.at(-1) ?? "").trim();
    if (last !== "" && !TRAILER.test(last)) break;
    lines.pop();
  }
  return lines
    .filter((l) => !/^(signed-off-by|co-authored-by):/i.test(l.trim()))
    .join("\n")
    .replace(/\[(skip ci|ci skip|skip actions)\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function subjectOf(message: string): string {
  return (message.split("\n")[0] ?? "").trim();
}

/** The description for a first-parent step. A merge is described by the commits it brought in. */
export function describe(repo: SourceRepo, commit: CommitInfo): string {
  if (commit.parents.length < 2) return cleanMessage(commit.message);
  const merged = repo.mergedMessages(commit.parents[0] as string, commit.sha).map(cleanMessage);
  const head = cleanMessage(commit.message);
  // "Merge pull request #12 from user/branch" carries the PR title in its body.
  const prBody = /^Merge (pull request|branch)/i.test(head) ? head.split("\n").slice(1).join("\n").trim() : head;
  return [prBody, ...merged].filter(Boolean).join("\n\n");
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
}

export function classify(cfg: Config, isTestSide: (p: string) => boolean, changes: FileChange[]) {
  const test: FileChange[] = [];
  const source: FileChange[] = [];
  const other: FileChange[] = [];
  let env = false;
  for (const c of changes) {
    if (isTestSide(c.path)) test.push(c);
    else if (matchAny(cfg.mine.env, c.path)) {
      env = true;
      other.push(c);
    } else if (matchAny(cfg.mine.ignore, c.path)) other.push(c);
    else source.push(c);
  }
  return { test, source, other, env };
}

/** Walk first-parent history and turn each step into a candidate task, or a recorded reason to skip it. */
export function mine(cfg: Config, repo: SourceRepo, isTestSide: (p: string) => boolean, opts: MineOptions = {}) {
  const since = opts.since ?? cfg.mine.since;
  const all = opts.all ?? cfg.mine.all;
  const match = new RegExp(cfg.mine.match, "i");
  const head = repo.resolve(cfg.ref);
  const commits = repo.firstParentLog(head, { since, maxCount: opts.maxCommits ?? cfg.mine.maxCommits });
  const candidates: Candidate[] = [];
  const skipped: Record<string, number> = {};

  for (const commit of commits) {
    const parent = commit.parents[0];
    if (!parent) continue; // root commit
    const changes = repo.changes(parent, commit.sha);
    const { test, source, other, env } = classify(cfg, isTestSide, changes);
    const description = describe(repo, commit);
    const candidate: Candidate = {
      id: `${cfg.repoName}-${commit.sha.slice(0, 10)}`,
      commit: commit.sha,
      parent,
      date: commit.date,
      subject: subjectOf(commit.parents.length > 1 ? description : commit.message),
      description,
      isMerge: commit.parents.length > 1,
      testChanges: test,
      sourceChanges: source,
      otherChanges: other,
      sourceLines: 0,
    };
    const skip = (reason: SkipReason, detail?: string): void => {
      candidate.skip = detail ? { reason, detail } : { reason };
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    };

    const stats = repo.numstat(parent, commit.sha, source.map((c) => c.path));
    candidate.sourceLines = stats.reduce((n, s) => n + s.added + s.removed, 0);
    if (changes.length === 0) skip("merge");
    else if (!test.some((c) => c.status !== "D")) skip("no-test-change");
    else if (source.length === 0) skip("no-source-change");
    else if (!all && !match.test(description)) skip("message");
    else if (env) skip("env-change", other.filter((c) => matchAny(cfg.mine.env, c.path)).map((c) => c.path).join(", "));
    else if (source.length > cfg.mine.maxSourceFiles) skip("too-large", `${source.length} files`);
    else if (candidate.sourceLines > cfg.mine.maxSourceLines) skip("too-large", `${candidate.sourceLines} lines`);
    else if (stats.some((s) => s.binary)) skip("binary");
    else {
      try {
        repo.diff(parent, commit.sha, source.map((c) => c.path));
      } catch (error) {
        if (!(error instanceof NotUtf8Error)) throw error;
        skip("binary", "not UTF-8 text");
      }
    }
    candidates.push(candidate);
  }

  const summary: MineSummary = {
    repo: cfg.repoName,
    ref: cfg.ref,
    head,
    since: since ?? null,
    scanned: commits.length,
    candidates: candidates.filter((c) => !c.skip).length,
    skipped,
    at: new Date().toISOString(),
  };
  return { candidates, summary };
}
