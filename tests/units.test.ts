import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseClaudeCodeUsage } from "../src/agents.js";
import { stripTestSide } from "../src/grade.js";
import { parseJUnit, parseXml } from "../src/junit.js";
import { cleanMessage, wordCount } from "../src/mine.js";
import { mcnemarExact, quantile, wilson, worstCaseHalfWidth } from "../src/stats.js";
import { buildTestCommand } from "../src/testrun.js";
import { matchAny, matchGlob } from "../src/util/glob.js";
import { firstHunk, parsePatch, patchStats } from "../src/util/patch.js";
import { quoteArg, UnsafeArgumentError } from "../src/util/proc.js";
import { classifyTests } from "../src/validate.js";

describe("glob", () => {
  it("anchors patterns with a slash and matches bare names at any depth", () => {
    assert.ok(matchGlob("tests/**", "tests/a/b.py"));
    assert.ok(!matchGlob("tests/**", "src/tests.py"));
    assert.ok(matchGlob("test_*.py", "pkg/sub/test_x.py"));
    assert.ok(matchGlob("test_*.py", "test_x.py"));
    assert.ok(!matchGlob("test_*.py", "pkg/test_x.pyc"));
    assert.ok(matchGlob("CHANGELOG*", "CHANGELOG.md"));
    assert.ok(matchGlob("**/conftest.py", "conftest.py"));
    assert.ok(matchGlob("src/*.js", "src/a.js"));
    assert.ok(!matchGlob("src/*.js", "src/x/a.js"));
  });

  it("supports braces and ?", () => {
    assert.ok(matchGlob("*.test.{js,mjs}", "a/b.test.mjs"));
    assert.ok(!matchGlob("*.test.{js,mjs}", "a/b.test.ts"));
    assert.ok(matchGlob("file?.txt", "file1.txt"));
    assert.ok(!matchGlob("file?.txt", "file12.txt"));
    assert.ok(matchAny(["docs/**", "*.md"], "README.md"));
  });

  it("treats regex characters literally", () => {
    assert.ok(matchGlob("a+b(c).txt", "a+b(c).txt"));
    assert.ok(!matchGlob("a.b", "aXb"));
  });
});

const PYTEST_XML = `<?xml version="1.0" encoding="utf-8"?>
<testsuites name="pytest tests"><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="6" time="0.1">
<testcase classname="tests.test_split" name="test_begin" time="0.001" />
<testcase classname="tests.test_split" name="test_end[a&lt;b &amp; &quot;c&quot;]" time="0.001"><failure message="assert 1 == 2">def test_end():&#10;&gt;       assert 1 == 2</failure></testcase>
<testcase classname="tests.test_split" name="test_skip" time="0"><skipped type="pytest.skip" message="nope">tests/test_split.py:3: nope</skipped></testcase>
<testcase classname="" name="tests.test_new" time="0"><error message="collection failure"><![CDATA[ImportError: cannot import name 'x' <from> y]]></error></testcase>
<!-- a comment with <testcase name="fake"/> inside -->
<testcase classname="tests.test_split" name="test_begin" time="0.001" />
</testsuite></testsuites>`;

describe("junit", () => {
  it("reads pytest reports, including entities, CDATA, comments, and repeated names", () => {
    const tests = parseJUnit(PYTEST_XML, "/work");
    assert.deepEqual(
      tests.map((t) => [t.id, t.status]),
      [
        ["tests.test_split::test_begin", "pass"],
        ['tests.test_split::test_end[a<b & "c"]', "fail"],
        ["tests.test_split::test_skip", "skipped"],
        ["tests.test_new", "error"],
        ["tests.test_split::test_begin #2", "pass"],
      ],
    );
    assert.equal(tests[1]?.message, "assert 1 == 2");
  });

  it("makes absolute file paths from Node's reporter relative to the checkout", () => {
    const root = process.platform === "win32" ? "C:\\tmp\\ws-abc" : "/tmp/ws-abc";
    const file = process.platform === "win32" ? "C:\\tmp\\ws-abc\\test\\a.test.js" : "/tmp/ws-abc/test/a.test.js";
    const xml = `<testsuites>
      <testcase name="adds" classname="test" file="${file}"/>
      <testsuite name="group"><testcase name="inner" classname="test" file="${file}"><skipped type="skipped" message="true"/></testcase></testsuite>
      <testcase name="fails" classname="test" file="${file}" failure="x"><failure type="testCodeFailure" message="x">trace</failure></testcase>
    </testsuites>`;
    assert.deepEqual(
      parseJUnit(xml, root).map((t) => [t.id, t.status]),
      [
        ["test/a.test.js::adds", "pass"],
        ["test/a.test.js::group::inner", "skipped"],
        ["test/a.test.js::fails", "fail"],
      ],
    );
  });

  it("falls back to the checkout folder's unique name when the path is spelled differently", () => {
    const xml = `<testsuites><testcase name="t" file="C:\\Users\\LONGNA~1\\Temp\\ws-q1w2e3\\test\\x.test.js"/></testsuites>`;
    assert.equal(parseJUnit(xml, "C:\\Users\\Long Name\\Temp\\ws-q1w2e3")[0]?.id, "test/x.test.js::t");
  });

  it("rejects malformed XML instead of guessing", () => {
    assert.throws(() => parseXml("<a><b></a>"), /mismatched/);
    assert.throws(() => parseXml("<a>"), /unclosed/);
    assert.throws(() => parseXml("<a x=1/>"), /unquoted/);
  });
});

