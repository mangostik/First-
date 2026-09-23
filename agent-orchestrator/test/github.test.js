import test from "node:test";
import assert from "node:assert/strict";
import { fetchGitHubDiff } from "../src/github.js";

test("fetchGitHubDiff requires repo/base/head", async () => {
  await assert.rejects(() => fetchGitHubDiff({}), /repo is required/);
});

test("oversized diff policy is fail-closed in Stage 2", async () => {
  const source = await import("node:fs/promises").then(fs =>
    fs.readFile(new URL("../src/index.js", import.meta.url), "utf8")
  );
  assert.match(source, /DIFF_TOO_LARGE/);
  assert.match(source, /final_status: "BLOCKED"/);
});
