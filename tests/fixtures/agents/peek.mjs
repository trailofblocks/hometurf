// Scripted agent that looks around: what does the workspace's git history show, and what was the prompt?
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const git = (...args) => spawnSync("git", args, { encoding: "utf8" });
const prompt = fs.readFileSync(0, "utf8");
const report = {
  commits: git("rev-list", "--all", "--count").stdout.trim(),
  remotes: git("remote").stdout.trim(),
  fixReachable: process.env.PEEK_FIX ? git("cat-file", "-e", `${process.env.PEEK_FIX}^{commit}`).status === 0 : null,
  status: git("status", "--porcelain").stdout,
  prompt,
  promptFileMatches: fs.readFileSync(process.env.HOMETURF_PROMPT_FILE, "utf8") === prompt,
  files: fs.readdirSync("."),
  claudeMd: fs.existsSync("CLAUDE.md") ? fs.readFileSync("CLAUDE.md", "utf8") : null,
};
fs.writeFileSync(process.env.PEEK_OUT, JSON.stringify(report, null, 2));
// Claude Code-style result line, to exercise the claude-code usage parser.
console.log("some log line");
console.log(JSON.stringify({ type: "result", total_cost_usd: 0.25, num_turns: 4, usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 50 } }));
