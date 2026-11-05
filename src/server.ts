/**
 * Construction du serveur MCP et de l'application HTTP (Epics 25 et 27), séparée du démarrage (`index.ts`) pour être
 * testée de bout en bout avec un client Supabase simulé.
 */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyJwtMiddleware } from "./auth.js";
import { TOOL_DEFINITIONS, runTool, ToolInputError } from "./tools.js";

export const SERVER_VERSION = "0.5.0";

/** Fabrique le client Supabase d'une requête : créé AVEC LE JETON de cette requête (RLS de l'utilisateur). */
export type ClientFactory = (jwt: string) => SupabaseClient;

export interface HttpAppOptions {
  jwtSecret: string;
  supabaseUrl?: string;
  makeClient: ClientFactory;
}

// ─── MCP server factory (per session) ─────────────────────────────────────────
// L'identité (userId) est fixée à l'ouverture de la session ; le JETON, lui, est lu à CHAQUE appel d'outil
// (`extra.authInfo`, alimenté par `req.auth` à chaque requête HTTP). `fallbackJwt` ne sert qu'au mode stdio.

export function createMcpServer(userId: string, makeClient: ClientFactory, fallbackJwt?: string): Server {
  const server = new Server(
    { name: "agenticfocus-mcp-server", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    try {
      const jwt = extra.authInfo?.token ?? fallbackJwt;
      if (!jwt) throw new Error("Jeton absent de la requête.");
      const ctx = {
        userId,
        supabase: makeClient(jwt),
        timeZone: process.env.USER_TIMEZONE || undefined,
      };
      const result = await runTool(name, args, ctx);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      // Erreur de saisie : message lisible pour l'agent. Autre erreur : message court, détail dans les journaux.
      if (!(err instanceof ToolInputError)) console.error(`[agenticfocus-mcp] tool ${name} failed:`, err);
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  });

  return server;
}

export function buildHttpApp(opts: HttpAppOptions): { app: express.Express; transports: Record<string, { transport: StreamableHTTPServerTransport; userId: string }> } {
  const app = express();
  app.use(express.json());

  // Session-keyed transport map (stateful mode).
  // Each session is bound to a specific (userId, userJwt) extracted from the JWT
  // at the initialize handshake. Subsequent requests on the same session re-use it.
  const transports: Record<string, { transport: StreamableHTTPServerTransport; userId: string }> = {};

  // Health check — no auth, no body. Useful for Docker healthcheck + reverse proxy ping.
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "agenticfocus-mcp",
      transport: "http",
      version: SERVER_VERSION,
      sessions: Object.keys(transports).length,
    });
  });

  // JWT verification middleware applied to all /mcp routes.
  // Passe SUPABASE_URL pour permettre la vérification JWKS des tokens ES256/RS256
  // (nouvelles JWT Signing Keys Supabase), avec repli HS256 via le secret.
  const jwtMiddleware = verifyJwtMiddleware(opts.jwtSecret, opts.supabaseUrl);

  // POST /mcp — JSON-RPC client→server (initialize + tool calls)
  app.post("/mcp", jwtMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const userId = req.userId!;
    const userJwt = req.userJwt!;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Existing session — verify the JWT user matches the session owner.
      if (transports[sessionId].userId !== userId) {
        res.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32002, message: "JWT user does not match session owner" },
          id: null,
        });
        return;
      }
      transport = transports[sessionId].transport;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session — bind to (userId, userJwt) extracted from JWT.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
          console.error(`[agenticfocus-mcp] session closed: ${transport.sessionId} (user ${userId})`);
        }
      };
      const server = createMcpServer(userId, opts.makeClient);
      await server.connect(transport);
      req.auth = { token: userJwt, clientId: userId, scopes: [] };
      await transport.handleRequest(req, res, req.body);
      if (transport.sessionId) {
        transports[transport.sessionId] = { transport, userId };
        console.error(`[agenticfocus-mcp] session opened: ${transport.sessionId} (user ${userId})`);
      }
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: missing mcp-session-id header for non-initialize request" },
        id: null,
      });
      return;
    }

    // Jeton de CETTE requête (déjà vérifié) : lu par les outils via `extra.authInfo` (Story 25-6).
    req.auth = { token: userJwt, clientId: userId, scopes: [] };
    await transport.handleRequest(req, res, req.body);
  });

  // GET /mcp — SSE stream (server→client)
  app.get("/mcp", jwtMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing mcp-session-id header");
      return;
    }
    if (transports[sessionId].userId !== req.userId) {
      res.status(403).send("JWT user does not match session owner");
      return;
    }
    await transports[sessionId].transport.handleRequest(req, res);
  });

  // DELETE /mcp — explicit session termination
  app.delete("/mcp", jwtMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing mcp-session-id header");
      return;
    }
    if (transports[sessionId].userId !== req.userId) {
      res.status(403).send("JWT user does not match session owner");
      return;
    }
    await transports[sessionId].transport.handleRequest(req, res);
  });

  return { app, transports };
}

