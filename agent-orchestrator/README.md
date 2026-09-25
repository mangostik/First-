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
- The orchestration role registry includes `backend`, `qa`, `frontend`, `database`, `security`, `documentation`, and `reviewer`. Each role has an explicit purpose, allowed task types, input context, result format, constraints, completion criteria, and required tests.
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
CLAUDE_REQUEST_TIMEOUT_MS=120000
OPENAI_REQUEST_TIMEOUT_MS=120000
PROVIDER_MAX_RETRIES=1
STRUCTURED_MAX_RETRIES=1
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

`src/mcp-server.js` is import-safe: importing its factories and tool registration
does not open a port. The HTTP listener starts only through `npm run start:mcp`,
which preserves `/health`, MCP initialization, and the registered tool set.

The Claude/OpenAI review loop uses 120-second per-request timeouts plus a
600-second `REVIEW_LOOP_TIMEOUT_MS` deadline for the complete provider loop.
Structured `provider_started`, `provider_completed`, `provider_timeout`,
`provider_error`, and `review_loop_aborted` events are emitted without secrets.

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

### Production hardening baseline

The production image uses the committed `package-lock.json` and `npm ci --omit=dev --ignore-scripts` for a reproducible dependency install. It starts with `npm run start:mcp`, listens on Railway's `PORT`, and exposes `/health` for the platform healthcheck.

Keep these safe defaults in production until the container has a supported Git/workspace strategy:

```text
ORCHESTRATION_AGENT_MODE=mock
ORCHESTRATION_REVIEWER_MODE=mock
ORCHESTRATION_TEST_MODE=mock
ORCHESTRATION_MAX_PARALLEL=2
ORCHESTRATION_MAX_RETRIES=1
ORCHESTRATION_TIMEOUT_MS=30000
ORCHESTRATION_JOB_TIMEOUT_MS=300000
```

Provider requests have independent 120-second defaults. `PROVIDER_MAX_RETRIES=1` bounds retryable 429/5xx responses, while `STRUCTURED_MAX_RETRIES=1` bounds invalid or incomplete structured-output retries. Timeouts and cancellations produce a valid structured failure JSON result, which is uploaded and can be summarized without a secondary JSON parse failure.

Set `MCP_PATH_TOKEN` and `ORCHESTRATION_TRACKER_TOKEN` only as deployment secrets; never commit their values. The production smoke test checks `/health`, authenticated `/tracker`, MCP initialization, `tools/list`, and `orchestrator_status` without calling external model providers.

The current image is not a production real-runner image: it does not contain a Git repository or workspace root. Worktree isolation and the real runner require a separately designed worker environment. Job state is local JSON storage and can disappear after a restart or redeploy.

### MCP access protection

`MCP_PATH_TOKEN` can make the MCP endpoint an unguessable private path for a personal deployment. `MCP_ACCESS_TOKEN` remains available for non-ChatGPT clients that can send a custom Bearer token.

Do not expose a paid-agent MCP endpoint at a predictable unauthenticated URL. For broader/shared use, use standards-compliant OAuth instead of relying only on a secret path.

### ChatGPT connection

ChatGPT custom apps/plugins connect to a **remote HTTPS MCP endpoint** using Streamable HTTP. The deployed URL should end in `/mcp`. ChatGPT does not connect directly to a localhost MCP server; use a remote deployment or a supported secure tunnel.

After the endpoint is reachable, add it as a custom MCP app/plugin in ChatGPT developer mode and scan its tools. The expected tools are `run_agent_review` and `orchestrator_status`.

## Parallel orchestration MVP

The MVP adds a non-blocking mock orchestration flow for the task shape “add an API function and tests”. It keeps the existing review tools unchanged and exposes:

- `create_orchestration_job` — creates a job and immediately returns a `job_id`;
- `get_job_status` — reads the persisted job and subtask statuses;
- `get_job_result` — reads the final result when available;
- `cancel_job` — cancels a queued or running job.

