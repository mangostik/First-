import { askClaude } from "./providers/claude.js";
import { askOpenAI } from "./providers/openai.js";

function errorMeta(error) {
  return { code: error?.code || "REVIEW_ERROR", message: String(error?.message || error || "Unknown review error").slice(0, 500) };
}

export function createReviewEventEmitter({ events = [], write = null, maxEvents = 1000 } = {}) {
  const limit = Math.max(1, Number(maxEvents) || 1000);
  const emit = event => {
    const safeEvent = { timestamp: new Date().toISOString(), ...event };
    events.push(safeEvent);
    if (events.length > limit) events.splice(0, events.length - limit);
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

export class ReviewCostLimitError extends Error {
  constructor(message, partialResult) {
    super(message);
    this.name = "ReviewCostLimitError";
    this.code = "COST_LIMIT";
    this.partialResult = partialResult;
  }
}

function needsFollowup(result) {
  const decision = result?.decision || {};
  return result?.final_status !== "CONSENSUS" || decision.status !== "agree" ||
    decision.ready_to_merge !== true ||
    (Array.isArray(decision.critical_issues) && decision.critical_issues.length > 0);
}

export async function runProviderReviewLoop({ task, chunks, config, promptBuilders, synthesize, isConsensus, signal, emit, onProgress = () => {}, askClaudeFn = askClaude, askOpenAIFn = askOpenAI }) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });

  const mode = config.reviewMode == null ? "deep" : (["cheap", "standard", "deep"].includes(config.reviewMode) ? config.reviewMode : "cheap");
  const maxRounds = Math.max(1, Number(config.maxRounds || 1));
  const maxProviderCalls = Math.max(1, Number(config.maxProviderCalls || (mode === "cheap" ? 8 : mode === "standard" ? 12 : 100)));
  const maxOutputTokens = Math.max(1, Number(config.maxOutputTokens || 1));
  const estimatedCostPer1k = Math.max(0, Number(config.estimatedCostPer1kTokensUsd || 0));
  const costBudgetUsd = Number.isFinite(Number(config.costBudgetUsd)) ? Math.max(0, Number(config.costBudgetUsd)) : Infinity;
  const configuredTimeBudgetMs = Number(config.reviewTimeBudgetMs || config.reviewLoopTimeoutMs);
  const deadlineMs = Math.min(Number(config.reviewLoopTimeoutMs), configuredTimeBudgetMs);
  const deadlineAt = Date.now() + deadlineMs;
  const guardMs = Number(config.reviewLoopGuardMs || 1000);
  const startedAt = Date.now();
  const partial = {
    chunkResults: [], mandatory_completed: 0, followups_completed: 0,
    chunks_total: Number(config.totalChunks || chunks.length), coverage_complete: false,
    synthesis: null, elapsed_ms: 0, last_provider: null, last_chunk: null, last_round: null,
    pending_chunk: null, pending_chunks: [],
    usage: {
      review_mode: mode,
      provider_calls: 0,
      provider_calls_by_provider: { Claude: 0, OpenAI: 0 },
      estimated_output_tokens: 0,
      estimated_cost_usd: 0,
      max_provider_calls: maxProviderCalls,
      max_output_tokens: maxOutputTokens,
      cost_budget_usd: Number.isFinite(costBudgetUsd) ? costBudgetUsd : null,
      time_budget_ms: deadlineMs
    }
  };
  const refreshPartial = () => { partial.elapsed_ms = Date.now() - startedAt; return partial; };
  const checkpoint = () => onProgress(JSON.parse(JSON.stringify(refreshPartial())));
  const timeoutError = reason => new ReviewLoopTimeoutError(reason || `review loop timed out after ${deadlineMs}ms`, JSON.parse(JSON.stringify(partial)));
  const costError = reason => new ReviewCostLimitError(reason, JSON.parse(JSON.stringify(partial)));
  const assertTimeAvailable = provider => {
    const timeoutMs = provider === "Claude" ? Number(config.claudeTimeoutMs) : Number(config.openaiTimeoutMs);
    const remainingMs = deadlineAt - Date.now();
    // Preserve a useful request window without reserving the entire 120-second
    // provider timeout for every call near the overall deadline.
    if (remainingMs <= Math.min(timeoutMs, 30000) + guardMs) throw timeoutError(`insufficient time for next ${provider} request (${Math.max(0, remainingMs)}ms remaining)`);
  };

  const callProvider = async (provider, invoke, meta = {}) => {
    partial.last_provider = provider;
    partial.last_chunk = meta.chunk || null;
    partial.last_round = meta.round || null;
    const charge = tokenLimit => {
      assertTimeAvailable(provider);
      const tokens = Number(tokenLimit || maxOutputTokens);
      const nextCost = partial.usage.estimated_cost_usd + (tokens / 1000) * estimatedCostPer1k;
      if (partial.usage.provider_calls >= maxProviderCalls) throw costError(`provider call limit reached (${maxProviderCalls})`);
      if (nextCost > costBudgetUsd) throw costError(`cost budget reached (${costBudgetUsd} USD)`);
      partial.usage.provider_calls += 1;
      partial.usage.provider_calls_by_provider[provider] += 1;
      partial.usage.estimated_output_tokens += tokens;
      partial.usage.estimated_cost_usd = Number(nextCost.toFixed(6));
      refreshPartial();
      checkpoint();
    };
    let firstAttempt = true;
    const onAttempt = ({ maxOutputTokens: tokens } = {}) => {
      if (firstAttempt) { firstAttempt = false; return; }
      charge(tokens);
      emit({ type: "provider_retry", provider, ...meta, attempt: partial.usage.provider_calls });
    };
    let started = false;
    try {
      charge(meta.outputTokens || maxOutputTokens);
      emit({ type: "provider_started", provider, ...meta });
      started = true;
      checkpoint();
      const result = await invoke(controller.signal, onAttempt);
      emit({ type: "provider_completed", provider, ...meta });
      checkpoint();
      return result;
    } catch (error) {
      const details = errorMeta(error);
      if (started) emit({ type: details.code === "PROVIDER_TIMEOUT" ? "provider_timeout" : "provider_error", provider, ...meta, code: details.code, message: details.message });
      checkpoint();
      throw error;
    }
  };

  const runRound = async ({ diff, chunkIndex, chunkCount, round, lastOpenAI }) => {
    const phase = round === 1 ? "mandatory" : "followup";
    const claude = await callProvider("Claude", (providerSignal, onAttempt) => askClaudeFn({
      apiKey: config.anthropicApiKey, model: config.anthropicModel,
      prompt: promptBuilders.claude({ task, diff, chunkIndex, chunkCount, round, openaiReview: lastOpenAI }),
      maxOutputTokens: config.maxOutputTokens, timeoutMs: config.claudeTimeoutMs, signal: providerSignal, maxRetries: config.providerMaxRetries, onAttempt
    }), { phase, chunk: chunkIndex, round });
    const openai = await callProvider("OpenAI", (providerSignal, onAttempt) => askOpenAIFn({
      apiKey: config.openaiApiKey, model: config.openaiModel,
      prompt: promptBuilders.openai({ task, diff, chunkIndex, chunkCount, round, claudeResponse: claude }),
      maxOutputTokens: config.maxOutputTokens, timeoutMs: config.openaiTimeoutMs, signal: providerSignal,
      maxRetries: config.providerMaxRetries, maxStructuredRetries: config.structuredMaxRetries,
      reasoningEffort: "low", onAttempt
    }), { phase, chunk: chunkIndex, round });
    return { claude, openai, result: { final_status: isConsensus(claude, openai) ? "CONSENSUS" : (claude.status === "blocked" && openai.status === "blocked" ? "BLOCKED" : "FINAL_DECISION"), rounds: round, decision: openai } };
  };

  const runClaudePass = async ({ diff, chunkIndex, chunkCount }) => {
    const claude = await callProvider("Claude", (providerSignal, onAttempt) => askClaudeFn({
      apiKey: config.anthropicApiKey, model: config.anthropicModel,
      prompt: promptBuilders.claude({ task, diff, chunkIndex, chunkCount, round: 1, openaiReview: null }),
      maxOutputTokens, timeoutMs: config.claudeTimeoutMs, signal: providerSignal, maxRetries: config.providerMaxRetries, onAttempt
    }), { phase: "mandatory", chunk: chunkIndex, round: 1 });
    return { claude, openai: null, result: { final_status: claude.status === "agree" && claude.ready_to_merge === true ? "CONSENSUS" : "FINAL_DECISION", rounds: 1, decision: claude } };
  };

  const hasConcreteFindings = result => {
    const decision = result?.decision || result || {};
    return decision.status !== "agree" || decision.ready_to_merge !== true ||
      (Array.isArray(decision.critical_issues) && decision.critical_issues.length > 0) ||
      (Array.isArray(decision.recommended_changes) && decision.recommended_changes.length > 0);
  };

  const confirmFinding = async ({ diff, chunkIndex, chunkCount, claude, phase }) => {
    const openai = await callProvider("OpenAI", (providerSignal, onAttempt) => askOpenAIFn({
      apiKey: config.openaiApiKey, model: config.openaiModel,
      prompt: promptBuilders.openai({ task, diff, chunkIndex, chunkCount, round: 1, claudeResponse: claude }),
      maxOutputTokens, timeoutMs: config.openaiTimeoutMs, signal: providerSignal,
      maxRetries: config.providerMaxRetries, maxStructuredRetries: config.structuredMaxRetries,
      reasoningEffort: "low", onAttempt
    }), { phase, chunk: chunkIndex, round: 1 });
    return openai;
  };

  const run = async () => {
    const byChunk = new Map();
    if (mode === "standard") {
      // Cover the entire diff with Claude before spending time on confirmations.
      // A finding is not a completed chunk until OpenAI confirms it.
      const pending = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const round = await runClaudePass({ diff: chunks[index], chunkIndex: index + 1, chunkCount: partial.chunks_total });
        if (hasConcreteFindings(round.claude)) {
          pending.push({ index, claude: round.claude });
          partial.pending_chunk = { chunk: index + 1, claude: round.claude };
          partial.pending_chunks.push(partial.pending_chunk);
        } else {
          const item = { chunk: index + 1, ...round.result, transcript: [{ round: 1, claude: round.claude, openai: null }] };
          partial.chunkResults.push(item);
          partial.mandatory_completed += 1;
        }
        checkpoint();
      }
      for (const { index, claude } of pending) {
        partial.pending_chunk = { chunk: index + 1, claude };
        checkpoint();
        const openai = await confirmFinding({ diff: chunks[index], chunkIndex: index + 1, chunkCount: partial.chunks_total, claude, phase: "finding_confirmation" });
        const item = { chunk: index + 1, final_status: openai.status === "agree" && openai.ready_to_merge === true ? "CONSENSUS" : "FINAL_DECISION", rounds: 1, decision: openai, transcript: [{ round: 1, claude, openai }] };
        partial.chunkResults.push(item);
        partial.mandatory_completed += 1;
        partial.pending_chunk = null;
        partial.pending_chunks = partial.pending_chunks.filter(item => item.chunk !== index + 1);
        checkpoint();
      }
      partial.chunkResults.sort((a, b) => a.chunk - b.chunk);
      partial.coverage_complete = partial.mandatory_completed === partial.chunks_total;
      if (!partial.coverage_complete) throw costError("review stopped before all chunks were covered");
      checkpoint();
      partial.synthesis = await synthesize({ task, results: partial.chunkResults, signal: controller.signal, callProvider });
      checkpoint();
      return { chunkResults: partial.chunkResults, synthesis: partial.synthesis, coverageComplete: true, usage: partial.usage };
    }
    if (mode === "cheap") {
      for (let index = 0; index < chunks.length; index += 1) {
        const round = await runClaudePass({ diff: chunks[index], chunkIndex: index + 1, chunkCount: partial.chunks_total });
        partial.pending_chunk = { chunk: index + 1, claude: round.claude };
        partial.pending_chunks = [partial.pending_chunk];
        checkpoint();
        let decision = round.claude;
        let openai = null;
        if (hasConcreteFindings(round.claude)) {
          openai = await confirmFinding({ diff: chunks[index], chunkIndex: index + 1, chunkCount: partial.chunks_total, claude: round.claude, phase: "finding_confirmation" });
          decision = openai;
        }
        const item = { chunk: index + 1, final_status: decision.status === "agree" && decision.ready_to_merge === true ? "CONSENSUS" : "FINAL_DECISION", rounds: 1, decision, transcript: [{ round: 1, claude: round.claude, openai }] };
        byChunk.set(index, item);
        partial.chunkResults.push(item);
        partial.mandatory_completed += 1;
        partial.pending_chunk = null;
        partial.pending_chunks = [];
        checkpoint();
      }
      partial.coverage_complete = partial.mandatory_completed === partial.chunks_total;
      if (!partial.coverage_complete) throw costError("review stopped before all chunks were covered");
      partial.synthesis = await synthesize({ task, results: partial.chunkResults, signal: controller.signal, callProvider });
      checkpoint();
      return { chunkResults: partial.chunkResults, synthesis: partial.synthesis, coverageComplete: true, usage: partial.usage };
    }
    // Mandatory phase: complete one round for every chunk before follow-ups.
    for (let index = 0; index < chunks.length; index += 1) {
      const round = await runRound({ diff: chunks[index], chunkIndex: index + 1, chunkCount: chunks.length, round: 1, lastOpenAI: null });
      const item = { chunk: index + 1, final_status: round.result.final_status, rounds: 1, decision: round.result.decision, transcript: [{ round: 1, claude: round.claude, openai: round.openai }] };
      byChunk.set(index, item);
      partial.chunkResults.push(item);
      partial.mandatory_completed += 1;
      checkpoint();
    }
    if (partial.mandatory_completed < partial.chunks_total) throw costError(`chunk limit reached (${partial.mandatory_completed}/${partial.chunks_total})`);
    // Follow-up phase: only chunks with unresolved findings get more rounds.
    for (let index = 0; index < chunks.length; index += 1) {
      const item = byChunk.get(index);
      let lastOpenAI = item.decision;
      while (needsFollowup(item) && item.rounds < maxRounds) {
        const round = await runRound({ diff: chunks[index], chunkIndex: index + 1, chunkCount: chunks.length, round: item.rounds + 1, lastOpenAI });
        item.rounds = round.result.rounds;
        item.final_status = round.result.final_status;
        item.decision = round.result.decision;
        item.transcript.push({ round: item.rounds, claude: round.claude, openai: round.openai });
        lastOpenAI = item.decision;
        partial.followups_completed += 1;
        checkpoint();
      }
    }
    partial.coverage_complete = partial.mandatory_completed === chunks.length;
    if (!partial.coverage_complete) throw timeoutError("review did not cover every chunk");
    partial.synthesis = chunks.length > 1 ? await synthesize({ task, results: partial.chunkResults, signal: controller.signal, callProvider }) : null;
    return { chunkResults: partial.chunkResults, synthesis: partial.synthesis, coverageComplete: true, usage: partial.usage };
  };

  let timer;
  let deadlineReached = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { deadlineReached = true; controller.abort(new Error("review loop deadline exceeded")); reject(timeoutError(`review loop timed out after ${deadlineMs}ms`)); }, deadlineMs);
  });
  try {
    return await Promise.race([run(), deadline]);
  } catch (error) {
    if (!error.partialResult) error.partialResult = JSON.parse(JSON.stringify(refreshPartial()));
    error.partialResult.coverage_complete = false;
    try { checkpoint(); } catch {}
    if (deadlineReached || error?.code === "PROVIDER_ABORTED" || error?.code === "PROVIDER_TIMEOUT" || error?.code === "REVIEW_LOOP_TIMEOUT" || error?.code === "COST_LIMIT") {
      emit({ type: "review_loop_aborted", code: error?.code || "REVIEW_LOOP_ABORTED", reason: String(error?.message || "review loop aborted").slice(0, 500), mandatory_completed: partial.mandatory_completed, chunks_total: partial.chunks_total });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
