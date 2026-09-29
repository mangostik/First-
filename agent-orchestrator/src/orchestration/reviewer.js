import { runAgentReview } from "../mcp-runner.js";
import { validateReviewResult } from "./schemas.js";

export function createMockJobReviewer() {
  return {
    mode: "mock",
    async review({ task, aggregate, testEvidence }) {
      const findings = [];
      if (aggregate.conflicts.length) findings.push(...aggregate.conflicts);
      if (aggregate.remaining_work.length) findings.push(...aggregate.remaining_work);
      if (!aggregate.tests.length) findings.push("No test evidence was produced by the subtasks");
      if (!testEvidence || testEvidence.status !== "passed") findings.push("Project test gate did not pass");
      const approved = findings.length === 0;
      return validateReviewResult({
        final_decision: approved ? "approved" : "rejected",
        reviewer_mode: "mock",
        summary: approved ? `Mock review approved: ${task}` : "Mock review rejected the aggregate result",
        review_findings: findings,
        approved
      });
    }
  };
}

export function createRealJobReviewer({ review = runAgentReview } = {}) {
  return {
    mode: "real",
    async review({ task, aggregate, testEvidence, workspace, verifiedDiff, signal }) {
      const result = await review({
        task: [
          "Review the completed orchestration result for the original task. This is a read-only review; do not modify files.",
          task,
          `Read-only result workspace: ${workspace?.workspace_path || "unavailable"}`,
          "Verified Git diff from the result workspace:",
          String(verifiedDiff || aggregate.integration?.final_diff || ""),
          "Aggregate result:",
          JSON.stringify(aggregate),
          "Project test evidence:",
          JSON.stringify(testEvidence || null)
        ].join("\n\n")
      }, { signal });
      const decision = result.decision || {};
      const findings = [
        ...(decision.critical_issues || []),
        ...(decision.recommended_changes || []),
        ...aggregate.conflicts,
        ...aggregate.remaining_work
      ].map(String);
      if (!testEvidence || testEvidence.status !== "passed") findings.push("Project test gate did not pass");
      const approved = ["FINAL_DECISION", "CONSENSUS"].includes(result.final_status) &&
        result.coverage_complete !== false && decision.ready_to_merge === true &&
        ["agree", "approved"].includes(decision.status) && findings.length === 0 &&
        aggregate.conflicts.length === 0 && aggregate.remaining_work.length === 0 &&
        testEvidence?.status === "passed";
      return validateReviewResult({
        final_decision: approved ? "approved" : "rejected",
        reviewer_mode: "real",
        summary: decision.status || result.final_status || "Real review completed",
        review_findings: findings,
        approved
      });
    }
  };
}

export function createConfiguredJobReviewer({ env = process.env, realOptions = {} } = {}) {
  const mode = String(env.ORCHESTRATION_REVIEWER_MODE || "mock").trim().toLowerCase();
  if (mode === "mock") return createMockJobReviewer();
  if (mode === "real") return createRealJobReviewer(realOptions);
  throw new Error(`Invalid ORCHESTRATION_REVIEWER_MODE: ${mode}`);
}
