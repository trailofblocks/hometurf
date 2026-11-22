import { isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class NotUtf8Error extends Error {}

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

// Settings that would change what a diff or checkout produces, pinned for every call.
const PINNED = [
  "core.autocrlf=false",
  "core.safecrlf=false",
  "core.quotepath=false",
  "core.longpaths=true",
  "diff.noprefix=false",
  "diff.mnemonicPrefix=false",
  "diff.relative=false",
  "advice.detachedHead=false",
  "init.defaultBranch=main",
].flatMap((kv) => ["-c", kv]);

const FIXED_DATE = "2000-01-01T00:00:00Z";

let emptyConfig: string | undefined;
function emptyConfigFile(): string {
  if (!emptyConfig) {
    emptyConfig = path.join(os.tmpdir(), "hometurf-empty.gitconfig");
    if (!fs.existsSync(emptyConfig)) fs.writeFileSync(emptyConfig, "");
  }
  return emptyConfig;
}

/**
 * Environment for a git call. Inherited GIT_* variables are dropped so a stray GIT_DIR or
 * GIT_INDEX_FILE can't redirect anything. `isolated` calls (on hometurf's own scratch repos)
 * also ignore the user's global and system config: no signing, hooks, or templates.
 */
function gitEnv(isolated: boolean, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  if (isolated) {
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: emptyConfigFile(),
      GIT_AUTHOR_NAME: "hometurf",
      GIT_AUTHOR_EMAIL: "hometurf@localhost",
      GIT_COMMITTER_NAME: "hometurf",
      GIT_COMMITTER_EMAIL: "hometurf@localhost",
      GIT_AUTHOR_DATE: FIXED_DATE,
      GIT_COMMITTER_DATE: FIXED_DATE,
    });
  }
  return Object.assign(env, extra);
}

export interface GitCall {
  cwd: string;
  isolated?: boolean;
  input?: string | Buffer;
  env?: Record<string, string>;
}

export function gitRaw(args: string[], call: GitCall): { code: number | null; stdout: Buffer; stderr: string } {
  const r = spawnSync("git", [...PINNED, ...args], {
    cwd: call.cwd,
    env: gitEnv(call.isolated ?? false, call.env),
    input: call.input,
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr.toString("utf8") };
}

export function git(args: string[], call: GitCall): string {
  const r = gitRaw(args, call);
  if (r.code !== 0) {
    throw new GitError(`git ${args.slice(0, 3).join(" ")} failed: ${r.stderr.trim().split("\n").slice(-3).join(" ")}`, r.stderr);
  }
  return r.stdout.toString("utf8");
}

function tempIndex(): string {
  return path.join(os.tmpdir(), `hometurf-index-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
}

function withTempIndex<T>(fn: (env: Record<string, string>) => T): T {
  const file = tempIndex();
  try {
    return fn({ GIT_INDEX_FILE: file });
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.lock`, { force: true });
  }
}

export type ChangeStatus = "A" | "M" | "D" | "T";

export interface FileChange {
  path: string;
  status: ChangeStatus;
}

export interface CommitInfo {
  sha: string;
  parents: string[];
  /** Committer date, ISO 8601. */
  date: string;
  message: string;
}

const DIFF_FLAGS = ["--no-renames", "--no-ext-diff", "--no-color", "--no-textconv"];

/** Read-only access to the repository the benchmark is mined from. Nothing is written into it. */
export class SourceRepo {
  private constructor(readonly root: string) {}

  static open(dir: string): SourceRepo {
    if (!fs.existsSync(dir)) throw new Error(`repository not found: ${dir}`);
    const root = git(["rev-parse", "--show-toplevel"], { cwd: dir }).trim();
    return new SourceRepo(path.resolve(root));
  }

  private run(args: string[], env?: Record<string, string>, input?: string | Buffer): string {
    return git(args, { cwd: this.root, env, input });
  }

