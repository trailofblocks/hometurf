import fs from "node:fs";
import path from "node:path";
import type { Task } from "./bench.js";
import type { Config, Setup } from "./config.js";
import { applyPatch } from "./git.js";
import { childEnv } from "./testrun.js";
import { firstHunk } from "./util/patch.js";
import { runShell } from "./util/proc.js";

export interface Usage {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  turns?: number;
}

export interface AgentRun {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  error?: string;
  usage: Usage;
}

export const DEFAULT_PROMPT = `You are working in a git repository checked out in the current directory.

Resolve the issue below by changing the repository's code.

<issue>
{{description}}
</issue>

Hidden tests will check your change when you finish. Changes to test files are discarded before grading.
`;

export function renderPrompt(cfg: Config, setup: Setup, task: Task): string {
  const template = setup.prompt ? fs.readFileSync(path.resolve(cfg.benchDir, setup.prompt), "utf8") : DEFAULT_PROMPT;
  return template.replace(/\{\{\s*description\s*\}\}/g, () => task.description).replace(/\{\{\s*task\s*\}\}/g, () => task.id);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clean(u: Usage): Usage {
  return Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)) as Usage;
}

/**
 * Usage from Claude Code's `--output-format json` (one result object) or `stream-json` (the
 * last `"type":"result"` line). The cost is Claude Code's own estimate.
 */
export function parseClaudeCodeUsage(stdout: string): Usage {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  const candidates = [stdout.trim(), ...lines];
  for (const text of candidates) {
    if (!text.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== undefined && obj.type !== "result") continue;
    if (obj.total_cost_usd === undefined && obj.usage === undefined) continue;
    const usage = (obj.usage ?? {}) as Record<string, unknown>;
    const input = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens]
      .map(num)
      .filter((n): n is number => n !== undefined);
    return clean({
      costUsd: num(obj.total_cost_usd),
      inputTokens: input.length ? input.reduce((a, b) => a + b, 0) : undefined,
      outputTokens: num(usage.output_tokens),
      turns: num(obj.num_turns),
    });
  }
  return {};
}

/** Usage an agent wrote to $HOMETURF_USAGE_FILE: `{"costUsd": 0.12, "inputTokens": 1000, "outputTokens": 200, "turns": 3}`. */
export function readUsageFile(file: string): Usage {
  if (!fs.existsSync(file)) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
    return clean({ costUsd: num(obj.costUsd), inputTokens: num(obj.inputTokens), outputTokens: num(obj.outputTokens), turns: num(obj.turns) });
  } catch {
    return {};
  }
}

export interface AgentContext {
  cfg: Config;
  setup: Setup;
  task: Task;
  workspace: string;
  prompt: string;
  /** Private scratch folder outside the workspace for the prompt and usage files. */
  scratch: string;
  /** Where stdout and stderr are logged. */
  logDir: string;
}

/** Run one setup on one task in a prepared workspace. */
export async function runAgent(a: AgentContext): Promise<AgentRun> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const { setup, task } = a;
  if (setup.builtin) {
    const patch = setup.builtin === "oracle" ? task.goldPatch : setup.builtin === "gold-first-hunk" ? firstHunk(task.goldPatch) : "";
    const applied = applyPatch(a.workspace, patch);
    return { exitCode: applied.ok ? 0 : 1, timedOut: false, durationMs: elapsed(), usage: {}, ...(applied.ok ? {} : { error: applied.error }) };
  }

  const promptFile = path.join(a.scratch, "prompt.md");
  const usageFile = path.join(a.scratch, "usage.json");
  fs.writeFileSync(promptFile, a.prompt);
  const timeoutSec = setup.timeoutSec ?? a.cfg.agentTimeoutSec;
  const r = await runShell(setup.command as string, {
    cwd: a.workspace,
    env: childEnv({
      ...setup.env,
      HOMETURF_TASK_ID: task.id,
      HOMETURF_PROMPT_FILE: promptFile,
      HOMETURF_USAGE_FILE: usageFile,
      HOMETURF_WORKSPACE: a.workspace,
    }),
    input: a.prompt,
    timeoutMs: timeoutSec * 1000,
    stdoutFile: path.join(a.logDir, "agent.stdout.log"),
    stderrFile: path.join(a.logDir, "agent.stderr.log"),
  });
  const usage = setup.usage === "claude-code" ? parseClaudeCodeUsage(r.stdout) : setup.usage === "file" ? readUsageFile(usageFile) : {};
  if (fs.existsSync(usageFile)) fs.copyFileSync(usageFile, path.join(a.logDir, "usage.json"));
  const run: AgentRun = { exitCode: r.code, timedOut: r.timedOut, durationMs: r.durationMs, usage };
  if (r.timedOut) run.error = `agent timed out after ${timeoutSec}s`;
  return run;
}
