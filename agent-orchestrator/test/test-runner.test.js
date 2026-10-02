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

test("real test runner passes only the cross-platform toolchain environment and bounds output", async () => {
  let options;
  const marker = "synthetic-test-env-secret-marker";
  const runner = createRealTestRunner({
    command: ["node", "--version"],
    env: { PATH: "/safe/bin", CI: "1", TEMP: "/tmp", OPENAI_API_KEY: marker, RAILWAY_TOKEN: "railway-marker" },
    executor: async (_file, _args, received) => {
      options = received;
      return { exitCode: 0, stdout: `tests passed ${marker}`, stderr: "useful warning" };
    }
  });
  const result = await runner.run({ workspace: { workspace_path: "/workspace" } });
  assert.deepEqual(options.env, { PATH: "/safe/bin", CI: "1", TEMP: "/tmp" });
  assert.equal(options.maxBuffer, 256 * 1024);
  assert.equal(result.status, "passed");
  assert.match(result.stdout, /tests passed/);
  assert.match(result.stdout, /REDACTED/);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-test-env-secret-marker|railway-marker/);

  const large = await createRealTestRunner({ executor: async () => ({ exitCode: 1, stdout: "x".repeat(100_000), stderr: "ordinary failure" }) }).run({});
  assert.equal(Buffer.byteLength(large.stdout) <= 32 * 1024, true);
  assert.match(large.stdout, /output truncated/);
  assert.equal(large.status, "failed");
  assert.match(large.stderr, /ordinary failure/);
});

test("real test runner redacts secrets from stdout, stderr, and spawn errors", async () => {
  const marker = "synthetic-provider-secret-marker";
  const env = { TEST_SECRET_MARKER: marker };
  const outputRunner = createRealTestRunner({
    env,
    executor: async () => ({ exitCode: 1, stdout: `stdout ${marker}`, stderr: `stderr ${marker}` })
  });
  const output = await outputRunner.run({});
  assert.equal(output.status, "failed");
  assert.doesNotMatch(JSON.stringify(output), new RegExp(marker));
  assert.match(output.stdout, /stdout \[REDACTED\]/);
  assert.match(output.stderr, /stderr \[REDACTED\]/);

  const errorRunner = createRealTestRunner({
    env,
    executor: async () => {
      const error = new Error(`spawn failed while reading ${marker}`);
      error.code = "ENOENT";
      error.stdout = `partial ${marker}`;
      error.stderr = `diagnostic ${marker}`;
      throw error;
    }
  });
  const failure = await errorRunner.run({});
  assert.equal(failure.status, "error");
  assert.doesNotMatch(JSON.stringify(failure), new RegExp(marker));
  assert.match(failure.error, /spawn failed/);
  assert.match(failure.stdout, /partial \[REDACTED\]/);
  assert.match(failure.stderr, /diagnostic \[REDACTED\]/);
});

test("real test runner redacts timeout and cancellation diagnostics", async () => {
  const marker = "synthetic-timeout-secret-marker";
  const env = { TEST_AUTH_TOKEN: marker };
  const timeoutRunner = createRealTestRunner({ env, executor: async () => {
    const error = new Error(`command timed out ${marker}`);
    error.code = "ETIMEDOUT";
    error.stdout = `partial ${marker}`;
    error.stderr = `timeout stderr ${marker}`;
    throw error;
  } });
  const timeout = await timeoutRunner.run({});
  assert.equal(timeout.status, "timeout");
  assert.doesNotMatch(JSON.stringify(timeout), new RegExp(marker));
  assert.match(timeout.error, /command timed out/);

  const controller = new AbortController();
  const cancellationRunner = createRealTestRunner({ env, executor: async (_file, _args, options) => {
    assert.equal(options.signal, controller.signal);
    const error = new Error(`cancelled ${marker}`);
    error.name = "AbortError";
    error.stdout = `cancel stdout ${marker}`;
    throw error;
  } });
  controller.abort();
  const cancelled = await cancellationRunner.run({ signal: controller.signal });
  assert.equal(cancelled.status, "error");
  assert.doesNotMatch(JSON.stringify(cancelled), new RegExp(marker));
  assert.match(cancelled.error, /cancelled/);
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

test("test runner propagates an already-aborted parent signal", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const runner = withTestTimeout({ mode: "mock", run: async ({ signal }) => {
    called = true;
    assert.equal(signal.aborted, true);
    return { status: "passed", command: "mock", exit_code: 0, stdout: "", stderr: "", duration_ms: 0, error: null };
  } }, 100);
  const result = await runner.run({ signal: controller.signal });
  assert.equal(called, true);
  assert.equal(result.status, "passed");
});

test("job reviewer rejects missing or unsuccessful project test evidence", async () => {
  const reviewer = createMockJobReviewer();
  const aggregate = { summary: "1/1", changed_files: [], tests: ["agent test passed"], warnings: [], conflicts: [], remaining_work: [], workspaces: [] };
  const missing = await reviewer.review({ task: "task", aggregate });
  const failed = await reviewer.review({ task: "task", aggregate, testEvidence: { status: "failed" } });
  assert.equal(missing.final_decision, "rejected");
  assert.equal(failed.final_decision, "rejected");
});
