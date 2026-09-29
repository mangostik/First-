import { randomUUID } from "node:crypto";
import { assertStatus, JOB_STATUSES, SUBTASK_STATUSES } from "./statuses.js";

function asString(value, name, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return undefined;
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function asStringArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map(item => asString(item, `${name} item`));
}

export function validateWorkspace(value) {
  if (!value || typeof value !== "object") throw new Error("workspace must be an object");
  const state = asString(value.state, "workspace.state");
  if (!new Set(["creating", "ready", "running", "completed", "failed", "cancelled", "released"]).has(state)) {
    throw new Error(`Invalid workspace.state: ${state}`);
  }
  return {
    job_id: asString(value.job_id, "workspace.job_id"),
    subtask_id: asString(value.subtask_id, "workspace.subtask_id"),
    workspace_path: asString(value.workspace_path, "workspace.workspace_path"),
    branch_name: asString(value.branch_name, "workspace.branch_name"),
    base_ref: asString(value.base_ref, "workspace.base_ref"),
    state
  };
}

export function validateDependency(value) {
  if (!value || typeof value !== "object") throw new Error("dependency must be an object");
  const requiredStatus = asString(value.required_status || "completed", "dependency.required_status");
  if (requiredStatus !== "completed") throw new Error(`Invalid dependency.required_status: ${requiredStatus}`);
  return {
    subtask_id: asString(value.subtask_id, "dependency.subtask_id"),
    required_status: requiredStatus
  };
}

export function validateAgentResult(value) {
  if (!value || typeof value !== "object") throw new Error("agent result must be an object");
  const status = asString(value.status, "agent result.status");
  if (!new Set(["completed", "failed"]).has(status)) {
    throw new Error(`Invalid agent result.status: ${status}`);
  }
  return {
    status,
    execution_mode: value.execution_mode == null ? null : String(value.execution_mode),
    git_verified: Boolean(value.git_verified),
    summary: asString(value.summary || "No summary", "agent result.summary"),
    changed_files: asStringArray(value.changed_files || [], "agent result.changed_files"),
    tests: asStringArray(value.tests || [], "agent result.tests"),
    warnings: asStringArray(value.warnings || [], "agent result.warnings"),
    error: value.error == null ? null : String(value.error),
    diagnostics: value.diagnostics && typeof value.diagnostics === "object" ? {
      exit_code: value.diagnostics.exit_code == null ? null : Number(value.diagnostics.exit_code),
      signal: value.diagnostics.signal == null ? null : String(value.diagnostics.signal),
      termination_reason: value.diagnostics.termination_reason == null ? null : String(value.diagnostics.termination_reason),
      stdout_excerpt: String(value.diagnostics.stdout_excerpt || ""),
      stderr_excerpt: String(value.diagnostics.stderr_excerpt || ""),
      stdout_truncated: Boolean(value.diagnostics.stdout_truncated),
      stderr_truncated: Boolean(value.diagnostics.stderr_truncated)
    } : null,
    timestamps: value.timestamps && typeof value.timestamps === "object" ? value.timestamps : {},
    duration_ms: Number(value.duration_ms || 0),
    retry_reasons: asStringArray(value.retry_reasons || [], "agent result.retry_reasons")
  };
}

export function validateAggregateResult(value) {
  if (!value || typeof value !== "object") throw new Error("aggregate result must be an object");
  return {
    summary: asString(value.summary, "aggregate.summary"),
    changed_files: asStringArray(value.changed_files || [], "aggregate.changed_files"),
    tests: asStringArray(value.tests || [], "aggregate.tests"),
    warnings: asStringArray(value.warnings || [], "aggregate.warnings"),
    conflicts: asStringArray(value.conflicts || [], "aggregate.conflicts"),
    remaining_work: asStringArray(value.remaining_work || [], "aggregate.remaining_work"),
    workspaces: (value.workspaces || []).map(validateWorkspace),
    execution_mode: value.execution_mode == null ? null : String(value.execution_mode),
    integration: value.integration == null ? null : {
      status: asString(value.integration.status, "aggregate.integration.status"),
      base_ref: asString(value.integration.base_ref, "aggregate.integration.base_ref"),
      source_refs: Array.isArray(value.integration.source_refs) ? value.integration.source_refs.map(item => ({
        subtask_id: asString(item.subtask_id, "aggregate.integration.source_refs.subtask_id"),
        branch_name: asString(item.branch_name, "aggregate.integration.source_refs.branch_name"),
        workspace_path: asString(item.workspace_path, "aggregate.integration.source_refs.workspace_path")
      })) : [],
      result_ref: value.integration.result_ref == null ? null : String(value.integration.result_ref),
      result_workspace: value.integration.result_workspace == null ? null : String(value.integration.result_workspace),
      applied_files: asStringArray(value.integration.applied_files || [], "aggregate.integration.applied_files"),
      patch_bytes: Number(value.integration.patch_bytes || 0),
      final_diff: String(value.integration.final_diff || ""),
      error: value.integration.error == null ? null : String(value.integration.error),
      failed_subtask_id: value.integration.failed_subtask_id == null ? null : String(value.integration.failed_subtask_id)
    }
  };
}

export function validateReviewResult(value) {
  if (!value || typeof value !== "object") throw new Error("review result must be an object");
  const finalDecision = asString(value.final_decision, "review.final_decision");
  if (!new Set(["approved", "rejected"]).has(finalDecision)) throw new Error(`Invalid review.final_decision: ${finalDecision}`);
  if (typeof value.approved !== "boolean" || value.approved !== (finalDecision === "approved")) {
    throw new Error("review.approved must match review.final_decision");
  }
  return {
    final_decision: finalDecision,
    reviewer_mode: String(value.reviewer_mode || "mock"),
    summary: asString(value.summary, "review.summary"),
    review_findings: asStringArray(value.review_findings || [], "review.review_findings"),
    approved: value.approved
  };
}

