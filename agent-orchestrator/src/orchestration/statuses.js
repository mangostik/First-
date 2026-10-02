export const JOB_STATUSES = Object.freeze([
  "queued",
  "planning",
  "running",
  "waiting",
  "integrating",
  "reviewing",
  "completed",
  "failed",
  "cancelled"
]);

export const SUBTASK_STATUSES = JOB_STATUSES;
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function assertStatus(status, label = "status") {
  if (!JOB_STATUSES.includes(status)) {
    throw new Error(`Invalid ${label}: ${status}`);
  }
  return status;
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}
