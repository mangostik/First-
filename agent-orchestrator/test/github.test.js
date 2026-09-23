import test from "node:test";
import assert from "node:assert/strict";
import { fetchGitHubDiff } from "../src/github.js";

test("fetchGitHubDiff requires repo/base/head", async () => {
  await assert.rejects(() => fetchGitHubDiff({}), /repo is required/);
});
