import { join } from "node:path";
import { createJob, validateFinalJobResult, validateTestEvidence } from "./schemas.js";
import { planTask } from "./planner.js";
import { JsonJobStore } from "./job-store.js";
import { createConfiguredAgentRunner } from "./agent-runner.js";
import { DependencyScheduler } from "./scheduler.js";
import { createConfiguredWorkspaceManager } from "./workspace.js";
import { integrateSubtasks } from "./integrator.js";
import { createConfiguredJobReviewer } from "./reviewer.js";
import { createConfiguredTestRunner } from "./test-runner.js";
import { addEvent, addLimitViolation, durationMs, markState, readOrchestrationLimits, safeLog } from "./observability.js";

export class OrchestrationService {
  constructor({ store, runner, reviewer, testRunner, schedulerOptions = {}, onStatusChange, workspaceManager } = {}) {
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
    this.limits = { ...readOrchestrationLimits(), ...schedulerOptions };
    this.schedulerOptions = schedulerOptions;
    this.schedulers = new Map();
    this.processes = new Map();
    this.cancelled = new Set();
    this.onStatusChange = typeof onStatusChange === "function" ? onStatusChange : () => {};
  }

  async createJob(task) {
    const job = await this.store.create(createJob(task));
    const processing = this.process(job.job_id);
    this.processes.set(job.job_id, processing);
    processing.finally(() => this.processes.delete(job.job_id)).catch(() => {});
    return { job_id: job.job_id, status: job.status };
  }

  async process(jobId) {
    try {
      await this.setStatus(jobId, "planning");
      const planned = planTask((await this.store.get(jobId)).task);
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
        logEvents: this.limits.logEvents,
        ...this.schedulerOptions
      });
      this.schedulers.set(jobId, scheduler);
      let job = await scheduler.run(jobId);
      if (job.status === "cancelled" || this.cancelled.has(jobId)) return;
      const hardLimitFailure = job.limit_violations?.some(item => ["max_subtasks", "concurrency", "job_timeout"].includes(item.code));
      if (job.status === "failed" && hardLimitFailure) {
        await this.saveFailureResult(jobId, job.error || job.limit_violations.at(-1).code);
        return;
      }
      await this.setStatus(jobId, "integrating");
      job = await this.store.get(jobId);
      const aggregate = integrateSubtasks(job);
      await this.store.update(jobId, current => { current.aggregate = aggregate; return current; });
      let testEvidence;
      try {
        testEvidence = await this.testRunner.run({
          job,
          aggregate,
          workspace: aggregate.workspaces[0] || null
        });
      } catch (error) {
        testEvidence = validateTestEvidence({
          status: "error",
          command: this.testRunner.mode || "project-tests",
          stdout: "",
          stderr: "",
          duration_ms: 0,
          error: error?.message || String(error)
        });
      }
      await this.store.update(jobId, current => { current.test_evidence = testEvidence; return current; });
      await this.setStatus(jobId, "reviewing");
      const review = await this.reviewer.review({ task: job.task, aggregate, testEvidence });
      const latest = await this.store.get(jobId);
      const result = validateFinalJobResult({
        ...aggregate,
        final_decision: review.final_decision,
        review_findings: review.review_findings,
        test_evidence: testEvidence,
        aggregate,
        review,
        events: latest.events,
        metrics: latest.metrics,
        limit_violations: latest.limit_violations,
        duration_ms: durationMs(latest)
      });
      await this.store.update(jobId, current => { current.result = result; return current; });
      await this.setStatus(jobId, review.approved ? "completed" : "failed");
    } catch (error) {
      await this.store.update(jobId, job => { job.error = error.message; addEvent(job, "job_failed", { reason: error.message }); return job; }).catch(() => {});
      await this.setStatus(jobId, "failed").catch(() => {});
    } finally {
      this.schedulers.delete(jobId);
    }
  }

  getStatus(jobId) { return this.store.get(jobId); }
  getResult(jobId) { return this.store.get(jobId).then(job => job.result); }

  async runWithWorkspace({ job, subtask, attempt, signal }) {
    let workspace = subtask.workspace;
    if (!workspace) {
      workspace = await this.workspaceManager.create({
        jobId: job.job_id,
        subtaskId: subtask.id,
        baseRef: this.baseRef
      });
      await this.store.update(job.job_id, current => {
        const item = current.subtasks.find(value => value.id === subtask.id);
        if (item) item.workspace = workspace;
        return current;
      });
    }
    workspace = await this.workspaceManager.markState(workspace, signal?.aborted ? "cancelled" : "running");
    await this.store.update(job.job_id, current => {
      const item = current.subtasks.find(value => value.id === subtask.id);
      if (item) item.workspace = workspace;
      return current;
    });
    try {
      const result = await this.runner({ job, subtask: { ...subtask, workspace }, attempt, signal, workspace });
      workspace = await this.workspaceManager.markState(workspace, "completed");
      await this.store.update(job.job_id, current => {
        const item = current.subtasks.find(value => value.id === subtask.id);
        if (item) item.workspace = workspace;
        return current;
      });
      return result;
    } catch (error) {
      workspace = await this.workspaceManager.markState(workspace, signal?.aborted ? "cancelled" : "failed");
      await this.store.update(job.job_id, current => {
        const item = current.subtasks.find(value => value.id === subtask.id);
        if (item) item.workspace = workspace;
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
    const scheduler = this.schedulers.get(jobId);
    if (scheduler) await scheduler.cancel(jobId);
    else await this.store.update(jobId, job => { job.status = "cancelled"; job.cancelled_at = new Date().toISOString(); return job; });
    await this.processes.get(jobId);
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
    const result = validateFinalJobResult({
      summary: `Job failed: ${reason}`,
      changed_files: [], tests: [], warnings: [], conflicts: [], remaining_work: [],
      final_decision: "rejected", review_findings: [reason], workspaces: [], aggregate: null,
      test_evidence: null, review: null, events: job.events, metrics: job.metrics,
      limit_violations: job.limit_violations, duration_ms: durationMs(job)
    });
    await this.store.update(jobId, current => { current.result = result; return current; });
  }
}
