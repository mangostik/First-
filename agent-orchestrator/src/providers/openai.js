import { extractJson, normalizeAgentResponse } from "../protocol.js";

const AGENT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["agree", "disagree", "needs_changes", "blocked"] },
    critical_issues: { type: "array", items: { type: "string" } },
    recommended_changes: { type: "array", items: { type: "string" } },
    ready_to_merge: { type: "boolean" },
    evidence: { type: "array", items: { type: "string" } }
  },
  required: ["status", "critical_issues", "recommended_changes", "ready_to_merge", "evidence"]
};

function collectOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
  if (!Array.isArray(data.output)) return "";
  return data.output
    .flatMap(item => Array.isArray(item.content) ? item.content : [])
    .filter(part => part && part.type === "output_text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n");
}

export async function askOpenAI({ apiKey, model, prompt, maxOutputTokens, timeoutMs }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!model) throw new Error("OPENAI_MODEL is required");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: prompt,
        max_output_tokens: maxOutputTokens,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "agent_review",
            strict: true,
            schema: AGENT_RESPONSE_SCHEMA
          }
        }
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error("OpenAI API error " + response.status + ": " + await response.text());
    const data = await response.json();
    const text = collectOutputText(data);
    if (!text.trim()) {
      throw new Error("OpenAI returned no text output. status=" + String(data.status || "unknown") +
        " incomplete=" + JSON.stringify(data.incomplete_details || null));
    }
    return normalizeAgentResponse(extractJson(text));
  } finally { clearTimeout(timeout); }
}
