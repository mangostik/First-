import { execFile, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { redactSecrets } from "./observability.js";

const execFileAsync = promisify(execFile);
const SECRET_NAME = /(api[_-]?key|token|secret|password|credential)/i;
const DIAGNOSTIC_SECRET_ASSIGNMENT = /((?:api[_-]?key|authorization|token|password|secret|credential)\s*[:=]\s*)[^\r\n]*/gi;

function finitePositive(value, fallback, name) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  if (value === undefined || value === null || value === "") return fallback;
  throw new Error(`${name} must be a finite positive number`);
}

function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalizeRelativeFile(value) {
  const file = String(value || "").trim().replaceAll("\\", "/");
  if (!file || file.startsWith("/") || /^[A-Za-z]:\//.test(file)) throw new Error("allowed file must be relative");
  const parts = file.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new Error("allowed file escapes workspace");
  return parts.join("/");
}

export function validateAllowedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("coding agent requires non-empty allowed_files");
  return [...new Set(files.map(normalizeRelativeFile))];
}

function safeChildEnvironment(baseEnv, extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(baseEnv || {})) {
    if (SECRET_NAME.test(name) || name === "GITHUB_TOKEN") continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

function splitNullList(value) {
  return String(value || "").split("\0").filter(Boolean).map(item => item.replaceAll("\\", "/"));
}

async function defaultGitChangedFiles(workspacePath) {
  const options = { cwd: workspacePath, windowsHide: true, maxBuffer: 1024 * 1024 };
  const [unstaged, staged, untracked] = await Promise.all([
    execFileAsync("git", ["diff", "--name-only", "-z", "--relative"], options),
    execFileAsync("git", ["diff", "--cached", "--name-only", "-z", "--relative"], options),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], options)
  ]);
  return [...new Set([
    ...splitNullList(unstaged.stdout),
    ...splitNullList(staged.stdout),
    ...splitNullList(untracked.stdout)
  ])].sort();
}

function buildPrompt({ subtask, workspacePath, allowedFiles }) {
  return [
    "You are a coding agent executing one bounded task.",
    `Task: ${subtask.instructions}`,
    `Workspace: ${workspacePath}`,
    "You may modify only these repository-relative files:",
    ...allowedFiles.map(file => `- ${file}`),
    "Work only in the provided workspace. Do not access parent directories, main, other worktrees, secrets, or network credentials.",
    "Do not commit, merge, push, or change Git configuration.",
    "Make the requested file changes and run only the smallest relevant local checks."
  ].join("\n");
}

function normalizeWindowsSandbox(value) {
  const sandbox = String(value || "").trim().toLowerCase();
  if (!new Set(["elevated", "unelevated"]).has(sandbox)) {
    throw new Error("coding agent windowsSandbox must be elevated or unelevated");
  }
  return sandbox;
}

export function codexArgs({ workspacePath, model, windowsSandbox }) {
  const args = [
    "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules"
  ];
  if (windowsSandbox) args.push("--config", `windows.sandbox=${JSON.stringify(windowsSandbox)}`);
  args.push("--sandbox", "workspace-write", "--cd", workspacePath, "--color", "never");
  if (model) args.push("--model", model);
  args.push("-");
  return args;
}

function collectOutput(stream, onChunk) {
  if (!stream) return;
  stream.on("data", chunk => onChunk(Buffer.from(chunk)));
}

function diagnosticExcerpt(value, limit) {
  const assignedRedacted = String(value || "").replace(DIAGNOSTIC_SECRET_ASSIGNMENT, "$1[REDACTED]");
  const redacted = String(redactSecrets(assignedRedacted))
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .trim();
  return { text: redacted.slice(0, limit), truncated: redacted.length > limit };
}

