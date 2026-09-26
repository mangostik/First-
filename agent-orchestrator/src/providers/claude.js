import { extractJson, normalizeAgentResponse, unstructuredAgentResponse } from "../protocol.js";
import { isRetryableProviderError, requestWithTimeout, waitBeforeRetry } from "./http.js";

async function requestClaude({ apiKey, model, prompt, maxOutputTokens, timeoutMs, signal }) {
  return requestWithTimeout({
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
      return (data.content || []).filter(part => part.type === "text").map(part => part.text).join("\n");
    }
  });
}

export async function askClaude({ apiKey, model, prompt, maxOutputTokens, timeoutMs, signal, maxRetries = 1, structuredMaxRetries = 1 }) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
  if (!model) throw new Error("ANTHROPIC_MODEL is required");
  const attempts = Math.max(1, Number(maxRetries) + 1);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const text = await requestClaude({ apiKey, model, prompt, maxOutputTokens, timeoutMs, signal });
      try {
        return normalizeAgentResponse(extractJson(text));
      } catch {
        const recoveryPrompt = [
          prompt,
          "",
          "FORMAT RECOVERY: Return one JSON object only. Do not use prose, Markdown, code fences, or explanations outside that object."
        ].join("\n");
        const recoveryAttempts = Math.max(1, Number(structuredMaxRetries) + 1);
        for (let recoveryAttempt = 1; recoveryAttempt <= recoveryAttempts; recoveryAttempt += 1) {
          const retryText = await requestClaude({ apiKey, model, prompt: recoveryPrompt, maxOutputTokens, timeoutMs, signal });
          try {
            return normalizeAgentResponse(extractJson(retryText));
          } catch {
            if (recoveryAttempt >= recoveryAttempts) return unstructuredAgentResponse("Claude");
          }
        }
      }
    } catch (error) {
      if (!isRetryableProviderError(error) || attempt >= attempts) {
        error.message = `${error.message} (Claude attempt ${attempt}/${attempts})`;
        throw error;
      }
      await waitBeforeRetry({ attempt, signal });
    }
  }
}
