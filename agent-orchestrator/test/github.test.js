import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchGitHubDiff,
  validateGitHubConfig,
  validatePositiveInteger
} from "../src/github.js";

test("fetchGitHubDiff requires repo/base/head", async () => {
  await assert.rejects(() => fetchGitHubDiff({}), /repo is required/);
});

test("validateGitHubConfig rejects partial configuration", () => {
  assert.throws(
    () => validateGitHubConfig({ repo: "mangostik/First-", base: "main", head: "" }),
    /must be set together/
  );
});

test("validatePositiveInteger rejects unsafe MAX_DIFF_CHARS values", () => {
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => validatePositiveInteger(value, "MAX_DIFF_CHARS"));
  }
  assert.equal(validatePositiveInteger(20000, "MAX_DIFF_CHARS"), 20000);
});

test("fetchGitHubDiff stops when streamed body exceeds maxBytes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345"));
        controller.enqueue(new TextEncoder().encode("67890"));
        controller.close();
      }
    }),
    { status: 200 }
  );

  try {
    await assert.rejects(
      () => fetchGitHubDiff({
        repo: "owner/repo",
        base: "main",
        head: "feature",
        maxBytes: 6
      }),
      error => error && error.code === "DIFF_TOO_LARGE"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