  resolve(ref: string): string {
    return this.run(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  }

  exists(sha: string): boolean {
    return gitRaw(["cat-file", "-e", `${sha}^{commit}`], { cwd: this.root }).code === 0;
  }

  firstParentLog(ref: string, opts: { since?: string; maxCount: number }): CommitInfo[] {
    const args = ["log", "--first-parent", `--max-count=${opts.maxCount}`, "--format=%H%x00%P%x00%cI%x00%B%x1e"];
    if (opts.since) args.push(`--since=${opts.since}`);
    args.push(this.resolve(ref));
    return this.run(args)
      .split("\x1e")
      .map((rec) => rec.replace(/^\n/, ""))
      .filter((rec) => rec.length > 0)
      .map((rec) => {
        const [sha = "", parents = "", date = "", message = ""] = rec.split("\x00");
        return { sha, parents: parents.split(" ").filter(Boolean), date, message: message.trimEnd() };
      });
  }

  /** Messages of the non-merge commits a merge brought in. */
  mergedMessages(parent: string, merge: string): string[] {
    return this.run(["log", "--no-merges", "--reverse", "--format=%B%x1e", `${parent}..${merge}`])
      .split("\x1e")
      .map((m) => m.trim())
      .filter(Boolean);
  }

  changes(from: string, to: string): FileChange[] {
    const out = this.run(["diff", "--name-status", "-z", ...DIFF_FLAGS, from, to]);
    const parts = out.split("\0");
    const changes: FileChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = (parts[i] ?? "").charAt(0) as ChangeStatus;
      const file = parts[i + 1] ?? "";
      if (file) changes.push({ path: file, status });
    }
    return changes;
  }

  /** Lines added and removed per path. Binary files report `binary: true`. */
  numstat(from: string, to: string, paths: string[]): Array<{ path: string; added: number; removed: number; binary: boolean }> {
    if (paths.length === 0) return [];
    const out = this.run(["diff", "--numstat", "-z", ...DIFF_FLAGS, from, to, "--", ...paths.map(literal)]);
    return out
      .split("\0")
      .filter(Boolean)
      .map((rec) => {
        const [added = "", removed = "", file = ""] = rec.split("\t");
        const binary = added === "-";
        return { path: file, added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary };
      });
  }

  /** A patch from `from` to `to` for the given paths. Throws NotUtf8Error if it isn't valid UTF-8 text. */
  diff(from: string, to: string, paths: string[]): string {
    if (paths.length === 0) return "";
    const r = gitRaw(["diff", "--binary", "--full-index", ...DIFF_FLAGS, from, to, "--", ...paths.map(literal)], { cwd: this.root });
    if (r.code !== 0) throw new GitError(`git diff failed: ${r.stderr.trim()}`, r.stderr);
    if (!isUtf8(r.stdout)) throw new NotUtf8Error("the patch is not valid UTF-8");
    return r.stdout.toString("utf8");
  }

  /** Every file path in a commit's tree. */
  listFiles(commit: string): string[] {
    return this.run(["ls-tree", "-r", "-z", "--name-only", "--full-tree", commit]).split("\0").filter(Boolean);
  }

  /** Write a commit's files into `dest` (which must exist). No history comes along. */
  exportTree(commit: string, dest: string): void {
    withTempIndex((env) => {
      this.run(["read-tree", commit], env);
      this.run(["checkout-index", "--all", "--force", `--prefix=${prefixFor(dest)}`], env);
    });
  }

  /** Write the given paths as they are in `commit` into `dest`. Paths missing from `commit` are deleted from `dest`. */
  checkoutPaths(commit: string, dest: string, paths: string[]): void {
    if (paths.length === 0) return;
    const present = new Set(this.run(["ls-tree", "-r", "-z", "--name-only", "--full-tree", commit, "--", ...paths.map(literal)]).split("\0"));
    const write = paths.filter((p) => present.has(p));
    for (const p of paths) {
      if (!present.has(p)) fs.rmSync(path.join(dest, p), { force: true });
    }
    if (write.length === 0) return;
    withTempIndex((env) => {
      this.run(["read-tree", commit], env);
      this.run(["checkout-index", "--force", "-z", "--stdin", `--prefix=${prefixFor(dest)}`], env, `${write.join("\0")}\0`);
    });
  }
}

/** A pathspec that matches exactly this path, even if it contains glob characters. */
function literal(p: string): string {
  return `:(literal)${p}`;
}

function prefixFor(dest: string): string {
  return `${dest.split(path.sep).join("/").replace(/\/$/, "")}/`;
}

export interface RawChange {
  path: string;
  status: string;
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
}

const NULL_SHA = "0".repeat(40);

