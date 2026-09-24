import { extractJson, normalizeAgentResponse, unstructuredAgentResponse } from "../protocol.js";

async function requestClaude({ apiKey, model, prompt, maxOutputTokens, signal }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxOutputTokens, messages: [{ role: "user", content: prompt }] }),
    signal
  });
  if (!response.ok) throw new Error("Anthropic API error " + response.status + ": " + await response.text());
  const data = await response.json();
  return (data.content || []).filter(part => part.type === "text").map(part => part.text).join("\n");
}

export async function askClaude({ apiKey, model, prompt, maxOutputTokens, timeoutMs }) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
  if (!model) throw new Error("ANTHROPIC_MODEL is required");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const text = await requestClaude({ apiKey, model, prompt, maxOutputTokens, signal: controller.signal });
    try {
      return normalizeAgentResponse(extractJson(text));
    } catch {
      const retryPrompt = [
        prompt,
        "",
        "FORMAT RECOVERY: Return one JSON object only. Do not use prose, Markdown, code fences, or explanations outside that object."
      ].join("\n");
      const retryText = await requestClaude({ apiKey, model, prompt: retryPrompt, maxOutputTokens, signal: controller.signal });
      try {
        return normalizeAgentResponse(extractJson(retryText));
      } catch {
        return unstructuredAgentResponse("Claude");
      }
    }
  } finally { clearTimeout(timeout); }
}
