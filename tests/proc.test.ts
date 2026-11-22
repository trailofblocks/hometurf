import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { quoteArg, runShell } from "../src/util/proc.js";

const node = quoteArg(process.execPath);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hometurf-proc-"));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

describe("runShell", () => {
  it("passes stdin, captures output, and reports the exit code", async () => {
    const dir = tmp();
    const script = path.join(dir, "echo.js");
    fs.writeFileSync(script, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('got:'+s);console.error('err');process.exit(3)})");
    const r = await runShell(`${node} ${quoteArg(script)}`, { cwd: dir, timeoutMs: 20_000, input: "hello", stdoutFile: path.join(dir, "out.log") });
    assert.equal(r.code, 3);
    assert.equal(r.timedOut, false);
    assert.match(r.stdout, /got:hello/);
    assert.match(r.stderr, /err/);
    assert.match(fs.readFileSync(path.join(dir, "out.log"), "utf8"), /got:hello/);
  });

  it("kills the whole process tree on timeout", async () => {
    const dir = tmp();
    const pidFile = path.join(dir, "child.pid");
    const script = path.join(dir, "spawner.js");
    fs.writeFileSync(
      script,
      `const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
setInterval(() => {}, 1000);`,
    );
    const started = Date.now();
    const r = await runShell(`${node} ${quoteArg(script)}`, { cwd: dir, timeoutMs: 1_500 });
    assert.equal(r.timedOut, true);
    assert.equal(r.code, null);
    assert.ok(Date.now() - started < 10_000, "returned soon after the timeout");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(await waitFor(() => !alive(pid), 5_000), `grandchild ${pid} is still running`);
  });

  it("returns when the command exits even if a background process holds its output open", async () => {
    const dir = tmp();
    const pidFile = path.join(dir, "bg.pid");
    const script = path.join(dir, "bg.js");
    fs.writeFileSync(
      script,
      `const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
c.unref();
process.exit(0);`,
    );
    const started = Date.now();
    const r = await runShell(`${node} ${quoteArg(script)}`, { cwd: dir, timeoutMs: 30_000 });
    assert.equal(r.timedOut, false);
    assert.equal(r.code, 0);
    assert.ok(Date.now() - started < 15_000);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    if (process.platform !== "win32") {
      // On POSIX the process group is killed once the command exits.
      assert.ok(await waitFor(() => !alive(pid), 5_000), `background process ${pid} is still running`);
    } else if (alive(pid)) {
      process.kill(pid);
    }
  });
});
