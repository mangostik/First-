export const STATUSES = new Set(["agree", "disagree", "needs_changes", "blocked"]);

export function normalizeAgentResponse(value) {
  if (!value || typeof value !== "object") throw new Error("Agent response must be an object");
  const status = String(value.status || "").toLowerCase();
  if (!STATUSES.has(status)) throw new Error("Invalid status: " + value.status);
  return {
    status,
    critical_issues: Array.isArray(value.critical_issues) ? value.critical_issues.map(String) : [],
    recommended_changes: Array.isArray(value.recommended_changes) ? value.recommended_changes.map(String) : [],
    ready_to_merge: Boolean(value.ready_to_merge),
    evidence: Array.isArray(value.evidence) ? value.evidence.map(String) : []
  };
}

export function extractJson(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1].trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) return JSON.parse(raw.slice(first, last + 1));
  throw new Error("No JSON object found in model response");
}

export function isConsensus(claude, openai) {
  return claude.status === "agree" && openai.status === "agree" &&
    claude.critical_issues.length === 0 && openai.critical_issues.length === 0 &&
    claude.ready_to_merge === true && openai.ready_to_merge === true;
}

export const RESPONSE_SCHEMA_HINT = {
  status: "agree | disagree | needs_changes | blocked",
  critical_issues: ["string"],
  recommended_changes: ["string"],
  ready_to_merge: false,
  evidence: ["string"]
};
