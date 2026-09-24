export const AGENT_REGISTRY = Object.freeze({
  backend: { role: "backend", description: "API and server logic" },
  qa: { role: "qa", description: "Tests and verification" },
  reviewer: { role: "reviewer", description: "Combined result review" }
});

export function getAgentDefinition(role) {
  const definition = AGENT_REGISTRY[role];
  if (!definition) throw new Error(`Unknown agent role: ${role}`);
  return definition;
}
