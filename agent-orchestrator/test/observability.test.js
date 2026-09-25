import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJob } from "../src/orchestration/schemas.js";
import { JsonJobStore } from "../src/orchestration/job-store.js";
import { DependencyScheduler } from "../src/orchestration/scheduler.js";
import { addEvent, addLimitViolation, readOrchestrationLimits, redactSecrets } from "../src/orchestration/observability.js";
import { OrchestrationService } from "../src/orchestration/service.js";
import { WorkspaceManager } from "../src/orchestration/workspace.js";
import { createMockAgentRunner } from "../src/orchestration/agent-runner.js";

test("structured events redact API keys and MCP tokens", () => {
  const safe = redactSecrets({ apiKey: "secret-value", authorization: "Bearer abc-token", message: "ghp_123456789" });
  assert.equal(safe.apiKey, "[REDACTED]");
  assert.equal(safe.authorization, "[REDACTED]");
  assert.equal(safe.message, "[REDACTED]");
});

test("limits are configurable and concurrency is capped at three", () => {
  const limits = readOrchestrationLimits({ ORCHESTRATION_MAX_SUBTASKS: "4", ORCHESTRATION_MAX_PARALLEL: "9", ORCHESTRATION_MAX_RETRIES: "2", ORCHESTRATION_TIMEOUT_MS: "7", ORCHESTRATION_JOB_TIMEOUT_MS: "11" });
  assert.deepEqual(limits, { maxSubtasks: 4, requestedMaxParallel: 9, maxParallel: 3, maxRetries: 2, subtaskTimeoutMs: 7, jobTimeoutMs: 11, logEvents: false });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fishcrm-observability-"));
  const store = new JsonJobStore(root);
  const job = createJob("observability");
  job.status = "running";
  job.subtasks = [{ id: "one", role: "backend", title: "one", instructions: "one", dependencies: [], status: "queued", timestamps: { queued: new Date().toISOString() } }];
  await store.create(job);
  return { root, store, job };
}

test("scheduler records attempts, active concurrency, retry and timeout violations", async () => {
  const { root, store, job } = await fixture();
  try {
    let calls = 0;
    const result = await new DependencyScheduler({ store, runner: async () => { calls += 1; if (calls === 1) throw new Error("transient"); return { status: "completed", summary: "ok", changed_files: [], tests: [], warnings: [], error: null }; }, maxParallel: 1, timeoutMs: 30, maxRetries: 1, jobTimeoutMs: 500 }).run(job.job_id);
    assert.equal(result.subtasks[0].attempts, 2);
    assert.ok(result.events.some(event => event.type === "subtask_retry"));
    assert.equal(result.metrics.max_active_tasks, 1);
    const timeoutJob = createJob("timeout");
    timeoutJob.status = "running";
    timeoutJob.subtasks = [{ id: "timeout", role: "backend", title: "timeout", instructions: "timeout", dependencies: [], status: "queued", timestamps: { queued: new Date().toISOString() } }];
    await store.create(timeoutJob);
    const timed = await new DependencyScheduler({ store, runner: async () => new Promise(() => {}), maxParallel: 1, timeoutMs: 5, maxRetries: 0, jobTimeoutMs: 100 }).run(timeoutJob.job_id);
    assert.ok(timed.limit_violations.some(item => item.code === "subtask_timeout"));
    assert.ok(timed.limit_violations.some(item => item.code === "max_retries"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("job timeout and cancellation preserve reasons and events", async () => {
  const { root, store, job } = await fixture();
  try {
    const timed = await new DependencyScheduler({ store, runner: async () => new Promise(() => {}), maxParallel: 1, timeoutMs: 500, maxRetries: 0, jobTimeoutMs: 10 }).run(job.job_id);
    assert.equal(timed.error, "job_timeout");
    assert.ok(timed.limit_violations.some(item => item.code === "job_timeout"));
    const cancelJob = createJob("cancel");
    cancelJob.status = "running";
    cancelJob.subtasks = [{ id: "cancel", role: "backend", title: "cancel", instructions: "cancel", dependencies: [], status: "queued" }];
    await store.create(cancelJob);
    const scheduler = new DependencyScheduler({ store, runner: async ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })), maxParallel: 1, timeoutMs: 500, jobTimeoutMs: 1000 });
    const running = scheduler.run(cancelJob.job_id);
    await new Promise(resolve => setTimeout(resolve, 10));
    const cancelled = await scheduler.cancel(cancelJob.job_id);
    await running;
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.events.some(event => event.type === "job_cancelled"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("limit violations are retained in final-shaped job data", () => {
  const job = createJob("limits");
  addEvent(job, "job_state", { status: "failed" });
  addLimitViolation(job, "max_subtasks", { actual: 4, limit: 3 });
  assert.equal(job.limit_violations[0].code, "max_subtasks");
  assert.equal(job.events.at(-1).type, "limit_violation");
});

test("service rejects a plan over max subtasks and saves the violation", async () => {
  const root = await mkdtemp(join(tmpdir(), "fishcrm-limit-"));
  try {
    const store = new JsonJobStore(root);
    const workspaceManager = new WorkspaceManager({ rootDir: join(root, "workspaces"), repoRoot: root, allowedRoot: root, git: async () => ({}) });
    const service = new OrchestrationService({ store, workspaceManager, runner: createMockAgentRunner() });
    service.limits.maxSubtasks = 2;
    const created = await service.createJob("Add an API function and tests");
    let job;
    for (let i = 0; i < 100; i += 1) {
      job = await service.getStatus(created.job_id);
      if (job.status === "failed" && job.result) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(job.status, "failed");
    assert.equal(job.result.limit_violations[0].code, "max_subtasks");
  } finally { await rm(root, { recursive: true, force: true }); }
});
