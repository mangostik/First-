import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrateGitChanges } from "../src/orchestration/integrator.js";
import { createRealTestRunner } from "../src/orchestration/test-runner.js";
import { WorkspaceManager } from "../src/orchestration/workspace.js";
import { JsonJobStore } from "../src/orchestration/job-store.js";
import { OrchestrationService } from "../src/orchestration/service.js";
import { createMockJobReviewer, createRealJobReviewer } from "../src/orchestration/reviewer.js";

const exec = promisify(execFile);
async function git(cwd, ...args) { return exec("git", args, { cwd, windowsHide: true }); }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-integration-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "--initial-branch=base");
  await git(repo, "config", "user.email", "integration-test@example.invalid");
  await git(repo, "config", "user.name", "Integration Test");
  await writeFile(join(repo, "shared.txt"), "base\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base");
  const manager = new WorkspaceManager({ repoRoot: repo, allowedRoot: root, rootDir: join(root, "workspaces") });
  const workspaces = [];
  const cleanup = async () => { for (const workspace of workspaces.reverse()) await manager.cleanup(workspace).catch(() => {}); await rm(root, { recursive: true, force: true }); };
  return { repo, manager, workspaces, cleanup };
}

function subtask(id, workspace, file, content) {
  return { id, status: "completed", allowed_files: [file], workspace, result: { status: "completed", summary: id, changed_files: [file], tests: [`${id} passed`], warnings: [], error: null } , content };
}

async function runReviewerService(reviewer, label) {
  const ctx = await fixture();
  try {
    const service = new OrchestrationService({
      store: new JsonJobStore(join(ctx.repo, `.jobs-${label}`)),
      workspaceManager: ctx.manager,
      runner: async ({ workspace }) => {
        await writeFile(join(workspace.workspace_path, "reviewed-file.txt"), "verified change\n");
        return { status: "completed", execution_mode: "real", git_verified: true, summary: "changed file", changed_files: [], tests: ["coding check passed"], warnings: [], error: null };
      },
      planner: () => ({ subtasks: [
        { id: "agent-a", role: "backend", title: "change file", instructions: "change file", allowed_files: ["reviewed-file.txt"], dependencies: [], status: "queued" }
      ], dependencies: [], required_agents: ["backend"], risk_level: "low", acceptance_criteria: [] }),
      reviewer,
      testRunner: { mode: "mock", async run() { return { status: "passed", command: "reviewer-fixture:test", exit_code: 0, stdout: "", stderr: "", duration_ms: 0, error: null }; } },
      schedulerOptions: { maxRetries: 0, timeoutMs: 2_000, jobTimeoutMs: 5_000 }
    });
    service.baseRef = "base";
    const created = await service.createJob(`Reviewer outcome ${label}`);
    await service.processes.get(created.job_id);
    return await service.getStatus(created.job_id);
  } finally {
    await ctx.cleanup();
  }
}

test("approved mock Reviewer adds no remaining work", async () => {
  const job = await runReviewerService(createMockJobReviewer(), "approved");
  assert.equal(job.status, "completed");
  assert.equal(job.aggregate.remaining_work.length, 0);
  assert.equal(job.result.remaining_work.length, 0);
});

test("rejected Reviewer decision is explicit remaining work", async () => {
  const reviewer = createRealJobReviewer({ review: async () => ({
    final_status: "FINAL_DECISION", coverage_complete: true,
    decision: { status: "needs_changes", ready_to_merge: false, critical_issues: ["change needed"], recommended_changes: [] }
  }) });
  const job = await runReviewerService(reviewer, "rejected");
  assert.notEqual(job.status, "completed");
  assert.ok(job.aggregate.remaining_work.some(item => item.includes("REVIEW_REJECTED") && item.includes("Reviewer rejected")));
});

test("structured Reviewer TIMEOUT is preserved in remaining work", async () => {
  const credential = "reviewer-fixture-secret-marker";
  const reviewer = createRealJobReviewer({ review: async () => ({
    final_status: "TIMEOUT", coverage_complete: false, reason: `Authorization: Bearer ${credential}`,
    error: { code: "MCP_REVIEW_TIMEOUT", message: `Authorization: Bearer ${credential}` },
    decision: {
      status: "blocked", ready_to_merge: false,
      critical_issues: [`Review timed out: Authorization: Bearer ${credential}`],
      recommended_changes: [`API_KEY=${credential}`]
    }
  }) });
  const job = await runReviewerService(reviewer, "timeout");
  assert.notEqual(job.status, "completed");
  assert.ok(job.aggregate.remaining_work.some(item => item.includes("MCP_REVIEW_TIMEOUT/TIMEOUT") && item.includes("REDACTED")));
  assert.equal(job.result.review.failure_reason.includes(credential), false);
  assert.equal(job.result.review.review_findings.some(item => item.includes(credential)), false);
  assert.equal(JSON.stringify(job.result.review).includes(credential), false);
});