function processDiagnostics(processResult, excerptLimit) {
  const stdout = diagnosticExcerpt(processResult.stdout, excerptLimit);
  const stderr = diagnosticExcerpt(processResult.stderr, excerptLimit);
  return {
    exit_code: processResult.exitCode == null ? null : Number(processResult.exitCode),
    signal: processResult.signal || null,
    termination_reason: processResult.terminationReason || null,
    stdout_excerpt: stdout.text,
    stderr_excerpt: stderr.text,
    stdout_truncated: Boolean(processResult.stdoutTruncated || stdout.truncated),
    stderr_truncated: Boolean(processResult.stderrTruncated || stderr.truncated)
  };
}

function sandboxFailureCode(processResult) {
  const output = `${processResult.stdout || ""}\n${processResult.stderr || ""}`;
  return /read[- ]only|access.+denied|permission.+denied|blocked by policy|policy_denied/i.test(output)
    ? "coding_agent_sandbox_read_only"
    : "coding_agent_sandbox_preflight_failed";
}

function runChild({ command, args, cwd, env, input, signal, timeoutMs, killGraceMs, maxOutputBytes, spawnProcess = spawn, killTree = null }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnProcess(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let spawnError = null;
    let terminationReason = null;
    let closed = false;
    let timeout;
    let forceTimer;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const append = (current, chunk) => Buffer.concat([current, chunk]).subarray(0, maxOutputBytes);
    collectOutput(child.stdout, chunk => { stdoutBytes += chunk.length; stdout = append(stdout, chunk); });
    collectOutput(child.stderr, chunk => { stderrBytes += chunk.length; stderr = append(stderr, chunk); });

    const forceKill = async () => {
      if (closed) return;
      try {
        if (killTree) await killTree(child.pid);
        else if (process.platform === "win32") await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGKILL");
      } catch {}
    };
    const terminate = reason => {
      if (terminationReason) return;
      terminationReason = reason;
      try { child.kill("SIGTERM"); } catch {}
      forceTimer = setTimeout(forceKill, killGraceMs);
      forceTimer.unref?.();
    };
    const onAbort = () => terminate("cancelled");
    if (signal?.aborted) terminate("cancelled");
    else signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    timeout.unref?.();

    child.once("error", error => { spawnError = error; });
    child.once("close", (code, closeSignal) => {
      closed = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      signal?.removeEventListener("abort", onAbort);
      if (spawnError && code == null && !terminationReason) return rejectPromise(spawnError);
      resolvePromise({
        exitCode: code,
        signal: closeSignal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutTruncated: stdoutBytes > stdout.length,
        stderrTruncated: stderrBytes > stderr.length,
        terminationReason
      });
    });
    child.stdin?.end(input);
  });
}

async function runWindowsSandboxPreflight({
  command,
  workspacePath,
  windowsSandbox,
  env,
  timeoutMs,
  killGraceMs,
  maxOutputBytes,
  excerptLimit
}) {
  const probePath = resolve(workspacePath, `.orchestration-write-probe-${randomUUID()}.tmp`);
  const probeScript = [
    "const fs = require('node:fs');",
    "const path = process.argv.at(-1);",
    "fs.writeFileSync(path, 'workspace-write-ok', { flag: 'wx' });",
    "fs.unlinkSync(path);"
  ].join(" ");
  let processResult;
  try {
    processResult = await runChild({
      command,
      args: [
        "sandbox", "--permission-profile", ":workspace",
        "--config", `windows.sandbox=${JSON.stringify(windowsSandbox)}`,
        "--cd", workspacePath,
        process.execPath, "-e", probeScript, probePath
      ],
      cwd: workspacePath,
      env,
      input: "",
      timeoutMs,
      killGraceMs,
      maxOutputBytes
    });
  } finally {
    await rm(probePath, { force: true }).catch(() => {});
  }
  if (processResult.exitCode === 0 && !processResult.terminationReason) return { ok: true };
  return {
    ok: false,
    error: sandboxFailureCode(processResult),
    diagnostics: processDiagnostics(processResult, excerptLimit)
  };
}

