import { validateAggregateResult } from "./schemas.js";
import { writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative, isAbsolute } from "node:path";
import { redactSecrets } from "./observability.js";

const execFileAsync = promisify(execFile);

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

export function integrateSubtasks(job) {
  const subtasks = Array.isArray(job?.subtasks) ? job.subtasks : [];
  const fileOwners = new Map();
  const changedFiles = [];
  const tests = [];
  const warnings = [];
  const remainingWork = [];
  const workspaces = [];

  for (const subtask of subtasks) {
    if (subtask.workspace) workspaces.push(subtask.workspace);
    if (subtask.status !== "completed" || !subtask.result) {
      remainingWork.push(`${subtask.id}: ${subtask.error || subtask.status}`);
    }
    const result = subtask.result;
    if (!result) continue;
    for (const file of result.changed_files || []) {
      changedFiles.push(String(file));
      if (!fileOwners.has(String(file))) fileOwners.set(String(file), []);
      fileOwners.get(String(file)).push(subtask.id);
    }
    tests.push(...(result.tests || []).map(String));
    warnings.push(...(result.warnings || []).map(String));
    if (result.error) warnings.push(`${subtask.id}: ${result.error}`);
  }

  const conflicts = [...fileOwners.entries()]
    .filter(([, owners]) => new Set(owners).size > 1)
    .map(([file, owners]) => `${file} changed by ${unique(owners).join(", ")}`);

  return validateAggregateResult({
    summary: `${subtasks.filter(item => item.status === "completed").length}/${subtasks.length} subtasks completed`,
    changed_files: unique(changedFiles),
    tests: unique(tests),
    warnings: unique(warnings),
    conflicts,
    remaining_work: unique(remainingWork),
    workspaces
  });
}

function safeDiagnostic(error) {
  const message = error?.stderr || error?.message || error;
  return String(redactSecrets(String(message))).slice(0, 1000);
}

