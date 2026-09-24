import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateJob } from "./schemas.js";

function safeId(jobId) {
  const id = String(jobId || "");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid job_id");
  return id;
}

export class JsonJobStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(this.rootDir, { recursive: true });
  }

  pathFor(jobId) {
    return join(this.rootDir, safeId(jobId) + ".json");
  }

  async create(job) {
    const valid = validateJob(job);
    return this.enqueue(async () => {
      await this._write(valid);
      return valid;
    });
  }

  async get(jobId) {
    const raw = await readFile(this.pathFor(jobId), "utf8");
    return validateJob(JSON.parse(raw));
  }

  async write(job) {
    const valid = validateJob(job);
    return this.enqueue(() => this._write(valid));
  }

  async _write(job) {
    await this.init();
    const path = this.pathFor(job.job_id);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(job, null, 2) + "\n", "utf8");
      let renamed = false;
      const maxRenameAttempts = process.platform === "win32" ? 2 : 20;
      for (let attempt = 0; attempt < maxRenameAttempts && !renamed; attempt += 1) {
        try {
          await rename(temp, path);
          renamed = true;
        } catch (error) {
          if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === maxRenameAttempts - 1) break;
          await new Promise(resolve => setTimeout(resolve, 10 * Math.min(attempt + 1, 5)));
        }
      }
      if (!renamed && process.platform === "win32") {
        const backup = `${path}.${process.pid}.previous.bak`;
        await rm(backup, { force: true });
        await rename(path, backup);
        try {
          await rename(temp, path);
          renamed = true;
        } catch (error) {
          await rename(backup, path).catch(() => {});
          throw error;
        }
        await rm(backup, { force: true });
      }
      if (!renamed) throw new Error("Could not atomically replace job file");
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
    return job;
  }

  async update(jobId, updater) {
    return this.enqueue(async () => {
      const current = await this.get(jobId);
      const next = await updater(structuredClone(current));
      next.updated_at = new Date().toISOString();
      return this._write(next);
    });
  }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
}
