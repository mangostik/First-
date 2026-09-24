# FishCRM Agent Orchestrator

Automated Claude ↔ OpenAI engineering review loop with GitHub diff support and an MCP bridge for ChatGPT.

## Current stages

- Stage 1 — structured Claude/OpenAI debate loop.
- Stage 2 — GitHub branch / PR diff review.
- Stage 3 — GitHub Actions automation, PR summaries, safe large-diff chunking, cross-chunk synthesis, and OpenAI final arbitration.
- Stage 4 — remote MCP bridge exposing the orchestrator to ChatGPT.

## Agent roles

- Claude — implementation engineer.
- OpenAI — reviewer, architect, and final arbiter.
- Consensus requires both agents to agree, no critical issues, and `ready_to_merge=true`.
- Objective blockers are preserved and must be supported by evidence.
- Multi-chunk diffs receive a final cross-chunk OpenAI synthesis before whole-change consensus can be emitted.

## Environment

Required for agent calls:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-sonnet-4-5
```

Optional controls:

```text
MAX_ROUNDS=3
MAX_OUTPUT_TOKENS=1800
REQUEST_TIMEOUT_MS=120000
MAX_DIFF_CHARS=20000
MAX_DIFF_TOTAL_BYTES=250000
GITHUB_TOKEN=...
GITHUB_REPO=owner/repo
GITHUB_PR_NUMBER=123
# OR:
GITHUB_BASE=main
GITHUB_HEAD=feature-branch
```

## CLI

```bash
npm install
npm test
npm start -- "Review this GitHub change"
```

The process returns structured JSON containing `final_status`, the final decision, rounds, chunk metadata, and transcript.

## Stage 4 MCP bridge

The MCP server exposes:

- `run_agent_review` — runs a task through Claude and OpenAI. It can optionally review a GitHub PR or branch comparison.
- `orchestrator_status` — lightweight health/capability check.

Run locally:

```bash
npm install
npm run start:mcp
```

Default local endpoint:

```text
http://localhost:3000/mcp
```

For a private personal deployment, set `MCP_PATH_TOKEN`. The MCP endpoint becomes:

```text
https://<host>/mcp/<MCP_PATH_TOKEN>
```

The server also exposes an unauthenticated `/health` endpoint for platform health checks.

For a remote deployment, set `PORT` as required by the host. The included Dockerfile runs the MCP server on Node 24.

### MCP access protection

`MCP_PATH_TOKEN` can make the MCP endpoint an unguessable private path for a personal deployment. `MCP_ACCESS_TOKEN` remains available for non-ChatGPT clients that can send a custom Bearer token.

Do not expose a paid-agent MCP endpoint at a predictable unauthenticated URL. For broader/shared use, use standards-compliant OAuth instead of relying only on a secret path.

### ChatGPT connection

ChatGPT custom apps/plugins connect to a **remote HTTPS MCP endpoint** using Streamable HTTP. The deployed URL should end in `/mcp`. ChatGPT does not connect directly to a localhost MCP server; use a remote deployment or a supported secure tunnel.

After the endpoint is reachable, add it as a custom MCP app/plugin in ChatGPT developer mode and scan its tools. The expected tools are `run_agent_review` and `orchestrator_status`.

## Safety

- API keys remain in environment/secrets only.
- Diffs are treated as untrusted external data.
- Large diffs have bounded total size and are reviewed in chunks.
- The OpenAI arbiter can reject unsupported Claude claims when runtime evidence contradicts them.
- GitHub changes are reviewed through branches/PRs; the orchestrator does not write directly to `main`.
