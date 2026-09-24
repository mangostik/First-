import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const orchestratorPath = join(here, "index.js");

export function buildReviewEnv(input = {}, baseEnv = process.env) {
  const env = { ...baseEnv };

  const optional = {
    GITHUB_REPO: input.repo,
    GITHUB_PR_NUMBER: input.prNumber == null ? undefined : String(input.prNumber),
    GITHUB_BASE: input.base,
    GITHUB_HEAD: input.head
  };

  for (const [key, value] of Object.entries(optional)) {
    if (value === undefined || value === null || String(value).trim() === "") {
      delete env[key];
    } else {
      env[key] = String(value);
    }
  }

  return env;
}

export function runAgentReview(input, options = {}) {
  const task = String(input?.task || "").trim();
  if (!task) throw new Error("task is required");

  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const maxBuffer = options.maxBuffer ?? 5 * 1024 * 1024;
  const env = buildReviewEnv(input, options.env || process.env);

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [orchestratorPath, task],
      { env, timeout: timeoutMs, maxBuffer },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error(
            "Agent orchestrator failed: " +
            (stderr.trim() || error.message)
          );
          wrapped.cause = error;
          reject(wrapped);
          return;
        }

        let result;
        try {
          result = JSON.parse(stdout);
        } catch (parseError) {
          reject(new Error("Agent orchestrator returned invalid JSON: " + parseError.message));
          return;
        }

        resolve(result);
      }
    );
  });
}
