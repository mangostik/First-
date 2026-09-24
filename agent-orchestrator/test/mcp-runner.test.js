import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewEnv } from "../src/mcp-runner.js";

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
  const env = buildReviewEnv(
    { repo: "owner/repo", base: "main", head: "feature" },
    {}
  );

  assert.equal(env.GITHUB_REPO, "owner/repo");
  assert.equal(env.GITHUB_BASE, "main");
  assert.equal(env.GITHUB_HEAD, "feature");
  assert.equal(env.GITHUB_PR_NUMBER, undefined);
});
