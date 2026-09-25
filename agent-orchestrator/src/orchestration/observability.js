const SECRET_KEY = /(api.?key|authorization|token|password|secret|credential)/i;
const SECRET_VALUE = /(bearer\s+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})/gi;

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(item)]));
  }
  return typeof value === "string" ? value.replace(SECRET_VALUE, match => match.toLowerCase().startsWith("bearer") ? "Bearer [REDACTED]" : "[REDACTED]") : value;
}

export function createEvent(type, data = {}) {
  return redactSecrets({ type, timestamp: new Date().toISOString(), ...data });
}

export function addEvent(job, type, data = {}) {
  job.events = Array.isArray(job.events) ? job.events : [];
  job.events.push(createEvent(type, { job_id: job.job_id, ...data }));
  return job.events[job.events.length - 1];
}

export function addLimitViolation(job, code, details = {}) {
  job.limit_violations = Array.isArray(job.limit_violations) ? job.limit_violations : [];
  const violation = createEvent("limit_violation", { code, ...details });
  job.limit_violations.push(violation);
  addEvent(job, "limit_violation", violation);
  return violation;
}

export function markState(target, status, timestamp = new Date().toISOString()) {
  target.timestamps = target.timestamps && typeof target.timestamps === "object" ? target.timestamps : {};
  target.timestamps[status] = timestamp;
  return target;
}

export function durationMs(target, now = Date.now()) {
  const started = Date.parse(target.timestamps?.running || target.timestamps?.started || "");
  if (!Number.isFinite(started)) return 0;
  const end = Date.parse(target.timestamps?.completed || target.timestamps?.failed || target.timestamps?.cancelled || "") || now;
  return Math.max(0, end - started);
}

export function safeLog(event, logger = console) {
  const output = JSON.stringify(redactSecrets(event));
  (logger.info || logger.log).call(logger, output);
}

export function readOrchestrationLimits(env = process.env) {
  const number = (name, fallback, minimum = 0) => {
    const value = Number(env[name] ?? fallback);
    return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
  };
  return {
    maxSubtasks: number("ORCHESTRATION_MAX_SUBTASKS", 10, 1),
    requestedMaxParallel: number("ORCHESTRATION_MAX_PARALLEL", 2, 1),
    maxParallel: Math.min(3, number("ORCHESTRATION_MAX_PARALLEL", 2, 1)),
    maxRetries: number("ORCHESTRATION_MAX_RETRIES", 1, 0),
    subtaskTimeoutMs: number("ORCHESTRATION_TIMEOUT_MS", 30_000, 1),
    jobTimeoutMs: number("ORCHESTRATION_JOB_TIMEOUT_MS", 300_000, 1),
    logEvents: String(env.ORCHESTRATION_LOG_EVENTS || "0") === "1"
  };
}
