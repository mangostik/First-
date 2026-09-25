import { validateAggregateResult } from "./schemas.js";

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

export function integrateSubtasks(job) {
  const subtasks = Array.isArray(job?.subtasks) ? job.subtasks : [];
  const fileOwners = new Map();
  const changedFiles = [];
  const tests = [];
  const warnings = [];
  const remainingWork = [];
  const workspaces = [];

  for (const subtask of subtasks) {
    if (subtask.workspace) workspaces.push(subtask.workspace);
    if (subtask.status !== "completed" || !subtask.result) {
      remainingWork.push(`${subtask.id}: ${subtask.error || subtask.status}`);
    }
    const result = subtask.result;
    if (!result) continue;
    for (const file of result.changed_files || []) {
      changedFiles.push(String(file));
      if (!fileOwners.has(String(file))) fileOwners.set(String(file), []);
      fileOwners.get(String(file)).push(subtask.id);
    }
    tests.push(...(result.tests || []).map(String));
    warnings.push(...(result.warnings || []).map(String));
    if (result.error) warnings.push(`${subtask.id}: ${result.error}`);
  }

  const conflicts = [...fileOwners.entries()]
    .filter(([, owners]) => new Set(owners).size > 1)
    .map(([file, owners]) => `${file} changed by ${unique(owners).join(", ")}`);

  return validateAggregateResult({
    summary: `${subtasks.filter(item => item.status === "completed").length}/${subtasks.length} subtasks completed`,
    changed_files: unique(changedFiles),
    tests: unique(tests),
    warnings: unique(warnings),
    conflicts,
    remaining_work: unique(remainingWork),
    workspaces
  });
}
