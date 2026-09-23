import { askClaude } from "./providers/claude.js";
import { askOpenAI } from "./providers/openai.js";
import { fetchGitHubDiff } from "./github.js";
import { isConsensus, RESPONSE_SCHEMA_HINT } from "./protocol.js";

const env = process.env;
const config = {
  openaiApiKey: env.OPENAI_API_KEY,
  openaiModel: env.OPENAI_MODEL,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  anthropicModel: env.ANTHROPIC_MODEL,
  githubToken: env.GITHUB_TOKEN || "",
  githubRepo: env.GITHUB_REPO || "",
  githubBase: env.GITHUB_BASE || "",
  githubHead: env.GITHUB_HEAD || "",
  maxRounds: Number(env.MAX_ROUNDS || 3),
  maxOutputTokens: Number(env.MAX_OUTPUT_TOKENS || 1800),
  timeoutMs: Number(env.REQUEST_TIMEOUT_MS || 120000),
  maxDiffChars: Number(env.MAX_DIFF_CHARS || 20000)
};

function readTaskFromArgs() {
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) throw new Error('Pass a task, e.g. npm start -- "Review this GitHub diff"');
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

function withDiff(task, diff) {
  if (!diff) return task;
  return [task, "", "GitHub diff to review:", diff].join("\n");
}

function claudePrompt({ task, diff, round, openaiReview }) {
  return [
    "You are Claude acting as the implementation engineer.",
    "Task and code context:",
    withDiff(task, diff), "",
    "Round: " + round, "",
    "OpenAI reviewer feedback from the previous round:",
    openaiReview ? JSON.stringify(openaiReview, null, 2) : "None yet.", "",
    "Your job:",
    "1. Analyze the actual diff when present.",
    "2. Propose or refine the implementation direction.",
    "3. Address every concrete reviewer issue.",
    "4. Do not claim agreement just to end the discussion.",
    "5. If something is objectively impossible, use status=blocked and provide evidence.",
    "", jsonRule()
  ].join("\n");
}

function openaiPrompt({ task, diff, round, claudeResponse }) {
  return [
    "You are OpenAI acting as reviewer, architect, and final arbiter.",
    "Task and code context:",
    withDiff(task, diff), "",
    "Round: " + round, "",
    "Claude implementation-engineer response:",
    JSON.stringify(claudeResponse, null, 2), "",
    "Your job:",
    "1. Review the actual diff when present for correctness, architecture, regressions, security, and maintainability.",
    "2. Distinguish critical problems from preferences.",
    "3. If Claude direction is safe, agree.",
    "4. If not, give the smallest concrete set of changes required.",
    "5. You are the arbiter if the maximum round limit is reached.",
    "", jsonRule()
  ].join("\n");
}

async function loadOptionalDiff() {
  const configured = config.githubRepo && config.githubBase && config.githubHead;
  if (!configured) return "";

  const raw = await fetchGitHubDiff({
    repo: config.githubRepo,
    base: config.githubBase,
    head: config.githubHead,
    token: config.githubToken,
    timeoutMs: config.timeoutMs
  });

  if (raw.length <= config.maxDiffChars) return raw;
  const error = new Error("Diff exceeds MAX_DIFF_CHARS limit");
  error.code = "DIFF_TOO_LARGE";
  error.diffSize = raw.length;
  error.limit = config.maxDiffChars;
  throw error;
}

async function main() {
  const task = readTaskFromArgs();
  let diff = "";
  try {
    diff = await loadOptionalDiff();
  } catch (error) {
    if (error && error.code === "DIFF_TOO_LARGE") {
      process.stdout.write(JSON.stringify({
        final_status: "BLOCKED",
        reason: "diff_too_large",
        diff_size: error.diffSize,
        limit: error.limit,
        decision: {
          status: "blocked",
          critical_issues: ["GitHub diff exceeds MAX_DIFF_CHARS and cannot be fully reviewed safely."],
          recommended_changes: ["Increase MAX_DIFF_CHARS or reduce/split the diff before review."],
          ready_to_merge: false,
          evidence: ["Review stopped before any agent call because the complete diff was not available."]
        },
        transcript: []
      }, null, 2) + "\n");
      return;
    }
    throw error;
  }
  let lastOpenAI = null;
  const transcript = [];

  for (let round = 1; round <= config.maxRounds; round++) {
    const claude = await askClaude({
      apiKey: config.anthropicApiKey,
      model: config.anthropicModel,
      prompt: claudePrompt({ task, diff, round, openaiReview: lastOpenAI }),
      maxOutputTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs
    });

    const openai = await askOpenAI({
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      prompt: openaiPrompt({ task, diff, round, claudeResponse: claude }),
      maxOutputTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs
    });

    transcript.push({ round, claude, openai });

    if (isConsensus(claude, openai)) {
      process.stdout.write(JSON.stringify({ final_status: "CONSENSUS", rounds: round, decision: openai, diff_loaded: Boolean(diff), transcript }, null, 2) + "\n");
      return;
    }

    if (claude.status === "blocked") {
      process.stdout.write(JSON.stringify({ final_status: "BLOCKED", rounds: round, decision: claude, diff_loaded: Boolean(diff), transcript }, null, 2) + "\n");
      return;
    }

    lastOpenAI = openai;
  }

  process.stdout.write(JSON.stringify({ final_status: "FINAL_DECISION", rounds: config.maxRounds, decision: lastOpenAI, diff_loaded: Boolean(diff), transcript }, null, 2) + "\n");
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
