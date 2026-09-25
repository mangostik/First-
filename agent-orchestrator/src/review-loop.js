import { askClaude } from "./providers/claude.js";
import { askOpenAI } from "./providers/openai.js";

function errorMeta(error) {
  return { code: error?.code || "REVIEW_ERROR", message: String(error?.message || error || "Unknown review error").slice(0, 500) };
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

export class ReviewLoopTimeoutError extends Error {
  constructor(message, partialResult) {
    super(message);
    this.name = "ReviewLoopTimeoutError";
    this.code = "REVIEW_LOOP_TIMEOUT";
    this.partialResult = partialResult;
  }
}

function needsFollowup(result) {
  const decision = result?.decision || {};
  return result?.final_status !== "CONSENSUS" || decision.status !== "agree" ||
    decision.ready_to_merge !== true ||
    (Array.isArray(decision.critical_issues) && decision.critical_issues.length > 0);
}

export async function runProviderReviewLoop({ task, chunks, config, promptBuilders, synthesize, isConsensus, signal, emit, askClaudeFn = askClaude, askOpenAIFn = askOpenAI }) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });

  const deadlineMs = Number(config.reviewLoopTimeoutMs);
  const deadlineAt = Date.now() + deadlineMs;
  const guardMs = Number(config.reviewLoopGuardMs || 1000);
  const partial = { chunkResults: [], mandatory_completed: 0, followups_completed: 0, chunks_total: chunks.length, coverage_complete: false, synthesis: null };
  const timeoutError = reason => new ReviewLoopTimeoutError(reason || `review loop timed out after ${deadlineMs}ms`, JSON.parse(JSON.stringify(partial)));
  const assertTimeAvailable = provider => {
    const timeoutMs = provider === "Claude" ? Number(config.claudeTimeoutMs) : Number(config.openaiTimeoutMs);
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= timeoutMs + guardMs) throw timeoutError(`insufficient time for next ${provider} request (${Math.max(0, remainingMs)}ms remaining)`);
  };

  const callProvider = async (provider, invoke, meta = {}) => {
    assertTimeAvailable(provider);
    emit({ type: "provider_started", provider, ...meta });
    try {
      const result = await invoke(controller.signal);
      emit({ type: "provider_completed", provider, ...meta });
      return result;
    } catch (error) {
      const details = errorMeta(error);
      emit({ type: details.code === "PROVIDER_TIMEOUT" ? "provider_timeout" : "provider_error", provider, ...meta, code: details.code, message: details.message });
      throw error;
    }
  };

  const runRound = async ({ diff, chunkIndex, chunkCount, round, lastOpenAI }) => {
    const phase = round === 1 ? "mandatory" : "followup";
    const claude = await callProvider("Claude", providerSignal => askClaudeFn({
      apiKey: config.anthropicApiKey, model: config.anthropicModel,
      prompt: promptBuilders.claude({ task, diff, chunkIndex, chunkCount, round, openaiReview: lastOpenAI }),
      maxOutputTokens: config.maxOutputTokens, timeoutMs: config.claudeTimeoutMs, signal: providerSignal, maxRetries: config.providerMaxRetries
    }), { phase, chunk: chunkIndex, round });
    const openai = await callProvider("OpenAI", providerSignal => askOpenAIFn({
      apiKey: config.openaiApiKey, model: config.openaiModel,
      prompt: promptBuilders.openai({ task, diff, chunkIndex, chunkCount, round, claudeResponse: claude }),
      maxOutputTokens: config.maxOutputTokens, timeoutMs: config.openaiTimeoutMs, signal: providerSignal,
      maxRetries: config.providerMaxRetries, maxStructuredRetries: config.structuredMaxRetries
    }), { phase, chunk: chunkIndex, round });
    return { claude, openai, result: { final_status: isConsensus(claude, openai) ? "CONSENSUS" : (claude.status === "blocked" && openai.status === "blocked" ? "BLOCKED" : "FINAL_DECISION"), rounds: round, decision: openai } };
  };

  const run = async () => {
    const byChunk = new Map();
    // Mandatory phase: complete one round for every chunk before follow-ups.
    for (let index = 0; index < chunks.length; index += 1) {
      const round = await runRound({ diff: chunks[index], chunkIndex: index + 1, chunkCount: chunks.length, round: 1, lastOpenAI: null });
      const item = { chunk: index + 1, final_status: round.result.final_status, rounds: 1, decision: round.result.decision, transcript: [{ round: 1, claude: round.claude, openai: round.openai }] };
      byChunk.set(index, item);
      partial.chunkResults.push(item);
      partial.mandatory_completed += 1;
    }
    // Follow-up phase: only chunks with unresolved findings get more rounds.
    for (let index = 0; index < chunks.length; index += 1) {
      const item = byChunk.get(index);
      let lastOpenAI = item.decision;
      while (needsFollowup(item) && item.rounds < Number(config.maxRounds)) {
        const round = await runRound({ diff: chunks[index], chunkIndex: index + 1, chunkCount: chunks.length, round: item.rounds + 1, lastOpenAI });
        item.rounds = round.result.rounds;
        item.final_status = round.result.final_status;
        item.decision = round.result.decision;
        item.transcript.push({ round: item.rounds, claude: round.claude, openai: round.openai });
        lastOpenAI = item.decision;
        partial.followups_completed += 1;
      }
    }
    partial.coverage_complete = partial.mandatory_completed === chunks.length;
    if (!partial.coverage_complete) throw timeoutError("review did not cover every chunk");
    partial.synthesis = chunks.length > 1 ? await synthesize({ task, results: partial.chunkResults, signal: controller.signal, callProvider }) : null;
    return { chunkResults: partial.chunkResults, synthesis: partial.synthesis, coverageComplete: true };
  };

  let timer;
  let deadlineReached = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { deadlineReached = true; controller.abort(new Error("review loop deadline exceeded")); reject(timeoutError(`review loop timed out after ${deadlineMs}ms`)); }, deadlineMs);
  });
  try {
    return await Promise.race([run(), deadline]);
  } catch (error) {
    if (deadlineReached || error?.code === "PROVIDER_ABORTED" || error?.code === "PROVIDER_TIMEOUT" || error?.code === "REVIEW_LOOP_TIMEOUT") {
      if (!error.partialResult) error.partialResult = JSON.parse(JSON.stringify(partial));
      emit({ type: "review_loop_aborted", code: error?.code || "REVIEW_LOOP_ABORTED", reason: String(error?.message || "review loop aborted").slice(0, 500), mandatory_completed: partial.mandatory_completed, chunks_total: partial.chunks_total });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
