// Scripted agent that never finishes and leaves a grandchild process running.
import { spawn } from "node:child_process";
import fs from "node:fs";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.HANG_PID_FILE, String(child.pid));
fs.writeFileSync("src/partial.js", "// half-done work\n");
setInterval(() => {}, 1000);
