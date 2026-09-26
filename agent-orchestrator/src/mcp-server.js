import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import * as z from "zod";
import { runAgentReview } from "./mcp-runner.js";
import { OrchestrationService } from "./orchestration/service.js";
import { ReadOnlyTracker } from "./orchestration/tracker.js";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const accessToken = process.env.MCP_ACCESS_TOKEN || "";
const pathToken = process.env.MCP_PATH_TOKEN || "";
const domainChallengeToken = process.env.OPENAI_APPS_CHALLENGE_TOKEN || "";
const mcpPath = pathToken ? "/mcp/" + pathToken : "/mcp";
export const ORCHESTRATION_TOOL_NAMES = [
  "create_orchestration_job",
  "get_job_status",
  "get_job_result",
  "cancel_job"
];
const orchestrationService = new OrchestrationService();
const tracker = new ReadOnlyTracker({ store: orchestrationService.store });
// Stage 4: keep tool metadata explicit for ChatGPT Plugin Creator validation.

function isAuthorized(req) {
  if (!accessToken) return true;
  return req.headers.authorization === "Bearer " + accessToken;
}

export function registerOrchestrationTools(server, service = orchestrationService) {
  server.registerTool(
    "create_orchestration_job",
    {
      title: "Create orchestration job",
      description: "Create a non-blocking MVP orchestration job for an API function and tests.",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({ task: z.string().min(1).max(12000) })
    },
    async input => {
      try {
        const result = await service.createJob(input.task);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error?.message || String(error) }] };
      }
    }
  );

  for (const [name, title, action] of [
    ["get_job_status", "Get job status", jobId => service.getStatus(jobId)],
    ["get_job_result", "Get job result", jobId => service.getResult(jobId)],
    ["cancel_job", "Cancel job", jobId => service.cancelJob(jobId)]
  ]) {
    server.registerTool(
      name,
      {
        title,
        description: `${title} for an orchestration job.`,
        annotations: { readOnlyHint: name === "get_job_status" || name === "get_job_result", openWorldHint: false, destructiveHint: name === "cancel_job" },
        inputSchema: z.object({ job_id: z.string().min(1).max(100) })
      },
      async input => {
        try {
          const result = await action(input.job_id);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error?.message || String(error) }] };
        }
      }
    );
  }
}

export function createAgentServer(service = orchestrationService) {
  const server = new McpServer(
    { name: "fishcrm-agent-orchestrator", version: "0.1.0" },
    {
      instructions:
        "Use run_agent_review to send a concrete engineering/review task through the Claude implementation engineer and OpenAI reviewer/arbiter loop."
    }
  );

  server.registerTool(
    "run_agent_review",
    {
      title: "Run agent review",
      description:
        "Run the Claude ↔ OpenAI orchestrator for a task. Optionally review a GitHub PR or branch diff. Returns the structured final decision and transcript.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false
      },
      inputSchema: z.object({
        task: z.string().min(1).max(12000),
        repo: z.string().min(3).max(300).optional(),
        prNumber: z.number().int().positive().optional(),
        base: z.string().min(1).max(300).optional(),
        head: z.string().min(1).max(300).optional()
      })
    },
    async input => {
      try {
        const result = await runAgentReview(input);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error?.message || String(error) }]
        };
      }
    }
  );

  server.registerTool(
    "orchestrator_status",
    {
      title: "Orchestrator status",
      description: "Check whether the MCP bridge is running and which capabilities it exposes.",
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false
      },
      inputSchema: z.object({})
    },
    async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          service: "fishcrm-agent-orchestrator",
          stage: 4,
          tools: ["run_agent_review", "orchestrator_status"]
        })
      }]
    })
  );

  registerOrchestrationTools(server, service);

  return server;
}

export function createMcpHttpServer({ service = orchestrationService, trackerInstance = tracker } = {}) {
  return createServer(async (req, res) => {
    if (req.url === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, service: "fishcrm-agent-orchestrator" }));
      return;
    }

    if (req.url === "/.well-known/openai-apps-challenge") {
      if (!domainChallengeToken) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(domainChallengeToken);
      return;
    }

    if (await trackerInstance.handle(req, res)) return;

    if (req.url !== mcpPath) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    if (!isAuthorized(req)) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", "Bearer");
      res.end("Unauthorized");
      return;
    }

    const server = createAgentServer(service);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) res.statusCode = 500;
      if (!res.writableEnded) res.end("MCP server error");
      console.error(error);
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
}

export function startMcpServer({ port: listenPort = port, host: listenHost = host } = {}) {
  const httpServer = createMcpHttpServer();
  return httpServer.listen(listenPort, listenHost, () => {
    console.log("MCP server listening on http://" + listenHost + ":" + listenPort + (pathToken ? "/mcp/<private>" : "/mcp"));
  });
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) startMcpServer();