export function createCodingAgentAdapter({
  command = "codex",
  model = "",
  workspaceRoot,
  timeoutMs = 120_000,
  killGraceMs = 5_000,
  maxOutputBytes = 64 * 1024,
  diagnosticExcerptChars = 2_048,
  argsBuilder = codexArgs,
  spawnProcess = spawn,
  gitChangedFiles = defaultGitChangedFiles,
  killTree = null,
  env = process.env,
  extraEnv = {},
  windowsSandbox = null,
  sandboxPreflight = null
} = {}) {
  const root = resolve(String(workspaceRoot || ""));
  if (!workspaceRoot) throw new Error("coding agent workspaceRoot is required");
  const boundedTimeoutMs = finitePositive(timeoutMs, 120_000, "coding agent timeoutMs");
  const boundedKillGraceMs = finitePositive(killGraceMs, 5_000, "coding agent killGraceMs");
  const boundedOutputBytes = finitePositive(maxOutputBytes, 64 * 1024, "coding agent maxOutputBytes");
  const boundedDiagnosticChars = finitePositive(diagnosticExcerptChars, 2_048, "coding agent diagnosticExcerptChars");
  const executable = basename(String(command)).toLowerCase();
  const usesCodexRuntime = new Set(["codex", "codex.exe"]).has(executable) && argsBuilder === codexArgs;
  if (!usesCodexRuntime && argsBuilder === codexArgs) {
    throw new Error("unsupported coding agent runtime");
  }
  const configuredWindowsSandbox = usesCodexRuntime && process.platform === "win32"
    ? normalizeWindowsSandbox(windowsSandbox)
    : null;

  return {
    mode: "real",
    runtime: String(command),
    limits: { max_processes_per_attempt: 1, timeout_ms: boundedTimeoutMs, token_limit: null },
    async run({ subtask, signal, workspace }) {
      if (signal?.aborted) throw new Error("coding_agent_cancelled");
      const startedAt = new Date().toISOString();
      const workspacePath = resolve(String(workspace?.workspace_path || ""));
      if (!workspace?.workspace_path || !isWithin(root, workspacePath) || workspacePath === root) {
        throw new Error("coding agent workspace is outside the allowed root");
      }
      const branch = String(workspace.branch_name || "").toLowerCase().replace(/^refs\/heads\//, "");
      if (!branch || branch === "main" || branch === "origin/main") throw new Error("coding agent cannot write main");
      const baseRef = String(workspace.base_ref || "").toLowerCase().replace(/^refs\/heads\//, "");
      if (!baseRef || baseRef === "main" || baseRef === "origin/main") throw new Error("coding agent cannot use main as base_ref");
      const allowedFiles = validateAllowedFiles(subtask.allowed_files);
      const before = await gitChangedFiles(workspacePath);
      if (before.length) throw new Error(`coding agent requires a clean workspace: ${before.join(", ")}`);

      const prompt = buildPrompt({ subtask, workspacePath, allowedFiles });
      const childEnv = safeChildEnvironment(env, {
        ...extraEnv,
        ORCHESTRATION_WORKSPACE_PATH: workspacePath,
        ORCHESTRATION_ALLOWED_FILES: JSON.stringify(allowedFiles)
      });
      const preflight = sandboxPreflight || (usesCodexRuntime && process.platform === "win32"
        ? runWindowsSandboxPreflight
        : null);
      if (preflight) {
        const preflightResult = await preflight({
          command,
          workspacePath,
          windowsSandbox: configuredWindowsSandbox,
          env: childEnv,
          timeoutMs: Math.min(boundedTimeoutMs, 15_000),
          killGraceMs: boundedKillGraceMs,
          maxOutputBytes: boundedOutputBytes,
          excerptLimit: boundedDiagnosticChars
        });
        if (!preflightResult?.ok) {
          const completedAt = new Date().toISOString();
          return {
            status: "failed",
            summary: "Coding agent sandbox preflight denied workspace writes",
            changed_files: [],
            tests: [],
            warnings: [],
            error: preflightResult?.error || "coding_agent_sandbox_preflight_failed",
            ...(preflightResult?.diagnostics ? { diagnostics: preflightResult.diagnostics } : {}),
            timestamps: { started: startedAt, completed: completedAt },
            duration_ms: Date.parse(completedAt) - Date.parse(startedAt)
          };
        }
      }
      const processResult = await runChild({
        command,
        args: argsBuilder({
          workspacePath,
          model,
          allowedFiles,
          subtask,
          windowsSandbox: configuredWindowsSandbox
        }),
        cwd: workspacePath,
        env: childEnv,
        input: prompt,
        signal,
        timeoutMs: boundedTimeoutMs,
        killGraceMs: boundedKillGraceMs,
        maxOutputBytes: boundedOutputBytes,
        spawnProcess,
        killTree
      });
      const completedAt = new Date().toISOString();
      const diagnostics = processDiagnostics(processResult, boundedDiagnosticChars);
      if (processResult.terminationReason === "cancelled") throw new Error("coding_agent_cancelled");
      if (processResult.terminationReason === "timeout") throw new Error("coding_agent_timeout");
      const changedFiles = await gitChangedFiles(workspacePath);
      const unauthorized = changedFiles.filter(file => !allowedFiles.includes(file));
      if (unauthorized.length) {
        return {
          status: "failed", summary: "Coding agent changed files outside its assignment", changed_files: changedFiles,
          tests: [], warnings: unauthorized.map(file => `unauthorized changed file: ${file}`), error: "unauthorized_changed_files",
          timestamps: { started: startedAt, completed: completedAt }, duration_ms: Date.parse(completedAt) - Date.parse(startedAt)
        };
      }
      if (processResult.exitCode !== 0) {
        return {
          status: "failed", summary: `Coding agent exited with code ${processResult.exitCode}`, changed_files: changedFiles,
          tests: [], warnings: [], error: "coding_agent_process_failed",
          diagnostics,
          timestamps: { started: startedAt, completed: completedAt }, duration_ms: Date.parse(completedAt) - Date.parse(startedAt)
        };
      }
      if (!changedFiles.length) {
        return {
          status: "failed", summary: "Coding agent produced no Git diff", changed_files: [], tests: [], warnings: [], error: "coding_agent_empty_diff",
          diagnostics,
          timestamps: { started: startedAt, completed: completedAt }, duration_ms: Date.parse(completedAt) - Date.parse(startedAt)
        };
      }
      return {
        status: "completed",
        summary: `Coding agent changed ${changedFiles.length} assigned file(s)`,
        changed_files: changedFiles,
        tests: [],
        warnings: [],
        error: null,
        timestamps: { started: startedAt, completed: completedAt },
        duration_ms: Date.parse(completedAt) - Date.parse(startedAt)
      };
    }
  };
}

export function createConfiguredCodingAgent({ env = process.env } = {}) {
  const repoRoot = resolve(env.ORCHESTRATION_REPO_ROOT || resolve(process.cwd(), ".."));
  const workspaceRoot = resolve(env.ORCHESTRATION_WORKSPACE_ROOT || resolve(repoRoot, ".orchestration-workspaces"));
  return createCodingAgentAdapter({
    command: env.ORCHESTRATION_CODING_AGENT_COMMAND || "codex",
    model: env.ORCHESTRATION_CODING_AGENT_MODEL || "",
    workspaceRoot,
    timeoutMs: env.ORCHESTRATION_CODING_AGENT_TIMEOUT_MS || env.ORCHESTRATION_TIMEOUT_MS || 120_000,
    killGraceMs: env.ORCHESTRATION_CODING_AGENT_KILL_GRACE_MS || 5_000,
    windowsSandbox: env.ORCHESTRATION_CODING_AGENT_WINDOWS_SANDBOX || null,
    env
  });
}
