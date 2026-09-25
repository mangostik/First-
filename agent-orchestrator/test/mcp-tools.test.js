import test from "node:test";
import assert from "node:assert/strict";
import { ORCHESTRATION_TOOL_NAMES, registerOrchestrationTools } from "../src/mcp-server.js";

test("MCP exposes the four non-blocking orchestration tools", () => {
  const registered = [];
  const server = { registerTool(name) { registered.push(name); } };
  registerOrchestrationTools(server, {
    createJob: async () => ({ job_id: "job", status: "queued" }),
    getStatus: async () => ({}),
    getResult: async () => null,
    cancelJob: async () => ({ status: "cancelled" })
  });
  assert.deepEqual(registered, ORCHESTRATION_TOOL_NAMES);
});

test("MCP registration does not replace legacy tool names", () => {
  assert.deepEqual(ORCHESTRATION_TOOL_NAMES, ["create_orchestration_job", "get_job_status", "get_job_result", "cancel_job"]);
});
