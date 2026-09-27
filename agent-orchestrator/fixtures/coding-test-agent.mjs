import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const mode = process.env.TEST_AGENT_MODE || "write";
const delayMs = Number(process.env.TEST_AGENT_DELAY_MS || 0);
const allowed = JSON.parse(process.env.ORCHESTRATION_ALLOWED_FILES || "[]");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));

if (mode === "empty") process.exit(0);
const target = mode === "outside" ? join(process.cwd(), "..", "outside.txt") : join(process.cwd(), allowed[0]);
await writeFile(target, `test-agent cwd=${process.cwd()}\n${prompt.match(/^Task:.*$/m)?.[0] || "task"}\n`, "utf8");
process.stdout.write(`changed ${target.slice(dirname(process.cwd()).length)}\n`);
