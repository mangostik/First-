import { askClaude } from "./providers/claude.js";
import { askOpenAI } from "./providers/openai.js";

function errorMeta(error) {
  return {
    code: error?.code || "REVIEW_ERROR",
    message: String(error?.message || error || "Unknown review error").slice(0, 500)
  };
}

export function createReviewEventEmitter({ events = [], write = null } = {}) {
  const emit = event => {
    const safeEvent = { timestamp: new Date().toISOString(), ...event };
    events.push(safeEvent);
    if (write) write(JSON.stringify(safeEvent) + "\n");
    return safeEvent;
  };
  return { events, emit };
}

export async function runProviderReviewLoop({
  task,
  chunks,
  config,
  promptBuilders,
  synthesize,
  isConsensus,
  signal,
  emit,
  askClaudeFn = askClaude,
  askOpenAIFn = askOpenAI
}) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });

  const callProvider = async (provider, invoke, meta = {}) => {
    emit({ type: "provider_started", provider, ...meta });
    try {
      const result = await invoke(controller.signal);
      emit({ type: "provider_completed", provider, ...meta });
      return result;
    } catch (error) {
      const details = errorMeta(error);
      emit({
        type: details.code === "PROVIDER_TIMEOUT" ? "provider_timeout" : "provider_error",
        provider,
        ...meta,
        code: details.code,
        message: details.message
      });
      throw error;
    }
  };

  const reviewChunk = async ({ diff, chunkIndex, chunkCount }) => {
    let lastOpenAI = null;
    const transcript = [];

    for (let round = 1; round <= config.maxRounds; round += 1) {
      const claude = await callProvider("Claude", providerSignal => askClaudeFn({
        apiKey: config.anthropicApiKey,
        model: config.anthropicModel,
        prompt: promptBuilders.claude({ task, diff, chunkIndex, chunkCount, round, openaiReview: lastOpenAI }),
        maxOutputTokens: config.maxOutputTokens,
        timeoutMs: config.claudeTimeoutMs,
        signal: providerSignal,
        maxRetries: config.providerMaxRetries
      }), { phase: "review", chunk: chunkIndex, round });

      const openai = await callProvider("OpenAI", providerSignal => askOpenAIFn({
        apiKey: config.openaiApiKey,
        model: config.openaiModel,
        prompt: promptBuilders.openai({ task, diff, chunkIndex, chunkCount, round, claudeResponse: claude }),
        maxOutputTokens: config.maxOutputTokens,
        timeoutMs: config.openaiTimeoutMs,
        signal: providerSignal,
        maxRetries: config.providerMaxRetries,
        maxStructuredRetries: config.structuredMaxRetries
      }), { phase: "review", chunk: chunkIndex, round });

      transcript.push({ round, claude, openai });
      if (isConsensus(claude, openai)) {
        return { final_status: "CONSENSUS", rounds: round, decision: openai, transcript };
      }
      if (claude.status === "blocked" && openai.status === "blocked") {
        return { final_status: "BLOCKED", rounds: round, decision: openai, transcript };
      }
      lastOpenAI = openai;
    }

    return {
      final_status: lastOpenAI?.status === "blocked" ? "BLOCKED" : "FINAL_DECISION",
      rounds: config.maxRounds,
      decision: lastOpenAI,
      transcript
    };
  };

  const work = (async () => {
    const chunkResults = [];
    for (let index = 0; index < chunks.length; index += 1) {
      chunkResults.push({
        chunk: index + 1,
        ...(await reviewChunk({ diff: chunks[index], chunkIndex: index + 1, chunkCount: chunks.length }))
      });
    }
    const synthesis = chunks.length > 1
      ? await synthesize({ task, results: chunkResults, signal: controller.signal, callProvider })
      : null;
    return { chunkResults, synthesis };
  })();

  let timer;
  let deadlineReached = false;
  const deadlineMs = Number(config.reviewLoopTimeoutMs);
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      deadlineReached = true;
      controller.abort(new Error("review loop deadline exceeded"));
      reject(Object.assign(new Error(`review loop timed out after ${deadlineMs}ms`), {
        code: "REVIEW_LOOP_TIMEOUT"
      }));
    }, deadlineMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    if (deadlineReached || error?.code === "PROVIDER_ABORTED") {
      emit({
        type: "review_loop_aborted",
        code: error?.code || "REVIEW_LOOP_ABORTED",
        reason: String(error?.message || "review loop aborted").slice(0, 500)
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