export function validateTestEvidence(value) {
  if (!value || typeof value !== "object") throw new Error("test evidence must be an object");
  const status = asString(value.status, "test evidence.status");
  if (!new Set(["passed", "failed", "timeout", "error"]).has(status)) throw new Error(`Invalid test evidence.status: ${status}`);
  return {
    status,
    command: asString(value.command, "test evidence.command"),
    exit_code: value.exit_code == null ? null : Number(value.exit_code),
    stdout: String(value.stdout || ""),
    stderr: String(value.stderr || ""),
    duration_ms: Number(value.duration_ms || 0),
    error: value.error == null ? null : String(value.error)
  };
}

export function validateSubtask(value) {
  if (!value || typeof value !== "object") throw new Error("subtask must be an object");
  const status = asString(value.status || "queued", "subtask.status");
  if (!SUBTASK_STATUSES.includes(status)) throw new Error(`Invalid subtask.status: ${status}`);
  return {
    id: asString(value.id, "subtask.id"),
    role: asString(value.role, "subtask.role"),
    title: asString(value.title, "subtask.title"),
    instructions: asString(value.instructions, "subtask.instructions"),
    allowed_files: asStringArray(value.allowed_files || [], "subtask.allowed_files"),
    dependencies: (value.dependencies || []).map(validateDependency),
    status,
    attempts: Number.isInteger(value.attempts) && value.attempts >= 0 ? value.attempts : 0,
    result: value.result == null ? null : validateAgentResult(value.result),
    workspace: value.workspace == null ? null : validateWorkspace(value.workspace),
    error: value.error == null ? null : String(value.error),
    started_at: value.started_at || null,
    finished_at: value.finished_at || null,
    timestamps: value.timestamps && typeof value.timestamps === "object" ? value.timestamps : {},
    duration_ms: Number(value.duration_ms || 0),
    retry_reasons: asStringArray(value.retry_reasons || [], "subtask.retry_reasons"),
    cancel_reason: value.cancel_reason == null ? null : String(value.cancel_reason)
  };
}

export function validateFinalJobResult(value) {
  if (!value || typeof value !== "object") throw new Error("final job result must be an object");
  const decision = asString(value.final_decision, "final job result.final_decision");
  if (!new Set(["approved", "rejected"]).has(decision)) throw new Error(`Invalid final job result.final_decision: ${decision}`);
  return {
    summary: asString(value.summary, "final job result.summary"),
    changed_files: asStringArray(value.changed_files || [], "final job result.changed_files"),
    tests: asStringArray(value.tests || [], "final job result.tests"),
    warnings: asStringArray(value.warnings || [], "final job result.warnings"),
    conflicts: asStringArray(value.conflicts || [], "final job result.conflicts"),
    remaining_work: asStringArray(value.remaining_work || [], "final job result.remaining_work"),
    final_decision: decision,
    review_findings: asStringArray(value.review_findings || [], "final job result.review_findings"),
    workspaces: (value.workspaces || []).map(validateWorkspace),
    aggregate: value.aggregate == null ? null : validateAggregateResult(value.aggregate),
    test_evidence: value.test_evidence == null ? null : validateTestEvidence(value.test_evidence),
    review: value.review == null ? null : validateReviewResult(value.review),
    events: Array.isArray(value.events) ? value.events : [],
    metrics: value.metrics && typeof value.metrics === "object" ? value.metrics : {},
    limit_violations: Array.isArray(value.limit_violations) ? value.limit_violations : [],
    duration_ms: Number(value.duration_ms || 0),
    execution_mode: value.execution_mode == null ? null : String(value.execution_mode)
  };
}

export function validateJob(value) {
  if (!value || typeof value !== "object") throw new Error("job must be an object");
  const status = asString(value.status, "job.status");
  assertStatus(status, "job.status");
  const subtasks = (value.subtasks || []).map(validateSubtask);
  return {
    job_id: asString(value.job_id, "job.job_id"),
    task: asString(value.task, "job.task"),
    status,
    created_at: asString(value.created_at, "job.created_at"),
    updated_at: asString(value.updated_at, "job.updated_at"),
    subtasks,
    aggregate: value.aggregate == null ? null : validateAggregateResult(value.aggregate),
    test_evidence: value.test_evidence == null ? null : validateTestEvidence(value.test_evidence),
    result: value.result == null ? null : validateFinalJobResult(value.result),
    error: value.error == null ? null : String(value.error),
    cancelled_at: value.cancelled_at || null,
    timestamps: value.timestamps && typeof value.timestamps === "object" ? value.timestamps : {},
    events: Array.isArray(value.events) ? value.events : [],
    metrics: value.metrics && typeof value.metrics === "object" ? value.metrics : {},
    limit_violations: Array.isArray(value.limit_violations) ? value.limit_violations : [],
    duration_ms: Number(value.duration_ms || 0),
    execution_mode: value.execution_mode == null ? null : String(value.execution_mode)
  };
}

export function createJob(task, now = new Date().toISOString()) {
  const cleanTask = asString(task, "task");
  const jobId = randomUUID();
  return {
    job_id: jobId,
    task: cleanTask,
    status: "queued",
    created_at: now,
    updated_at: now,
    subtasks: [],
    aggregate: null,
    test_evidence: null,
    result: null,
    error: null,
    cancelled_at: null,
    timestamps: { queued: now },
    events: [{ type: "job_state", timestamp: now, job_id: jobId, status: "queued" }],
    metrics: { active_tasks: 0, max_active_tasks: 0, total_attempts: 0 },
    limit_violations: [],
    duration_ms: 0
  };
}
