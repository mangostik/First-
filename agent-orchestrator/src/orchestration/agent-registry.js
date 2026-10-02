export const AGENT_REGISTRY = Object.freeze({
  backend: {
    role: "backend",
    description: "API and server logic",
    purpose: "Implement server-side behavior, endpoints, integrations, and business logic.",
    allowed_task_types: ["api", "endpoint", "backend", "server", "integration"],
    input_context: ["original task", "acceptance criteria", "assigned workspace", "dependency results"],
    result_format: ["summary", "changed_files", "tests", "warnings", "error"],
    constraints: ["work only in the assigned workspace", "do not modify main", "do not merge branches"],
    completion_criteria: ["implementation is complete", "changed files are listed", "relevant checks are reported"],
    required_tests: ["unit or integration tests for the API behavior"]
  },
  qa: {
    role: "qa",
    description: "Tests and verification",
    purpose: "Design and run verification for the requested behavior and regressions.",
    allowed_task_types: ["test", "tests", "qa", "verification", "regression"],
    input_context: ["original task", "acceptance criteria", "backend results", "assigned workspace"],
    result_format: ["summary", "tests", "failures", "warnings", "error"],
    constraints: ["do not weaken assertions", "do not hide failures", "do not modify main"],
    completion_criteria: ["test cases are defined", "checks are executed or blocked with evidence", "failures are explicit"],
    required_tests: ["positive path", "failure path", "regression coverage"]
  },
  frontend: {
    role: "frontend",
    description: "User interface and client behavior",
    purpose: "Implement or verify browser-facing screens, components, and client interactions.",
    allowed_task_types: ["frontend", "ui", "ux", "component", "screen", "dashboard", "browser"],
    input_context: ["original task", "UI acceptance criteria", "API contract", "assigned workspace"],
    result_format: ["summary", "changed_files", "tests", "accessibility_notes", "warnings", "error"],
    constraints: ["preserve existing UI contracts", "avoid new dependencies unless explicitly requested", "do not modify main"],
    completion_criteria: ["UI behavior matches acceptance criteria", "responsive/accessibility concerns are reported", "checks are recorded"],
    required_tests: ["component or UI behavior", "keyboard/accessibility checks where applicable"]
  },
  database: {
    role: "database",
    description: "Schema, migrations, and data integrity",
    purpose: "Design or implement safe schema, migration, query, and data-integrity changes.",
    allowed_task_types: ["database", "db", "schema", "migration", "sql", "query", "data"],
    input_context: ["original task", "current schema", "migration policy", "assigned workspace"],
    result_format: ["summary", "changed_files", "migration_safety", "tests", "warnings", "error"],
    constraints: ["preserve history", "avoid destructive operations without explicit approval", "do not modify production data", "do not modify main"],
    completion_criteria: ["migration/query is reviewable", "rollback or safety notes are recorded", "data-integrity checks are reported"],
    required_tests: ["schema or migration validation", "data-integrity and rollback checks"]
  },
  security: {
    role: "security",
    description: "Security, authorization, and threat review",
    purpose: "Identify and address security risks in implementation, data access, and configuration.",
    allowed_task_types: ["security", "auth", "authorization", "permission", "rls", "vulnerability", "secret"],
    input_context: ["original task", "threat assumptions", "changed files", "assigned workspace"],
    result_format: ["summary", "findings", "severity", "tests", "warnings", "error"],
    constraints: ["never expose secrets", "do not bypass authorization", "do not make production changes", "do not modify main"],
    completion_criteria: ["findings have severity and evidence", "remediation or accepted risk is explicit", "security checks are recorded"],
    required_tests: ["authorization boundary", "negative/abuse path", "secret-redaction check"]
  },
  documentation: {
    role: "documentation",
    description: "User and developer documentation",
    purpose: "Create or update accurate operational, API, and developer documentation.",
    allowed_task_types: ["documentation", "docs", "readme", "runbook", "guide", "api reference"],
    input_context: ["original task", "implemented behavior", "configuration", "assigned workspace"],
    result_format: ["summary", "changed_files", "coverage", "tests", "warnings", "error"],
    constraints: ["document observed behavior only", "do not expose secrets or private endpoints", "do not modify main"],
    completion_criteria: ["instructions are actionable", "configuration and limitations are documented", "links/examples are checked"],
    required_tests: ["documentation link or example check", "configuration accuracy review"]
  },
  reviewer: {
    role: "reviewer",
    description: "Combined result review",
    purpose: "Review completed role outputs for completeness, conflicts, tests, and remaining work.",
    allowed_task_types: ["review", "integration review"],
    input_context: ["original task", "all dependency results", "aggregate result", "test evidence"],
    result_format: ["summary", "changed_files", "tests", "warnings", "conflicts", "remaining_work", "final_decision"],
    constraints: ["never merge automatically", "reject missing evidence", "do not modify main"],
    completion_criteria: ["all findings are explicit", "approval is evidence-based", "remaining work is recorded"],
    required_tests: ["aggregate and project test evidence review"]
  }
});

export function getAgentDefinition(role) {
  const definition = AGENT_REGISTRY[role];
  if (!definition) throw new Error(`Unknown agent role: ${role}`);
  return definition;
}

export function listAgentDefinitions() {
  return Object.values(AGENT_REGISTRY).map(definition => structuredClone(definition));
}
