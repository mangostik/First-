import { askClaude } from "./providers/claude.js";
import { askOpenAI } from "./providers/openai.js";
import { isConsensus, RESPONSE_SCHEMA_HINT } from "./protocol.js";

const env = process.env;
const config = {
  openaiApiKey: env.OPENAI_API_KEY,
  openaiModel: env.OPENAI_MODEL,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  anthropicModel: env.ANTHROPIC_MODEL,
  maxRounds: Number(env.MAX_ROUNDS || 3),
  maxOutputTokens: Number(env.MAX_OUTPUT_TOKENS || 1800),
  timeoutMs: Number(env.REQUEST_TIMEOUT_MS || 120000)
};

function readTaskFromArgs() {
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) throw new Error('Pass a task, e.g. npm start -- "Check stock calculation logic"');
  return task;
}

function jsonRule() {
  return [
    "Return ONLY valid JSON with this shape:",
    JSON.stringify(RESPONSE_SCHEMA_HINT, null, 2),
    "",
    "Rules:",
    "- critical_issues: only concrete high-impact problems.",
    "- recommended_changes: concise, actionable items.",
    "- ready_to_merge=true only if you believe the proposed direction is safe enough to proceed.",
    "- blocked is allowed only for an objective technical blocker; put proof in evidence."
  ].join("\n");
}

function claudePrompt({ task, round, openaiReview }) {
  return [
    "You are Claude acting as the implementation engineer.",
    "Task:", task, "",
    "Round: " + round, "",
    "OpenAI reviewer feedback from the previous round:",
    openaiReview ? JSON.stringify(openaiReview, null, 2) : "None yet.", "",
    "Your job:",
    "1. Propose or refine the implementation direction.",
    "2. Address every concrete reviewer issue.",
    "3. Do not claim agreement just to end the discussion.",
    "4. If something is objectively impossible, use status=blocked and provide evidence.",
    "", jsonRule()
  ].join("\n");
}

function openaiPrompt({ task, round, claudeResponse }) {
  return [
    "You are OpenAI acting as reviewer, architect, and final arbiter.",
    "Task:", task, "",
    "Round: " + round, "",
    "Claude implementation-engineer response:",
    JSON.stringify(claudeResponse, null, 2), "",
    "Your job:",
    "1. Review for correctness, architecture, regressions, security, and practical maintainability.",
    "2. Distinguish critical problems from preferences.",
    "3. If Claude direction is safe, agree.",
    "4. If not, give the smallest concrete set of changes required.",
    "5. You are the arbiter if the maximum round limit is reached.",
    "", jsonRule()
  ].join("\n");
}

async function main() {
  const task = readTaskFromArgs();
  let lastOpenAI = null;
  const transcript = [];

  for (let round = 1; round <= config.maxRounds; round++) {
    const claude = await askClaude({
      apiKey: config.anthropicApiKey,
      model: config.anthropicModel,
      prompt: claudePrompt({ task, round, openaiReview: lastOpenAI }),
      maxOutputTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs
    });

    const openai = await askOpenAI({
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      prompt: openaiPrompt({ task, round, claudeResponse: claude }),
      maxOutputTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs
    });

    transcript.push({ round, claude, openai });

    if (isConsensus(claude, openai)) {
      process.stdout.write(JSON.stringify({ final_status: "CONSENSUS", rounds: round, decision: openai, transcript }, null, 2) + "\n");
      return;
    }

    if (claude.status === "blocked") {
      process.stdout.write(JSON.stringify({ final_status: "BLOCKED", rounds: round, decision: claude, transcript }, null, 2) + "\n");
      return;
    }

    lastOpenAI = openai;
  }

  process.stdout.write(JSON.stringify({ final_status: "FINAL_DECISION", rounds: config.maxRounds, decision: lastOpenAI, transcript }, null, 2) + "\n");
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
