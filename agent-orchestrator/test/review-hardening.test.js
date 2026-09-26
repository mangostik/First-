import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomicJson } from "../src/progress.js";
import { aggregateChunkResults } from "../src/aggregation.js";
import { createReviewEventEmitter } from "../src/review-loop.js";

test("incomplete cheap coverage blocks a previously approving aggregate", () => {
  const result = aggregateChunkResults([
    { final_status: "CONSENSUS", rounds: 1, decision: { status: "agree", ready_to_merge: true, critical_issues: [], recommended_changes: [], evidence: [] } }
  ], null, false);
  assert.equal(result.final_status, "BLOCKED");
  assert.equal(result.decision.ready_to_merge, false);
});

test("aggregate preserves explicit terminal failure statuses", () => {
  for (const status of ["TIMEOUT", "COST_LIMIT", "FAILED"]) {
    const result = aggregateChunkResults([
      { final_status: status, rounds: 1, decision: { status: "needs_changes", ready_to_merge: false, critical_issues: [], recommended_changes: [], evidence: [] } }
    ], null, false);
    assert.equal(result.final_status, status);
    assert.equal(result.decision.ready_to_merge, false);
  }
});

test("incomplete coverage preserves an explicit BLOCKED result", () => {
  const result = aggregateChunkResults([
    {
      final_status: "BLOCKED",
      rounds: 1,
      decision: {
        status: "blocked",
        ready_to_merge: false,
        critical_issues: ["provider failure"],
        recommended_changes: [],
        evidence: ["provider=Claude"]
      }
    }
  ], null, false);
  assert.equal(result.final_status, "BLOCKED");
  assert.equal(result.decision.status, "blocked");
  assert.equal(result.decision.ready_to_merge, false);
});

test("progress JSON is replaced atomically and remains valid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-progress-"));
  const filePath = join(directory, "progress.json");
  try {
    writeAtomicJson(filePath, { status: "IN_PROGRESS", value: 1 });
    writeAtomicJson(filePath, { status: "COMPLETED", value: 2 });
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { status: "COMPLETED", value: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("review events retain only the configured bounded tail", () => {
  const events = [];
  const { emit } = createReviewEventEmitter({ events, maxEvents: 2 });
  emit({ type: "one" });
  emit({ type: "two" });
  emit({ type: "three" });
  assert.deepEqual(events.map(event => event.type), ["two", "three"]);
});