describe("classifyTests", () => {
  const m = (entries: Record<string, "pass" | "fail" | "error" | "skipped">) => new Map(Object.entries(entries));

  it("splits fail-to-pass, pass-to-pass, and flaky tests", () => {
    const before = [m({ a: "pass", b: "fail", c: "pass", e: "skipped" }), m({ a: "pass", b: "fail", c: "fail", e: "skipped" })];
    const after = [m({ a: "pass", b: "pass", c: "pass", d: "pass", e: "pass" }), m({ a: "pass", b: "pass", c: "pass", d: "pass", e: "pass" })];
    assert.deepEqual(classifyTests(before, after), { failToPass: ["b", "d"], passToPass: ["a"], flaky: ["c"] });
  });

  it("drops tests that still fail after the fix, and tests that flip after it", () => {
    const before = [m({ a: "fail", b: "fail" })];
    const after = [m({ a: "fail", b: "pass" }), m({ a: "fail", b: "fail" })];
    assert.deepEqual(classifyTests(before, after), { failToPass: [], passToPass: [], flaky: ["b"] });
  });

  it("counts a test that disappears in one run as flaky", () => {
    const after = [m({ a: "pass" }), m({})];
    assert.deepEqual(classifyTests([m({})], after).flaky, ["a"]);
  });
});

const PATCH = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,3 +1,4 @@
+const x = require("./b.js");
 one
 two
 three
@@ -20,3 +21,3 @@
 twenty
-old
+new
 end
diff --git a/src/b.js b/src/b.js
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/b.js
@@ -0,0 +1 @@
+module.exports = 1;
diff --git a/test/a.test.js b/test/a.test.js
index 4444444..5555555 100644
--- a/test/a.test.js
+++ b/test/a.test.js
@@ -1 +1 @@
-assert(false)
+assert(true)
`;

describe("patch", () => {
  it("splits files and hunks and counts lines", () => {
    const files = parsePatch(PATCH);
    assert.equal(files.length, 3);
    assert.equal(files[0]?.hunks.length, 2);
    assert.deepEqual(patchStats(PATCH), { files: 3, added: 4, removed: 2 });
  });

  it("keeps only the first hunk of the first file", () => {
    const one = firstHunk(PATCH);
    assert.deepEqual(patchStats(one), { files: 1, added: 1, removed: 0 });
    assert.ok(one.startsWith("diff --git a/src/a.js b/src/a.js\n"));
    assert.ok(!one.includes("@@ -20,3"));
  });

  it("drops test-side sections from an outside patch", () => {
    const { patch, dropped } = stripTestSide(PATCH, (p) => p.startsWith("test/"));
    assert.deepEqual(dropped, ["test/a.test.js"]);
    assert.equal(parsePatch(patch).length, 2);
  });
});

describe("stats", () => {
  it("computes Wilson intervals that stay inside [0, 1]", () => {
    const close = (x: number, y: number) => assert.ok(Math.abs(x - y) < 1e-3, `${x} vs ${y}`);
    const a = wilson(0, 10);
    close(a.low, 0);
    close(a.high, 0.2775);
    const b = wilson(10, 10);
    close(b.low, 0.7225);
    close(b.high, 1);
    const c = wilson(5, 10);
    close(c.low, 0.2366);
    close(c.high, 0.7634);
    assert.deepEqual(wilson(0, 0), { low: 0, high: 1 });
  });

  it("computes exact McNemar p-values", () => {
    assert.equal(mcnemarExact(0, 0), 1);
    assert.ok(Math.abs(mcnemarExact(5, 1) - 0.21875) < 1e-12);
    assert.ok(Math.abs(mcnemarExact(6, 0) - 0.03125) < 1e-12);
    assert.equal(mcnemarExact(3, 3), 1);
    assert.ok(mcnemarExact(900, 1100) < 1e-5); // large n doesn't overflow
  });

  it("interpolates quantiles", () => {
    assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(quantile([], 0.5), undefined);
    assert.ok(Math.abs(worstCaseHalfWidth(24) - 19.0) < 0.5);
  });
});

describe("descriptions", () => {
  it("drops trailers and CI markers", () => {
    const msg = "Fix the thing [skip ci]\n\nLonger text.\n\nSigned-off-by: A <a@x>\nCo-authored-by: B <b@x>\n";
    assert.equal(cleanMessage(msg), "Fix the thing \n\nLonger text.");
    assert.equal(wordCount("Fix #12 (x)"), 2);
  });
});

describe("claude code usage", () => {
  it("reads the result object from json and stream-json output", () => {
    const json = JSON.stringify({ type: "result", total_cost_usd: 0.5, num_turns: 3, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 7 } });
    assert.deepEqual(parseClaudeCodeUsage(json), { costUsd: 0.5, inputTokens: 100, outputTokens: 7, turns: 3 });
    const stream = [JSON.stringify({ type: "assistant", message: {} }), json, ""].join("\n");
    assert.deepEqual(parseClaudeCodeUsage(stream), { costUsd: 0.5, inputTokens: 100, outputTokens: 7, turns: 3 });
    assert.deepEqual(parseClaudeCodeUsage("not json"), {});
  });
});

describe("shell quoting", () => {
  it("quotes for sh and cmd.exe", () => {
    assert.equal(quoteArg("a b's", "linux"), `'a b'\\''s'`);
    assert.equal(quoteArg("C:\\a b\\x.xml", "win32"), `"C:\\a b\\x.xml"`);
    assert.throws(() => quoteArg("100%", "win32"), UnsafeArgumentError);
    assert.throws(() => quoteArg('a"b', "win32"), UnsafeArgumentError);
  });

  it("fills {junit} and {files}", () => {
    const cmd = buildTestCommand("run --junit={junit} {files}", "out dir/r.xml", ["t/a.py", "t/b c.py"]);
    const q = (s: string) => quoteArg(s);
    assert.equal(cmd, `run --junit=${q("out dir/r.xml")} ${q("t/a.py")} ${q("t/b c.py")}`);
  });
});
