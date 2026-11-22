import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { removeTree } from "../src/util/fs.js";
import { buildFixtureRepo } from "./helpers/fixture.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(repoRoot, "src", "cli.ts");
const tsx = ["--import", import.meta.resolve("tsx")];

let root: string;
let bench: string;

function hometurf(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOMETURF_FIXTURE_COUNTER: path.join(root, "counter") };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [...tsx, cli, ...args], { cwd: root, encoding: "utf8", env, timeout: 300_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

before(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "hometurf-cli-")));
  buildFixtureRepo(root);
  bench = path.join(root, "bench");
});

after(() => removeTree(root));

describe("cli", () => {
  it("init detects the test setup and refuses to overwrite", () => {
    const r = hometurf(["init", "fixture-lib", "--bench", bench]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /preset node-test/);
    const cfg = JSON.parse(fs.readFileSync(path.join(bench, "hometurf.json"), "utf8"));
    assert.equal(cfg.repo, "../fixture-lib");
    assert.match(cfg.tests.command, /--test-reporter=junit/);
    assert.equal(hometurf(["init", "fixture-lib", "--bench", bench]).code, 2);
  });

  it("mines, validates, lists, calibrates, and reports", () => {
    let r = hometurf(["mine", "--bench", bench]);
    assert.equal(r.code, 0, r.out);
    // The preset's default size limit keeps the 61-line fix the pipeline tests reject as too large.
    assert.match(r.out, /Scanned 11 commits; 6 candidates\./);

    r = hometurf(["validate", "--bench", bench, "--jobs", "2"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Kept 5 of 6\. The benchmark now has 5 tasks\./);
    assert.equal(fs.readFileSync(path.join(bench, "rejected.jsonl"), "utf8").trim().split("\n").length, 1);

    r = hometurf(["validate", "--bench", bench]);
    assert.match(r.out, /Validating 0 candidates/, "already-validated candidates are not redone");

    r = hometurf(["tasks", "--bench", bench]);
    assert.match(r.out, /5 tasks\./);
    assert.match(r.out, /\[thin description\] Handle tabs in collapseSpaces/);

    r = hometurf(["calibrate", "--bench", bench, "--jobs", "2"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Calibration passed: the oracle solved all 5 tasks and the no-op agent solved none\./);

    r = hometurf(["report", "--bench", bench, "--run", "calibration", "--out", path.join(root, "copy.md")]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /oracle\s+5\/5/);
    assert.match(fs.readFileSync(path.join(root, "copy.md"), "utf8"), /## How the tasks were mined/);
  });

  it("calibrate fails when a task's tests can't detect the bug", () => {
    // Break one task: make the recorded fail-to-pass test one that always passes.
    const tasksDir = path.join(bench, "tasks");
    const id = fs.readdirSync(tasksDir).sort()[0] as string;
    const file = path.join(tasksDir, id, "task.json");
    const task = JSON.parse(fs.readFileSync(file, "utf8"));
    task.failToPass = task.passToPass.slice(0, 1);
    fs.writeFileSync(file, JSON.stringify(task));
    const r = hometurf(["calibrate", "--bench", bench, "--jobs", "2"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`no-op agent solved ${id}`));
  });

  it("grade reports a patch's result and drops test edits", () => {
    const tasksDir = path.join(bench, "tasks");
    const id = fs.readdirSync(tasksDir).sort()[1] as string;
    const gold = path.join(tasksDir, id, "gold.patch");
    let r = hometurf(["grade", "--bench", bench, "--task", id, "--patch", gold]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^RESOLVED/m);
    const cheat = path.join(root, "cheat.patch");
    fs.writeFileSync(cheat, "diff --git a/test/lib.test.js b/test/lib.test.js\n--- a/test/lib.test.js\n+++ b/test/lib.test.js\n@@ -1 +1 @@\n-x\n+y\n");
    r = hometurf(["grade", "--bench", bench, "--task", id, "--patch", cheat]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Dropped changes to test-side files: test\/lib\.test\.js/);
    assert.match(r.out, /NOT RESOLVED \(unresolved\)/);
  });

  it("explains bad input instead of crashing", () => {
    assert.match(hometurf(["run", "--bench", bench, "--setups", "nope"]).out, /unknown setup "nope"/);
    assert.match(hometurf(["mine", "--bench", path.join(root, "missing")]).out, /no hometurf\.json/);
  });
});
