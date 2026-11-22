#!/usr/bin/env node
// Builds a hometurf benchmark from sqlparse's history and runs the calibration agents on it.
// Needs git, Python 3.10+ with pytest on PATH as `python`, and a built hometurf (`npm run build`).
//
//   node examples/sqlparse/run-demo.mjs <work-dir> [--jobs 4]
//
// sqlparse is cloned into <work-dir>/sqlparse at a pinned commit; the benchmark goes to <work-dir>/bench.
// No model is called: the setups are hometurf's built-in calibration agents.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const URL = "https://github.com/andialbrecht/sqlparse.git";
const COMMIT = "09dbe1eec31ed1b3cd05366748865f11ba427d32"; // 2026-11-01, "Release 0.6.1"

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "..", "..", "dist", "cli.js");
const args = process.argv.slice(2);
const work = args[0];
if (!work) {
  console.error("usage: node examples/sqlparse/run-demo.mjs <work-dir> [--jobs N]");
  process.exit(2);
}
const jobsAt = args.indexOf("--jobs");
const jobs = jobsAt >= 0 ? args[jobsAt + 1] ?? "4" : "4";
if (!fs.existsSync(cli)) {
  console.error(`${cli} not found; run \`npm run build\` first`);
  process.exit(2);
}

function run(cmd, cmdArgs, opts = {}) {
  console.log(`\n$ ${[cmd, ...cmdArgs].join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

function must(cmd, cmdArgs, opts) {
  const code = run(cmd, cmdArgs, opts);
  if (code !== 0) {
    console.error(`failed with exit code ${code}`);
    process.exit(code);
  }
}

fs.mkdirSync(work, { recursive: true });
const repo = path.join(work, "sqlparse");
const bench = path.join(work, "bench");
if (!fs.existsSync(path.join(repo, ".git"))) {
  must("git", ["clone", "--quiet", URL, repo]);
}
must("git", ["-C", repo, "-c", "advice.detachedHead=false", "checkout", "--quiet", COMMIT]);
fs.mkdirSync(bench, { recursive: true });
fs.copyFileSync(path.join(here, "hometurf.json"), path.join(bench, "hometurf.json"));

const ht = (...rest) => [cli, ...rest, "--bench", bench];
must(process.execPath, ht("mine"));
must(process.execPath, ht("validate", "--jobs", jobs));
must(process.execPath, ht("tasks"));
const calibration = run(process.execPath, ht("calibrate", "--jobs", jobs));
const name = "demo";
fs.rmSync(path.join(bench, "runs", name), { recursive: true, force: true });
must(process.execPath, ht("run", "--name", name, "--jobs", jobs));
console.log(`\nReport: ${path.join(bench, "runs", name, "report.md")}`);
process.exit(calibration);
