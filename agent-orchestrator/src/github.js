export function validatePositiveInteger(value, name) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(name + " must be a positive finite integer");
  }
  return value;
}

export function validateGitHubConfig({ repo = "", base = "", head = "" }) {
  const values = [repo, base, head].map(value => String(value || "").trim());
  const present = values.filter(Boolean).length;
  if (present !== 0 && present !== 3) {
    throw new Error("GITHUB_REPO, GITHUB_BASE, and GITHUB_HEAD must be set together");
  }
  return {
    configured: present === 3,
    repo: values[0],
    base: values[1],
    head: values[2]
  };
}

export async function fetchGitHubDiff({
  repo,
  base,
  head,
  token,
  timeoutMs = 120000,
  maxBytes = 20000
}) {
  if (!repo) throw new Error("repo is required, e.g. mangostik/First-");
  if (!base) throw new Error("base is required");
  if (!head) throw new Error("head is required");
  validatePositiveInteger(maxBytes, "maxBytes");

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
    if (!response.body) throw new Error("GitHub compare returned no response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let diff = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch {}
        controller.abort();
        const error = new Error("Diff exceeds MAX_DIFF_CHARS limit");
        error.code = "DIFF_TOO_LARGE";
        error.diffSize = totalBytes;
        error.limit = maxBytes;
        throw error;
      }

      diff += decoder.decode(value, { stream: true });
    }

    diff += decoder.decode();
    if (!diff.trim()) throw new Error("GitHub compare returned an empty diff");
    return diff;
  } finally {
    clearTimeout(timeout);
  }
}
