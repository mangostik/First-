export class ProviderRequestError extends Error {
  constructor(message, { code, provider, timeoutMs, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProviderRequestError";
    this.code = code || "PROVIDER_REQUEST_ERROR";
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }
}

function positiveTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value) || value <= 0) throw new Error("provider timeout must be positive");
  return Math.floor(value);
}

export async function requestWithTimeout({ provider, timeoutMs, signal, request }) {
  const limit = positiveTimeout(timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  let timer;
  let rejectAbort;

  const abortPromise = new Promise((_, reject) => {
    rejectAbort = () => reject(new ProviderRequestError(`${provider} request was cancelled`, {
      code: "PROVIDER_ABORTED",
      provider,
      timeoutMs: limit
    }));
  });

  const abortFromCaller = () => {
    externallyAborted = true;
    controller.abort(signal.reason);
    rejectAbort();
  };

  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`${provider} request timeout`));
      reject(new ProviderRequestError(`${provider} request timed out after ${limit}ms`, {
        code: "PROVIDER_TIMEOUT",
        provider,
        timeoutMs: limit
      }));
    }, limit);
  });

  try {
    if (externallyAborted) {
      throw new ProviderRequestError(`${provider} request was cancelled`, {
        code: "PROVIDER_ABORTED",
        provider,
        timeoutMs: limit
      });
    }
    return await Promise.race([Promise.resolve().then(() => request(controller.signal)), timeoutPromise, abortPromise]);
  } catch (error) {
    if (timedOut || error?.code === "PROVIDER_TIMEOUT") throw error;
    if (externallyAborted || error?.name === "AbortError") {
      throw new ProviderRequestError(`${provider} request was cancelled`, {
        code: "PROVIDER_ABORTED",
        provider,
        timeoutMs: limit,
        cause: error
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function isRetryableProviderError(error) {
  return Boolean(error?.retryable) || [408, 429, 500, 502, 503, 504].includes(error?.status);
}

export async function waitBeforeRetry({ attempt, retryAfterMs = 0, signal }) {
  const delayMs = Math.min(5000, Math.max(100, Number(retryAfterMs) || 250 * (2 ** (attempt - 1))));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const cancel = () => {
      clearTimeout(timer);
      reject(new ProviderRequestError("Provider retry was cancelled", { code: "PROVIDER_ABORTED" }));
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
