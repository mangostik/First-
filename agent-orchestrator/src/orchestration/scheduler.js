import { isTerminal } from "./statuses.js";
import { addEvent, addLimitViolation, durationMs, markState, safeLog } from "./observability.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finiteAtLeast = (value, fallback, minimum) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, number) : fallback;
};

export class DependencyScheduler {
  constructor({ store, runner, maxParallel = 3, timeoutMs = 30_000, maxRetries = 1, jobTimeoutMs = 300_000, logEvents = false } = {}) {
    if (!store || !runner) throw new Error("store and runner are required");
    this.store = store;
    this.runner = typeof runner === "function" ? runner : runner?.run?.bind(runner);
    if (!this.runner) throw new Error("runner must be a function or adapter with run()");
    this.maxParallel = Math.min(3, finiteAtLeast(maxParallel, 3, 1));
    this.timeoutMs = finiteAtLeast(timeoutMs, 30_000, 1);
    this.maxRetries = finiteAtLeast(maxRetries, 1, 0);
    this.jobTimeoutMs = finiteAtLeast(jobTimeoutMs, 300_000, 1);
    this.logEvents = Boolean(logEvents);
    this.active = new Map();
    this.cancelled = new Set();
  }

  activeFor(jobId) {
    return [...this.active.values()].filter(entry => entry.jobId === jobId);
  }

  async cancel(jobId) {
    this.cancelled.add(jobId);
    for (const entry of this.activeFor(jobId)) entry.controller.abort();
    await this.store.update(jobId, job => {
      if (job.status === "completed" || job.status === "failed") return job;
      job.status = "cancelled";
      job.cancelled_at = new Date().toISOString();
      markState(job, "cancelled", job.cancelled_at);
      addEvent(job, "job_cancelled", { reason: "job_cancelled" });
      for (const subtask of job.subtasks) {
        if (!isTerminal(subtask.status)) {
            subtask.status = "cancelled";
            subtask.cancel_reason = "job_cancelled";
            markState(subtask, "cancelled", job.cancelled_at);
            subtask.duration_ms = durationMs(subtask, Date.parse(job.cancelled_at));
            addEvent(job, "subtask_cancelled", { subtask_id: subtask.id, reason: "job_cancelled" });
          if (subtask.workspace) subtask.workspace.state = "cancelled";
        }
      }
      return job;
    });
    this.cancelled.delete(jobId);
    return this.store.get(jobId);
  }

  async cancelSubtask(jobId, subtaskId) {
    const key = `${jobId}:${subtaskId}`;
    const entry = this.active.get(key);
    if (entry) entry.controller.abort();
    if (entry) await Promise.allSettled([entry.promise]);
    return this.store.update(jobId, job => {
      const subtask = job.subtasks.find(item => item.id === subtaskId);
      if (!subtask || isTerminal(subtask.status)) return job;
      subtask.status = "cancelled";
      subtask.error = "cancelled";
      subtask.cancel_reason = "subtask_cancelled";
      subtask.finished_at = new Date().toISOString();
      markState(subtask, "cancelled", subtask.finished_at);
      subtask.duration_ms = durationMs(subtask, Date.parse(subtask.finished_at));
      addEvent(job, "subtask_cancelled", { subtask_id: subtaskId, reason: "subtask_cancelled" });
      if (subtask.workspace) subtask.workspace.state = "cancelled";
      return job;
    });
  }

