import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodingAgentAdapter } from "../src/orchestration/coding-agent-executor.js";
import { JsonJobStore } from "../src/orchestration/job-store.js";
import { OrchestrationService } from "../src/orchestration/service.js";
import { WorkspaceManager } from "../src/orchestration/workspace.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const testAgent = join(here, "..", "fixtures", "coding-test-agent.mjs");

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd, windowsHide: true });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fishcrm-coding-agent-"));
  const repo = join(root, "repo");
  const workspaces = join(root, "workspaces");
  await mkdir(repo);
  await git(repo, "init", "--initial-branch=pilot-base");
  await git(repo, "config", "user.email", "coding-agent-test@example.invalid");
  await git(repo, "config", "user.name", "Coding Agent Test");
  await writeFile(join(repo, "README.md"), "fixture\n", "utf8");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "fixture");
  const manager = new WorkspaceManager({ repoRoot: repo, allowedRoot: root, rootDir: workspaces });
  const created = [];
  const createWorkspace = async (jobId, subtaskId) => {
    const workspace = await manager.create({ jobId, subtaskId, baseRef: "pilot-base" });
    created.push(workspace);
    return workspace;
  };
  const cleanup = async () => {
    for (const workspace of created.reverse()) await manager.cleanup(workspace).catch(() => {});
    await rm(root, { recursive: true, force: true });
  };
  return { root, repo, workspaces, manager, createWorkspace, cleanup };
}

function nodeArgs({ workspacePath }) {
  return [
    "--permission",
    `--allow-fs-read=${testAgent}`,
    `--allow-fs-write=${workspacePath}`,
    testAgent
  ];
}

function adapter(workspaceRoot, extraEnv = {}, timeoutMs = 2_000) {
  return createCodingAgentAdapter({
    command: process.execPath,
    argsBuilder: nodeArgs,
    workspaceRoot,
    timeoutMs,
    killGraceMs: 100,
    env: process.env,
    extraEnv
  });
}

function subtask(id, file) {
  return { id, role: "backend", instructions: `Create ${file}`, allowed_files: [file] };
}

test("coding agent records a real Git change from its assigned workspace", async () => {
  const ctx = await fixture();
  try {
    const workspace = await ctx.createWorkspace("job-success", "agent-one");
    const result = await adapter(ctx.workspaces).run({ subtask: subtask("agent-one", "agent-one.txt"), workspace });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.changed_files, ["agent-one.txt"]);
    assert.match(await readFile(join(workspace.workspace_path, "agent-one.txt"), "utf8"), /Create agent-one\.txt/);
  } finally { await ctx.cleanup(); }
});

test("coding agent cannot report success with an empty Git diff", async () => {
  const ctx = await fixture();
  try {
    const workspace = await ctx.createWorkspace("job-empty", "agent-empty");
    const result = await adapter(ctx.workspaces, { TEST_AGENT_MODE: "empty" }).run({ subtask: subtask("agent-empty", "empty.txt"), workspace });
    assert.equal(result.status, "failed");
    assert.equal(result.error, "coding_agent_empty_diff");
    assert.deepEqual(result.changed_files, []);
  } finally { await ctx.cleanup(); }
});

test("coding agent process cannot write outside its workspace", async () => {
  const ctx = await fixture();
  try {
    const workspace = await ctx.createWorkspace("job-outside", "agent-outside");
    const result = await adapter(ctx.workspaces, { TEST_AGENT_MODE: "outside" }).run({ subtask: subtask("agent-outside", "inside.txt"), workspace });
    assert.equal(result.status, "failed");
    assert.equal(result.error, "coding_agent_process_failed");
    await assert.rejects(access(join(ctx.workspaces, "job-outside", "outside.txt")));
  } finally { await ctx.cleanup(); }
});

test("coding agent cancellation waits for process exit and leaves no change", async () => {
  const ctx = await fixture();
  try {
    const workspace = await ctx.createWorkspace("job-cancel", "agent-cancel");
    const controller = new AbortController();
    const running = adapter(ctx.workspaces, { TEST_AGENT_DELAY_MS: "1000" }).run({ subtask: subtask("agent-cancel", "cancelled.txt"), workspace, signal: controller.signal });
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(running, /coding_agent_cancelled/);
    await assert.rejects(access(join(workspace.workspace_path, "cancelled.txt")));
  } finally { await ctx.cleanup(); }
});

