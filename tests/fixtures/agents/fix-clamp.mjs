// Scripted agent: fixes the fixture's clamp bug if it is there, reports a made-up cost, and exits.
import fs from "node:fs";

const file = "src/lib.js";
const text = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, text.replace("if (x > hi) return lo;", "if (x > hi) return hi;"));
fs.writeFileSync(process.env.HOMETURF_USAGE_FILE, JSON.stringify({ costUsd: 0.05, inputTokens: 1200, outputTokens: 300, turns: 2 }));
