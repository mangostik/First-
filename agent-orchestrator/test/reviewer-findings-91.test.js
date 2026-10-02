import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createJob, validateDependency, validateFinalJobResult, validateReviewResult } from "../src/orchestration/schemas.js";
import { JsonJobStore } from "../src/orchestration/job-store.js";
import { DependencyScheduler } from "../src/orchestration/scheduler.js";
import { OrchestrationService } from "../src/orchestration/service.js";
import { WorkspaceManager } from "../src/orchestration/workspace.js";
import { createMockAgentRunner } from "../src/orchestration/agent-runner.js";
import { createRealJobReviewer } from "../src/orchestration/reviewer.js";
import { requestWithTimeout } from "../src/providers/http.js";
import { runProviderReviewLoop } from "../src/review-loop.js";

const exec = promisify(execFile);
async function git(cwd, ...args) { return exec("git", args, { cwd, windowsHide: true }); }

async function withGitFixture(run, { gitCommand = git, onRootCreated = () => {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "fishcrm-findings-91-cancel-"));
  try {
    onRootCreated(root);
    const repo = join(root, "repo");
    await mkdir(repo);
    await gitCommand(repo, "init", "--initial-branch=base");
    await gitCommand(repo, "config", "user.email", "reviewer-findings@example.invalid");
    await gitCommand(repo, "config", "user.name", "Reviewer Findings Test");
    await writeFile(join(repo, "README.md"), "base\n");
    await gitCommand(repo, "add", ".");
    await gitCommand(repo, "commit", "-m", "base");
    return await run({ root, repo });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fishcrm-findings-91-"));
  return { root, store: new JsonJobStore(root), workspaceManager: new WorkspaceManager({
    rootDir: join(root, "workspaces"), repoRoot: root, allowedRoot: root, useGit: false
  }) };
}

async function oneTask(store, label) {
  const job = createJob(label);
  job.status = "running";
  job.subtasks = [{ id: "backend", role: "backend", title: label, instructions: label, dependencies: [], status: "queued" }];
  await store.create(job);
  return job;
}

test("job-level real reviewer cannot approve failed work despite provider approval", async () => {
  const reviewer = createRealJobReviewer({ review: async () => ({
    final_status: "FINAL_DECISION", coverage_complete: true,
    decision: { status: "agree", ready_to_merge: true, critical_issues: [], recommended_changes: [] }
  }) });
  const result = await reviewer.review({ task: "x", aggregate: {
    summary: "incomplete", changed_files: [], tests: ["passed"], warnings: [], conflicts: [],
    remaining_work: ["backend failed"], workspaces: []
  }, testEvidence: { status: "passed" } });
  assert.equal(result.approved, false);
  assert.equal(result.final_decision, "rejected");
  assert.ok(result.review_findings.includes("backend failed"));
});

test("scheduler treats a failed agent result as failed work", async () => {
  const { root, store } = await fixture();
  try {
    const job = await oneTask(store, "failed result");
    const failedAgentResult = {
      status: "failed",
      summary: "Coding agent produced no Git diff",
      changed_files: [],
      tests: [],
      warnings: [],
      error: "coding_agent_empty_diff",
      diagnostics: {
        exit_code: 0,
        signal: null,
        termination_reason: null,
        stdout_excerpt: "bounded diagnostic",
        stderr_excerpt: "",
        stdout_truncated: false,
        stderr_truncated: false
      }
    };
    const scheduler = new DependencyScheduler({ store, runner: async () => failedAgentResult, maxRetries: 0 });
    const result = await scheduler.run(job.job_id);
    assert.equal(result.subtasks[0].status, "failed");
    assert.equal(result.subtasks[0].error, "coding_agent_empty_diff");
    assert.equal(result.subtasks[0].result.error, "coding_agent_empty_diff");
    assert.equal(result.subtasks[0].result.diagnostics.exit_code, 0);
    assert.equal(result.subtasks[0].result.diagnostics.stdout_excerpt, "bounded diagnostic");
    const persisted = await store.get(job.job_id);
    assert.deepEqual(persisted.subtasks[0].result, result.subtasks[0].result);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancelling one job on a shared scheduler does not abort another job", async () => {
  const { root, store } = await fixture();
  try {
    const first = await oneTask(store, "first");
    const second = await oneTask(store, "second");
    const scheduler = new DependencyScheduler({ store, maxParallel: 2, timeoutMs: 200, maxRetries: 0, runner: ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ status: "completed", summary: "ok" }), 40);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true });
    }) });
    const runningFirst = scheduler.run(first.job_id);
    const runningSecond = scheduler.run(second.job_id);
    for (let i = 0; i < 50 && !scheduler.activeFor(first.job_id).length; i += 1) await delay(2);
    assert.equal(scheduler.activeFor(first.job_id).length, 1);
    await scheduler.cancel(first.job_id);
    await Promise.all([runningFirst, runningSecond]);
    assert.equal((await store.get(first.job_id)).status, "cancelled");
    assert.equal((await store.get(second.job_id)).subtasks[0].status, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("timed-out runner is signalled and not retried while it may still execute", async () => {
  const { root, store } = await fixture();
  try {
    const job = await oneTask(store, "timeout");
    let calls = 0;
    let aborted = false;
    const scheduler = new DependencyScheduler({ store, maxRetries: 2, timeoutMs: 5, runner: ({ signal }) => {
      calls += 1;
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    } });
    const result = await scheduler.run(job.job_id);
    assert.equal(result.subtasks[0].status, "failed");
    assert.equal(result.subtasks[0].error, "timeout");
    assert.equal(calls, 1);
    assert.equal(aborted, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("timed-out runner keeps its active slot quarantined until it settles", async () => {
  const { root, store } = await fixture();
  try {
    const job = await oneTask(store, "quarantine timeout");
    let finished = false;
    const scheduler = new DependencyScheduler({ store, maxRetries: 2, timeoutMs: 5, runner: async () => {
      await delay(40);
      finished = true;
      return { status: "completed", summary: "late", changed_files: [], tests: [], warnings: [], error: null };
    } });
    const result = await scheduler.run(job.job_id);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "timeout");
    assert.equal(scheduler.activeFor(job.job_id).length, 1);
    await delay(60);
    assert.equal(finished, true);
    assert.equal(scheduler.activeFor(job.job_id).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scheduler options cannot raise configured safety limits", async () => {
  const { root, store, workspaceManager } = await fixture();
  try {
    const service = new OrchestrationService({ store, workspaceManager, runner: createMockAgentRunner(), schedulerOptions: {
      maxSubtasks: 999, maxParallel: 999, maxRetries: 999, timeoutMs: 9999999, jobTimeoutMs: 9999999
    } });
    assert.ok(service.limits.maxParallel <= 3);
    assert.ok(service.limits.maxSubtasks <= 10);
    assert.ok(service.limits.maxRetries <= 1);
    assert.ok(service.limits.subtaskTimeoutMs <= 30000);
    assert.ok(service.limits.jobTimeoutMs <= 300000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("job store validates updater output and preserves the requested job id", async () => {
  const { root, store } = await fixture();
  try {
    const job = await oneTask(store, "store integrity");
    await assert.rejects(() => store.update(job.job_id, current => ({ ...current, job_id: "attacker" })), /cannot change job_id/);
    assert.equal((await store.get(job.job_id)).job_id, job.job_id);
    await assert.rejects(() => store.update(job.job_id, () => ({ status: "queued" })), /cannot change job_id/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Git fixture is removed when initial commit setup fails", async () => {
  let root;
  await assert.rejects(withGitFixture(async () => assert.fail("fixture callback must not run"), {
    onRootCreated: value => { root = value; },
    gitCommand: async (cwd, ...args) => {
      if (args[0] === "commit") throw new Error("injected initial commit failure");
      return git(cwd, ...args);
    }
  }), /injected initial commit failure/);
  await assert.rejects(access(root), { code: "ENOENT" });
});

test("cancellation during test gate prevents job-level review and completion", async () => {
  await withGitFixture(async ({ root, repo }) => {
    const store = new JsonJobStore(join(root, "jobs"));
    const workspaceManager = new WorkspaceManager({
      rootDir: join(root, "workspaces"), repoRoot: repo, allowedRoot: root
    });
    let service;
    let created;
    try {
      let enteredGate;
      const gateStarted = new Promise(resolve => { enteredGate = resolve; });
      let reviewerCalls = 0;
      service = new OrchestrationService({ store, workspaceManager, runner: async ({ workspace }) => {
        await writeFile(join(workspace.workspace_path, "cancel-target.txt"), "verified change\n");
        return { status: "completed", execution_mode: "real", git_verified: true, summary: "changed file", changed_files: [], tests: [], warnings: [], error: null };
      }, planner: () => ({ subtasks: [
        { id: "backend", role: "backend", title: "change file", instructions: "change file", allowed_files: ["cancel-target.txt"], dependencies: [], status: "queued" }
      ], dependencies: [], required_agents: ["backend"], risk_level: "low", acceptance_criteria: [] }), testRunner: {
        mode: "mock", run: ({ signal }) => new Promise((_, reject) => {
          enteredGate();
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(new Error("cancelled"));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        })
      }, reviewer: { review: async () => { reviewerCalls += 1; throw new Error("should not review"); } } });
      service.baseRef = "base";
      created = await service.createJob("Add an API function and tests");
      await Promise.race([
        gateStarted,
        service.processes.get(created.job_id).then(() => { throw new Error("job ended before the test gate started"); })
      ]);
      const cancelled = await service.cancelJob(created.job_id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(reviewerCalls, 0);
      assert.equal(cancelled.result.final_decision, "rejected");
    } finally {
      if (created && service) await service.cancelJob(created.job_id).catch(() => {});
      const job = created ? await store.get(created.job_id).catch(() => null) : null;
      const workspaces = [
        ...(job?.subtasks || []).map(item => item.workspace),
        ...(job?.aggregate?.workspaces || [])
      ].filter(Boolean);
      for (const workspace of workspaces.reverse()) await workspaceManager.cleanup(workspace).catch(() => {});
    }
  });
});

test("schema rejects unsupported dependencies and contradictory review decisions", () => {
  assert.throws(() => validateDependency({ subtask_id: "a", required_status: "unknown" }), /Invalid dependency/);
  assert.throws(() => validateReviewResult({ final_decision: "approved", summary: "x", approved: false }), /must match/);
  assert.throws(() => validateFinalJobResult({ summary: "x", final_decision: "unknown" }), /Invalid final job result/);
});

test("provider timeout wins synchronous fetch abort race", async () => {
  await assert.rejects(requestWithTimeout({ provider: "Claude", timeoutMs: 5, request: signal => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  }) }), error => error.code === "PROVIDER_TIMEOUT");
});

test("invalid loop timeout config uses a finite fallback instead of an immediate deadline", async () => {
  const response = { status: "agree", ready_to_merge: true, critical_issues: [], recommended_changes: [], evidence: [] };
  const result = await runProviderReviewLoop({ task: "x", chunks: ["diff"], config: {
    reviewMode: "cheap", reviewLoopTimeoutMs: Number.NaN, reviewTimeBudgetMs: Number.NaN,
    claudeTimeoutMs: 50, openaiTimeoutMs: 50, maxOutputTokens: 100, maxProviderCalls: 2, costBudgetUsd: 1
  }, promptBuilders: { claude: () => "x", openai: () => "x" }, synthesize: async () => response,
  isConsensus: () => true, emit: () => {}, askClaudeFn: async () => { await delay(5); return response; } });
  assert.equal(result.coverageComplete, true);
  assert.equal(result.chunkResults.length, 1);
});

test("MCP review rejects an invalid explicit deadline before spawning a child", async () => {
  const { runAgentReview } = await import("../src/mcp-runner.js");
  assert.throws(() => runAgentReview({ task: "x" }, { deadlineMs: 0 }), /deadlineMs must be a finite positive number/);
});
