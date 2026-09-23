import { extractJson, normalizeAgentResponse } from "../protocol.js";

export async function askOpenAI({ apiKey, model, prompt, maxOutputTokens, timeoutMs }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!model) throw new Error("OPENAI_MODEL is required");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: prompt, max_output_tokens: maxOutputTokens }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error("OpenAI API error " + response.status + ": " + await response.text());
    const data = await response.json();
    let text = data.output_text || "";
    if (!text && Array.isArray(data.output)) {
      text = data.output.flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text).join("\n");
    }
    return normalizeAgentResponse(extractJson(text));
  } finally { clearTimeout(timeout); }
}
