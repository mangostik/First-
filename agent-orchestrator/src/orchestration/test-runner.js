import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const TEST_EVIDENCE_STATUSES = Object.freeze(["passed", "failed", "timeout", "error"]);

function evidence({ status, command, exitCode = null, stdout = "", stderr = "", durationMs, error = null }) {
  return { status, command, exit_code: exitCode, stdout: String(stdout || ""), stderr: String(stderr || ""), duration_ms: durationMs, error: error == null ? null : String(error) };
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

export function createRealTestRunner({ command = ["npm", "test"], executor = execFileAsync } = {}) {
  return {
    mode: "real",
    async run({ workspace, signal } = {}) {
      const args = normalizeCommand(command);
      const started = Date.now();
      try {
        const result = await executor(args[0], args.slice(1), { cwd: workspace?.workspace_path, signal, windowsHide: true });
        return evidence({ status: result.exitCode === 0 ? "passed" : "failed", command: args.join(" "), exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr, durationMs: Date.now() - started });
      } catch (error) {
        const timedOut = error?.code === "ETIMEDOUT" || error?.killed || error?.signal === "SIGTERM";
        return evidence({ status: timedOut ? "timeout" : (Number.isInteger(error?.code) ? "failed" : "error"), command: args.join(" "), exitCode: Number.isInteger(error?.code) ? error.code : null, stdout: error?.stdout, stderr: error?.stderr, durationMs: Date.now() - started, error: error?.message || String(error) });
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
      context.signal?.addEventListener("abort", onAbort, { once: true });
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
