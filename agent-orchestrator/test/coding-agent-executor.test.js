import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexArgs, createCodingAgentAdapter } from "../src/orchestration/coding-agent-executor.js";
import { JsonJobStore } from "../src/orchestration/job-store.js";
import { validateAgentResult } from "../src/orchestration/schemas.js";
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

function adapter(workspaceRoot, extraEnv = {}, timeoutMs = 2_000, options = {}) {
  return createCodingAgentAdapter({
    command: process.execPath,
    argsBuilder: nodeArgs,
    workspaceRoot,
    timeoutMs,
    killGraceMs: 100,
    env: process.env,
    extraEnv,
    ...options
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

test("Codex runtime keeps workspace-write while selecting an explicit Windows sandbox backend", () => {
  const args = codexArgs({
    workspacePath: "C:\\bounded-worktree",
    model: "",
    windowsSandbox: "unelevated"
  });
  assert.deepEqual(args.slice(0, 8), [
    "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "--config", "windows.sandbox=\"unelevated\"", "--sandbox", "workspace-write"
  ]);
});

test("native Windows Codex runtime fails closed without an explicit sandbox backend", () => {
  if (process.platform !== "win32") return;
  assert.throws(
    () => createCodingAgentAdapter({ command: "codex", workspaceRoot: "C:\\bounded-root" }),
    /windowsSandbox must be elevated or unelevated/
  );
});

test("read-only sandbox preflight fails before the model process starts", async () => {
  const ctx = await fixture();
  let modelSpawns = 0;
  try {
    const workspace = await ctx.createWorkspace("job-read-only", "agent-read-only");
    const runner = createCodingAgentAdapter({
      command: "codex",
      workspaceRoot: ctx.workspaces,
      windowsSandbox: "unelevated",
      sandboxPreflight: async () => ({
        ok: false,
        error: "coding_agent_sandbox_read_only",
        diagnostics: {
          exit_code: 1,
          signal: null,
          termination_reason: null,
          stdout_excerpt: "",
          stderr_excerpt: "sandbox: read-only; write blocked by policy",
          stdout_truncated: false,
          stderr_truncated: false
        }
      }),
      spawnProcess: () => {
        modelSpawns += 1;
        throw new Error("model process must not start");
      }
    });
    const result = await runner.run({
      subtask: subtask("agent-read-only", "blocked.txt"),
      workspace
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error, "coding_agent_sandbox_read_only");
    assert.equal(modelSpawns, 0);
    await assert.rejects(access(join(workspace.workspace_path, "blocked.txt")));
  } finally { await ctx.cleanup(); }
});

test("writable preflight allows the controlled local agent to modify its workspace", async () => {
  const ctx = await fixture();
  let preflightVerified = false;
  try {
    const workspace = await ctx.createWorkspace("job-preflight-write", "agent-write");
    const result = await adapter(ctx.workspaces, {}, 2_000, {
      sandboxPreflight: async ({ workspacePath }) => {
        const probe = join(workspacePath, ".controlled-write-probe");
        await writeFile(probe, "ok", "utf8");
        await rm(probe);
        preflightVerified = true;
        return { ok: true };
      }
    }).run({ subtask: subtask("agent-write", "written.txt"), workspace });
    assert.equal(preflightVerified, true);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.changed_files, ["written.txt"]);
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
    assert.equal(result.diagnostics.exit_code, 0);
    assert.equal(result.diagnostics.termination_reason, null);
  } finally { await ctx.cleanup(); }
});

test("coding agent records bounded diagnostics for a failed process", async () => {
  const ctx = await fixture();
  try {
    const workspace = await ctx.createWorkspace("job-process-error", "agent-error");
    const result = await adapter(ctx.workspaces, {
      TEST_AGENT_MODE: "error",
      TEST_AGENT_EXIT_CODE: "7",
      TEST_AGENT_STDERR: "controlled process failure"
    }).run({ subtask: subtask("agent-error", "error.txt"), workspace });
    assert.equal(result.status, "failed");
    assert.equal(result.error, "coding_agent_process_failed");
    assert.equal(result.diagnostics.exit_code, 7);
    assert.equal(result.diagnostics.termination_reason, null);
    assert.match(result.diagnostics.stderr_excerpt, /controlled process failure/);
  } finally { await ctx.cleanup(); }
});

test("coding agent truncates long diagnostic output", async () => {
  const ctx = await fixture();
  try {
    const workspace = await ctx.createWorkspace("job-long-output", "agent-long");
    const result = await adapter(ctx.workspaces, {
      TEST_AGENT_MODE: "empty",
      TEST_AGENT_STDOUT: "x".repeat(5_000)
    }, 2_000, { maxOutputBytes: 256, diagnosticExcerptChars: 80 }).run({
      subtask: subtask("agent-long", "long.txt"), workspace
    });
    assert.equal(result.error, "coding_agent_empty_diff");
    assert.equal(result.diagnostics.stdout_excerpt.length, 80);
    assert.equal(result.diagnostics.stdout_truncated, true);
  } finally { await ctx.cleanup(); }
});

test("coding agent redacts secrets before diagnostics survive schema validation", async () => {
  const ctx = await fixture();
  try {
    const workspace = await ctx.createWorkspace("job-secret-output", "agent-secret");
    const secret = "sk-1234567890abcdef";
    const result = await adapter(ctx.workspaces, {
      TEST_AGENT_MODE: "empty",
      TEST_AGENT_STDOUT: `token=plain-secret ${secret}`,
      TEST_AGENT_STDERR: "Authorization: Bearer top-secret-value"
    }).run({ subtask: subtask("agent-secret", "secret.txt"), workspace });
    const persisted = validateAgentResult(result);
    const serialized = JSON.stringify(persisted.diagnostics);
    assert.doesNotMatch(serialized, /plain-secret|1234567890abcdef|top-secret-value/);
    assert.match(serialized, /REDACTED/);
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
