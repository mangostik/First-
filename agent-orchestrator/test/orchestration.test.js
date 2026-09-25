import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOB_STATUSES, isTerminal } from "../src/orchestration/statuses.js";
import { createJob, validateJob } from "../src/orchestration/schemas.js";
import { JsonJobStore } from "../src/orchestration/job-store.js";
import { planTask } from "../src/orchestration/planner.js";
import {
  createMockAgentRunner,
  createRealAgentAdapter,
  createConfiguredAgentRunner,
  getAgentRunnerMode
} from "../src/orchestration/agent-runner.js";
import { DependencyScheduler } from "../src/orchestration/scheduler.js";
import { OrchestrationService } from "../src/orchestration/service.js";
import { assertNotMainBranch } from "../src/orchestration/workspace-policy.js";
import { WorkspaceManager } from "../src/orchestration/workspace.js";
import { integrateSubtasks } from "../src/orchestration/integrator.js";
import { createMockJobReviewer, createRealJobReviewer } from "../src/orchestration/reviewer.js";
import { createMockTestRunner } from "../src/orchestration/test-runner.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fishcrm-orchestrator-"));
  const store = new JsonJobStore(root);
  const workspaceManager = new WorkspaceManager({
    rootDir: join(root, "workspaces"),
    repoRoot: root,
    allowedRoot: root,
    git: async () => ({ stdout: "", stderr: "" })
  });
  return { root, store, workspaceManager };
}

test("canonical statuses and job validation are enforced", () => {
  assert.deepEqual(JOB_STATUSES, ["queued", "planning", "running", "waiting", "integrating", "reviewing", "completed", "failed", "cancelled"]);
  assert.throws(() => validateJob({ ...createJob("x"), status: "unknown" }), /Invalid job.status/);
  assert.equal(isTerminal("completed"), true);
  assert.equal(isTerminal("running"), false);
});

test("workspace policy rejects direct changes to main", () => {
  assert.throws(() => assertNotMainBranch("main"), /forbidden/);
  assert.equal(assertNotMainBranch("mvp-parallel-orchestrator"), "mvp-parallel-orchestrator");
});

