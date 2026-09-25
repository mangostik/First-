import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

test("importing mcp-server does not start an HTTP listener", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", "import('./src/mcp-server.js')"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("mcp-server import did not exit; an import-time listener may be active"));
    }, 2000);
    child.once("exit", code => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.equal(exit, 0);
});
