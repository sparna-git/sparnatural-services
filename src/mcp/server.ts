import express from "express";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

// not used yet
// import { registerResources } from "./resources/registerResources";
import { registerPrompts } from "./prompts/registerPrompts";
import { registerTools } from "./tools/registerTools";
import {
  ConfigBackedProjectConfigAdapter,
  type ProjectConfigAdapter,
} from "./utils/projectConfigAdapter";

// Factory to create a new McpServer instance with all prompts/tools/resources registered for a given project. In HTTP mode, a new server will be created for each session.
async function buildServer(
  projectId: string,
  projectConfigAdapter: ProjectConfigAdapter,
): Promise<McpServer> {
  // create a new MCP server instance for this session (HTTP) or the whole process (stdio)
  const server = new McpServer({
    name: `sparnatural-mcp-${projectId}`,
    version: "0.1.0",
  });

  await registerTools(server, { projectConfigAdapter, projectId });
  //registerResources(server, { projectConfigAdapter, projectId });
  registerPrompts(server, { projectConfigAdapter, projectId });

  return server;
}

/**
 * Returns an Express Router that handles MCP HTTP sessions for any project.
 * The router expects a :projectKey param from the parent route
 */
export function createMcpRouter(
  projectConfigAdapter: ProjectConfigAdapter = new ConfigBackedProjectConfigAdapter(),
): express.Router {
  type SessionEntry = {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
  };
  // sessions keyed by projectId
  const sessionsByProject: Record<string, Record<string, SessionEntry>> = {};

  const router = express.Router({ mergeParams: true });

  router.post(
    "/",
    async (req: express.Request<{ projectKey: string }>, res) => {
      const projectId = req.params.projectKey;
      const projectSessions = (sessionsByProject[projectId] ??= {});

      try {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (sessionId) {
          const existing = projectSessions[sessionId];
          if (!existing) {
            res.status(400).send("Invalid or missing session ID");
            return;
          }
          await existing.transport.handleRequest(req, res, req.body);
          return;
        }

        if (!isInitializeRequest(req.body)) {
          res.status(400).send("Bad Request: First request must be initialize");
          return;
        }

        // build a new server instance for this session
        const sessionServer = await buildServer(projectId, projectConfigAdapter);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid: string) => {
            projectSessions[sid] = { server: sessionServer, transport };
            console.error(
              `MCP HTTP session initialized: ${sid} (project=${projectId})`,
            );
          },
        });

        // Cleanup session on transport close
        transport.onclose = async () => {
          const sid = transport.sessionId;
          if (sid && projectSessions[sid]) {
            delete projectSessions[sid];
            console.error(
              `MCP HTTP session closed: ${sid} (project=${projectId})`,
            );
          }
        };

        // Connect the server to the transport and handle the initial request
        await sessionServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error(`POST /api/v1/mcp/${projectId} error:`, error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: req.body?.id ?? null,
          });
        }
      }
    },
  );

  // For GET and DELETE requests, we expect the client to provide the session ID in the header and route the request to the correct server instance.
  const handleSessionRequest = async (
    req: express.Request<{ projectKey: string }>,
    res: express.Response,
  ) => {
    const projectId = req.params.projectKey;
    const projectSessions = sessionsByProject[projectId];
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !projectSessions?.[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }
      await projectSessions[sessionId].transport.handleRequest(req, res);
    } catch (error) {
      console.error(`${req.method} /mcp/${projectId} error:`, error);
      if (!res.headersSent) res.status(500).send("Internal server error");
    }
  };

  router.get("/", handleSessionRequest);
  router.delete("/", handleSessionRequest);

  return router;
}

/**
 * Starts the MCP server in stdio mode for a single project.
 */
export async function startMcpStdio(
  projectId: string,
  projectConfigAdapter: ProjectConfigAdapter = new ConfigBackedProjectConfigAdapter(),
): Promise<void> {
  // Redirect console.log to stderr — stdout is the MCP wire protocol in stdio mode
  console.log = console.error;

  const server = await buildServer(projectId, projectConfigAdapter);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`MCP stdio server started for project '${projectId}'`);
}
