# FishCRM Agent Orchestrator — Stage 1

Stage 1 proves the core loop:

**Task → Claude (implementation engineer) → OpenAI (reviewer/arbiter) → repeat → CONSENSUS / FINAL_DECISION**

This stage intentionally does not modify FishCRM, GitHub branches, PRs, or Supabase automatically.

## Roles

- Claude — implementation engineer.
- OpenAI — reviewer, architect, and arbiter.
- Maximum rounds are controlled by `MAX_ROUNDS` (default: 3).
- Consensus requires both agents to return `agree`, no critical issues, and `ready_to_merge=true`.
- If the round limit is reached, the last OpenAI review becomes `FINAL_DECISION`.
- Claude may return `blocked` only for an objective blocker and should provide `evidence`.

## Safety / budget controls

- API keys live only in environment variables.
- Models are configured via environment variables, not hard-coded.
- `MAX_ROUNDS` limits debate length.
- `MAX_OUTPUT_TOKENS` limits each model response.
- `REQUEST_TIMEOUT_MS` prevents a hung request from blocking forever.
- Responses are validated before the loop continues.

## Setup

Requires Node.js 20+.

Copy `.env.example` values into your environment and fill in:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=...
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=...
```

Then run:

```bash
npm test
npm start -- "Review how FishCRM should prevent negative stock"
```

The process prints one JSON result containing `final_status`, number of rounds, the final decision, and the complete Stage 1 transcript.

## Response protocol

Each agent must return:

```json
{
  "status": "agree | disagree | needs_changes | blocked",
  "critical_issues": [],
  "recommended_changes": [],
  "ready_to_merge": false,
  "evidence": []
}
```

## Roadmap

**Stage 1 — now:** prove automatic structured Claude ↔ OpenAI discussion.

**Stage 2:** connect the loop to GitHub task branches and actual diffs. Claude proposes/implements changes; OpenAI reviews the real diff; discussion is stored in PRs; nobody writes directly to `main`.

**Stage 3:** add GitHub webhooks so continuation is event-driven instead of polling.

**Stage 4:** expose the orchestrator through MCP/custom app so ChatGPT can call Claude through the orchestrator directly.
