import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewEnv, assertTrustedReviewSource, runAgentReview } from "../src/mcp-runner.js";
import { resolveWorkspaceRoot, assertTrustedWorkspace } from "../src/workspace.js";

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

test("reviewer rejects an explicitly untrusted source", () => {
  assert.throws(
    () => assertTrustedReviewSource({ ORCHESTRATION_TRUSTED_REF: "pull-request" }),
    error => error.code === "UNTRUSTED_REVIEW_SOURCE"
  );
});

test("CI reviewer must declare stage4-mcp", () => {
  assert.throws(
    () => assertTrustedReviewSource({ CI: "true" }),
    error => error.code === "UNTRUSTED_REVIEW_SOURCE"
  );
  assert.doesNotThrow(() => assertTrustedReviewSource({ CI: "true", ORCHESTRATION_TRUSTED_REF: "stage4-mcp" }));
});

test("workspace root is resolved from the Linux runner workspace", () => {
  const root = resolveWorkspaceRoot("review-workspace");
  assert.equal(root, resolveWorkspaceRoot(root));
  assert.ok(root.endsWith("review-workspace"));
  assert.doesNotThrow(() => assertTrustedWorkspace({ ORCHESTRATION_TRUSTED_REF: "stage4-mcp" }));
});

test("invalid timeout cannot be treated as a successful review", () => {
  assert.throws(() => runAgentReview({ task: "review" }, { timeoutMs: 0 }), /timeoutMs must be positive/);
});