The Planner routes task content to `backend`, `qa`, `frontend`, `database`, `security`, and `documentation` role templates. Routed role subtasks are independent unless the plan explicitly adds dependencies; a dependent `reviewer` subtask is added after all routed roles. Unknown task text receives a safe backend clarification fallback instead of speculative multi-role work. The scheduler runs at most two tasks concurrently by default, waits for dependencies, applies a bounded retry, enforces a timeout, and persists each job as an atomic JSON file under `JOB_STORAGE_DIR`. Mock mode remains the safe default; real mode delegates each subtask to the existing Claude/OpenAI review loop.

Supported job and subtask statuses are:

`queued`, `planning`, `running`, `waiting`, `integrating`, `reviewing`, `completed`, `failed`, `cancelled`.

Direct changes to `main` are rejected by the workspace safety policy. Each subtask receives its own retained worktree; no automatic merge is performed.

### Agent runner configuration

`ORCHESTRATION_AGENT_MODE=mock` is the safe default. Set it to `real` only when the existing `OPENAI_API_KEY`, `OPENAI_MODEL`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_MODEL` configuration is available. The real adapter delegates each subtask to the existing `runAgentReview` loop and passes its assigned workspace path, branch, and base ref in the task context/environment. The deterministic mock adapter remains available for tests and local lifecycle checks. The real-runner smoke test is opt-in with `ORCHESTRATION_REAL_SMOKE=1` and is skipped by default.

Each orchestration subtask now receives a separate Git worktree under `ORCHESTRATION_WORKSPACE_ROOT`, created from the explicit non-`main` `ORCHESTRATION_BASE_REF`. Workspaces are retained after normal completion; cleanup is an explicit, idempotent operation and is never run automatically by the service.

After all subtasks finish, the Integrator aggregates changed files, tests, warnings, conflicts, remaining work, and workspace descriptors without merging branches. A job-level Reviewer then returns `approved` or `rejected` with `review_findings`; the job is `completed` only after approval, otherwise it is `failed`. `ORCHESTRATION_REVIEWER_MODE=mock` is the safe default; `real` delegates review through the existing `runAgentReview` adapter.

Before job-level review, the project test gate runs and stores `test_evidence` with status `passed`, `failed`, `timeout`, or `error`, plus command, exit code, stdout, stderr, and duration. `ORCHESTRATION_TEST_MODE=mock` is the safe default for deterministic tests; `real` runs the configured command (default `npm test`) with `ORCHESTRATION_TEST_TIMEOUT_MS`. Reviewer approval is impossible without `test_evidence.status=passed`.

### Observability and limits

Every job and subtask records structured events, state timestamps, duration, attempts, retry/cancel/failure reasons, and active-task metrics in persisted JSON state and the final result. Logs are opt-in with `ORCHESTRATION_LOG_EVENTS=1` and redact API keys, bearer tokens, and common provider tokens.

Safety limits are configured through `.env.example`: `ORCHESTRATION_MAX_SUBTASKS`, `ORCHESTRATION_MAX_PARALLEL` (capped at three), `ORCHESTRATION_MAX_RETRIES`, `ORCHESTRATION_TIMEOUT_MS`, and `ORCHESTRATION_JOB_TIMEOUT_MS`. Violations are recorded in `limit_violations` and retained in the final result; cancellation records its reason. No automatic merge is performed.

### Read-only web tracker

The Node service includes a dependency-free read-only tracker at `/tracker`. It exposes `GET /api/jobs`, `GET /api/jobs/:jobId`, `GET /api/jobs/:jobId/events`, and an SSE stream on the same events path when the client requests `text/event-stream`. The panel displays job status, subtasks, event timeline, evidence, warnings, limit violations, aggregate data, and reviewer result. It never creates, cancels, edits, or executes work.

Set `ORCHESTRATION_TRACKER_TOKEN` to require `Authorization: Bearer <token>`. An authenticated HTML request receives an HttpOnly same-origin cookie so the browser's fetch and `EventSource` calls remain protected. Responses and SSE payloads use the existing observability redaction; CORS is not enabled and no MCP/API secret is rendered into the panel.

## Safety

- API keys remain in environment/secrets only.
- Diffs are treated as untrusted external data.
- Large diffs have bounded total size and are reviewed in chunks.
- The OpenAI arbiter can reject unsupported Claude claims when runtime evidence contradicts them.
- GitHub changes are reviewed through branches/PRs; the orchestrator does not write directly to `main`.
