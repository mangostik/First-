import { extractJson, normalizeAgentResponse } from "../protocol.js";
import { isRetryableProviderError, requestWithTimeout, waitBeforeRetry } from "./http.js";

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

async function requestOnce({ apiKey, model, prompt, maxOutputTokens, timeoutMs, signal, maxRetries = 1 }) {
  const attempts = Math.max(1, Number(maxRetries) + 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestWithTimeout({
        provider: "OpenAI",
        timeoutMs,
        signal,
        request: async requestSignal => {
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
            signal: requestSignal
          });
          if (!response.ok) {
            const error = new Error("OpenAI API error " + response.status + ": " + await response.text());
            error.status = response.status;
            error.retryable = isRetryableProviderError({ status: response.status });
            throw error;
          }
          return response.json();
        }
      });
    } catch (error) {
      if (!isRetryableProviderError(error) || attempt >= attempts) {
        error.message = `${error.message} (OpenAI request attempt ${attempt}/${attempts})`;
        throw error;
      }
      await waitBeforeRetry({ attempt, signal });
    }
  }
}

export function computeRetryTokenLimit(maxOutputTokens) {
  return Math.max(maxOutputTokens, Math.min(maxOutputTokens * 2, 8000));
}

export async function askOpenAI({ apiKey, model, prompt, maxOutputTokens, timeoutMs, signal, maxRetries = 1, maxStructuredRetries = 1 }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!model) throw new Error("OPENAI_MODEL is required");

  let lastError;
  const structuredAttempts = Math.max(1, Number(maxStructuredRetries) + 1);
  for (let attempt = 1; attempt <= structuredAttempts; attempt += 1) {
    const tokenLimit = attempt === 1 ? maxOutputTokens : computeRetryTokenLimit(maxOutputTokens);
    const data = await requestOnce({ apiKey, model, prompt, maxOutputTokens: tokenLimit, timeoutMs, signal, maxRetries });
    const text = collectOutputText(data);

    if (data.status === "incomplete") {
      lastError = new Error(
        "OpenAI response incomplete: " + JSON.stringify(data.incomplete_details || null)
      );
      continue;
    }

    if (!text.trim()) {
      lastError = new Error(
        "OpenAI returned no text output. status=" + String(data.status || "unknown") +
        " incomplete=" + JSON.stringify(data.incomplete_details || null)
      );
      continue;
    }

    try {
      return normalizeAgentResponse(extractJson(text));
    } catch (error) {
      lastError = new Error(
        "OpenAI returned invalid structured output on attempt " + attempt +
        ": " + error.message
      );
    }
  }

  throw lastError || new Error("OpenAI structured output failed after retries");
}
