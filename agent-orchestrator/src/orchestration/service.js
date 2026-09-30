import { join } from "node:path";
import { createJob, validateAggregateResult, validateFinalJobResult, validateReviewResult, validateTestEvidence } from "./schemas.js";
import { planTask } from "./planner.js";
import { JsonJobStore } from "./job-store.js";
import { createConfiguredAgentRunner } from "./agent-runner.js";
import { DependencyScheduler } from "./scheduler.js";
import { createConfiguredWorkspaceManager } from "./workspace.js";
import { integrateGitChanges } from "./integrator.js";
import { createConfiguredJobReviewer } from "./reviewer.js";
import { createConfiguredTestRunner } from "./test-runner.js";
import { addEvent, addLimitViolation, durationMs, markState, readOrchestrationLimits, redactSecrets, safeLog } from "./observability.js";

const REVIEWER_DIAGNOSTIC_SECRET_ASSIGNMENT = /((?:api[_-]?key|authorization|token|password|secret|credential)\s*[:=]\s*)[^\r\n]*/gi;

function safeReviewerReason(value) {
  const assignedRedacted = String(value || "").replace(REVIEWER_DIAGNOSTIC_SECRET_ASSIGNMENT, "$1[REDACTED]");
  return String(redactSecrets(assignedRedacted)).replace(/\s+/g, " ").trim().slice(0, 500);
}

function safeReviewerCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 80) || null;
}

function sanitizeReviewerResult(review) {
  const findings = review.review_findings.length > 100
    ? [...review.review_findings.slice(0, 99), `${review.review_findings.length - 99} additional findings omitted`]
    : review.review_findings;
  return validateReviewResult({
    ...review,
    terminal_status: safeReviewerCode(review.terminal_status),
    terminal_code: safeReviewerCode(review.terminal_code),
    failure_reason: review.failure_reason == null ? null : safeReviewerReason(review.failure_reason) || "Reviewer failure details redacted",
    summary: safeReviewerReason(review.summary) || "Reviewer summary redacted",
    review_findings: findings.map(item => safeReviewerReason(item) || "Reviewer finding redacted")
  });
}

function reviewerFailureRecord(review) {
  if (review?.final_decision === "approved" && review.approved === true && !review.terminal_code) return null;
  const status = String(review?.terminal_status || (review?.final_decision === "rejected" ? "REJECTED" : "FAILED"))
    .toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 80) || "FAILED";
  const code = String(review?.terminal_code || (status === "REJECTED" ? "REVIEW_REJECTED" : "REVIEW_FAILED"))
    .toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 80) || "REVIEW_FAILED";
  const reason = safeReviewerReason(review?.failure_reason || (status === "REJECTED" ? "Reviewer rejected the result" : "Reviewer did not complete successfully"));
  return { code, record: `reviewer [${code}/${status}]: ${reason || "Reviewer did not complete successfully"}` };
}

function appendReviewerFailure(aggregate, review) {
  const failure = reviewerFailureRecord(review);
  if (!failure || aggregate.remaining_work.some(item => item.startsWith(`reviewer [${failure.code}/`))) return aggregate;
  return validateAggregateResult({ ...aggregate, remaining_work: [...aggregate.remaining_work, failure.record] });
}

