import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "agent-review.yml"), "utf8");

test("Agent Review is manual-only and exposes safe dispatch inputs", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /review_mode:/);
  assert.match(workflow, /pull_request_number:/);
  assert.match(workflow, /review_ref:/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
});

test("trusted ref validation precedes checkout and provider secrets", () => {
  const validation = workflow.indexOf("Validate trusted reviewer ref");
  const checkout = workflow.indexOf("Checkout trusted reviewer code");
  const layout = workflow.indexOf("Validate orchestrator workspace layout");
  const secrets = workflow.indexOf("OPENAI_API_KEY:");
  assert.ok(validation >= 0);
  assert.ok(validation < checkout);
  assert.ok(checkout < layout);
  assert.ok(layout < secrets);
  assert.ok(checkout < secrets);
  assert.match(workflow, /refs\/heads\/stage4-mcp/);
  assert.match(workflow, /REVIEW_REF.*stage4-mcp/);
  assert.doesNotMatch(workflow, /defaults:\s*\n\s+run:\s*\n\s+working-directory:/);
  assert.match(workflow, /working-directory: agent-orchestrator/);
  assert.match(workflow, /agent-orchestrator\/package\.json/);
  assert.match(workflow, /agent-orchestrator\/src\/index\.js/);
  assert.match(workflow, /agent-orchestrator\/test/);
});