test("structured Reviewer cancellation is preserved in remaining work", async () => {
  const reviewer = createRealJobReviewer({ review: async () => ({
    final_status: "CANCELLED", coverage_complete: false, reason: "review cancelled",
    error: { code: "MCP_REVIEW_CANCELLED", message: "review cancelled" },
    decision: { status: "blocked", ready_to_merge: false, critical_issues: ["Review cancelled"], recommended_changes: [] }
  }) });
  const job = await runReviewerService(reviewer, "cancelled");
  assert.notEqual(job.status, "completed");
  assert.ok(job.aggregate.remaining_work.some(item => item.includes("MCP_REVIEW_CANCELLED/CANCELLED") && item.includes("review cancelled")));
});

test("rejected Reviewer promise is normalized once and redacted", async () => {
  const reviewer = {
    mode: "real",
    async review() {
      const error = new Error("provider rejected Authorization: Bearer bearer-secret API_KEY=sk-1234567890");
      error.code = "PROVIDER_FAILURE";
      throw error;
    }
  };
  const job = await runReviewerService(reviewer, "promise-reject");
  assert.notEqual(job.status, "completed");
  const records = job.aggregate.remaining_work.filter(item => item.includes("reviewer [PROVIDER_FAILURE/FAILED]"));
  assert.equal(records.length, 1);
  assert.doesNotMatch(records[0], /bearer-secret|sk-1234567890|API_KEY=/i);
  assert.ok(records[0].length <= 550);
  assert.doesNotMatch(JSON.stringify(job.result.review), /bearer-secret|sk-1234567890|API_KEY=/i);
});

test("integrator applies both agent Git diffs and exposes the result ref", async () => {
  const ctx = await fixture();
  try {
    const a = await ctx.manager.create({ jobId: "merge-success", subtaskId: "agent-a", baseRef: "base" });
    const b = await ctx.manager.create({ jobId: "merge-success", subtaskId: "agent-b", baseRef: "base" });
    ctx.workspaces.push(a, b);
    await writeFile(join(a.workspace_path, "a.txt"), "from a\n");
    await writeFile(join(b.workspace_path, "b.txt"), "from b\n");
    const aggregate = await integrateGitChanges({ job_id: "merge-success", subtasks: [subtask("agent-a", a, "a.txt"), subtask("agent-b", b, "b.txt")] }, { workspaceManager: ctx.manager });
    assert.equal(aggregate.integration.status, "applied");
    assert.deepEqual(aggregate.changed_files, ["a.txt", "b.txt"]);
    assert.match(aggregate.integration.final_diff, /a\.txt/);
    assert.match(aggregate.integration.final_diff, /b\.txt/);
    assert.equal(aggregate.workspaces.length, 1);
    assert.equal((await readFile(join(aggregate.workspaces[0].workspace_path, "a.txt"), "utf8")).replaceAll("\r\n", "\n"), "from a\n");
    assert.equal((await readFile(join(aggregate.workspaces[0].workspace_path, "b.txt"), "utf8")).replaceAll("\r\n", "\n"), "from b\n");
    const gate = await createRealTestRunner({ command: [process.execPath, "-e", "const fs=require('node:fs'); process.exit(fs.existsSync('a.txt') && fs.existsSync('b.txt') ? 0 : 1)"] }).run({ workspace: aggregate.workspaces[0] });
    assert.equal(gate.status, "passed", JSON.stringify(gate));
    ctx.workspaces.push(aggregate.workspaces[0]);
  } finally { await ctx.cleanup(); }
});

test("integrator refuses same-file changes without applying either diff", async () => {
  const ctx = await fixture();
  try {
    const a = await ctx.manager.create({ jobId: "merge-conflict", subtaskId: "agent-a", baseRef: "base" });
    const b = await ctx.manager.create({ jobId: "merge-conflict", subtaskId: "agent-b", baseRef: "base" });
    ctx.workspaces.push(a, b);
    await writeFile(join(a.workspace_path, "shared.txt"), "from a\n");
    await writeFile(join(b.workspace_path, "shared.txt"), "from b\n");
    const aggregate = await integrateGitChanges({ job_id: "merge-conflict", subtasks: [subtask("agent-a", a, "shared.txt"), subtask("agent-b", b, "shared.txt")] }, { workspaceManager: ctx.manager });
    assert.equal(aggregate.integration.status, "failed");
    assert.equal(aggregate.integration.error, "coding_agent_file_conflict");
    assert.equal(aggregate.workspaces.length, 0);
    assert.match(aggregate.conflicts[0], /shared\.txt/);
  } finally { await ctx.cleanup(); }
});

