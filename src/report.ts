import { REJECT_REASONS, type Rejection, SKIP_REASONS, type Task } from "./bench.js";
import type { MineSummary } from "./mine.js";
import type { CellResult, RunMeta } from "./run.js";
import { mcnemarExact, quantile, wilson, worstCaseHalfWidth } from "./stats.js";

export interface Interval {
  low: number;
  high: number;
}

export interface SetupRow {
  setup: string;
  label?: string;
  tasks: number;
  cells: number;
  /** Tasks counted as solved: solved in more than half of their attempts (with one attempt, simply solved). */
  solved: number;
  ci: Interval;
  /** Mean over every attempt. */
  rate: number;
  passAtK?: { count: number; ci: Interval };
  passAllK?: { count: number; ci: Interval };
  /** Mean share of fail-to-pass tests passing, over every attempt. */
  partial: number;
  costKnown: number;
  costTotal?: number;
  costPerTask?: number;
  costPerSolved?: number;
  /** Means over the attempts that reported them. */
  tokensIn?: number;
  tokensOut?: number;
  medianSec?: number;
  p90Sec?: number;
  reverted: number;
  errors: number;
  timeouts: number;
}

export interface Comparison {
  a: string;
  b: string;
  n: number;
  onlyA: number;
  onlyB: number;
  p: number;
}

export interface Analysis {
  rows: SetupRow[];
  comparisons: Comparison[];
  repeat: number;
  taskCount: number;
  /** task -> setup -> resolved flags, one per attempt */
  matrix: Map<string, Map<string, boolean[]>>;
}

function byTask(results: CellResult[], setup: string): Map<string, CellResult[]> {
  const map = new Map<string, CellResult[]>();
  for (const r of results) {
    if (r.setup !== setup) continue;
    const list = map.get(r.task) ?? [];
    list.push(r);
    map.set(r.task, list);
  }
  return map;
}

function majority(cells: CellResult[]): boolean {
  return cells.filter((c) => c.resolved).length * 2 > cells.length;
}

export function analyze(meta: RunMeta, results: CellResult[]): Analysis {
  const rows: SetupRow[] = [];
  const matrix = new Map<string, Map<string, boolean[]>>();
  for (const id of meta.tasks) matrix.set(id, new Map());

  for (const s of meta.setups) {
    const tasks = byTask(results, s.name);
    const cells = [...tasks.values()].flat();
    for (const [id, list] of tasks) {
      matrix.get(id)?.set(s.name, [...list].sort((x, y) => x.attempt - y.attempt).map((c) => c.resolved));
    }
    const n = tasks.size;
    const solved = [...tasks.values()].filter(majority).length;
    const costs = cells.map((c) => c.usage.costUsd).filter((v): v is number => v !== undefined);
    const durations = cells.map((c) => c.agent.durationMs / 1000).sort((a, b) => a - b);
    const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
    const tokensIn = cells.map((c) => c.usage.inputTokens).filter((v): v is number => v !== undefined);
    const tokensOut = cells.map((c) => c.usage.outputTokens).filter((v): v is number => v !== undefined);
    const resolvedCells = cells.filter((c) => c.resolved).length;
    const row: SetupRow = {
      setup: s.name,
      label: s.label,
      tasks: n,
      cells: cells.length,
      solved,
      ci: wilson(solved, n),
      rate: cells.length ? resolvedCells / cells.length : 0,
      partial: cells.length ? sum(cells.map((c) => (c.grade.failToPass.total ? c.grade.failToPass.passed / c.grade.failToPass.total : 0))) / cells.length : 0,
      costKnown: costs.length,
      medianSec: quantile(durations, 0.5),
      p90Sec: quantile(durations, 0.9),
      reverted: cells.filter((c) => c.reverted.length > 0).length,
      errors: cells.filter((c) => !["resolved", "unresolved"].includes(c.status)).length,
      timeouts: cells.filter((c) => c.agent.timedOut).length,
    };
    if (s.label === undefined) delete row.label;
    if (meta.repeat > 1) {
      const any = [...tasks.values()].filter((l) => l.some((c) => c.resolved)).length;
      const all = [...tasks.values()].filter((l) => l.length === meta.repeat && l.every((c) => c.resolved)).length;
      row.passAtK = { count: any, ci: wilson(any, n) };
      row.passAllK = { count: all, ci: wilson(all, n) };
    }
    if (costs.length > 0) {
      row.costTotal = sum(costs);
      row.costPerTask = row.costTotal / costs.length;
      if (costs.length === cells.length && resolvedCells > 0) row.costPerSolved = row.costTotal / resolvedCells;
    }
    if (tokensIn.length) row.tokensIn = sum(tokensIn) / tokensIn.length;
    if (tokensOut.length) row.tokensOut = sum(tokensOut) / tokensOut.length;
    rows.push(row);
  }

  rows.sort((x, y) => y.solved - x.solved || y.rate - x.rate || (x.costPerTask ?? Infinity) - (y.costPerTask ?? Infinity) || x.setup.localeCompare(y.setup));

  // Paired comparisons on tasks both setups finished. All pairs for small fields, neighbours otherwise.
  const comparisons: Comparison[] = [];
  const pairs: Array<[SetupRow, SetupRow]> = [];
  if (rows.length <= 6) {
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) pairs.push([rows[i] as SetupRow, rows[j] as SetupRow]);
  } else {
    for (let i = 0; i + 1 < rows.length; i++) pairs.push([rows[i] as SetupRow, rows[i + 1] as SetupRow]);
  }
  for (const [ra, rb] of pairs) {
    const a = byTask(results, ra.setup);
    const b = byTask(results, rb.setup);
    let n = 0;
    let onlyA = 0;
    let onlyB = 0;
    for (const [id, la] of a) {
      const lb = b.get(id);
      if (!lb || la.length < meta.repeat || lb.length < meta.repeat) continue;
      n++;
      const sa = majority(la);
      const sb = majority(lb);
      if (sa && !sb) onlyA++;
      if (sb && !sa) onlyB++;
    }
    comparisons.push({ a: ra.setup, b: rb.setup, n, onlyA, onlyB, p: mcnemarExact(onlyA, onlyB) });
  }
  return { rows, comparisons, repeat: meta.repeat, taskCount: meta.tasks.length, matrix };
}