function normalizePath(file) {
  return String(file).replaceAll("\\", "/").replace(/^\.\//, "");
}

function allowedPath(file, allowedFiles) {
  const normalized = normalizePath(file);
  return allowedFiles.some(allowed => normalizePath(allowed) === normalized);
}

async function git(cwd, args, options = {}) {
  return execFileAsync("git", args, { cwd, windowsHide: true, ...options });
}

async function actualDiff(workspace, baseRef) {
  const indexPath = join(workspace.workspace_path, "..", `.integration-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    await git(workspace.workspace_path, ["read-tree", baseRef], { env });
    await git(workspace.workspace_path, ["add", "--all", "--", "."], { env });
    const names = await git(workspace.workspace_path, ["diff", "--cached", "--name-only", "-z", baseRef], { env });
    const patch = await git(workspace.workspace_path, ["diff", "--cached", "--binary", baseRef], { encoding: "buffer", maxBuffer: 50 * 1024 * 1024, env });
    return {
      files: String(names.stdout || "").split("\0").map(normalizePath).filter(Boolean),
      patch: Buffer.isBuffer(patch.stdout) ? patch.stdout : Buffer.from(patch.stdout || "")
    };
  } finally {
    await rm(indexPath, { force: true });
  }
}

function resultWorkspaceDescriptor(workspace, integration) {
  return { ...workspace, state: integration === "applied" ? "completed" : "failed" };
}

/**
 * Apply the actual uncommitted Git diffs from completed agent worktrees to a
 * fresh result worktree. The legacy synchronous aggregator remains available
 * for metadata-only callers and fixtures without real workspaces.
 */
export async function integrateGitChanges(job, { workspaceManager } = {}) {
  const subtasks = Array.isArray(job?.subtasks) ? job.subtasks : [];
  const codingTasks = subtasks.filter(item => item.role !== "reviewer");
  const baseRef = codingTasks.find(item => item.workspace?.base_ref)?.workspace?.base_ref;
  const metadata = integrateSubtasks(job);
  const sourceRefs = codingTasks.filter(item => item.workspace).map(({ id, workspace }) => ({
    subtask_id: id,
    branch_name: workspace.branch_name,
    workspace_path: workspace.workspace_path
  }));
  const integrationFailure = (reason, { conflicts = [], remaining = [], failedSubtaskId = null } = {}) => validateAggregateResult({
    ...metadata,
    summary: "Coding changes were not fully integrated",
    changed_files: [],
    conflicts: unique([...metadata.conflicts, ...conflicts]),
    remaining_work: unique([...metadata.remaining_work, ...remaining]),
    workspaces: [],
    integration: {
      status: "failed", base_ref: String(baseRef || "unavailable"), source_refs: sourceRefs,
      result_ref: null, result_workspace: null, applied_files: [], patch_bytes: 0,
      final_diff: "", error: String(redactSecrets(String(reason))).slice(0, 1000), failed_subtask_id: failedSubtaskId
    }
  });
  if (!workspaceManager || !baseRef) return integrationFailure("coding_agent_integration_context_missing", {
    remaining: codingTasks.map(item => `${item.id}: no Git workspace or base ref`)
  });
  if (!codingTasks.length) return integrationFailure("no_coding_agent_tasks", {
    remaining: ["coding agents: no coding subtasks were planned"]
  });
  const incomplete = codingTasks.filter(item => item.status !== "completed" || !item.result || !item.workspace?.workspace_path);
  if (incomplete.length) return integrationFailure("coding_agent_incomplete", {
    remaining: incomplete.map(item => `${item.id}: ${item.error || item.status || "missing Git workspace"}`)
  });

  const sourceDiffs = [];
  const changedBy = new Map();
  const warnings = [];
  const tests = [];
  try {
    for (const subtask of codingTasks) {
      const diff = await actualDiff(subtask.workspace, baseRef);
      const allowed = subtask.allowed_files || [];
      const unauthorized = diff.files.filter(file => !allowedPath(file, allowed));
      if (unauthorized.length) return integrationFailure("unauthorized_changed_files", {
        conflicts: [`${subtask.id}: unauthorized Git changes: ${unauthorized.join(", ")}`]
      });
      if (!diff.files.length || !diff.patch.length) return integrationFailure("coding_agent_empty_diff", {
        remaining: [`${subtask.id}: coding agent produced no verifiable Git diff`],
        failedSubtaskId: subtask.id
      });
      for (const file of diff.files) {
        if (!changedBy.has(file)) changedBy.set(file, []);
        changedBy.get(file).push(subtask.id);
      }
      sourceDiffs.push({ subtask, ...diff });
      tests.push(...(subtask.result.tests || []).map(String));
      warnings.push(...(subtask.result.warnings || []).map(String));
    }
  } catch (error) {
    return integrationFailure(safeDiagnostic(error));
  }
  const conflicts = [...changedBy.entries()]
    .filter(([, owners]) => new Set(owners).size > 1)
    .map(([file, owners]) => `${file} changed by ${unique(owners).join(", ")}`);
  if (conflicts.length) {
    return integrationFailure("coding_agent_file_conflict", { conflicts });
  }

  const jobId = String(job.job_id || "integration");
  let result;
  try {
    result = await workspaceManager.create({
      jobId,
      subtaskId: "integrated-result",
      baseRef,
      branchName: `orchestrator/${jobId}/integrated-result`
    });
  } catch (error) {
    return integrationFailure(safeDiagnostic(error));
  }
  const integration = {
    status: "applied",
    base_ref: baseRef,
    source_refs: sourceDiffs.map(({ subtask }) => ({ subtask_id: subtask.id, branch_name: subtask.workspace.branch_name, workspace_path: subtask.workspace.workspace_path })),
    result_ref: result.branch_name,
    result_workspace: result.workspace_path,
    applied_files: [],
    patch_bytes: 0,
    final_diff: "",
    error: null
  };
  try {
    for (const source of sourceDiffs) {
      if (!source.patch.length) throw new Error(`${source.subtask.id}: empty Git diff`);
      const patchPath = join(result.workspace_path, `.integration-${source.subtask.id}.patch`);
      await writeFile(patchPath, source.patch);
      try {
        await git(result.workspace_path, ["apply", "--index", "--3way", patchPath]);
      } finally {
        await rm(patchPath, { force: true });
      }
      integration.applied_files.push(...source.files);
      integration.patch_bytes += source.patch.length;
    }
    const finalDiff = await actualDiff(result, baseRef);
    integration.applied_files = unique(finalDiff.files);
    integration.final_diff = finalDiff.patch.toString("utf8");
    return validateAggregateResult({
      summary: `${sourceDiffs.length}/${codingTasks.length} coding subtasks integrated`,
      changed_files: integration.applied_files,
      tests: unique(tests), warnings: unique(warnings), conflicts: [], remaining_work: [],
      workspaces: [resultWorkspaceDescriptor(result, "applied")], integration,
      execution_mode: sourceDiffs.every(({ subtask }) => subtask.result.execution_mode === "real" && subtask.result.git_verified) ? "real" : "simulation"
    });
  } catch (error) {
    integration.status = "failed";
    integration.error = safeDiagnostic(error);
    await workspaceManager.cleanup(result).catch(() => {});
    return validateAggregateResult({
      summary: `${sourceDiffs.length}/${codingTasks.length} coding subtasks integrated`,
      changed_files: [], tests: unique(tests), warnings: unique(warnings),
      conflicts: [`integration failed: ${integration.error}`], remaining_work: [], workspaces: [], integration
    });
  }
}
