import { execFile } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const WORKSPACE_STATES = new Set(["creating", "ready", "running", "completed", "failed", "cancelled", "released"]);

function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

function rejectMainRef(ref) {
  const normalized = String(ref || "").trim().toLowerCase().replace(/^refs\/heads\//, "");
  if (!normalized || normalized === "main" || normalized === "origin/main") {
    throw new Error("base_ref main is forbidden for workspace writes");
  }
}

function validateId(value, name) {
  const id = String(value || "");
  if (!SAFE_ID.test(id)) throw new Error(`${name} contains an unsafe path segment`);
  return id;
}

async function defaultGit(args, options = {}) {
  return execFileAsync("git", args, options);
}

export class WorkspaceManager {
  constructor({ rootDir, repoRoot, allowedRoot, git = defaultGit, useGit = true } = {}) {
    this.repoRoot = resolve(repoRoot || process.cwd());
    this.allowedRoot = resolve(allowedRoot || dirname(this.repoRoot));
    this.rootDir = resolve(rootDir || `${this.repoRoot}/.orchestration-workspaces`);
    this.git = git;
    this.useGit = useGit;
    if (!isWithin(this.allowedRoot, this.rootDir)) throw new Error("workspace root must be inside the allowed root");
    if (!isWithin(this.allowedRoot, this.repoRoot)) throw new Error("repository root must be inside the allowed root");
    if (this.rootDir === this.repoRoot) throw new Error("workspace root cannot be the repository root");
  }

  pathFor(jobId, subtaskId) {
    const safeJobId = validateId(jobId, "job_id");
    const safeSubtaskId = validateId(subtaskId, "subtask_id");
    const workspacePath = resolve(this.rootDir, safeJobId, safeSubtaskId);
    if (!isWithin(this.rootDir, workspacePath) || workspacePath === this.rootDir) throw new Error("workspace path escapes the allowed root");
    return workspacePath;
  }

  async create({ jobId, subtaskId, baseRef, branchName } = {}) {
    rejectMainRef(baseRef);
    const workspacePath = this.pathFor(jobId, subtaskId);
    const branch = branchName || `orchestrator/${validateId(jobId, "job_id")}/${validateId(subtaskId, "subtask_id")}`;
    rejectMainRef(branch);
    await mkdir(dirname(workspacePath), { recursive: true });
    try {
      await mkdir(workspacePath);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("workspace already exists");
      throw error;
    }
    const descriptor = {
      job_id: String(jobId),
      subtask_id: String(subtaskId),
      workspace_path: workspacePath,
      branch_name: branch,
      base_ref: String(baseRef),
      state: "creating"
    };
    if (!this.useGit) {
      descriptor.state = "ready";
      return descriptor;
    }
    try {
      await this.git(["worktree", "add", "-b", branch, workspacePath, String(baseRef)], { cwd: this.repoRoot });
      descriptor.state = "ready";
      return descriptor;
    } catch (error) {
      await this.safeRemoveCreatedPath(workspacePath);
      const wrapped = new Error(`workspace git creation failed: ${error?.message || String(error)}`);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async markState(workspace, state) {
    if (!workspace) return null;
    if (!WORKSPACE_STATES.has(state)) throw new Error(`Invalid workspace state: ${state}`);
    return { ...workspace, state };
  }

  async cleanup(workspace) {
    if (!workspace || typeof workspace !== "object") throw new Error("workspace is required");
    rejectMainRef(workspace.base_ref);
    const workspacePath = resolve(String(workspace.workspace_path || ""));
    if (!isWithin(this.rootDir, workspacePath) || workspacePath === this.rootDir) throw new Error("workspace cleanup path is outside the allowed root");
    if (String(workspace.branch_name || "").toLowerCase() === "main") throw new Error("cleanup of main branch is forbidden");
    try {
      await access(workspacePath);
    } catch (error) {
      if (error.code === "ENOENT") return { ...workspace, state: "released" };
      throw error;
    }
    if (this.useGit) await this.git(["worktree", "remove", "--force", workspacePath], { cwd: this.repoRoot });
    await rm(workspacePath, { recursive: true, force: true });
    return { ...workspace, state: "released" };
  }

  async safeRemoveCreatedPath(workspacePath) {
    if (!isWithin(this.rootDir, workspacePath) || workspacePath === this.rootDir) return;
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
  }
}

export function createConfiguredWorkspaceManager({ env = process.env } = {}) {
  const repoRoot = resolve(env.ORCHESTRATION_REPO_ROOT || resolve(process.cwd(), ".."));
  const allowedRoot = resolve(env.ORCHESTRATION_ALLOWED_ROOT || repoRoot);
  const rootDir = resolve(env.ORCHESTRATION_WORKSPACE_ROOT || join(repoRoot, ".orchestration-workspaces"));
  const useGit = String(env.ORCHESTRATION_AGENT_MODE || "mock").trim().toLowerCase() !== "mock";
  return new WorkspaceManager({ rootDir, repoRoot, allowedRoot, useGit });
}
