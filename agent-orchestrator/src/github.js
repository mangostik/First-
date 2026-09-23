export async function fetchGitHubDiff({ repo, base, head, token, timeoutMs = 120000 }) {
  if (!repo) throw new Error("repo is required, e.g. mangostik/First-");
  if (!base) throw new Error("base is required");
  if (!head) throw new Error("head is required");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      "Accept": "application/vnd.github.v3.diff",
      "User-Agent": "fishcrm-agent-orchestrator"
    };
    if (token) headers.Authorization = "Bearer " + token;

    const url = "https://api.github.com/repos/" + repo + "/compare/" +
      encodeURIComponent(base) + "..." + encodeURIComponent(head);

    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error("GitHub compare error " + response.status + ": " + await response.text());
    }

    const diff = await response.text();
    if (!diff.trim()) throw new Error("GitHub compare returned an empty diff");
    return diff;
  } finally {
    clearTimeout(timeout);
  }
}
