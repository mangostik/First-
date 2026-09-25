import test from "node:test";
import assert from "node:assert/strict";
import { askClaude } from "../src/providers/claude.js";
import { askOpenAI } from "../src/providers/openai.js";
import { ProviderRequestError } from "../src/providers/http.js";
import { failureResult } from "../src/review-result.js";
import { createReviewEventEmitter, runProviderReviewLoop } from "../src/review-loop.js";

const agent = {
  status: "agree",
  critical_issues: [],
  recommended_changes: [],
  ready_to_merge: true,
  evidence: ["mock"]
};

function claudeResponse() {
  return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(agent) }] }), { status: 200 });
}

function openaiResponse() {
  return new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify(agent) }), { status: 200 });
}

const options = { apiKey: "test-key", model: "test-model", prompt: "review", maxOutputTokens: 100, timeoutMs: 50, maxRetries: 0 };

test("mock Claude and OpenAI requests produce normalized structured results", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes("anthropic") ? claudeResponse() : openaiResponse();
  try {
    assert.deepEqual(await askClaude(options), agent);
    assert.deepEqual(await askOpenAI(options), agent);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Claude request timeout aborts the provider request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, request) => new Promise((_, reject) => {
    request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  try {
    await assert.rejects(() => askClaude({ ...options, timeoutMs: 5 }), error => {
      assert.equal(error.code, "PROVIDER_TIMEOUT");
      assert.equal(error.provider, "Claude");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI request timeout aborts the provider request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, request) => new Promise((_, reject) => {
    request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  try {
    await assert.rejects(() => askOpenAI({ ...options, timeoutMs: 5 }), error => {
      assert.equal(error.code, "PROVIDER_TIMEOUT");
      assert.equal(error.provider, "OpenAI");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI timeout covers a response body that never finishes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const started = Date.now();
  try {
    await assert.rejects(() => askOpenAI({ ...options, timeoutMs: 20 }), error => {
      assert.equal(error.code, "PROVIDER_TIMEOUT");
      assert.equal(error.provider, "OpenAI");
      return true;
    });
    assert.ok(Date.now() - started < 500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("review loop deadline aborts a hanging provider and emits structured events", async () => {
  const events = [];
  const { emit } = createReviewEventEmitter({ events });
  const agentResult = { ...agent };
  const started = Date.now();
  await assert.rejects(() => runProviderReviewLoop({
    task: "review",
    chunks: [""],
    config: {
      maxRounds: 3,
      maxOutputTokens: 100,
      claudeTimeoutMs: 1000,
      openaiTimeoutMs: 1000,
      providerMaxRetries: 0,
      structuredMaxRetries: 0,
      reviewLoopTimeoutMs: 30,
      anthropicApiKey: "test",
      anthropicModel: "claude",
      openaiApiKey: "test",
      openaiModel: "openai"
    },
    promptBuilders: { claude: () => "claude", openai: () => "openai" },
    synthesize: async () => null,
    isConsensus: () => false,
    emit,
    askClaudeFn: async () => new Promise(() => {}),
    askOpenAIFn: async () => agentResult
  }), error => {
    assert.equal(error.code, "REVIEW_LOOP_TIMEOUT");
    return true;
  });
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(events.map(event => event.type), ["provider_started", "review_loop_aborted"]);
});

test("retryable Claude 503 and OpenAI 429 stop after the configured retry", async () => {
  const originalFetch = globalThis.fetch;
  let claudeCalls = 0;
  let openaiCalls = 0;
  globalThis.fetch = async url => {
    if (String(url).includes("anthropic")) {
      claudeCalls += 1;
      return claudeCalls === 1 ? new Response("overloaded", { status: 503 }) : claudeResponse();
    }
    openaiCalls += 1;
    return openaiCalls === 1 ? new Response("slow down", { status: 429 }) : openaiResponse();
  };
  try {
    assert.deepEqual(await askClaude({ ...options, maxRetries: 1 }), agent);
    assert.deepEqual(await askOpenAI({ ...options, maxRetries: 1 }), agent);
    assert.equal(claudeCalls, 2);
    assert.equal(openaiCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("external cancellation stops a provider request without retry", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, request) => new Promise((_, reject) => {
    request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const controller = new AbortController();
  try {
    const pending = askOpenAI({ ...options, signal: controller.signal, maxRetries: 1 });
    controller.abort();
    await assert.rejects(pending, error => {
      assert.equal(error.code, "PROVIDER_ABORTED");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider failure always serializes to valid structured review JSON", () => {
  const result = failureResult(new ProviderRequestError("OpenAI request timed out after 120000ms", {
    code: "PROVIDER_TIMEOUT",
    provider: "OpenAI",
    timeoutMs: 120000
  }));
  const parsed = JSON.parse(JSON.stringify(result));
  assert.equal(parsed.final_status, "TIMEOUT");
  assert.equal(parsed.decision.ready_to_merge, false);
  assert.equal(parsed.error.provider, "OpenAI");
  assert.ok(Array.isArray(parsed.transcript));
});
