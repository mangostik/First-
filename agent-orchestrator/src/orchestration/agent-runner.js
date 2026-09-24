import { getAgentDefinition } from "./agent-registry.js";
import { runAgentReview } from "../mcp-runner.js";

export const AGENT_RUNNER_MODES = Object.freeze(["mock", "real"]);

export function createMockAgentRunner(options = {}) {
  const delayMs = Number(options.delayMs || 0);
  const failuresBeforeSuccess = options.failuresBeforeSuccess || {};

  return async ({ subtask, attempt, signal }) => {
    getAgentDefinition(subtask.role);
    if (signal?.aborted) throw new Error("cancelled");
    if (delayMs > 0) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      }, { once: true });
    });
    const failCount = Number(failuresBeforeSuccess[subtask.id] || 0);
    if (attempt <= failCount) throw new Error(`mock failure for ${subtask.id}`);
    return {
      status: "completed",
      summary: `${subtask.role} mock completed`,
      changed_files: [],
      tests: subtask.role === "qa" ? ["mock QA checks passed"] : [],
      warnings: ["Mock agent: no source files were changed."],
      error: null
    };
  };
}

export function createMockAgentAdapter(options = {}) {
  return { mode: "mock", run: createMockAgentRunner(options) };
}

export function createRealAgentAdapter({ review = runAgentReview } = {}) {
  return {
    mode: "real",
    async run({ subtask, signal }) {
      if (signal?.aborted) throw new Error("cancelled");
      const result = await review(
        { task: subtask.instructions },
        { signal }
      );
      const blocked = result.final_status === "BLOCKED" || result.decision?.status === "blocked";
      return {
        status: blocked ? "failed" : "completed",
        summary: result.decision?.status || result.final_status || "real review completed",
        changed_files: [],
        tests: [],
        warnings: [
          ...(result.decision?.critical_issues || []),
          ...(result.decision?.recommended_changes || [])
        ].map(String),
        error: blocked ? "real review blocked" : null
      };
    }
  };
}

export function getAgentRunnerMode(env = process.env) {
  const mode = String(env.ORCHESTRATION_AGENT_MODE || "mock").trim().toLowerCase();
  if (!AGENT_RUNNER_MODES.includes(mode)) {
    throw new Error(`Invalid ORCHESTRATION_AGENT_MODE: ${mode}`);
  }
  return mode;
}

export function createConfiguredAgentRunner({ env = process.env, mockOptions = {}, realOptions = {} } = {}) {
  return getAgentRunnerMode(env) === "real"
    ? createRealAgentAdapter(realOptions)
    : createMockAgentAdapter(mockOptions);
}
