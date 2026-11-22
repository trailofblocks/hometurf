import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const isWindows = process.platform === "win32";

export interface ShellResult {
  /** Exit code, or null if the process was killed. */
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  /** The last `captureLimit` characters of stdout. The full stream goes to `stdoutFile` when one is given. */
  stdout: string;
  stderr: string;
}

export interface ShellOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Written to stdin, which is then closed. Without it, stdin is empty. */
  input?: string;
  stdoutFile?: string;
  stderrFile?: string;
  captureLimit?: number;
}

const active = new Set<ChildProcess>();

/** Kill a process and everything it started. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      // The child leads its own process group (spawned detached), so this reaches its descendants too.
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
  }
}

/** Kill every process tree started by runShell that is still running. Used on Ctrl+C. */
export function killAll(): void {
  for (const child of active) killTree(child);
}

class Tail {
  private text = "";
  private fd: number | undefined;
  constructor(
    private readonly limit: number,
    file: string | undefined,
  ) {
    if (file) this.fd = fs.openSync(file, "w");
  }
  push(chunk: Buffer): void {
    if (this.fd !== undefined) fs.writeSync(this.fd, chunk);
    this.text += chunk.toString("utf8");
    if (this.text.length > this.limit * 2) this.text = this.text.slice(-this.limit);
  }
  close(): string {
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
    return this.text.length > this.limit ? this.text.slice(-this.limit) : this.text;
  }
}

/**
 * Run a command line through the platform shell (cmd.exe or /bin/sh) with a hard timeout.
 * On timeout, or once the command exits, the whole process tree is killed, so nothing it
 * started in the background outlives it.
 */
export function runShell(command: string, opts: ShellOptions): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      detached: !isWindows,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    active.add(child);
    const limit = opts.captureLimit ?? 1024 * 1024;
    let out: Tail;
    let err: Tail;
    try {
      out = new Tail(limit, opts.stdoutFile);
      err = new Tail(limit, opts.stderrFile);
    } catch (error) {
      killTree(child);
      active.delete(child);
      reject(error);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // The command exited without reading its input.
      });
      child.stdin.end(opts.input);
    }

    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let drain: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      active.delete(child);
      resolve({
        code: timedOut ? null : exitCode,
        timedOut,
        durationMs: Math.round(performance.now() - started),
        stdout: out.close(),
        stderr: err.close(),
      });
    };
    // A background process can hold the pipes open after the command itself exits.
    const giveUpOnPipes = (ms: number): void => {
      if (drain) return;
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, ms);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      giveUpOnPipes(5_000);
    }, opts.timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.delete(child);
      out.close();
      err.close();
      reject(error);
    });
    child.on("exit", (code) => {
      exitCode = code;
      if (!isWindows) killTree(child);
      giveUpOnPipes(2_000);
    });
    child.on("close", (code) => {
      if (exitCode === null) exitCode = code;
      finish();
    });
  });
}

export class UnsafeArgumentError extends Error {}

/** Quote one argument for the platform shell. */
export function quoteArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    // Inside double quotes cmd.exe still expands %VAR%, and a quote ends the argument.
    if (/["%\r\n]/.test(arg) || arg.endsWith("\\")) {
      throw new UnsafeArgumentError(`can't pass ${JSON.stringify(arg)} safely through cmd.exe`);
    }
    return `"${arg}"`;
  }
  if (/[\r\n]/.test(arg)) throw new UnsafeArgumentError(`can't pass ${JSON.stringify(arg)} safely through sh`);
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
