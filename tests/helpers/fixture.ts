import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Builds a small Node library repository whose history covers every case the miner and validator
 * must handle. Identity and dates are fixed, so commit ids are the same on every machine.
 */

function git(dir: string, args: string[], date: string): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith("GIT_")) env[k] = v;
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(dir, "..", "fixture.gitconfig"),
    GIT_AUTHOR_NAME: "Fixture Dev",
    GIT_AUTHOR_EMAIL: "dev@fixture.invalid",
    GIT_COMMITTER_NAME: "Fixture Dev",
    GIT_COMMITTER_EMAIL: "dev@fixture.invalid",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  const r = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "init.defaultBranch=main", ...args], { cwd: dir, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const LIB_V0 = `function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return lo;
  return x;
}

function add(a, b) {
  return a + b;
}

function slug(s) {
  return s.toLowerCase().replace(/ /g, "-");
}

function parse(text) {
  return text.split(",").map((part) => Number(part.trim()));
}

module.exports = { clamp, add, slug, parse };
`;

const TEST_V0 = `const test = require("node:test");
const assert = require("node:assert");
const { clamp, add, slug } = require("../src/lib.js");

test("add", () => assert.strictEqual(add(2, 3), 5));
test("clamp below", () => assert.strictEqual(clamp(-1, 0, 10), 0));
test("slug basic", () => assert.strictEqual(slug("Hello World"), "hello-world"));
`;

export interface FixtureRepo {
  dir: string;
  commits: Record<string, string>;
}

export function buildFixtureRepo(parent: string): FixtureRepo {
  const dir = path.join(parent, "fixture-lib");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(parent, "fixture.gitconfig"), "");
  let day = 1;
  const commits: Record<string, string> = {};
  const write = (rel: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  const read = (rel: string): string => fs.readFileSync(path.join(dir, rel), "utf8");
  const replace = (rel: string, from: string, to: string): void => {
    const text = read(rel);
    if (!text.includes(from)) throw new Error(`fixture: ${JSON.stringify(from)} not in ${rel}`);
    write(rel, text.replace(from, to));
  };
  const commit = (key: string, message: string): void => {
    const date = `2024-01-${String(day++).padStart(2, "0")}T12:00:00Z`;
    git(dir, ["add", "-A"], date);
    git(dir, ["commit", "-q", "--no-verify", "-m", message], date);
    commits[key] = git(dir, ["rev-parse", "HEAD"], date);
  };
  const d0 = "2024-01-01T00:00:00Z";
  git(dir, ["init", "-q"], d0);

  write("package.json", `{ "name": "fixture-lib", "private": true }\n`);
  write("README.md", "# fixture-lib\n");
  write(".gitignore", "node_modules/\n");
  write("src/lib.js", LIB_V0);
  write("test/lib.test.js", TEST_V0);
  commit("init", "Initial commit");

  // A real bug fix with a regression test: becomes a task.
  replace("src/lib.js", "if (x > hi) return lo;", "if (x > hi) return hi;");
  write("test/lib.test.js", `${read("test/lib.test.js")}test("clamp above", () => assert.strictEqual(clamp(11, 0, 10), 10));\n`);
  write("CHANGELOG.md", "- Fix clamp upper bound\n");
  commit("clamp", "Fix clamp upper bound (fixes #1)\n\nclamp() returned the lower bound for values above the range.\n\nSigned-off-by: Fixture Dev <dev@fixture.invalid>");

  write("README.md", "# fixture-lib\n\nSmall helpers.\n");
  commit("docs", "Fix typo in README");

  replace("test/lib.test.js", 'test("add",', 'test("adds two numbers",');
  commit("tests-only", "Fix test name");

  // A feature, not a fix: skipped unless --all.
  write("src/lib.js", read("src/lib.js").replace("module.exports = { clamp, add, slug, parse };", "function multiply(a, b) {\n  return a * b;\n}\n\nmodule.exports = { clamp, add, slug, parse, multiply };"));
  write("test/lib.test.js", `${read("test/lib.test.js").replace("const { clamp, add, slug }", "const { clamp, add, slug, multiply }")}test("multiply", () => assert.strictEqual(multiply(3, 4), 12));\n`);
  commit("feature", "Add multiply helper");

  // A fix spread over two files: the first hunk alone isn't enough.
  write("src/text.js", `function collapseSpaces(s) {\n  return s.trim().replace(/ +/g, " ");\n}\n\nmodule.exports = { collapseSpaces };\n`);
  replace("src/lib.js", "function clamp(x, lo, hi) {", 'const { collapseSpaces } = require("./text.js");\n\nfunction clamp(x, lo, hi) {');
  replace("src/lib.js", 'return s.toLowerCase().replace(/ /g, "-");', 'return collapseSpaces(s).toLowerCase().replace(/ /g, "-");');
  write("test/lib.test.js", `${read("test/lib.test.js")}test("slug repeated spaces", () => assert.strictEqual(slug("  Hello   World "), "hello-world"));\n`);
  commit("slug", "Fix slug for repeated and surrounding spaces");

  // The new test already passes before the change: rejected.
  replace("src/lib.js", "  return a + b;", "  return b + a;");
  write("test/lib.test.js", `${read("test/lib.test.js")}test("add is commutative", () => assert.strictEqual(add(1, 2), add(2, 1)));\n`);
  commit("no-f2p", "Fix add argument order");

  // A real fix next to a flaky test: the flaky test is dropped, the task is kept.
  replace("src/lib.js", "function parse(text) {\n", 'function parse(text) {\n  if (text.trim() === "") return [];\n');
  write(
    "test/parse.test.js",
    `const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { parse } = require("../src/lib.js");

test("parse numbers", () => assert.deepStrictEqual(parse("1, 2"), [1, 2]));
test("parse empty", () => assert.deepStrictEqual(parse(" "), []));
test("flaky", () => {
  const file = process.env.HOMETURF_FIXTURE_COUNTER;
  if (!file) return;
  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
  fs.writeFileSync(file, String(n + 1));
  assert.ok(n % 2 === 0, "fails on every other run");
});
`,
  );
  commit("parse", "Fix parse crash on empty input");

  // Touches the package manifest: skipped (the environment would need rebuilding).
  replace("package.json", `"private": true`, `"private": true, "version": "1.0.1"`);
  replace("src/lib.js", "  if (x < lo) return lo;", "  if (Number.isNaN(x)) return lo;\n  if (x < lo) return lo;");
  write("test/lib.test.js", `${read("test/lib.test.js")}test("clamp NaN", () => assert.strictEqual(clamp(NaN, 0, 10), 0));\n`);
  commit("env", "Fix clamp NaN and bump version");

  // A fix on a branch, merged with a merge commit: the first-parent step is one task.
  const branchDate = `2024-01-${String(day++).padStart(2, "0")}T12:00:00Z`;
  git(dir, ["checkout", "-q", "-b", "feature/tabs"], branchDate);
  replace("src/text.js", "replace(/ +/g", "replace(/[ \\t]+/g");
  write("test/text.test.js", `const test = require("node:test");\nconst assert = require("node:assert");\nconst { collapseSpaces } = require("../src/text.js");\n\ntest("collapse tabs", () => assert.strictEqual(collapseSpaces("a\\t\\tb"), "a b"));\ntest("collapse plain", () => assert.strictEqual(collapseSpaces("a  b"), "a b"));\n`);
  commit("branch-fix", "Handle tabs in collapseSpaces");
  git(dir, ["checkout", "-q", "main"], branchDate);
  const mergeDate = `2024-01-${String(day++).padStart(2, "0")}T12:00:00Z`;
  git(dir, ["merge", "-q", "--no-ff", "--no-verify", "-m", "Merge branch 'feature/tabs'", "feature/tabs"], mergeDate);
  commits.merge = git(dir, ["rev-parse", "HEAD"], mergeDate);

  // Too big for the size limit the tests configure.
  write("src/big.js", `${Array.from({ length: 60 }, (_, i) => `exports.f${i} = () => ${i};`).join("\n")}\n`);
  write("test/big.test.js", `const test = require("node:test");\nconst assert = require("node:assert");\nconst big = require("../src/big.js");\ntest("big", () => assert.strictEqual(big.f59(), 59));\n`);
  commit("big", "Fix missing exports in big module");

  return { dir, commits };
}

/** A hometurf.json for the fixture, using the node-test preset with a small size limit. */
export function fixtureConfig(repoRel: string, setups: unknown[] = []): Record<string, unknown> {
  return {
    repo: repoRel,
    tests: {
      files: ["test/**"],
      run: ["test/**/*.test.js"],
      command: "node --test --test-reporter=junit --test-reporter-destination={junit} {files}",
      timeoutSec: 60,
    },
    mine: { env: ["package.json", "package-lock.json"], maxSourceLines: 40 },
    agentTimeoutSec: 60,
    setups,
  };
}
