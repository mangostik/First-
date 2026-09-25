import { extractJson, normalizeAgentResponse } from "../protocol.js";
import { isRetryableProviderError, requestWithTimeout, waitBeforeRetry } from "./http.js";

export async function askClaude({ apiKey, model, prompt, maxOutputTokens, timeoutMs, signal, maxRetries = 1 }) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
  if (!model) throw new Error("ANTHROPIC_MODEL is required");
  const attempts = Math.max(1, Number(maxRetries) + 1);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestWithTimeout({
        provider: "Claude",
        timeoutMs,
        signal,
        request: async requestSignal => {
          const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
            body: JSON.stringify({ model, max_tokens: maxOutputTokens, messages: [{ role: "user", content: prompt }] }),
            signal: requestSignal
          });
          if (!response.ok) {
            const error = new Error("Anthropic API error " + response.status + ": " + await response.text());
            error.status = response.status;
            error.retryable = isRetryableProviderError({ status: response.status });
            throw error;
          }
          const data = await response.json();
          const text = (data.content || []).filter(part => part.type === "text").map(part => part.text).join("\n");
          return normalizeAgentResponse(extractJson(text));
        }
      });
    } catch (error) {
      if (!isRetryableProviderError(error) || attempt >= attempts) {
        error.message = `${error.message} (Claude attempt ${attempt}/${attempts})`;
        throw error;
      }
      await waitBeforeRetry({ attempt, signal });
    }
  }
}
