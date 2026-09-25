import test from "node:test";
import assert from "node:assert/strict";
import { createConfiguredAgentRunner } from "../src/orchestration/agent-runner.js";

test("real runner smoke test", { skip: process.env.ORCHESTRATION_REAL_SMOKE !== "1" }, async () => {
  const runner = createConfiguredAgentRunner({ env: { ...process.env, ORCHESTRATION_AGENT_MODE: "real" } });
  const result = await runner.run({
    subtask: { role: "backend", instructions: "Return a concise health check for this agent runner." },
    workspace: { workspace_path: process.cwd(), branch_name: "smoke/real-runner", base_ref: "stage4-mcp" }
  });
  assert.ok(["completed", "failed"].includes(result.status));
});
