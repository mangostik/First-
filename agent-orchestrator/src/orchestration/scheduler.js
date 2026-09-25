import { isTerminal } from "./statuses.js";
import { addEvent, addLimitViolation, durationMs, markState, safeLog } from "./observability.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class DependencyScheduler {
  constructor({ store, runner, maxParallel = 3, timeoutMs = 30_000, maxRetries = 1, jobTimeoutMs = 300_000, logEvents = false } = {}) {
    if (!store || !runner) throw new Error("store and runner are required");
    this.store = store;
    this.runner = typeof runner === "function" ? runner : runner?.run?.bind(runner);
    if (!this.runner) throw new Error("runner must be a function or adapter with run()");
    this.maxParallel = Math.max(1, Math.min(3, Number(maxParallel)));
    this.timeoutMs = Math.max(1, Number(timeoutMs));
    this.maxRetries = Math.max(0, Number(maxRetries));
    this.jobTimeoutMs = Math.max(1, Number(jobTimeoutMs));
    this.logEvents = Boolean(logEvents);
    this.active = new Map();
    this.cancelled = new Set();
  }

  async cancel(jobId) {
    this.cancelled.add(jobId);
    const activePromises = [...this.active.values()].map(entry => {
      entry.controller.abort();
      return entry.promise;
    });
    await Promise.allSettled(activePromises);
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
      if (Date.now() - started >= this.jobTimeoutMs) {
        return this.failForLimit(jobId, "job_timeout", { limit_ms: this.jobTimeoutMs });
      }

      const byId = new Map(job.subtasks.map(subtask => [subtask.id, subtask]));
      let changed = false;
      for (const subtask of job.subtasks) {
        if (subtask.status !== "waiting") continue;
        const dependencies = subtask.dependencies.map(dep => byId.get(dep.subtask_id));
        if (dependencies.some(dep => dep?.status === "failed" || dep?.status === "cancelled")) {
          subtask.status = "failed";
          subtask.error = "dependency_failed";
          markState(subtask, "failed");
          addEvent(job, "subtask_failed", { subtask_id: subtask.id, reason: "dependency_failed" });
          changed = true;
        } else if (dependencies.every(dep => dep?.status === "completed")) {
          subtask.status = "queued";
          changed = true;
        }
      }
      if (changed) job = await this.store.write(job);

      const queued = job.subtasks.filter(subtask => subtask.status === "queued");
      for (const subtask of queued) {
        if (this.active.size >= this.maxParallel) break;
        this.start(jobId, subtask.id);
      }

      job = await this.store.get(jobId);
      const unfinished = job.subtasks.some(subtask => !isTerminal(subtask.status));
      if (!unfinished && this.active.size === 0) return job;
      if (this.active.size === 0 && queued.length === 0) {
        await this.store.update(jobId, current => {
          current.status = "failed";
          current.error = "dependency_deadlock";
          return current;
        });
        return this.store.get(jobId);
      }
      const remainingMs = Math.max(1, this.jobTimeoutMs - (Date.now() - started));
      if (this.active.size > 0) {
        let jobTimer;
        const winner = await Promise.race([
          ...[...this.active.values()].map(entry => entry.promise),
          new Promise(resolve => { jobTimer = setTimeout(() => resolve("__JOB_TIMEOUT__"), remainingMs); })
        ]).finally(() => clearTimeout(jobTimer));
        if (winner === "__JOB_TIMEOUT__") return this.failForLimit(jobId, "job_timeout", { limit_ms: this.jobTimeoutMs });
      } else await sleep(Math.min(5, remainingMs));
    }
  }

  start(jobId, subtaskId) {
    const controller = new AbortController();
    const key = `${jobId}:${subtaskId}`;
    const promise = this.execute(jobId, subtaskId, controller)
      .finally(() => this.active.delete(key));
    this.active.set(key, { controller, promise });
  }

  async execute(jobId, subtaskId, controller) {
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
      try {
        let subtaskTimer;
        const result = await Promise.race([
          this.runner({ job: current, subtask, attempt, signal: controller.signal }),
          new Promise((_, reject) => { subtaskTimer = setTimeout(() => reject(new Error("timeout")), this.timeoutMs); })
        ]).finally(() => clearTimeout(subtaskTimer));
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
        if (attempt <= this.maxRetries) {
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
          return job;
        });
      }
    }
  }

  async failForLimit(jobId, code, details = {}) {
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.allSettled([...this.active.values()].map(entry => entry.promise));
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