/** Add everything in a work tree, including files that are committed but match a .gitignore. */
function addAll(gitArgs: string[], cwd: string, tracked: string[]): void {
  if (tracked.length > 0) {
    git([...gitArgs, "add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      cwd,
      isolated: true,
      input: `${tracked.join("\0")}\0`,
      env: { GIT_LITERAL_PATHSPECS: "1" },
    });
  }
  git([...gitArgs, "add", "--all"], { cwd, isolated: true });
}

/** Make `dir` a git repository with one commit holding its current files. */
export function initOneCommitRepo(dir: string, tracked: string[]): string {
  git(["init", "-q"], { cwd: dir, isolated: true });
  addAll([], dir, tracked);
  git(["commit", "-q", "--no-verify", "--no-gpg-sign", "--allow-empty", "-m", "base"], { cwd: dir, isolated: true });
  return git(["rev-parse", "HEAD"], { cwd: dir, isolated: true }).trim();
}

export function applyPatch(dir: string, patch: string | Buffer): { ok: boolean; error: string } {
  if (patch.length === 0 || (typeof patch === "string" && !patch.trim())) return { ok: true, error: "" };
  const r = gitRaw(["apply", "--whitespace=nowarn", "-"], { cwd: dir, isolated: true, input: patch });
  return { ok: r.code === 0, error: r.stderr.trim() };
}

/**
 * Tracks a work tree from a git directory kept outside it, so whatever the agent does to the
 * work tree's own `.git` can't change what gets graded.
 */
export class Shadow {
  private constructor(
    readonly gitDir: string,
    readonly workTree: string,
  ) {}

  static create(gitDir: string, workTree: string, excludes: string[]): Shadow {
    git(["init", "-q", "--bare", gitDir], { cwd: path.dirname(gitDir), isolated: true });
    git(["--git-dir", gitDir, "config", "core.bare", "false"], { cwd: path.dirname(gitDir), isolated: true });
    fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "info", "exclude"), `${excludes.join("\n")}\n`);
    return new Shadow(gitDir, workTree);
  }

  private args(): string[] {
    return ["--git-dir", this.gitDir, "--work-tree", this.workTree];
  }

  private run(args: string[], extra: Partial<GitCall> = {}): string {
    return git([...this.args(), ...args], { cwd: this.workTree, isolated: true, ...extra });
  }

  /** Record the work tree's current content and return its tree id. */
  snapshot(tracked: string[] = []): string {
    addAll(this.args(), this.workTree, tracked);
    return this.run(["write-tree"]).trim();
  }

  changes(from: string, to: string): RawChange[] {
    const out = this.run(["diff-tree", "-r", "-z", "--no-renames", from, to]);
    const parts = out.split("\0");
    const changes: RawChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const meta = (parts[i] ?? "").replace(/^:/, "").split(" ");
      const file = parts[i + 1] ?? "";
      if (!file || meta.length < 5) continue;
      const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = meta;
      changes.push({ path: file, status: status.charAt(0), oldMode, newMode, oldSha, newSha });
    }
    return changes;
  }

  /**
   * `to`, with every change to an excluded path undone (restored as in `from`).
   * Returns the new tree and the paths whose changes were undone.
   */
  restrict(from: string, to: string, exclude: (p: string) => boolean): { tree: string; reverted: string[] } {
    const reverted = this.changes(from, to).filter((c) => exclude(c.path) || c.newMode === "160000");
    if (reverted.length === 0) return { tree: to, reverted: [] };
    const file = tempIndex();
    try {
      const env = { GIT_INDEX_FILE: file };
      this.run(["read-tree", to], { env });
      const info = reverted
        .map((c) => (c.oldMode === "000000" ? `0 ${NULL_SHA}\t${c.path}` : `${c.oldMode} ${c.oldSha}\t${c.path}`))
        .join("\0");
      this.run(["update-index", "-z", "--index-info"], { env, input: `${info}\0` });
      return { tree: this.run(["write-tree"], { env }).trim(), reverted: reverted.map((c) => c.path) };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  /** The patch as raw bytes: an agent may write files in any encoding. */
  diff(from: string, to: string): Buffer {
    if (from === to) return Buffer.alloc(0);
    const r = gitRaw([...this.args(), "diff", "--binary", "--full-index", ...DIFF_FLAGS, from, to], { cwd: this.workTree, isolated: true });
    if (r.code !== 0) throw new GitError(`git diff failed: ${r.stderr.trim()}`, r.stderr);
    return r.stdout;
  }
}