test("workspace manager creates distinct worktrees and rejects unsafe reuse", async () => {
  const { root, workspaceManager } = await fixture();
  try {
    const first = await workspaceManager.create({ jobId: "job-1", subtaskId: "backend-1", baseRef: "stage4-mcp" });
    const second = await workspaceManager.create({ jobId: "job-1", subtaskId: "qa-1", baseRef: "stage4-mcp" });
    assert.notEqual(first.workspace_path, second.workspace_path);
    assert.equal(first.state, "ready");
    assert.equal(first.job_id, "job-1");
    assert.equal(first.subtask_id, "backend-1");
    await assert.rejects(() => workspaceManager.create({ jobId: "job-1", subtaskId: "backend-1", baseRef: "stage4-mcp" }), /already exists/);
    await assert.rejects(() => workspaceManager.create({ jobId: "../escape", subtaskId: "qa-1", baseRef: "stage4-mcp" }), /unsafe path/);
    await assert.rejects(() => workspaceManager.create({ jobId: "job-1", subtaskId: "qa-2", baseRef: "main" }), /main is forbidden/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace manager handles Git errors and explicit idempotent cleanup", async () => {
  const { root } = await fixture();
  try {
    const failing = new WorkspaceManager({ rootDir: join(root, "failing"), repoRoot: root, allowedRoot: root, git: async () => { throw new Error("git unavailable"); } });
    await assert.rejects(() => failing.create({ jobId: "job-1", subtaskId: "backend-1", baseRef: "stage4-mcp" }), /git creation failed/);
    const manager = new WorkspaceManager({ rootDir: join(root, "cleanup"), repoRoot: root, allowedRoot: root, git: async () => ({}) });
    const workspace = await manager.create({ jobId: "job-2", subtaskId: "backend-1", baseRef: "stage4-mcp" });
    const released = await manager.cleanup(workspace);
    assert.equal(released.state, "released");
    assert.equal((await manager.cleanup(released)).state, "released");
    await assert.rejects(() => manager.cleanup({ ...workspace, workspace_path: root }), /outside the allowed root/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("job store writes and reads atomically shaped JSON jobs", async () => {
  const { root, store } = await fixture();
  try {
    const job = createJob("Add an API function and tests");
    await store.create(job);
    const updated = await store.update(job.job_id, value => { value.status = "planning"; return value; });
    assert.equal(updated.status, "planning");
    assert.deepEqual((await store.get(job.job_id)).job_id, job.job_id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MVP planner creates parallel backend and QA plus dependent reviewer", () => {
  const plan = planTask("Add an API function and tests");
  assert.deepEqual(plan.subtasks.map(item => item.id), ["backend-1", "qa-1", "reviewer-1"]);
  assert.deepEqual(plan.subtasks[0].dependencies, []);
  assert.deepEqual(plan.subtasks[1].dependencies, []);
  assert.deepEqual(plan.subtasks[2].dependencies.map(item => item.subtask_id), ["backend-1", "qa-1"]);
});

const workspace = subtaskId => ({
  job_id: "job-aggregate",
  subtask_id: subtaskId,
  workspace_path: `C:\\workspaces\\${subtaskId}`,
  branch_name: `orchestrator/job-aggregate/${subtaskId}`,
  base_ref: "stage4-mcp",
  state: "completed"
});

const completedSubtask = (id, files, tests = ["test passed"]) => ({
  id,
  status: "completed",
  workspace: workspace(id),
  result: { changed_files: files, tests, warnings: [], error: null }
});

test("integrator aggregates completed subtask results and workspaces", () => {
  const aggregate = integrateSubtasks({ subtasks: [completedSubtask("backend-1", ["src/api.js"]), completedSubtask("qa-1", ["test/api.test.js"])] });
  assert.deepEqual(aggregate.changed_files, ["src/api.js", "test/api.test.js"]);
  assert.equal(aggregate.workspaces.length, 2);
  assert.deepEqual(aggregate.conflicts, []);
  assert.equal(aggregate.remaining_work.length, 0);
});

test("integrator detects conflicting changed files and failed work", () => {
  const aggregate = integrateSubtasks({ subtasks: [
    completedSubtask("backend-1", ["src/shared.js"]),
    completedSubtask("qa-1", ["src/shared.js"]),
    { id: "reviewer-1", status: "failed", error: "agent crashed", result: null, workspace: null }
  ] });
  assert.equal(aggregate.conflicts.length, 1);
  assert.match(aggregate.conflicts[0], /src\/shared\.js/);
  assert.deepEqual(aggregate.remaining_work, ["reviewer-1: agent crashed"]);
});

test("job reviewer rejects conflicts or missing work and approves clean aggregate", async () => {
  const reviewer = createMockJobReviewer();
  const approved = await reviewer.review({ task: "API task", aggregate: {
    summary: "2/2", changed_files: ["src/api.js"], tests: ["api test passed"], warnings: [], conflicts: [], remaining_work: [], workspaces: []
  }, testEvidence: { status: "passed" } });
  assert.equal(approved.final_decision, "approved");
  const rejected = await reviewer.review({ task: "API task", aggregate: {
    summary: "1/2", changed_files: ["src/api.js"], tests: [], warnings: [], conflicts: ["src/api.js changed twice"], remaining_work: ["qa-1: failed"], workspaces: []
  } });
  assert.equal(rejected.final_decision, "rejected");
  assert.ok(rejected.review_findings.length >= 2);
});

test("real job reviewer is a separate adapter over the legacy review loop", async () => {
  let received = "";
  const reviewer = createRealJobReviewer({ review: async input => {
    received = input.task;
    return { final_status: "CONSENSUS", decision: { status: "agree", ready_to_merge: true, critical_issues: [], recommended_changes: [] } };
  } });
  const result = await reviewer.review({ task: "API task", aggregate: { summary: "ok", changed_files: [], tests: ["passed"], warnings: [], conflicts: [], remaining_work: [], workspaces: [] }, testEvidence: { status: "passed" } });
  assert.equal(reviewer.mode, "real");
  assert.match(received, /Aggregate result/);
  assert.equal(result.final_decision, "approved");
});

test("runner adapters support mock and injected real implementations", async () => {
  assert.equal(getAgentRunnerMode({}), "mock");
  assert.equal(getAgentRunnerMode({ ORCHESTRATION_AGENT_MODE: "REAL" }), "real");
  assert.equal(createConfiguredAgentRunner({ env: {} }).mode, "mock");
  assert.throws(() => getAgentRunnerMode({ ORCHESTRATION_AGENT_MODE: "other" }), /Invalid/);

  let receivedTask = "";
  let receivedOptions;
  const real = createRealAgentAdapter({
    review: async (input, options) => {
      receivedTask = input.task;
      receivedOptions = options;
      return { final_status: "CONSENSUS", decision: { status: "agree", critical_issues: [], recommended_changes: [] } };
    }
  });
  const result = await real.run({
    subtask: { role: "backend", instructions: "review this API" },
    workspace: { workspace_path: "C:\\assigned\\backend", branch_name: "orchestrator/job/backend", base_ref: "stage4-mcp" }
  });
  assert.equal(real.mode, "real");
  assert.match(receivedTask, /review this API/);
  assert.match(receivedTask, /C:\\assigned\\backend/);
  assert.equal(receivedOptions.env.ORCHESTRATION_WORKSPACE_PATH, "C:\\assigned\\backend");
  assert.equal(result.status, "completed");
});

test("scheduler starts independent work in parallel and respects dependencies", async () => {
  const { root, store } = await fixture();
  try {
    const job = createJob("scheduler test");
    job.status = "running";
    job.subtasks = planTask("Add an API function and tests").subtasks;
    await store.create(job);
    const started = [];
    let active = 0;
    let maxActive = 0;
    const runner = async ({ subtask }) => {
      started.push(subtask.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active -= 1;
      return { status: "completed", summary: "ok", changed_files: [], tests: [], warnings: [], error: null };
    };
    const result = await new DependencyScheduler({ store, runner, maxParallel: 2, timeoutMs: 100, maxRetries: 0 }).run(job.job_id);
    assert.equal(result.subtasks.every(item => item.status === "completed"), true);
    assert.deepEqual(started, ["backend-1", "qa-1", "reviewer-1"]);
    assert.equal(maxActive, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scheduler can cancel one active subtask while another independent task completes", async () => {
  const { root, store } = await fixture();
  try {
    const plan = planTask("Add an API function and tests");
    const job = createJob("cancel one task");
    job.status = "running";
    job.subtasks = plan.subtasks.slice(0, 2);
    await store.create(job);
    const runner = async ({ subtask, signal }) => {
      if (subtask.id === "backend-1") {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true });
        });
      }
      return { status: "completed", summary: subtask.id, changed_files: [], tests: [], warnings: [], error: null };
    };
    const scheduler = new DependencyScheduler({ store, runner, maxParallel: 2, timeoutMs: 500, maxRetries: 0 });
    const running = scheduler.run(job.job_id);
    await new Promise(resolve => setTimeout(resolve, 15));
    const cancelled = await scheduler.cancelSubtask(job.job_id, "backend-1");
    const result = await running;
    assert.equal(cancelled.subtasks.find(item => item.id === "backend-1").status, "cancelled");
    assert.equal(result.subtasks.find(item => item.id === "qa-1").status, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scheduler retries a failed subtask once", async () => {
  const { root, store } = await fixture();
  try {
    const job = createJob("retry test");
    job.status = "running";
    job.subtasks = [planTask("Add an API function and tests").subtasks[0]];
    await store.create(job);
    const runner = createMockAgentRunner({ failuresBeforeSuccess: { "backend-1": 1 } });
    const result = await new DependencyScheduler({ store, runner, maxParallel: 3, timeoutMs: 100, maxRetries: 1 }).run(job.job_id);
    assert.equal(result.subtasks[0].status, "completed");
    assert.equal(result.subtasks[0].attempts, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scheduler fails dependent work when an upstream subtask fails", async () => {
  const { root, store } = await fixture();
  try {
    const plan = planTask("Add an API function and tests");
    const job = createJob("dependency failure test");
    job.status = "running";
    job.subtasks = plan.subtasks;
    await store.create(job);
    const runner = async ({ subtask }) => {
      if (subtask.id === "backend-1") throw new Error("backend failed");
      return { status: "completed", summary: "ok", changed_files: [], tests: [], warnings: [], error: null };
    };
    const result = await new DependencyScheduler({ store, runner, maxParallel: 3, timeoutMs: 100, maxRetries: 0 }).run(job.job_id);
    assert.equal(result.subtasks.find(item => item.id === "backend-1").status, "failed");
    assert.equal(result.subtasks.find(item => item.id === "reviewer-1").error, "dependency_failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scheduler fails a timed out subtask after retry limit", async () => {
  const { root, store } = await fixture();
  try {
    const job = createJob("timeout test");
    job.status = "running";
    job.subtasks = [planTask("Add an API function and tests").subtasks[0]];
    await store.create(job);
    const runner = async () => new Promise(() => {});
    const result = await new DependencyScheduler({ store, runner, maxParallel: 3, timeoutMs: 5, maxRetries: 1 }).run(job.job_id);
    assert.equal(result.subtasks[0].status, "failed");
    assert.equal(result.subtasks[0].error, "timeout");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("service cancellation marks an active job and its subtasks cancelled", async () => {
  const { root, store, workspaceManager } = await fixture();
  try {
    const service = new OrchestrationService({ store, workspaceManager, runner: createMockAgentRunner({ delayMs: 100 }), schedulerOptions: { timeoutMs: 500 } });
    const created = await service.createJob("Add an API function and tests");
    await new Promise(resolve => setTimeout(resolve, 15));
    const cancelled = await service.cancelJob(created.job_id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.subtasks.every(item => isTerminal(item.status)), true);
    assert.equal(cancelled.subtasks.filter(item => item.workspace).every(item => item.workspace.state === "cancelled"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("service completes the non-blocking MVP job with a final result", async () => {
  const { root, store, workspaceManager } = await fixture();
  try {
    const history = [];
    let observedWorkspace;
    const service = new OrchestrationService({ store, workspaceManager, runner: async ({ workspace, subtask }) => {
      observedWorkspace = workspace;
      return { status: "completed", summary: "ok", changed_files: [], tests: subtask.role === "qa" ? ["mock QA passed"] : [], warnings: [], error: null };
    }, schedulerOptions: { timeoutMs: 2000 }, onStatusChange: job => history.push(job.status) });
    const created = await service.createJob("Add an API function and tests");
    assert.match(created.job_id, /^[0-9a-f-]{36}$/);
    assert.equal(created.status, "queued");
    let job;
    for (let i = 0; i < 600; i += 1) {
      job = await service.getStatus(created.job_id);
      if (job.status === "completed") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(job.status, "completed");
    assert.equal((await service.getResult(created.job_id)).final_decision, "approved");
    assert.ok(observedWorkspace.workspace_path);
    const finalResult = await service.getResult(created.job_id);
    assert.equal(finalResult.workspaces.length, 3);
    assert.equal(finalResult.aggregate.conflicts.length, 0);
    assert.equal(finalResult.review.final_decision, "approved");
    assert.equal(finalResult.test_evidence.status, "passed");
    assert.deepEqual(history, ["planning", "running", "integrating", "reviewing", "completed"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("service runs backend and QA through the real adapter in parallel and preserves workspaces", async () => {
  const { root, store, workspaceManager } = await fixture();
  try {
    const activeWorkspaces = new Set();
    let maxActive = 0;
    let active = 0;
    const runner = createRealAgentAdapter({
      review: async input => {
        const match = input.task.match(/assigned workspace: ([^\n]+)/);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (match) activeWorkspaces.add(match[1]);
        await new Promise(resolve => setTimeout(resolve, 20));
        active -= 1;
        return { final_status: "CONSENSUS", decision: { status: "agree", ready_to_merge: true, critical_issues: [], recommended_changes: [] } };
      }
    });
    const service = new OrchestrationService({
      store,
      workspaceManager,
      runner,
      schedulerOptions: { maxParallel: 2, timeoutMs: 500 },
      testRunner: createMockTestRunner()
    });
    const created = await service.createJob("Add an API function and tests");
    const immediate = await service.getStatus(created.job_id);
    assert.equal(created.status, "queued");
    assert.ok(["queued", "planning", "running"].includes(immediate.status));
    let job;
    for (let i = 0; i < 600; i += 1) {
      job = await service.getStatus(created.job_id);
      if (job.status === "completed") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(job.status, "completed");
    assert.equal(maxActive, 2);
    assert.equal(activeWorkspaces.size, 3);
    assert.equal(job.subtasks.filter(item => item.status === "completed").length, 3);
    assert.equal(job.test_evidence.status, "passed");
    assert.equal(job.result.aggregate.workspaces.length, 3);
    assert.equal(job.result.review.final_decision, "approved");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("service fails after a failed project test gate and saves evidence", async () => {
  const { root, store, workspaceManager } = await fixture();
  try {
    const service = new OrchestrationService({
      store,
      workspaceManager,
      testRunner: createMockTestRunner({ result: { status: "failed", exit_code: 1, stdout: "", stderr: "project test failed" } })
    });
    const created = await service.createJob("Add an API function and tests");
    let job;
    for (let i = 0; i < 300; i += 1) {
      job = await service.getStatus(created.job_id);
      if (job.status === "failed" && job.result) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(job.status, "failed");
    assert.equal(job.test_evidence.status, "failed");
    assert.equal(job.result.review.final_decision, "rejected");
    assert.equal(job.result.test_evidence.status, "failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("service exposes a failed lifecycle when an agent cannot complete", async () => {
  const { root, store, workspaceManager } = await fixture();
  try {
    const history = [];
    const service = new OrchestrationService({
      store,
      workspaceManager,
      runner: createMockAgentRunner({ failuresBeforeSuccess: { "backend-1": 10 } }),
      schedulerOptions: { timeoutMs: 100, maxRetries: 0 },
      onStatusChange: job => history.push(job.status)
    });
    const created = await service.createJob("Add an API function and tests");
    let job;
    for (let i = 0; i < 50; i += 1) {
      job = await service.getStatus(created.job_id);
      if (job.status === "failed" && history.includes("failed")) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(job.status, "failed");
    assert.deepEqual(history, ["planning", "running", "integrating", "reviewing", "failed"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
