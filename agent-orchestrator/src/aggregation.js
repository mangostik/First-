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
    ["agree", "approved"].includes(synthesis.status) &&
    synthesis.ready_to_merge === true &&
    (!Array.isArray(synthesis.critical_issues) || synthesis.critical_issues.length === 0)
  );
  const reviewerApproved = decisions.length > 0 &&
    decisions.every(item => ["agree", "approved"].includes(item.status) && item.ready_to_merge === true) &&
    synthesisAgrees && criticalIssues.length === 0;
  const finalStatus = preservedTerminalStatus || (
    !coverageComplete ? "BLOCKED" : "FINAL_DECISION"
  );
  const readyToMerge = coverageComplete &&
    !preservedTerminalStatus &&
    !hasBlocked &&
    reviewerApproved;
  return {
    final_status: finalStatus,
    rounds: results.reduce((sum, item) => sum + (item.rounds || 0), 0),
    decision: {
      status: readyToMerge ? "agree" : (hasBlocked ? "blocked" : "needs_changes"),
      critical_issues: criticalIssues,
      recommended_changes: recommendedChanges,
      ready_to_merge: readyToMerge,
      evidence: coverageComplete ? evidence : unique([
        ...evidence,
        "Review coverage is incomplete; approval is blocked until every chunk is reviewed."
      ])
    },
    combined: { critical_issues: criticalIssues, recommended_changes: recommendedChanges, evidence }
  };
}
