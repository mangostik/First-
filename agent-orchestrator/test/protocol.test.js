import test from "node:test";
import assert from "node:assert/strict";
import { extractJson, normalizeAgentResponse, isConsensus } from "../src/protocol.js";

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
