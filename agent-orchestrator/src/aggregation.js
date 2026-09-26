function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

export function aggregateChunkResults(results, synthesis = null, coverageComplete = true) {
  const decisions = results.map(item => item.decision || {});
  const hasBlocked = results.some(item =>
    item.final_status === "BLOCKED" || item.decision?.status === "blocked"
  ) || synthesis?.status === "blocked";
  // Preserve a concrete terminal cause deterministically. This keeps an
  // incomplete review actionable instead of replacing TIMEOUT/COST_LIMIT/
  // FAILED with the generic BLOCKED status.
  const terminalStatuses = ["TIMEOUT", "COST_LIMIT", "FAILED"];
  const preservedTerminalStatus = terminalStatuses.find(status =>
    results.some(item => item.final_status === status)
  );
  const allConsensus = results.every(item => item.final_status === "CONSENSUS");
  const allReady = decisions.every(item => item.ready_to_merge === true);
  const synthesisDecisions = synthesis ? [...decisions, synthesis] : decisions;
  const criticalIssues = unique(synthesisDecisions.flatMap(item =>
    Array.isArray(item.critical_issues) ? item.critical_issues : []
  ));
  const recommendedChanges = unique(synthesisDecisions.flatMap(item =>
    Array.isArray(item.recommended_changes) ? item.recommended_changes : []
  ));
  const evidence = unique(synthesisDecisions.flatMap(item =>
    Array.isArray(item.evidence) ? item.evidence : []
  ));
  const synthesisAgrees = !synthesis || (
    synthesis.status === "agree" &&
    synthesis.ready_to_merge === true &&
    (!Array.isArray(synthesis.critical_issues) || synthesis.critical_issues.length === 0)
  );
  const finalStatus = preservedTerminalStatus || (
    hasBlocked
      ? "BLOCKED"
      : !coverageComplete
        ? "BLOCKED"
        : allConsensus && allReady && criticalIssues.length === 0 && synthesisAgrees
          ? "CONSENSUS"
          : "FINAL_DECISION"
  );
  return {
    final_status: finalStatus,
    rounds: results.reduce((sum, item) => sum + (item.rounds || 0), 0),
    decision: {
      status: finalStatus === "CONSENSUS" ? "agree" : (hasBlocked ? "blocked" : "needs_changes"),
      critical_issues: criticalIssues,
      recommended_changes: recommendedChanges,
      ready_to_merge: coverageComplete && finalStatus === "CONSENSUS",
      evidence: coverageComplete ? evidence : unique([
        ...evidence,
        "Review coverage is incomplete; approval is blocked until every chunk is reviewed."
      ])
    },
    combined: { critical_issues: criticalIssues, recommended_changes: recommendedChanges, evidence }
  };
}
