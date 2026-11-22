import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Write a file so readers never see a half-written version. */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

export function writeJson(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

export function appendJsonl(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

export function readJsonl(file: string): unknown[] {
  if (!fs.existsSync(file)) return [];
  const out: unknown[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A line cut short by an interrupted run. Everything before it is still good.
    }
  }
  return out;
}

/** Remove a directory tree. Retries cover Windows, where a just-killed process can hold files briefly. */
export function removeTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/**
 * A new empty directory with a random name. The path is resolved to its real, long form,
 * so test reporters that print absolute paths agree with it (Windows can hand out 8.3 names).
 */
export function makeTempDir(parent: string | undefined, prefix: string): string {
  const base = parent ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.realpathSync.native(fs.mkdtempSync(path.join(base, prefix)));
}

/** Forward slashes, for paths that are stored or compared across platforms. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
