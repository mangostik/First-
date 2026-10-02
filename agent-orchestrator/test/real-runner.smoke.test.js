import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createConfiguredAgentRunner } from "../src/orchestration/agent-runner.js";

test("real runner smoke test", { skip: process.env.ORCHESTRATION_REAL_SMOKE !== "1" }, async () => {
  const workspacePath = process.env.ORCHESTRATION_REAL_SMOKE_WORKSPACE;
  const workspaceRoot = process.env.ORCHESTRATION_REAL_SMOKE_WORKSPACE_ROOT;
  const allowedFile = process.env.ORCHESTRATION_REAL_SMOKE_FILE;
  assert.ok(workspacePath && workspaceRoot && allowedFile, "dedicated smoke workspace, root, and file are required");
  assert.notEqual(resolve(workspacePath), resolve(workspaceRoot), "smoke test cannot use workspace root directly");
  const runner = createConfiguredAgentRunner({
    env: {
      ...process.env,
      ORCHESTRATION_AGENT_MODE: "real",
      ORCHESTRATION_WORKSPACE_ROOT: workspaceRoot
    }
  });
  const result = await runner.run({
    subtask: {
      role: "backend",
      instructions: `Make the requested bounded smoke-test change in ${allowedFile}.`,
      allowed_files: [allowedFile]
    },
    workspace: { workspace_path: workspacePath, branch_name: "smoke/real-runner", base_ref: "stage4-mcp" }
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.changed_files, [allowedFile.replaceAll("\\", "/")]);
});
