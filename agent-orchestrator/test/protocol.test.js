import test from "node:test";
import assert from "node:assert/strict";
import { extractJson, normalizeAgentResponse, isConsensus, unstructuredAgentResponse } from "../src/protocol.js";
import { askClaude } from "../src/providers/claude.js";

const response = (text) => ({
  ok: true,
  json: async () => ({ content: [{ type: "text", text }] })
});

test("extractJson parses fenced JSON", () => {
  const value = extractJson('```json\n{"status":"agree","critical_issues":[],"recommended_changes":[],"ready_to_merge":true,"evidence":[]}\n```');
  assert.equal(value.status, "agree");
});

test("normalizeAgentResponse rejects invalid status", () => {
  assert.throws(() => normalizeAgentResponse({ status: "maybe" }));
});

test("isConsensus requires both agents to agree and be ready", () => {
  const ok = { status: "agree", critical_issues: [], recommended_changes: [], ready_to_merge: true, evidence: [] };
  assert.equal(isConsensus(ok, ok), true);
});

test("unstructured model response blocks review safely", () => {
  const value = unstructuredAgentResponse("Claude");
  assert.equal(value.status, "blocked");
  assert.equal(value.ready_to_merge, false);
  assert.match(value.evidence[0], /structured response/);
});

test("askClaude retries once after unstructured output", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => response(++calls === 1 ? "plain text" : '{"status":"needs_changes","critical_issues":[],"recommended_changes":["check"],"ready_to_merge":false,"evidence":[]}');
  try {
    const value = await askClaude({ apiKey: "test", model: "test", prompt: "review", maxOutputTokens: 100, timeoutMs: 1000 });
    assert.equal(calls, 2);
    assert.equal(value.status, "needs_changes");
  } finally {
    global.fetch = originalFetch;
  }
});

test("askClaude never converts an aborted retry into a successful-looking result", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (_url, options) => {
    calls += 1;
    if (calls === 1) return response("plain text");
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
  try {
    await assert.rejects(
      askClaude({ apiKey: "test", model: "test", prompt: "review", maxOutputTokens: 100, timeoutMs: 1000 }),
      error => error.name === "AbortError"
    );
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
