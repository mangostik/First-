import test from "node:test";
import assert from "node:assert/strict";
import { createConfiguredTestRunner, createMockTestRunner, createRealTestRunner, withTestTimeout } from "../src/orchestration/test-runner.js";
import { createMockJobReviewer } from "../src/orchestration/reviewer.js";

test("mock test runner returns passed evidence with output fields", async () => {
  const result = await createMockTestRunner({ result: { status: "passed", exit_code: 0, stdout: "ok", stderr: "" } }).run({});
  assert.deepEqual(result.status, "passed");
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(typeof result.duration_ms, "number");
});

test("configured real runner reads command and timeout from environment", async () => {
  let received;
  const runner = createConfiguredTestRunner({
    env: { ORCHESTRATION_TEST_MODE: "real", ORCHESTRATION_TEST_COMMAND: "node --version", ORCHESTRATION_TEST_TIMEOUT_MS: "50" },
    realOptions: { executor: async (...args) => { received = args; return { exitCode: 0, stdout: "vtest", stderr: "" }; } }
  });
  const result = await runner.run({ workspace: { workspace_path: "C:/workspace" } });
  assert.equal(result.status, "passed");
  assert.equal(received[0], "node");
  assert.deepEqual(received[1], ["--version"]);
});

test("real test runner maps non-zero exit code to failed", async () => {
  const runner = createRealTestRunner({ command: ["fake-test", "--ci"], executor: async () => ({ exitCode: 2, stdout: "failed", stderr: "assertion" }) });
  const result = await runner.run({ workspace: { workspace_path: "C:\\workspace" } });
  assert.equal(result.status, "failed");
  assert.equal(result.exit_code, 2);
  assert.equal(result.stderr, "assertion");
  assert.equal(result.command, "fake-test --ci");
});

test("real test runner maps process errors to error and timeout evidence", async () => {
  const errorRunner = createRealTestRunner({ executor: async () => { const error = new Error("spawn failed"); error.code = "ENOENT"; error.stdout = "out"; error.stderr = "err"; throw error; } });
  assert.equal((await errorRunner.run({})).status, "error");
  const timeoutRunner = withTestTimeout(createRealTestRunner({ executor: async () => new Promise(() => {}) }), 5);
  const timeout = await timeoutRunner.run({});
  assert.equal(timeout.status, "timeout");
  assert.match(timeout.error, /5ms/);
});

test("job reviewer rejects missing or unsuccessful project test evidence", async () => {
  const reviewer = createMockJobReviewer();
  const aggregate = { summary: "1/1", changed_files: [], tests: ["agent test passed"], warnings: [], conflicts: [], remaining_work: [], workspaces: [] };
  const missing = await reviewer.review({ task: "task", aggregate });
  const failed = await reviewer.review({ task: "task", aggregate, testEvidence: { status: "failed" } });
  assert.equal(missing.final_decision, "rejected");
  assert.equal(failed.final_decision, "rejected");
});
