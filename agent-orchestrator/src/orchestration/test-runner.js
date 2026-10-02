import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactSecrets } from "./observability.js";

const execFileAsync = promisify(execFile);
export const TEST_EVIDENCE_STATUSES = Object.freeze(["passed", "failed", "timeout", "error"]);
const SAFE_TEST_COMMAND_LABEL = "configured-test-command";
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_CAPTURE_BYTES = 256 * 1024;
const SAFE_ENV_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "CI", "LANG", "LC_ALL", "TZ", "FORCE_COLOR", "NO_COLOR", "NODE_ENV"
]);
const SECRET_ENV_KEY = /(?:api.?key|authorization|access.?key|token|password|secret|credential|private.?key)/i;
const OUTPUT_TRUNCATION_MARKER = "\n[output truncated]";

function evidence({ status, command, exitCode = null, stdout = "", stderr = "", durationMs, error = null }) {
  return {
    status,
    command: String(command || "test command"),
    exit_code: exitCode,
    stdout: sanitizeOutput(stdout),
    stderr: sanitizeOutput(stderr),
    duration_ms: durationMs,
    error: error == null ? null : sanitizeOutput(error)
  };
}

function sanitizeOutput(value, secretValues = []) {
  try {
    let text = String(value || "");
    for (const secret of secretValues) {
      if (secret.length >= 4) text = text.split(secret).join("[REDACTED]");
    }
    text = String(redactSecrets(text));
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength <= MAX_OUTPUT_BYTES) return text;
    const markerBytes = Buffer.byteLength(OUTPUT_TRUNCATION_MARKER);
    let excerpt = bytes.subarray(0, MAX_OUTPUT_BYTES - markerBytes).toString("utf8");
    if (excerpt.endsWith("\uFFFD")) excerpt = excerpt.slice(0, -1);
    return `${excerpt}${OUTPUT_TRUNCATION_MARKER}`;
  } catch {
    return "[output omitted: redaction failed]";
  }
}

function childEnvironment(source = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (SAFE_ENV_KEYS.has(key.toUpperCase()) && value != null) result[key] = String(value);
  }
  return result;
}

function secretValuesFrom(source = process.env) {
  return Object.entries(source)
    .filter(([key]) => SECRET_ENV_KEY.test(key))
    .map(([, value]) => String(value || ""))
    .filter(value => value.length >= 4);
}

function normalizeCommand(command) {
  if (Array.isArray(command) && command.length) return command.map(String);
  return ["npm", "test"];
}

export function createMockTestRunner(options = {}) {
  return {
    mode: "mock",
    async run({ signal } = {}) {
      const started = Date.now();
      const delayMs = Number(options.delayMs || 0);
      if (delayMs > 0) await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      });
      const result = options.result || { status: "passed", exit_code: 0, stdout: "mock tests passed", stderr: "", error: null };
      return evidence({ ...result, command: result.command || "mock:test", exitCode: result.exit_code, durationMs: Date.now() - started });
    }
  };
}

export function createRealTestRunner({ command = ["npm", "test"], executor = execFileAsync, env = process.env } = {}) {
  return {
    mode: "real",
    async run({ workspace, signal } = {}) {
      const args = normalizeCommand(command);
      const started = Date.now();
      const secrets = secretValuesFrom(env);
      try {
        const result = await executor(args[0], args.slice(1), {
          cwd: workspace?.workspace_path,
          signal,
          windowsHide: true,
          env: childEnvironment(env),
          maxBuffer: MAX_CAPTURE_BYTES
        });
        const exitCode = result.exitCode ?? result.code ?? 0;
        return evidence({ status: exitCode === 0 ? "passed" : "failed", command: SAFE_TEST_COMMAND_LABEL, exitCode, stdout: sanitizeOutput(result.stdout, secrets), stderr: sanitizeOutput(result.stderr, secrets), durationMs: Date.now() - started });
      } catch (error) {
        const timedOut = error?.code === "ETIMEDOUT" || error?.killed || error?.signal === "SIGTERM";
        const cancelled = signal?.aborted || error?.name === "AbortError";
        return evidence({
          status: cancelled ? "error" : timedOut ? "timeout" : (Number.isInteger(error?.code) ? "failed" : "error"),
          command: SAFE_TEST_COMMAND_LABEL,
          exitCode: Number.isInteger(error?.code) ? error.code : null,
          stdout: sanitizeOutput(error?.stdout, secrets),
          stderr: sanitizeOutput(error?.stderr, secrets),
          durationMs: Date.now() - started,
          error: cancelled ? "test command cancelled" : timedOut ? "test command timed out" : "test command could not complete"
        });
      }
    }
  };
}

export function withTestTimeout(runner, timeoutMs = 120000) {
  return {
    mode: runner.mode,
    async run(context = {}) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (context.signal?.aborted) controller.abort(context.signal.reason);
      else context.signal?.addEventListener("abort", onAbort, { once: true });
      const started = Date.now();
      let timer;
      try {
        return await Promise.race([
          runner.run({ ...context, signal: controller.signal }),
          new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(evidence({ status: "timeout", command: runner.mode, durationMs: Date.now() - started, error: `test timeout after ${timeoutMs}ms` })); }, timeoutMs); })
        ]);
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", onAbort);
      }
    }
  };
}

export function createConfiguredTestRunner({ env = process.env, mockOptions = {}, realOptions = {} } = {}) {
  const mode = String(env.ORCHESTRATION_TEST_MODE || "mock").trim().toLowerCase();
  const timeoutMs = Number(env.ORCHESTRATION_TEST_TIMEOUT_MS || 120000);
  if (mode === "mock") return withTestTimeout(createMockTestRunner(mockOptions), timeoutMs);
  if (mode === "real") {
    const configuredCommand = String(env.ORCHESTRATION_TEST_COMMAND || "npm test").trim();
    const command = configuredCommand ? configuredCommand.split(/\s+/) : ["npm", "test"];
    return withTestTimeout(createRealTestRunner({ ...realOptions, command }), timeoutMs);
  }
  throw new Error(`Invalid ORCHESTRATION_TEST_MODE: ${mode}`);
}