// ---------- formatting ----------

const pct = (x: number): string => `${(x * 100).toFixed(x === 0 || x === 1 ? 0 : 1)}%`;
const ci = (i: Interval): string => `${Math.round(i.low * 100)}–${Math.round(i.high * 100)}%`;
const usd = (x: number | undefined): string => (x === undefined ? "n/a" : x < 0.01 && x > 0 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
const secs = (x: number | undefined): string => {
  if (x === undefined) return "n/a";
  if (x < 60) return `${x.toFixed(x < 10 ? 1 : 0)} s`;
  const m = Math.floor(x / 60);
  return `${m}m ${String(Math.round(x - m * 60)).padStart(2, "0")}s`;
};
const tokens = (x: number | undefined): string => (x === undefined ? "n/a" : x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(0)}k` : String(Math.round(x)));
const pval = (p: number): string => (p < 0.001 ? "< 0.001" : p.toFixed(3));
const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function verdict(c: Comparison): string {
  if (c.onlyA === 0 && c.onlyB === 0) return "same tasks solved";
  if (c.p < 0.05) return c.onlyA > c.onlyB ? `${c.a} solves more` : `${c.b} solves more`;
  return "can't tell apart";
}

function setupName(r: SetupRow): string {
  return r.label ? `${r.setup} (${r.label})` : r.setup;
}

export interface ReportInput {
  meta: RunMeta;
  results: CellResult[];
  tasks: Task[];
  mine?: MineSummary;
  rejections?: Rejection[];
}

export function renderMarkdown(input: ReportInput): string {
  const { meta, results, tasks } = input;
  const a = analyze(meta, results);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const runTasks = meta.tasks.map((id) => taskById.get(id)).filter((t): t is Task => t !== undefined);
  const dates = runTasks.map((t) => t.date.slice(0, 10)).sort();
  const expected = meta.tasks.length * meta.setups.length * meta.repeat;
  const out: string[] = [];

  out.push(`# hometurf report: ${meta.name}`, "");
  out.push(
    `Repository **${meta.repo}**, ${meta.tasks.length} tasks` +
      (dates.length ? ` from commits dated ${dates[0]} to ${dates.at(-1)}` : "") +
      `. ${meta.repeat === 1 ? "One attempt" : `${meta.repeat} attempts`} per task and setup` +
      `${meta.revealTests ? ", with the hidden tests shown to the agent" : ""}. Run on ${meta.platform}, Node ${meta.node}, started ${meta.startedAt}.`,
    "",
  );
  if (results.length < expected) {
    out.push(`> **Incomplete:** ${results.length} of ${expected} attempts finished${meta.maxCostUsd !== undefined ? ` (budget $${meta.maxCostUsd})` : ""}.`, "");
  }

  out.push("## Leaderboard", "");
  const k = meta.repeat;
  const head = ["Setup", "Solved", "95% CI", ...(k > 1 ? [`Mean of ${k}`, `Any of ${k}`, `All ${k}`] : []), "Partial", "Cost / attempt", "Cost / solve", "Median time", "Tokens / attempt (in / out)", "Notes"];
  out.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`);
  for (const r of a.rows) {
    const notes = [
      r.costKnown && r.costKnown < r.cells ? `cost known for ${r.costKnown}/${r.cells}` : "",
      r.reverted ? `${r.reverted} edited tests (discarded)` : "",
      r.errors ? `${r.errors} errors` : "",
      r.timeouts ? `${r.timeouts} timeouts` : "",
    ].filter(Boolean);
    const cells = [
      esc(setupName(r)),
      `${r.solved}/${r.tasks} (${pct(r.tasks ? r.solved / r.tasks : 0)})`,
      ci(r.ci),
      ...(k > 1 && r.passAtK && r.passAllK ? [pct(r.rate), `${r.passAtK.count}/${r.tasks}`, `${r.passAllK.count}/${r.tasks}`] : []),
      pct(r.partial),
      usd(r.costPerTask),
      usd(r.costPerSolved),
      secs(r.medianSec),
      `${tokens(r.tokensIn)} / ${tokens(r.tokensOut)}`,
      notes.join("; "),
    ];
    out.push(`| ${cells.join(" | ")} |`);
  }
  out.push("");
  out.push(
    `*Solved* counts tasks where every fail-to-pass and pass-to-pass test passed${k > 1 ? ` in more than half of the ${k} attempts` : ""}. ` +
      `*95% CI* is a Wilson score interval over tasks. With ${a.taskCount} tasks, an interval can be up to ±${worstCaseHalfWidth(a.taskCount).toFixed(0)} points wide. ` +
      `*Partial* is the mean share of fail-to-pass tests that passed. Cost is what each agent reported; "n/a" means it reported nothing.`,
    "",
  );

  if (a.comparisons.length) {
    out.push("## Can the setups be told apart?", "");
    out.push(
      "Exact McNemar test on tasks both setups finished: it looks only at the tasks one setup solved and the other didn't. p-values are not corrected for multiple comparisons.",
      "",
    );
    out.push("| A | B | Tasks | Only A solved | Only B solved | p | Verdict |", "|---|---|---|---|---|---|---|");
    for (const c of a.comparisons) {
      out.push(`| ${esc(c.a)} | ${esc(c.b)} | ${c.n} | ${c.onlyA} | ${c.onlyB} | ${pval(c.p)} | ${verdict(c)} |`);
    }
    out.push("");
  }

  out.push("## Tasks", "");
  const setupNames = a.rows.map((r) => r.setup);
  out.push(`| Task | Date | Fix | Tests (F2P / P2P) | ${setupNames.map(esc).join(" | ")} |`, `|---|---|---|---|${setupNames.map(() => "---").join("|")}|`);
  for (const id of meta.tasks) {
    const t = taskById.get(id);
    const row = a.matrix.get(id) ?? new Map<string, boolean[]>();
    const marks = setupNames.map((s) => {
      const flags = row.get(s);
      if (!flags || flags.length === 0) return "·";
      if (k === 1) return flags[0] ? "✅" : "❌";
      return `${flags.filter(Boolean).length}/${flags.length}`;
    });
    const subject = t ? esc(t.subject.length > 70 ? `${t.subject.slice(0, 69)}…` : t.subject) : "";
    const fix = t ? `+${t.goldStats.added} −${t.goldStats.removed} in ${t.goldStats.files} file${t.goldStats.files === 1 ? "" : "s"}` : "";
    out.push(`| \`${id}\` ${subject} | ${t?.date.slice(0, 10) ?? ""} | ${fix} | ${t ? `${t.failToPass.length} / ${t.passToPass.length}` : ""} | ${marks.join(" | ")} |`);
  }
  out.push("", "✅ solved · ❌ not solved · `·` not run", "");

  if (input.mine || (input.rejections && input.rejections.length)) {
    out.push("## How the tasks were mined", "");
    const m = input.mine;
    if (m) {
      out.push(`Scanned ${m.scanned} first-parent commits of \`${m.ref}\` (${m.head.slice(0, 10)})${m.since ? ` since ${m.since}` : ""}; ${m.candidates} became candidates.`, "");
      const skipped = Object.entries(m.skipped).sort((x, y) => y[1] - x[1]);
      if (skipped.length) {
        out.push("| Skipped because the commit... | Commits |", "|---|---|");
        for (const [reason, n] of skipped) out.push(`| ${SKIP_REASONS[reason as keyof typeof SKIP_REASONS] ?? reason} | ${n} |`);
        out.push("");
      }
    }
    const rej = input.rejections ?? [];
    out.push(`Validation kept ${tasks.length} task${tasks.length === 1 ? "" : "s"} and rejected ${rej.length} candidate${rej.length === 1 ? "" : "s"}.`, "");
    if (rej.length) {
      const counts = new Map<string, number>();
      for (const r of rej) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
      out.push("| Rejected because... | Candidates |", "|---|---|");
      for (const [reason, n] of [...counts].sort((x, y) => y[1] - x[1])) {
        out.push(`| ${REJECT_REASONS[reason as keyof typeof REJECT_REASONS] ?? reason} | ${n} |`);
      }
      out.push("");
    }
  }

  const problems = results.filter((r) => r.reverted.length > 0 || r.agent.timedOut || !["resolved", "unresolved"].includes(r.status));
  if (problems.length) {
    out.push("## Attempts worth a look", "");
    for (const r of problems.sort((x, y) => x.setup.localeCompare(y.setup) || x.task.localeCompare(y.task))) {
      const what = [
        r.agent.timedOut ? "timed out; whatever it had changed was graded" : "",
        r.reverted.length ? `edited test-side files, discarded before grading: ${r.reverted.slice(0, 5).map((p) => `\`${p}\``).join(", ")}` : "",
        !["resolved", "unresolved"].includes(r.status) ? `${r.status}${r.error ? `: ${esc(r.error.split("\n")[0] ?? "").slice(0, 160)}` : ""}` : "",
      ].filter(Boolean);
      out.push(`- **${esc(r.setup)}** on \`${r.task}\` (attempt ${r.attempt}): ${what.join("; ")}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/** A compact leaderboard for the terminal. */
export function renderText(meta: RunMeta, results: CellResult[]): string {
  const a = analyze(meta, results);
  const rows = [["setup", "solved", "95% CI", "partial", "cost/attempt", "median time"]];
  for (const r of a.rows) {
    rows.push([setupName(r), `${r.solved}/${r.tasks}`, ci(r.ci), pct(r.partial), usd(r.costPerTask), secs(r.medianSec)]);
  }
  const widths = (rows[0] as string[]).map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  const lines = rows.map((r) => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd());
  for (const c of a.comparisons) {
    const p = c.p < 0.001 ? "p < 0.001" : `p = ${c.p.toFixed(3)}`;
    lines.push(`${c.a} vs ${c.b}: only ${c.a} solved ${c.onlyA}, only ${c.b} solved ${c.onlyB}, McNemar ${p} (${verdict(c)})`);
  }
  return lines.join("\n");
}

/** Tasks where a calibration agent misbehaved: the oracle didn't solve it, or the no-op agent did. */
export function calibrationProblems(results: CellResult[], oracle = "oracle", noop = "noop") {
  return {
    oracleFailed: results.filter((r) => r.setup === oracle && !r.resolved),
    noopSolved: results.filter((r) => r.setup === noop && r.resolved),
  };
}
