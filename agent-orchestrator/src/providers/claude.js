import { extractJson, normalizeAgentResponse } from "../protocol.js";

export async function askClaude({ apiKey, model, prompt, maxOutputTokens, timeoutMs }) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
  if (!model) throw new Error("ANTHROPIC_MODEL is required");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxOutputTokens, messages: [{ role: "user", content: prompt }] }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error("Anthropic API error " + response.status + ": " + await response.text());
    const data = await response.json();
    const text = (data.content || []).filter(part => part.type === "text").map(part => part.text).join("\n");
    return normalizeAgentResponse(extractJson(text));
  } finally { clearTimeout(timeout); }
}
