import { validateSubtask } from "./schemas.js";

export function planTask(task) {
  const text = String(task || "").trim();
  if (!text) throw new Error("task is required");
  if (!/(api|endpoint|функц|функцию)/i.test(text) || !/(test|тест)/i.test(text)) {
    throw new Error("MVP planner supports tasks that request an API function and tests");
  }

  const subtasks = [
    validateSubtask({
      id: "backend-1",
      role: "backend",
      title: "Implement the API function",
      instructions: `Implement the requested API function: ${text}`,
      dependencies: [],
      status: "queued"
    }),
    validateSubtask({
      id: "qa-1",
      role: "qa",
      title: "Prepare and run API tests",
      instructions: `Prepare tests for the requested API function: ${text}`,
      dependencies: [],
      status: "queued"
    }),
    validateSubtask({
      id: "reviewer-1",
      role: "reviewer",
      title: "Review backend and QA results",
      instructions: "Review the backend and QA agent results for completeness and regressions.",
      dependencies: [
        { subtask_id: "backend-1", required_status: "completed" },
        { subtask_id: "qa-1", required_status: "completed" }
      ],
      status: "waiting"
    })
  ];

  return {
    subtasks,
    dependencies: subtasks.flatMap(subtask => subtask.dependencies.map(dependency => ({
      subtask_id: subtask.id,
      depends_on: dependency.subtask_id,
      required_status: dependency.required_status
    }))),
    required_agents: ["backend", "qa", "reviewer"],
    risk_level: "medium",
    acceptance_criteria: ["Backend task completes", "QA task completes", "Reviewer task completes"]
  };
}
