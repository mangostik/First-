import test from "node:test";
import assert from "node:assert/strict";
import { computeRetryTokenLimit } from "../src/providers/openai.js";

test("retry token limit grows up to 8000 but never shrinks", () => {
  assert.equal(computeRetryTokenLimit(1600), 3200);
  assert.equal(computeRetryTokenLimit(5000), 8000);
  assert.equal(computeRetryTokenLimit(10000), 10000);
});
