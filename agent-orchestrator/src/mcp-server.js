import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import * as z from "zod";
import { runAgentReview } from "./mcp-runner.js";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const accessToken = process.env.MCP_ACCESS_TOKEN || "";
const pathToken = process.env.MCP_PATH_TOKEN || "";
const domainChallengeToken = process.env.OPENAI_APPS_CHALLENGE_TOKEN || "";
const mcpPath = pathToken ? "/mcp/" + pathToken : "/mcp";

function isAuthorized(req) {
  if (!accessToken) return true;
  return req.headers.authorization === "Bearer " + accessToken;
}

function createAgentServer() {
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

  return server;
}

createServer(async (req, res) => {
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

  const server = createAgentServer();
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
}).listen(port, host, () => {
  console.log("MCP server listening on http://" + host + ":" + port + (pathToken ? "/mcp/<private>" : "/mcp"));
});
