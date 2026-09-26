import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = 39000 + Math.floor(Math.random() * 500);
const pathToken = "smoke-path-token";
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForHealth(child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The child can take a moment to load the MCP runtime.
    }
    await delay(100);
  }
  const output = await new Promise(resolve => {
    let value = "";
    child.stdout.on("data", chunk => { value += chunk; });
    child.stderr.on("data", chunk => { value += chunk; });
    setTimeout(() => resolve(value), 50);
  });
  throw new Error(`smoke server did not become healthy: ${output}`);
}

async function mcpRequest(id, method, params = {}) {
  const response = await fetch(`${baseUrl}/mcp/${pathToken}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("production smoke: health, tracker and MCP tools are reachable without provider calls", async () => {
  const child = spawn(process.execPath, ["src/mcp-server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      MCP_PATH_TOKEN: pathToken,
      MCP_ACCESS_TOKEN: "",
      ORCHESTRATION_TRACKER_TOKEN: "tracker-smoke-token",
      ORCHESTRATION_AGENT_MODE: "mock",
      ORCHESTRATION_REVIEWER_MODE: "mock",
      ORCHESTRATION_TEST_MODE: "mock"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForHealth(child);

    const health = await fetch(`${baseUrl}/health`);
    assert.deepEqual(await health.json(), { ok: true, service: "fishcrm-agent-orchestrator" });

    const unauthorizedTracker = await fetch(`${baseUrl}/tracker`);
    assert.equal(unauthorizedTracker.status, 401);
    const tracker = await fetch(`${baseUrl}/tracker`, { headers: { authorization: "Bearer tracker-smoke-token" } });
    assert.equal(tracker.status, 200);
    assert.match(await tracker.text(), /FishCRM Orchestrator Tracker/);

    const initialized = await mcpRequest(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "production-smoke", version: "1.0.0" }
    });
    assert.equal(initialized.result.serverInfo.name, "fishcrm-agent-orchestrator");

    const tools = await mcpRequest(2, "tools/list");
    const names = tools.result.tools.map(tool => tool.name);
    assert.deepEqual(names, [
      "run_agent_review",
      "orchestrator_status",
      "create_orchestration_job",
      "get_job_status",
      "get_job_result",
      "cancel_job"
    ]);

    const status = await mcpRequest(3, "tools/call", {
      name: "orchestrator_status",
      arguments: {}
    });
    assert.match(status.result.content[0].text, /"service":"fishcrm-agent-orchestrator"/);
  } finally {
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
  }
});
