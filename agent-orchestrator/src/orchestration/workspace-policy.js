export function assertNotMainBranch(branchName) {
  const branch = String(branchName || "").trim().toLowerCase();
  if (branch === "main") throw new Error("Direct changes to main are forbidden");
  return branchName;
}
