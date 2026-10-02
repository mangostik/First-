import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AGENT_REGISTRY, getAgentDefinition } from "../src/orchestration/agent-registry.js";
import { planTask, selectRoles } from "../src/orchestration/planner.js";
import { createJob } from "../src/orchestration/schemas.js";
import { JsonJobStore } from "../src/orchestration/job-store.js";
import { DependencyScheduler } from "../src/orchestration/scheduler.js";
import { integrateSubtasks } from "../src/orchestration/integrator.js";
import { createMockJobReviewer } from "../src/orchestration/reviewer.js";
import { OrchestrationService } from "../src/orchestration/service.js";
import { WorkspaceManager } from "../src/orchestration/workspace.js";
import { createMockAgentRunner } from "../src/orchestration/agent-runner.js";

test("all routed roles have explicit safe role templates", () => {
  for (const role of ["frontend", "database", "security", "documentation"]) {
    const definition = getAgentDefinition(role);
    for (const field of ["purpose", "allowed_task_types", "input_context", "result_format", "constraints", "completion_criteria", "required_tests"]) {
      assert.ok(definition[field]);
    }
  }
  assert.equal(Object.keys(AGENT_REGISTRY).includes("reviewer"), true);
});

test("planner routes coding work without scheduling a reviewer as a coding agent", () => {
  const plan = planTask("Create a frontend dashboard screen");
  assert.deepEqual(plan.required_agents, ["frontend"]);
  assert.deepEqual(plan.subtasks.map(item => item.id), ["frontend-1"]);
});

test("planner routes multiple coding roles independently", () => {
  const plan = planTask("Add an API endpoint, frontend screen, database migration, security authorization review, documentation and tests");
  assert.deepEqual(plan.required_agents, ["backend", "qa", "frontend", "database", "security", "documentation"]);
  assert.ok(plan.subtasks.every(item => item.dependencies.length === 0));
});

test("unknown task gets a safe backend clarification fallback", () => {
  const routing = selectRoles("Investigate an unclassified business request");
  const plan = planTask("Investigate an unclassified business request");
  assert.deepEqual(routing, { roles: ["backend"], fallback: true });
  assert.match(plan.subtasks[0].instructions, /safe fallback/i);
});

test("independent coding roles run in parallel without putting reviewer on the coding scheduler", async () => {
  const root = await mkdtemp(join(tmpdir(), "fishcrm-role-routing-"));
  try {
    const store = new JsonJobStore(root);
    const job = createJob("frontend and database task");
    job.status = "running";
    job.subtasks = planTask("Create a frontend screen and database migration").subtasks;
    await store.create(job);
    let active = 0;
    let maximum = 0;
    const started = [];
    let releaseWhenBothStarted;
    const bothStarted = new Promise(resolve => { releaseWhenBothStarted = resolve; });
    const result = await new DependencyScheduler({
      store,
      maxParallel: 2,
      timeoutMs: 5_000,
      maxRetries: 0,
      runner: async ({ subtask, signal }) => {
        started.push(subtask.id);
        active += 1;
        maximum = Math.max(maximum, active);
        if (started.length === 2) releaseWhenBothStarted();
        let onAbort;
        try {
          await Promise.race([
            bothStarted,
            new Promise((_, reject) => {
              onAbort = () => reject(new Error("runner cancelled before both roles started"));
              if (signal?.aborted) onAbort();
              else signal?.addEventListener("abort", onAbort, { once: true });
            })
          ]);
        } finally {
          if (onAbort) signal?.removeEventListener("abort", onAbort);
          active -= 1;
        }
        return { status: "completed", summary: `${subtask.role} complete`, changed_files: [], tests: [`${subtask.role} test passed`], warnings: [], error: null };
      }
    }).run(job.job_id);
    assert.equal(maximum, 2);
    assert.equal(result.subtasks.every(item => item.status === "completed"), true);
    assert.deepEqual(started.sort(), ["database-1", "frontend-1"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("new role results pass Integrator and Reviewer", async () => {
  const subtasks = ["frontend", "database", "security", "documentation"].map((role, index) => ({
    id: `${role}-1`, role, status: "completed", workspace: null,
    result: { status: "completed", summary: `${role} complete`, changed_files: [`${role}.md`], tests: [`${role} checks passed`], warnings: [], error: null },
    dependencies: [], attempts: 1, timestamps: { completed: new Date().toISOString() }
  }));
  const aggregate = integrateSubtasks({ subtasks });
  const review = await createMockJobReviewer().review({ task: "multi-role task", aggregate, testEvidence: { status: "passed" } });
  assert.equal(aggregate.conflicts.length, 0);
  assert.equal(review.final_decision, "approved");
});

test("max-subtask limit applies to routed roles", async () => {
  const root = await mkdtemp(join(tmpdir(), "fishcrm-role-limit-"));
  try {
    const store = new JsonJobStore(root);
    const workspaceManager = new WorkspaceManager({ rootDir: join(root, "workspaces"), repoRoot: root, allowedRoot: root, git: async () => ({}) });
    const service = new OrchestrationService({ store, workspaceManager, runner: createMockAgentRunner() });
    service.limits.maxSubtasks = 3;
    const created = await service.createJob("Add an API endpoint, frontend screen, database migration, security review, documentation and tests");
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
