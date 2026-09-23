import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchGitHubDiff,
  fetchGitHubPullRequestDiff,
  splitDiffIntoChunks,
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

test("validatePositiveInteger rejects unsafe values", () => {
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => validatePositiveInteger(value, "LIMIT"));
  }
  assert.equal(validatePositiveInteger(20000, "LIMIT"), 20000);
});

test("splitDiffIntoChunks preserves all content and respects limit", () => {
  const diff = [
    "diff --git a/a.js b/a.js\n",
    "+++ b/a.js\n",
    "+" + "a".repeat(35) + "\n",
    "diff --git a/b.js b/b.js\n",
    "+++ b/b.js\n",
    "+" + "b".repeat(35) + "\n"
  ].join("");

  const chunks = splitDiffIntoChunks(diff, 60);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), diff);
  assert.ok(chunks.every(chunk => chunk.length <= 60));
});

test("fetchGitHubDiff stops when streamed body exceeds total byte limit", async () => {
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
      error => error && error.code === "DIFF_TOTAL_TOO_LARGE"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("fetchGitHubPullRequestDiff uses the PR endpoint and preserves diff content", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response("diff --git a/a.js b/a.js\n+ok\n", { status: 200 });
  };

  try {
    const diff = await fetchGitHubPullRequestDiff({
      repo: "owner/repo",
      prNumber: 42,
      maxBytes: 1000
    });
    assert.match(requestedUrl, /repos\/owner\/repo\/pulls\/42$/);
    assert.match(diff, /\+ok/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