test("integrator refuses a Git change outside the assigned path", async () => {
  const ctx = await fixture();
  try {
    const a = await ctx.manager.create({ jobId: "merge-unauthorized", subtaskId: "agent-a", baseRef: "base" });
    ctx.workspaces.push(a);
    await writeFile(join(a.workspace_path, "allowed.txt"), "allowed\n");
    await writeFile(join(a.workspace_path, "secret.txt"), "unexpected\n");
    const aggregate = await integrateGitChanges({ job_id: "merge-unauthorized", subtasks: [subtask("agent-a", a, "allowed.txt")] }, { workspaceManager: ctx.manager });
    assert.equal(aggregate.workspaces.length, 0);
    assert.match(aggregate.conflicts[0], /unauthorized Git changes/);
    assert.match(aggregate.conflicts[0], /secret\.txt/);
  } finally { await ctx.cleanup(); }
});

test("service ends failed when integration reports a file conflict", async () => {
  const ctx = await fixture();
  try {
    const service = new OrchestrationService({
      store: new JsonJobStore(join(ctx.repo, ".jobs")),
      workspaceManager: ctx.manager,
      runner: async ({ workspace }) => {
        await writeFile(join(workspace.workspace_path, "shared.txt"), `${workspace.subtask_id}\n`);
        return { status: "completed", summary: "changed shared file", changed_files: ["shared.txt"], tests: [], warnings: [], error: null };
      },
      planner: () => ({ subtasks: [
        { id: "agent-a", role: "backend", title: "a", instructions: "a", allowed_files: ["shared.txt"], dependencies: [], status: "queued" },
        { id: "agent-b", role: "backend", title: "b", instructions: "b", allowed_files: ["shared.txt"], dependencies: [], status: "queued" }
      ], dependencies: [], required_agents: ["backend"], risk_level: "low", acceptance_criteria: [] }),
      reviewer: { mode: "mock", async review({ aggregate, testEvidence }) { const approved = aggregate.conflicts.length === 0 && testEvidence.status === "passed"; return { final_decision: approved ? "approved" : "rejected", summary: "conflict check", review_findings: aggregate.conflicts, approved }; } },
      testRunner: { mode: "mock", async run() { return { status: "passed", command: "conflict fixture", exit_code: 0, stdout: "", stderr: "", duration_ms: 0, error: null }; } },
      schedulerOptions: { maxParallel: 2, maxRetries: 0, timeoutMs: 2_000, jobTimeoutMs: 5_000 }
    });
    service.baseRef = "base";
    const created = await service.createJob("conflict integration");
    await service.processes.get(created.job_id);
    const job = await service.getStatus(created.job_id);
    assert.equal(job.status, "failed");
    assert.equal(job.result.final_decision, "rejected");
    assert.ok(job.aggregate.conflicts.length > 0);
  } finally { await ctx.cleanup(); }
});

test("service tests the result worktree and preserves reviewer failure as remaining work", async () => {
  const ctx = await fixture();
  try {
    let testedWorkspace;
    const service = new OrchestrationService({
      store: new JsonJobStore(join(ctx.repo, ".jobs-reviewer-error")),
      workspaceManager: ctx.manager,
      runner: async ({ workspace }) => {
        await writeFile(join(workspace.workspace_path, "agent-change.txt"), "verified change\n");
        return { status: "completed", execution_mode: "real", git_verified: true, summary: "changed file", changed_files: [], tests: [], warnings: [], error: null };
      },
      planner: () => ({ subtasks: [
        { id: "agent-a", role: "backend", title: "a", instructions: "a", allowed_files: ["agent-change.txt"], dependencies: [], status: "queued" }
      ], dependencies: [], required_agents: ["backend"], risk_level: "low", acceptance_criteria: [] }),
      reviewer: { mode: "real", async review() { throw new Error(`review failed api_key=sk-1234567890${"x".repeat(700)}`); } },
      testRunner: { mode: "real", async run({ workspace }) {
        testedWorkspace = workspace;
        assert.equal(workspace.subtask_id, "integrated-result");
        assert.equal((await readFile(join(workspace.workspace_path, "agent-change.txt"), "utf8")).replaceAll("\r\n", "\n"), "verified change\n");
        return { status: "passed", command: "result-worktree:test", exit_code: 0, stdout: "", stderr: "", duration_ms: 0, error: null };
      } },
      schedulerOptions: { maxRetries: 0, timeoutMs: 2_000, jobTimeoutMs: 5_000 }
    });
    service.baseRef = "base";
    const created = await service.createJob("reviewer failure fixture");
    await service.processes.get(created.job_id);
    const job = await service.getStatus(created.job_id);
    assert.equal(job.status, "failed");
    assert.equal(job.test_evidence.status, "passed", JSON.stringify(job.test_evidence));
    assert.equal(testedWorkspace.workspace_path, job.aggregate.integration.result_workspace);
    const reviewerFailure = job.aggregate.remaining_work.find(item => item.startsWith("reviewer [REVIEW_FAILED/FAILED]"));
    assert.ok(reviewerFailure);
    assert.ok(reviewerFailure.length < 550);
    assert.doesNotMatch(reviewerFailure, /sk-1234567890/);
    assert.equal(job.result.review.final_decision, "rejected");
  } finally { await ctx.cleanup(); }
});