  async run(jobId) {
    const started = Date.now();
    while (true) {
      let job = await this.store.get(jobId);
      if (job.status === "cancelled" || this.cancelled.has(jobId)) return job;
      if (job.status === "failed") return job;
      if (Date.now() - started >= this.jobTimeoutMs) {
        return this.failForLimit(jobId, "job_timeout", { limit_ms: this.jobTimeoutMs });
      }

      const dependencyUpdate = await this.store.update(jobId, current => {
        const byId = new Map(current.subtasks.map(subtask => [subtask.id, subtask]));
        let changed = false;
        for (const subtask of current.subtasks) {
          if (subtask.status !== "waiting") continue;
          const dependencies = subtask.dependencies.map(dep => byId.get(dep.subtask_id));
          if (dependencies.some(dep => dep?.status === "failed" || dep?.status === "cancelled")) {
            subtask.status = "failed";
            subtask.error = "dependency_failed";
            markState(subtask, "failed");
            addEvent(current, "subtask_failed", { subtask_id: subtask.id, reason: "dependency_failed" });
            changed = true;
          } else if (dependencies.every(dep => dep?.status === "completed")) {
            subtask.status = "queued";
            changed = true;
          }
        }
        return current;
      });
      job = dependencyUpdate;

      const queued = job.subtasks.filter(subtask => subtask.status === "queued");
      for (const subtask of queued) {
        if (this.active.size >= this.maxParallel) break;
        this.start(jobId, subtask.id);
      }

      job = await this.store.get(jobId);
      const unfinished = job.subtasks.some(subtask => !isTerminal(subtask.status));
      const activeForJob = this.activeFor(jobId);
      if (!unfinished && activeForJob.length === 0) return job;
      if (activeForJob.length === 0 && queued.length === 0) {
        const latest = await this.store.get(jobId);
        const latestActive = this.activeFor(jobId);
        const latestQueued = latest.subtasks.some(subtask => subtask.status === "queued");
        const latestUnfinished = latest.subtasks.some(subtask => !isTerminal(subtask.status));
        if (latestUnfinished || latestActive.length > 0 || latestQueued) continue;
        await this.store.update(jobId, current => {
          current.status = "failed";
          current.error = "dependency_deadlock";
          return current;
        });
        return this.store.get(jobId);
      }
      const remainingMs = Math.max(1, this.jobTimeoutMs - (Date.now() - started));
      if (activeForJob.length > 0) {
        let jobTimer;
        const winner = await Promise.race([
          ...activeForJob.map(entry => entry.promise),
          new Promise(resolve => { jobTimer = setTimeout(() => resolve("__JOB_TIMEOUT__"), remainingMs); })
        ]).finally(() => clearTimeout(jobTimer));
        if (winner === "__JOB_TIMEOUT__") return this.failForLimit(jobId, "job_timeout", { limit_ms: this.jobTimeoutMs });
      } else await sleep(Math.min(5, remainingMs));
    }
  }

  start(jobId, subtaskId) {
    const controller = new AbortController();
    const key = `${jobId}:${subtaskId}`;
    let resolveSettled;
    const settledPromise = new Promise(resolve => { resolveSettled = resolve; });
    const entry = { jobId, controller, promise: null, settledPromise, resolveSettled, runnerPromise: null, runnerSettled: true, executeSettled: false };
    entry.promise = this.execute(jobId, subtaskId, controller, entry)
      .finally(() => {
        entry.executeSettled = true;
        if (entry.runnerSettled) { entry.resolveSettled(); this.active.delete(key); }
      });
    this.active.set(key, entry);
  }