test("coding agent timeout terminates the process before returning", async () => {
  const ctx = await fixture();
  try {
    const workspace = await ctx.createWorkspace("job-timeout", "agent-timeout");
    await assert.rejects(
      adapter(ctx.workspaces, { TEST_AGENT_DELAY_MS: "1000" }, 40).run({ subtask: subtask("agent-timeout", "timeout.txt"), workspace }),
      /coding_agent_timeout/
    );
    await assert.rejects(access(join(workspace.workspace_path, "timeout.txt")));
  } finally { await ctx.cleanup(); }
});

test("two coding agents overlap in distinct Git workspaces", async () => {
  const ctx = await fixture();
  try {
    const [firstWorkspace, secondWorkspace] = await Promise.all([
      ctx.createWorkspace("job-parallel", "agent-a"),
      ctx.createWorkspace("job-parallel", "agent-b")
    ]);
    assert.notEqual(resolve(firstWorkspace.workspace_path), resolve(secondWorkspace.workspace_path));
    const runner = adapter(ctx.workspaces, { TEST_AGENT_DELAY_MS: "150" });
    const [first, second] = await Promise.all([
      runner.run({ subtask: subtask("agent-a", "alpha.txt"), workspace: firstWorkspace }),
      runner.run({ subtask: subtask("agent-b", "beta.txt"), workspace: secondWorkspace })
    ]);
    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.ok(Date.parse(first.timestamps.started) < Date.parse(second.timestamps.completed));
    assert.ok(Date.parse(second.timestamps.started) < Date.parse(first.timestamps.completed));
    assert.deepEqual(first.changed_files, ["alpha.txt"]);
    assert.deepEqual(second.changed_files, ["beta.txt"]);
  } finally { await ctx.cleanup(); }
});

test("orchestration service schedules two isolated coding processes concurrently", async () => {
  const ctx = await fixture();
  try {
    const makeSubtask = (id, file) => ({
      id,
      role: "backend",
      title: `Create ${file}`,
      instructions: `Create ${file}`,
      allowed_files: [file],
      dependencies: [],
      status: "queued",
      attempts: 0,
      result: null,
      error: null
    });
    const planner = () => ({
      subtasks: [makeSubtask("agent-a", "alpha.txt"), makeSubtask("agent-b", "beta.txt")],
      dependencies: [],
      required_agents: ["backend"],
      risk_level: "low",
      acceptance_criteria: ["alpha.txt and beta.txt exist"]
    });
    const service = new OrchestrationService({
      store: new JsonJobStore(join(ctx.root, "jobs")),
      runner: adapter(ctx.workspaces, { TEST_AGENT_DELAY_MS: "150" }),
      workspaceManager: ctx.manager,
      planner,
      schedulerOptions: { maxParallel: 2, maxRetries: 0, timeoutMs: 2_000, jobTimeoutMs: 5_000 },
      testRunner: {
        mode: "real",
        async run({ aggregate }) {
          assert.equal(aggregate.workspaces.length, 2);
          return {
            status: "passed",
            command: "controlled integration assertions",
            exit_code: 0,
            stdout: "both isolated diffs verified",
            stderr: "",
            duration_ms: 1,
            error: null
          };
        }
      },
      reviewer: {
        mode: "mock",
        async review({ aggregate, testEvidence }) {
          const approved = aggregate.changed_files.length === 2 && testEvidence.status === "passed";
          return { final_decision: approved ? "approved" : "rejected", summary: "controlled mock review", review_findings: [], approved };
        }
      }
    });
    service.baseRef = "pilot-base";

    const created = await service.createJob("Run two bounded coding tasks");
    await service.processes.get(created.job_id);
    const job = await service.getStatus(created.job_id);
    assert.equal(job.status, "completed");
    const [first, second] = job.subtasks;
    assert.notEqual(first.workspace.workspace_path, second.workspace.workspace_path);
    assert.ok(Date.parse(first.result.timestamps.started) < Date.parse(second.result.timestamps.completed));
    assert.ok(Date.parse(second.result.timestamps.started) < Date.parse(first.result.timestamps.completed));
    assert.deepEqual(job.aggregate.changed_files, ["alpha.txt", "beta.txt"]);
    assert.equal(job.test_evidence.status, "passed");
  } finally { await ctx.cleanup(); }
});
