import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewEnv, runAgentReview } from "../src/mcp-runner.js";

test("buildReviewEnv maps PR context without leaking stale branch selectors", () => {
  const env = buildReviewEnv(
    { repo: "owner/repo", prNumber: 42 },
    { OPENAI_API_KEY: "x", GITHUB_BASE: "stale-base", GITHUB_HEAD: "stale-head" }
  );
  assert.equal(env.GITHUB_REPO, "owner/repo");
  assert.equal(env.GITHUB_PR_NUMBER, "42");
  assert.equal(env.GITHUB_BASE, undefined);
  assert.equal(env.GITHUB_HEAD, undefined);
  assert.equal(env.OPENAI_API_KEY, "x");
});

test("buildReviewEnv maps branch comparison context", () => {
  const env = buildReviewEnv({ repo: "owner/repo", base: "main", head: "feature" }, {});
  assert.equal(env.GITHUB_REPO, "owner/repo");
  assert.equal(env.GITHUB_BASE, "main");
  assert.equal(env.GITHUB_HEAD, "feature");
  assert.equal(env.GITHUB_PR_NUMBER, undefined);
});

function timeoutError() {
  return Object.assign(new Error("process timed out"), {
    code: "ETIMEDOUT",
    killed: true,
    signal: "SIGTERM"
  });
}

test("MCP deadline converts a killed child and checkpoint into structured JSON", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fishcrm-mcp-test-"));
  const progressFile = join(directory, "progress.json");
  writeFileSync(progressFile, JSON.stringify({
    chunks_reviewed: 2,
    chunks_total: 5,
    events: [
      { type: "provider_started", provider: "OpenAI", chunk: 3, round: 2, timestamp: new Date().toISOString() }
    ],
    partial_result: {
      chunkResults: [{ chunk: 1 }, { chunk: 2 }],
      mandatory_completed: 2,
      chunks_total: 5,
      coverage_complete: false,
      elapsed_ms: 1234,
      last_provider: "OpenAI",
      last_chunk: 3,
      last_round: 2
    }
  }));
  try {
    const result = await runAgentReview({ task: "review" }, {
      deadlineMs: 50,
      progressFile,
      execFile: (_file, _args, _options, callback) => callback(timeoutError(), "", "")
    });
    assert.equal(result.final_status, "TIMEOUT");
    assert.equal(result.ready_to_merge, false);
    assert.equal(result.error.code, "MCP_REVIEW_TIMEOUT");
    assert.equal(result.last_provider, "OpenAI");
    assert.equal(result.last_chunk, 3);
    assert.equal(result.last_round, 2);
    assert.deepEqual(result.executed_chunks, [1, 2]);
    assert.equal(result.coverage_complete, false);
    assert.ok(Array.isArray(result.events));
    assert.equal(JSON.parse(JSON.stringify(result)).ready_to_merge, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("successful MCP child output keeps the legacy structured result", async () => {
  const result = await runAgentReview({ task: "review" }, {
    deadlineMs: 50,
    execFile: (_file, _args, _options, callback) => callback(null, JSON.stringify({
      final_status: "CONSENSUS",
      decision: { status: "agree", ready_to_merge: true }
    }), "")
  });
  assert.equal(result.final_status, "CONSENSUS");
  assert.equal(result.decision.ready_to_merge, true);
});