  async execute(jobId, subtaskId, controller, entry) {
    await this.store.update(jobId, job => {
      const subtask = job.subtasks.find(item => item.id === subtaskId);
      if (subtask) {
        subtask.status = "running";
        subtask.started_at = new Date().toISOString();
        markState(subtask, "running", subtask.started_at);
        addEvent(job, "subtask_started", { subtask_id: subtaskId });
        job.metrics = job.metrics || {};
        job.metrics.active_tasks = (job.metrics.active_tasks || 0) + 1;
        job.metrics.max_active_tasks = Math.max(job.metrics.max_active_tasks || 0, job.metrics.active_tasks);
        job.metrics.total_attempts = job.metrics.total_attempts || 0;
        safeLog(job.events.at(-1), this.logEvents ? console : { log() {} });
      }
      return job;
    });

    let attempt = 0;
    while (attempt <= this.maxRetries) {
      attempt += 1;
      const current = await this.store.get(jobId);
      const subtask = current.subtasks.find(item => item.id === subtaskId);
      await this.store.update(jobId, job => {
        const item = job.subtasks.find(value => value.id === subtaskId);
        if (item) item.attempts = attempt;
        job.metrics = job.metrics || {};
        job.metrics.total_attempts = (job.metrics.total_attempts || 0) + 1;
        return job;
      });
      let timedOut = false;
      try {
        let subtaskTimer;
        const attemptController = new AbortController();
        const abortAttempt = () => attemptController.abort(controller.signal.reason);
        if (controller.signal.aborted) abortAttempt();
        else controller.signal.addEventListener("abort", abortAttempt, { once: true });
        let rejectAbort;
        const cancelledAttempt = new Promise((_, reject) => { rejectAbort = () => reject(new Error("cancelled")); });
        if (controller.signal.aborted) rejectAbort();
        else controller.signal.addEventListener("abort", rejectAbort, { once: true });
        const runnerPromise = Promise.resolve().then(() => this.runner({ job: current, subtask, attempt, signal: attemptController.signal }));
        entry.runnerPromise = runnerPromise;
        entry.runnerSettled = false;
        runnerPromise.then(
          () => { entry.runnerSettled = true; if (entry.executeSettled) { entry.resolveSettled(); this.active.delete(`${jobId}:${subtaskId}`); } },
          () => { entry.runnerSettled = true; if (entry.executeSettled) { entry.resolveSettled(); this.active.delete(`${jobId}:${subtaskId}`); } }
        );
        const result = await Promise.race([
          runnerPromise,
          cancelledAttempt,
          new Promise((_, reject) => { subtaskTimer = setTimeout(() => { timedOut = true; attemptController.abort(new Error("timeout")); reject(new Error("timeout")); }, this.timeoutMs); })
        ]).finally(() => {
          clearTimeout(subtaskTimer);
          controller.signal.removeEventListener("abort", abortAttempt);
          controller.signal.removeEventListener("abort", rejectAbort);
        });
        entry.runnerSettled = true;
        if (result?.status === "failed") throw new Error(result.error || "agent_result_failed");
        if (controller.signal.aborted || this.cancelled.has(jobId)) return;
        await this.store.update(jobId, job => {
          const item = job.subtasks.find(value => value.id === subtaskId);
          if (item) {
            item.status = "completed";
            item.result = result;
            item.finished_at = new Date().toISOString();
            markState(item, "completed", item.finished_at);
            item.duration_ms = durationMs(item, Date.parse(item.finished_at));
            addEvent(job, "subtask_completed", { subtask_id: subtaskId, attempts: item.attempts, duration_ms: item.duration_ms });
            job.metrics.active_tasks = Math.max(0, (job.metrics?.active_tasks || 1) - 1);
          }
          return job;
        });
        return;
      } catch (error) {
        if (controller.signal.aborted || this.cancelled.has(jobId)) return;
        if (timedOut) error = new Error("timeout");
        // A runner that ignores AbortSignal may still be executing. Never
        // overlap a timeout with a new attempt in the same workspace.
        if (error.message !== "timeout" && attempt <= this.maxRetries) {
          await this.store.update(jobId, job => {
            const item = job.subtasks.find(value => value.id === subtaskId);
            if (item) { item.status = "queued"; item.error = error.message; item.retry_reasons = [...(item.retry_reasons || []), error.message]; markState(item, "queued"); }
            addEvent(job, "subtask_retry", { subtask_id: subtaskId, attempt, reason: error.message });
            if (error.message === "timeout") addLimitViolation(job, "subtask_timeout", { subtask_id: subtaskId, limit_ms: this.timeoutMs });
            return job;
          });
          continue;
        }
        await this.store.update(jobId, job => {
          const item = job.subtasks.find(value => value.id === subtaskId);
          if (item) {
            item.status = "failed";
            item.error = error.message;
            item.finished_at = new Date().toISOString();
            markState(item, "failed", item.finished_at);
            item.duration_ms = durationMs(item, Date.parse(item.finished_at));
            job.metrics.active_tasks = Math.max(0, (job.metrics?.active_tasks || 1) - 1);
            addEvent(job, "subtask_failed", { subtask_id: subtaskId, reason: error.message, attempts: item.attempts });
            if (error.message === "timeout") addLimitViolation(job, "subtask_timeout", { subtask_id: subtaskId, limit_ms: this.timeoutMs });
            if (attempt > this.maxRetries) addLimitViolation(job, "max_retries", { subtask_id: subtaskId, max_retries: this.maxRetries });
          }
          if (error.message === "timeout") {
            job.status = "failed";
            job.error = "timeout";
            markState(job, "failed");
          }
          return job;
        });
        return;
      }
    }
  }

  async failForLimit(jobId, code, details = {}) {
    const active = this.activeFor(jobId);
    for (const entry of active) entry.controller.abort();
    return this.store.update(jobId, job => {
      addLimitViolation(job, code, details);
      job.status = "failed";
      job.error = code;
      markState(job, "failed");
      addEvent(job, "job_failed", { reason: code });
      return job;
    });
  }
}
