import test from "node:test";
import assert from "node:assert/strict";
import { askOpenAI } from "../src/providers/openai.js";
import { failureResult } from "../src/review-result.js";
import { runProviderReviewLoop } from "../src/review-loop.js";

const approved = { status: "agree", critical_issues: [], recommended_changes: [], ready_to_merge: true, evidence: [] };
const finding = { status: "needs_changes", critical_issues: ["Concrete regression"], recommended_changes: ["Fix regression"], ready_to_merge: false, evidence: ["file:1"] };
const config = overrides => ({
  reviewMode: "standard", totalChunks: 3, maxRounds: 1, maxProviderCalls: 40,
  maxOutputTokens: 100, estimatedCostPer1kTokensUsd: 0.01, costBudgetUsd: 0.5,
  claudeTimeoutMs: 100, openaiTimeoutMs: 100, reviewLoopTimeoutMs: 5000,
  openaiApiKey: "mock", openaiModel: "mock",
  providerMaxRetries: 0, structuredMaxRetries: 1, ...overrides
});
const params = overrides => ({
  task: "review", chunks: ["one", "two", "three"], config: config(),
  promptBuilders: { claude: ({ diff }) => diff, openai: ({ diff }) => diff },
  synthesize: async () => approved, isConsensus: () => true, emit: () => {},
  askClaudeFn: async () => finding, askOpenAIFn: async () => approved,
  ...overrides
});

test("provider error preserves completed chunks, pending finding, partial aggregate and metrics", async () => {
  const checkpoints = [];
  let confirmations = 0;
  await assert.rejects(() => runProviderReviewLoop(params({
    onProgress: state => checkpoints.push(state),
    askOpenAIFn: async () => {
      confirmations += 1;
      if (confirmations === 3) throw Object.assign(new Error("incomplete output"), { code: "OPENAI_INCOMPLETE_OUTPUT" });
      return confirmations === 1 ? finding : approved;
    }
  })), error => {
    const result = JSON.parse(JSON.stringify(failureResult(error)));
    assert.equal(result.final_status, "FAILED");
    assert.equal(result.ready_to_merge, false);
    assert.equal(result.coverage_complete, false);
    assert.equal(result.chunks_reviewed, 2);
    assert.equal(result.chunks_total, 3);
    assert.deepEqual(result.executed_chunks, [1, 2]);
    assert.equal(result.last_provider, "OpenAI");
    assert.equal(result.last_chunk, 3);
    assert.equal(result.last_round, 1);
    assert.equal(result.partial_result.pending_chunk.chunk, 3);
    assert.deepEqual(result.partial_result.pending_chunk.claude.critical_issues, ["Concrete regression"]);
    assert.equal(result.partial_aggregate.final_status, "BLOCKED");
    assert.equal(result.partial_aggregate.decision.ready_to_merge, false);
    assert.deepEqual(result.partial_aggregate.decision.critical_issues, ["Concrete regression"]);
    assert.equal(result.usage.provider_calls, 6);
    assert.ok(checkpoints.some(state => state.chunkResults.length === 2));
    return true;
  });
});

test("standard covers all chunks with Claude before targeted OpenAI confirmations", async () => {
  const calls = [];
  const result = await runProviderReviewLoop(params({
    askClaudeFn: async ({ prompt }) => { calls.push(`Claude:${prompt}`); return prompt === "two" ? finding : approved; },
    askOpenAIFn: async ({ prompt }) => { calls.push(`OpenAI:${prompt}`); return approved; }
  }));
  assert.deepEqual(calls, ["Claude:one", "Claude:two", "Claude:three", "OpenAI:two"]);
  assert.equal(result.coverageComplete, true);
  assert.deepEqual(result.chunkResults.map(item => item.chunk), [1, 2, 3]);
  assert.equal(result.usage.provider_calls, 4);
});

test("timeout and abort retain partial coverage without approving it", async () => {
  for (const code of ["PROVIDER_TIMEOUT", "PROVIDER_ABORTED"]) {
    await assert.rejects(() => runProviderReviewLoop(params({
      askClaudeFn: async ({ prompt }) => {
        if (prompt === "three") throw Object.assign(new Error("stopped"), { code });
        return approved;
      }
    })), error => {
      const result = failureResult(error);
      assert.equal(result.final_status, code === "PROVIDER_TIMEOUT" ? "TIMEOUT" : "CANCELLED");
      assert.equal(result.ready_to_merge, false);
      assert.deepEqual(result.executed_chunks, [1, 2]);
      assert.equal(result.chunks_reviewed, 2);
      assert.equal(result.chunks_total, 3);
      return true;
    });
  }
});

test("OpenAI incomplete response retries with compact prompt and low reasoning effort", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const result = requests.length === 1
      ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
      : { status: "completed", output_text: JSON.stringify(approved) };
    return new Response(JSON.stringify(result), { status: 200 });
  };
  try {
    const attempts = [];
    const result = await askOpenAI({ apiKey: "mock", model: "mock", prompt: "Check this diff", maxOutputTokens: 1200, timeoutMs: 100,
      maxRetries: 0, maxStructuredRetries: 1, reasoningEffort: "low", onAttempt: value => attempts.push(value.maxOutputTokens) });
    assert.deepEqual(result, approved);
    assert.deepEqual(attempts, [1200, 2400]);
    assert.equal(requests[0].reasoning.effort, "low");
    assert.match(requests[1].input, /FORMAT RECOVERY/);
  } finally { globalThis.fetch = originalFetch; }
});

test("structured retry cannot exceed call budget and keeps the original partial result", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async url => {
    if (String(url).includes("openai")) {
      networkCalls += 1;
      return new Response(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), { status: 200 });
    }
    throw new Error("Unexpected network call");
  };
  try {
    await assert.rejects(() => runProviderReviewLoop(params({
      chunks: ["one"], config: config({ totalChunks: 1, maxProviderCalls: 2 }),
      askClaudeFn: async () => finding,
      askOpenAIFn: askOpenAI
    })), error => {
      const result = failureResult(error);
      assert.equal(result.final_status, "COST_LIMIT");
      assert.equal(result.usage.provider_calls, 2);
      assert.equal(result.chunks_reviewed, 0);
      assert.equal(result.chunks_total, 1);
      assert.equal(result.ready_to_merge, false);
      return true;
    });
    assert.equal(networkCalls, 1);
  } finally { globalThis.fetch = originalFetch; }
});
