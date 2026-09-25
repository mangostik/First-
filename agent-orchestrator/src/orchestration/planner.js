import { validateSubtask } from "./schemas.js";
import { AGENT_REGISTRY } from "./agent-registry.js";

const ROUTABLE_ROLES = ["backend", "qa", "frontend", "database", "security", "documentation"];

function matchesRole(role, text) {
  return AGENT_REGISTRY[role].allowed_task_types.some(type => new RegExp(`(?:^|[^a-zа-я])${type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-zа-я])`, "i").test(text));
}

export function selectRoles(task) {
  const text = String(task || "").trim();
  const selected = ROUTABLE_ROLES.filter(role => matchesRole(role, text));
  return selected.length ? { roles: selected, fallback: false } : { roles: ["backend"], fallback: true };
}

export function planTask(task) {
  const text = String(task || "").trim();
  if (!text) throw new Error("task is required");
  const routing = selectRoles(text);
  const subtasks = routing.roles.map(role => {
    const definition = AGENT_REGISTRY[role];
    return validateSubtask({
      id: `${role}-1`,
      role,
      title: definition.description,
      instructions: `${definition.purpose}\nTask: ${text}\nExpected result: ${definition.result_format.join(", ")}\nRequired tests: ${definition.required_tests.join(", ")}\nConstraints: ${definition.constraints.join("; ")}${routing.fallback ? "\nThis is a safe fallback: clarify the task and do not make speculative changes." : ""}`,
      dependencies: [],
      status: "queued"
    });
  });
  const reviewerDependencies = subtasks.map(subtask => ({ subtask_id: subtask.id, required_status: "completed" }));
  subtasks.push(validateSubtask({
    id: "reviewer-1",
    role: "reviewer",
    title: AGENT_REGISTRY.reviewer.description,
    instructions: "Review all routed role results for completeness, tests, conflicts, security, and remaining work.",
    dependencies: reviewerDependencies,
    status: "waiting"
  }));

  return {
    subtasks,
    dependencies: subtasks.flatMap(subtask => subtask.dependencies.map(dependency => ({
      subtask_id: subtask.id,
      depends_on: dependency.subtask_id,
      required_status: dependency.required_status
    }))),
    required_agents: [...routing.roles, "reviewer"],
    risk_level: "medium",
    acceptance_criteria: [...routing.roles.map(role => `${role} task completes`), "Reviewer task completes"],
    routing: { selected_roles: routing.roles, fallback: routing.fallback }
  };
}
