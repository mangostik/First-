export function failureResult(error, { chunksReviewed = 0, chunksTotal = 0, events = error?.reviewEvents || [], partial = error?.partialResult || null } = {}) {
  const provider = error?.provider || (error?.message || "").match(/^(Claude|OpenAI)/)?.[1] || null;
  const code = error?.code || "REVIEW_ERROR";
  const status = ["PROVIDER_TIMEOUT", "REVIEW_LOOP_TIMEOUT", "MCP_REVIEW_TIMEOUT"].includes(code)
    ? "TIMEOUT"
    : ["PROVIDER_ABORTED", "MCP_REVIEW_CANCELLED"].includes(code) ? "CANCELLED" : "FAILED";
  const reason = String(error?.message || error || "Unknown review failure");
  const lastProviderEvent = [...events].reverse().find(event => event?.provider);
  const completedChunks = Array.isArray(partial?.chunkResults) ? partial.chunkResults.map(item => item.chunk) : [];
  return {
    final_status: status,
    ready_to_merge: false,
    reason,
    error: { code, provider, message: reason },
    rounds: 0,
    chunks_reviewed: partial?.mandatory_completed ?? chunksReviewed,
    chunks_total: partial?.chunks_total ?? chunksTotal,
    coverage_complete: partial?.coverage_complete === true,
    executed_chunks: completedChunks,
    last_provider: partial?.last_provider || lastProviderEvent?.provider || null,
    last_chunk: partial?.last_chunk || lastProviderEvent?.chunk || null,
    last_round: partial?.last_round || lastProviderEvent?.round || null,
    elapsed_ms: partial?.elapsed_ms ?? null,
    partial_result: partial,
    decision: {
      status: "blocked",
      critical_issues: [`Review did not complete: ${reason}`],
      recommended_changes: ["Resolve the review provider failure and rerun the review."],
      ready_to_merge: false,
      evidence: [`provider=${provider || "unknown"}`, `error_code=${code}`]
    },
    events,
    transcript: partial?.chunkResults || []
  };
}
