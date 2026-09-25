export function failureResult(error, { chunksReviewed = 0, chunksTotal = 0, events = error?.reviewEvents || [] } = {}) {
  const provider = error?.provider || (error?.message || "").match(/^(Claude|OpenAI)/)?.[1] || null;
  const code = error?.code || "REVIEW_ERROR";
  const status = ["PROVIDER_TIMEOUT", "REVIEW_LOOP_TIMEOUT"].includes(code)
    ? "TIMEOUT"
    : code === "PROVIDER_ABORTED" ? "CANCELLED" : "FAILED";
  const reason = String(error?.message || error || "Unknown review failure");
  return {
    final_status: status,
    reason,
    error: { code, provider, message: reason },
    rounds: 0,
    chunks_reviewed: chunksReviewed,
    chunks_total: chunksTotal,
    decision: {
      status: "blocked",
      critical_issues: [`Review did not complete: ${reason}`],
      recommended_changes: ["Resolve the review provider failure and rerun the review."],
      ready_to_merge: false,
      evidence: [`provider=${provider || "unknown"}`, `error_code=${code}`]
    },
    events,
    transcript: []
  };
}
