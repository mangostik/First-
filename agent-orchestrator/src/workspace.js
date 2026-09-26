import { isAbsolute, normalize, resolve } from "node:path";

const TRUSTED_REF = "stage4-mcp";

export function resolveWorkspaceRoot(value = process.env.ORCHESTRATION_WORKSPACE_ROOT) {
  const raw = String(value || "").trim();
  if (!raw) return resolve(process.cwd());
  // GitHub Actions runs on Linux. Never turn a Windows drive path into a
  // misleading relative Linux path; use the runner workspace instead.
  if (process.platform === "linux" && /^[A-Za-z]:[\\/]/.test(raw)) {
    return resolve(process.cwd());
  }
  return normalize(isAbsolute(raw) ? raw : resolve(process.cwd(), raw));
}

export function assertTrustedWorkspace(env = process.env) {
  const ref = String(env.ORCHESTRATION_TRUSTED_REF || "").trim();
  if (env.CI === "true" && ref !== TRUSTED_REF) {
    const error = new Error(`Workspace must be reviewed from trusted ${TRUSTED_REF}`);
    error.code = "UNTRUSTED_WORKSPACE";
    throw error;
  }
  return resolveWorkspaceRoot(env.ORCHESTRATION_WORKSPACE_ROOT);
}