export class OrchestrationService {
  constructor({ store, runner, reviewer, testRunner, schedulerOptions = {}, onStatusChange, workspaceManager, planner = planTask } = {}) {
    this.store = store || new JsonJobStore(process.env.JOB_STORAGE_DIR || join(process.cwd(), ".orchestration-jobs"));
    const configuredRunner = runner || createConfiguredAgentRunner();
    this.runner = typeof configuredRunner === "function"
      ? configuredRunner
      : configuredRunner?.run?.bind(configuredRunner);
    if (!this.runner) throw new Error("runner must be a function or adapter with run()");
    this.reviewer = reviewer || createConfiguredJobReviewer();
    this.testRunner = testRunner || createConfiguredTestRunner();
    this.workspaceManager = workspaceManager || createConfiguredWorkspaceManager();
    this.baseRef = process.env.ORCHESTRATION_BASE_REF || "stage4-mcp";
    const limits = readOrchestrationLimits();
    const nonNegative = (name, value) => {
      if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid scheduler option: ${name}`);
      return value;
    };
    this.limits = {
      ...limits,
      maxSubtasks: Math.min(limits.maxSubtasks, schedulerOptions.maxSubtasks == null ? limits.maxSubtasks : nonNegative("maxSubtasks", Number(schedulerOptions.maxSubtasks))),
      maxParallel: Math.min(limits.maxParallel, schedulerOptions.maxParallel == null ? limits.maxParallel : nonNegative("maxParallel", Number(schedulerOptions.maxParallel))),
      maxRetries: Math.min(limits.maxRetries, schedulerOptions.maxRetries == null ? limits.maxRetries : nonNegative("maxRetries", Number(schedulerOptions.maxRetries))),
      subtaskTimeoutMs: Math.min(limits.subtaskTimeoutMs, schedulerOptions.timeoutMs == null ? limits.subtaskTimeoutMs : nonNegative("timeoutMs", Number(schedulerOptions.timeoutMs))),
      jobTimeoutMs: Math.min(limits.jobTimeoutMs, schedulerOptions.jobTimeoutMs == null ? limits.jobTimeoutMs : nonNegative("jobTimeoutMs", Number(schedulerOptions.jobTimeoutMs)))
    };
    this.schedulers = new Map();
    this.processes = new Map();
    this.jobControllers = new Map();
    this.cancelled = new Set();
    this.onStatusChange = typeof onStatusChange === "function" ? onStatusChange : () => {};
    this.planner = typeof planner === "function" ? planner : planTask;
  }

  async createJob(task) {
    const job = await this.store.create(createJob(task));
    this.jobControllers.set(job.job_id, new AbortController());
    const processing = this.process(job.job_id);
    this.processes.set(job.job_id, processing);
    processing.finally(() => this.processes.delete(job.job_id)).catch(() => {});
    return { job_id: job.job_id, status: job.status };
  }

  async process(jobId) {
    const jobSignal = this.jobControllers.get(jobId)?.signal;
    try {
      await this.setStatus(jobId, "planning");
      const planned = this.planner((await this.store.get(jobId)).task);
      if (this.cancelled.has(jobId)) return;
      if (planned.subtasks.length > this.limits.maxSubtasks) {
        await this.store.update(jobId, job => {
          addLimitViolation(job, "max_subtasks", { actual: planned.subtasks.length, limit: this.limits.maxSubtasks });
          job.error = "max_subtasks";
          job.status = "failed";
          markState(job, "failed");
          addEvent(job, "job_failed", { reason: "max_subtasks" });
          return job;
        });
        await this.saveFailureResult(jobId, "max_subtasks");
        return;
      }
      await this.store.update(jobId, job => {
        const timestamp = new Date().toISOString();
        job.subtasks = planned.subtasks.map(subtask => ({
          ...subtask,
          timestamps: { [subtask.status]: timestamp }
        }));
        for (const subtask of job.subtasks) addEvent(job, "subtask_queued", { subtask_id: subtask.id, status: subtask.status });
        if (this.limits.requestedMaxParallel > 3) addLimitViolation(job, "concurrency", { requested: this.limits.requestedMaxParallel, limit: 3 });
        return job;
      });
      await this.setStatus(jobId, "running");
      const scheduler = new DependencyScheduler({
        store: this.store,
        runner: async context => this.runWithWorkspace(context),
        maxParallel: this.limits.maxParallel,
        timeoutMs: this.limits.subtaskTimeoutMs,
        maxRetries: this.limits.maxRetries,
        jobTimeoutMs: this.limits.jobTimeoutMs,
        logEvents: this.limits.logEvents
      });
      this.schedulers.set(jobId, scheduler);
      let job = await scheduler.run(jobId);
      if (job.status === "cancelled" || this.cancelled.has(jobId)) return;
      const hardLimitFailure = job.limit_violations?.some(item => ["max_subtasks", "concurrency", "job_timeout", "subtask_timeout"].includes(item.code));
      if (job.status === "failed" && hardLimitFailure) {
        await this.saveFailureResult(jobId, job.error || job.limit_violations.at(-1).code);
        return;
      }
      await this.setStatus(jobId, "integrating");
      if (this.cancelled.has(jobId)) return;
      job = await this.store.get(jobId);
      let aggregate = await integrateGitChanges(job, { workspaceManager: this.workspaceManager });
      await this.store.update(jobId, current => {
        if (current.status !== "cancelled") current.aggregate = aggregate;
        if (aggregate.integration?.failed_subtask_id) {
          const failed = current.subtasks.find(item => item.id === aggregate.integration.failed_subtask_id);
          if (failed && failed.status !== "cancelled") {
            failed.status = "failed";
            failed.error = aggregate.integration.error || "coding_agent_unverified_diff";
            failed.finished_at = new Date().toISOString();
            markState(failed, "failed", failed.finished_at);
          }
        }
        return current;
      });
      if (this.cancelled.has(jobId)) return;
      let testEvidence;
      if (aggregate.integration?.status !== "applied" || aggregate.changed_files.length === 0) {
        testEvidence = validateTestEvidence({
          status: "failed", command: "integration-gate", exit_code: 1, stdout: "", stderr: "",
          duration_ms: 0, error: aggregate.integration?.error || "No verified integrated Git changes"
        });
      } else try {
        testEvidence = await this.testRunner.run({
          job,
          aggregate,
          workspace: aggregate.integration?.result_workspace ? aggregate.workspaces.find(item => item.workspace_path === aggregate.integration.result_workspace) || null : null,
          signal: jobSignal
        });
      } catch (error) {
        if (this.cancelled.has(jobId)) return;
        testEvidence = validateTestEvidence({
          status: "error",
          command: this.testRunner.mode || "project-tests",
          stdout: "",
          stderr: "",
          duration_ms: 0,
          error: error?.message || String(error)
        });
      }
      if (this.cancelled.has(jobId)) return;
      await this.store.update(jobId, current => { if (current.status !== "cancelled") current.test_evidence = testEvidence; return current; });
      await this.setStatus(jobId, "reviewing");
      if (this.cancelled.has(jobId)) return;
      let review;
      try {
        review = validateReviewResult(await this.reviewer.review({
          task: job.task,
          aggregate,
          testEvidence,
          workspace: aggregate.integration?.result_workspace ? aggregate.workspaces.find(item => item.workspace_path === aggregate.integration.result_workspace) || null : null,
          verifiedDiff: aggregate.integration?.final_diff || "",
          signal: jobSignal
        }));
      } catch (error) {
        const cancelled = this.cancelled.has(jobId) || jobSignal?.aborted || error?.code === "MCP_REVIEW_CANCELLED";
        const timedOut = ["ETIMEDOUT", "MCP_REVIEW_TIMEOUT", "REVIEW_LOOP_TIMEOUT", "PROVIDER_TIMEOUT"].includes(error?.code) || error?.name === "TimeoutError";
        const terminalStatus = cancelled ? "CANCELLED" : timedOut ? "TIMEOUT" : "FAILED";
        const terminalCode = error?.code || (cancelled ? "MCP_REVIEW_CANCELLED" : timedOut ? "REVIEW_TIMEOUT" : "REVIEW_FAILED");
        const diagnostic = safeReviewerReason(error?.message || String(error)) || "Reviewer did not complete successfully";
        const reason = `Reviewer ${terminalStatus.toLowerCase()}: ${diagnostic}`;
        review = validateReviewResult({
          final_decision: "rejected", reviewer_mode: this.reviewer.mode || "custom",
          terminal_status: terminalStatus, terminal_code: terminalCode, failure_reason: diagnostic,
          summary: reason, review_findings: [reason], approved: false
        });
      }
      if (this.cancelled.has(jobId) || jobSignal?.aborted) {
        review = validateReviewResult({
          ...review,
          final_decision: "rejected",
          reviewer_mode: review.reviewer_mode || this.reviewer.mode || "custom",
          terminal_status: "CANCELLED",
          terminal_code: review.terminal_code || "MCP_REVIEW_CANCELLED",
          failure_reason: review.failure_reason || "Review cancelled before approval",
          review_findings: review.review_findings,
          approved: false
        });
      }
      review = sanitizeReviewerResult(review);
      aggregate = appendReviewerFailure(aggregate, review);
      await this.store.update(jobId, current => { current.aggregate = aggregate; return current; });
      if (this.cancelled.has(jobId) || jobSignal?.aborted) return;
      const readinessFindings = [];
      if (aggregate.integration?.status !== "applied" || aggregate.changed_files.length === 0) readinessFindings.push("No verified coding-agent Git diff was integrated");
      if (aggregate.execution_mode !== "real") readinessFindings.push("Coding result is simulation only");
      if (testEvidence.status !== "passed") readinessFindings.push("Merged-result test gate did not pass");
      if (aggregate.conflicts.length || aggregate.remaining_work.length) readinessFindings.push(...aggregate.conflicts, ...aggregate.remaining_work);
      if (readinessFindings.length) {
        review = validateReviewResult({
          ...review,
          final_decision: "rejected",
          approved: false,
          review_findings: [...review.review_findings, ...readinessFindings],
          summary: review.summary
        });
      }
      review = sanitizeReviewerResult(review);
      const latest = await this.store.get(jobId);
      const result = validateFinalJobResult({
        ...aggregate,
        final_decision: review.final_decision,
        review_findings: review.review_findings,
        test_evidence: testEvidence,
        aggregate,
        review,
        execution_mode: aggregate.execution_mode || "simulation",
        events: latest.events,
        metrics: latest.metrics,
        limit_violations: latest.limit_violations,
        duration_ms: durationMs(latest)
      });
      await this.store.update(jobId, current => { if (current.status !== "cancelled") current.result = result; return current; });
      if (this.cancelled.has(jobId)) return;
      await this.setStatus(jobId, review.approved && aggregate.execution_mode === "real" ? "completed" : "failed");
    } catch (error) {
      if (this.cancelled.has(jobId)) return;
      await this.store.update(jobId, job => { job.error = error.message; addEvent(job, "job_failed", { reason: error.message }); return job; }).catch(() => {});
      await this.setStatus(jobId, "failed").catch(() => {});
    } finally {
      this.schedulers.delete(jobId);
      this.jobControllers.delete(jobId);
    }
  }

  getStatus(jobId) { return this.store.get(jobId); }
  getResult(jobId) { return this.store.get(jobId).then(job => job.result); }

  async runWithWorkspace({ job, subtask, attempt, signal }) {
    if (signal?.aborted) throw new Error("cancelled");
    let workspace = subtask.workspace;
    if (!workspace) {
      workspace = await this.workspaceManager.create({
        jobId: job.job_id,
        subtaskId: subtask.id,
        baseRef: this.baseRef
      });
      await this.store.update(job.job_id, current => {
        const item = current.subtasks.find(value => value.id === subtask.id);
        if (item) item.workspace = current.status === "cancelled" ? { ...workspace, state: "cancelled" } : workspace;
        return current;
      });
    }
    workspace = await this.workspaceManager.markState(workspace, signal?.aborted ? "cancelled" : "running");
    await this.store.update(job.job_id, current => {
      const item = current.subtasks.find(value => value.id === subtask.id);
      if (item) item.workspace = current.status === "cancelled" ? { ...workspace, state: "cancelled" } : workspace;
      return current;
    });
    try {
      const result = await this.runner({ job, subtask: { ...subtask, workspace }, attempt, signal, workspace });
      if (signal?.aborted) throw new Error("cancelled");
      workspace = await this.workspaceManager.markState(workspace, "completed");
      await this.store.update(job.job_id, current => {
        const item = current.subtasks.find(value => value.id === subtask.id);
        if (item) item.workspace = current.status === "cancelled" ? { ...workspace, state: "cancelled" } : workspace;
        return current;
      });
      return result;
    } catch (error) {
      workspace = await this.workspaceManager.markState(workspace, signal?.aborted ? "cancelled" : "failed");
      await this.store.update(job.job_id, current => {
        const item = current.subtasks.find(value => value.id === subtask.id);
        if (item) item.workspace = current.status === "cancelled" ? { ...workspace, state: "cancelled" } : workspace;
        return current;
      }).catch(() => {});
      throw error;
    }
  }

  async setStatus(jobId, status) {
    const result = await this.store.update(jobId, job => {
      if (job.status === "cancelled" && status !== "cancelled") return job;
      job.status = status;
      const timestamp = new Date().toISOString();
      markState(job, status, timestamp);
      job.duration_ms = durationMs(job, Date.parse(timestamp));
      addEvent(job, "job_state", { status });
      safeLog(job.events.at(-1), this.limits.logEvents ? console : { log() {} });
      return job;
    });
    try { await this.onStatusChange(result); } catch {}
    return result;
  }

  async cancelJob(jobId) {
    const current = await this.store.get(jobId);
    if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") return current;
    this.cancelled.add(jobId);
    this.jobControllers.get(jobId)?.abort(new Error("job_cancelled"));
    const scheduler = this.schedulers.get(jobId);
    if (scheduler) await scheduler.cancel(jobId);
    else await this.store.update(jobId, job => { job.status = "cancelled"; job.cancelled_at = new Date().toISOString(); return job; });
    await this.processes.get(jobId);
    await this.store.update(jobId, job => {
      for (const subtask of job.subtasks) {
        if (subtask.status === "cancelled" && subtask.workspace) subtask.workspace.state = "cancelled";
      }
      return job;
    });
    try { await this.onStatusChange(await this.store.get(jobId)); } catch {}
    if (!(await this.store.get(jobId)).result) await this.saveFailureResult(jobId, "cancelled");
    return this.store.get(jobId);
  }

  async cancelSubtask(jobId, subtaskId) {
    const scheduler = this.schedulers.get(jobId);
    if (!scheduler) throw new Error("job is not running");
    return scheduler.cancelSubtask(jobId, subtaskId);
  }

  async saveFailureResult(jobId, reason) {
    const job = await this.store.get(jobId);
    const aggregate = job.aggregate;
    const result = validateFinalJobResult({
      summary: `Job failed: ${reason}`,
      changed_files: aggregate?.changed_files || [], tests: aggregate?.tests || [], warnings: aggregate?.warnings || [],
      conflicts: aggregate?.conflicts || [], remaining_work: aggregate?.remaining_work || [],
      final_decision: "rejected", review_findings: [reason, ...(aggregate?.remaining_work || [])], workspaces: aggregate?.workspaces || [], aggregate: aggregate || null,
      test_evidence: null, review: null, events: job.events, metrics: job.metrics,
      limit_violations: job.limit_violations, duration_ms: durationMs(job), execution_mode: aggregate?.execution_mode || "simulation"
    });
    await this.store.update(jobId, current => { current.result = result; return current; });
  }
}
