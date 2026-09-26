import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { failureResult } from "./review-result.js";

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

  const requestedTimeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const deadlineMs = options.deadlineMs ?? Number(process.env.MCP_REVIEW_DEADLINE_MS || 240000);
  const timeoutMs = Math.min(requestedTimeoutMs, deadlineMs);
  const maxBuffer = options.maxBuffer ?? 5 * 1024 * 1024;
  const ownsProgressFile = !options.progressFile;
  const progressFile = options.progressFile || join(tmpdir(), `fishcrm-review-${randomUUID()}.json`);
  const env = buildReviewEnv(input, { ...(options.env || process.env), REVIEW_PROGRESS_FILE: progressFile });
  const execute = options.execFile || execFile;

  const readProgress = () => {
    try {
      if (!existsSync(progressFile)) return null;
      return JSON.parse(readFileSync(progressFile, "utf8"));
    } catch {
      return null;
    }
  };

  const cleanup = () => {
    if (ownsProgressFile) {
      try { unlinkSync(progressFile); } catch {}
    }
  };

  return new Promise((resolve, reject) => {
    execute(
      process.execPath,
      [options.orchestratorPath || orchestratorPath, task],
      { env, timeout: timeoutMs, maxBuffer, signal: options.signal },
      (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.code === "ETIMEDOUT" || error.killed === true || error.signal === "SIGTERM";
          const cancelled = options.signal?.aborted;
          if (timedOut || cancelled) {
            const cause = new Error(cancelled ? "Agent review cancelled" : `Agent review MCP deadline exceeded after ${timeoutMs}ms`);
            cause.code = cancelled ? "MCP_REVIEW_CANCELLED" : "MCP_REVIEW_TIMEOUT";
            const progress = readProgress();
            const result = failureResult(cause, {
              partial: progress?.partial_result || progress,
              events: progress?.events || [],
              chunksReviewed: progress?.chunks_reviewed || 0,
              chunksTotal: progress?.chunks_total || 0
            });
            cleanup();
            resolve(result);
            return;
          }
          const wrapped = new Error(
            "Agent orchestrator failed: " +
            (stderr.trim() || error.message)
          );
          wrapped.cause = error;
          cleanup();
          reject(wrapped);
          return;
        }

        let result;
        try {
          result = JSON.parse(stdout);
        } catch (parseError) {
          cleanup();
          reject(new Error("Agent orchestrator returned invalid JSON: " + parseError.message));
          return;
        }

        cleanup();
        resolve(result);
      }
    );
  });
}
