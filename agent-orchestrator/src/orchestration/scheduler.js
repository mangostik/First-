import { isTerminal } from "./statuses.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class DependencyScheduler {
  constructor({ store, runner, maxParallel = 3, timeoutMs = 30_000, maxRetries = 1 } = {}) {
    if (!store || !runner) throw new Error("store and runner are required");
    this.store = store;
    this.runner = typeof runner === "function" ? runner : runner?.run?.bind(runner);
    if (!this.runner) throw new Error("runner must be a function or adapter with run()");
    this.maxParallel = Math.max(1, Math.min(3, Number(maxParallel)));
    this.timeoutMs = Math.max(1, Number(timeoutMs));
    this.maxRetries = Math.max(0, Number(maxRetries));
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
      for (const subtask of job.subtasks) {
        if (!isTerminal(subtask.status)) {
          subtask.status = "cancelled";
          if (subtask.workspace) subtask.workspace.state = "cancelled";
        }
      }
      return job;
    });
  }

  async run(jobId) {
    while (true) {
      let job = await this.store.get(jobId);
      if (job.status === "cancelled" || this.cancelled.has(jobId)) return job;

      const byId = new Map(job.subtasks.map(subtask => [subtask.id, subtask]));
      let changed = false;
      for (const subtask of job.subtasks) {
        if (subtask.status !== "waiting") continue;
        const dependencies = subtask.dependencies.map(dep => byId.get(dep.subtask_id));
        if (dependencies.some(dep => dep?.status === "failed" || dep?.status === "cancelled")) {
          subtask.status = "failed";
          subtask.error = "dependency_failed";
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
      if (this.active.size > 0) await Promise.race([...this.active.values()].map(entry => entry.promise));
      else await sleep(5);
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
      if (subtask) { subtask.status = "running"; subtask.started_at = new Date().toISOString(); }
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
        return job;
      });
      try {
        const result = await Promise.race([
          this.runner({ job: current, subtask, attempt, signal: controller.signal }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), this.timeoutMs))
        ]);
        await this.store.update(jobId, job => {
          const item = job.subtasks.find(value => value.id === subtaskId);
          if (item) { item.status = "completed"; item.result = result; item.finished_at = new Date().toISOString(); }
          return job;
        });
        return;
      } catch (error) {
        if (controller.signal.aborted || this.cancelled.has(jobId)) return;
        if (attempt <= this.maxRetries) {
          await this.store.update(jobId, job => {
            const item = job.subtasks.find(value => value.id === subtaskId);
            if (item) { item.status = "queued"; item.error = error.message; }
            return job;
          });
          continue;
        }
        await this.store.update(jobId, job => {
          const item = job.subtasks.find(value => value.id === subtaskId);
          if (item) { item.status = "failed"; item.error = error.message; item.finished_at = new Date().toISOString(); }
          return job;
        });
      }
    }
  }
}
