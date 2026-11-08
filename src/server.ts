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
import type { NextFunction } from "express";
import { verifyJwtMiddleware } from "./auth.js";
import { TOOL_DEFINITIONS, runTool, ToolInputError } from "./tools.js";
import {
  AgentAuthError, isAgentToken, type AgentTokenStore, type RateLimiter, type Scope,
} from "./agentTokens.js";

export const SERVER_VERSION = "0.10.0";

/** Outils qui modifient des données : interdits à un jeton d'agent en lecture seule. */
export const WRITE_TOOLS = new Set([
  "create_day_task", "update_day_task", "complete_day_task",
  "create_project", "update_project", "move_project", "archive_project",
  "create_domain", "update_domain", "create_activity", "update_activity",
  "set_goal",
]);

/** Sans information de portée (mode stdio), tout est permis ; sinon la portée « write » est requise pour écrire. */
const canWrite = (scopes?: string[]): boolean => !scopes || scopes.includes("write");

/** Fabrique le client Supabase d'une requête : créé AVEC LE JETON de cette requête (RLS de l'utilisateur). */
export type ClientFactory = (jwt: string) => SupabaseClient;

export interface HttpAppOptions {
  jwtSecret: string;
  supabaseUrl?: string;
  makeClient: ClientFactory;
  /** Jetons d'agent (Story 27-10) : absent = fonction désactivée (les jetons utilisateur marchent toujours). */
  agentTokens?: AgentTokenStore;
  rateLimiter?: RateLimiter;
}

// ─── MCP server factory (per session) ─────────────────────────────────────────
// L'identité (userId) est fixée à l'ouverture de la session ; le JETON, lui, est lu à CHAQUE appel d'outil
// (`extra.authInfo`, alimenté par `req.auth` à chaque requête HTTP). `fallbackJwt` ne sert qu'au mode stdio.

export function createMcpServer(userId: string, makeClient: ClientFactory, fallbackJwt?: string): Server {
  const server = new Server(
    { name: "agenticfocus-mcp-server", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // Un jeton en lecture seule ne voit pas les outils d'écriture.
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => ({
    tools: canWrite(extra.authInfo?.scopes) ? TOOL_DEFINITIONS : TOOL_DEFINITIONS.filter((t) => !WRITE_TOOLS.has(t.name)),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const agentId = extra.authInfo?.extra?.agentTokenId as string | undefined;
    let outcome = "ok";
    try {
      if (WRITE_TOOLS.has(name) && !canWrite(extra.authInfo?.scopes)) {
        throw new ToolInputError("Ce jeton d'agent est en lecture seule : cet outil modifie des données.");
      }
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
      outcome = err instanceof ToolInputError ? "refused" : "error";
      if (!(err instanceof ToolInputError)) console.error(`[agenticfocus-mcp] tool ${name} failed:`, err);
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    } finally {
      // Journal d'audit des jetons d'agent : identifiant du jeton (jamais le jeton), outil, résultat.
      if (agentId) console.error(JSON.stringify({ evt: "agent_tool", agentTokenId: agentId, tool: name, outcome }));
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

  const rpcError = (res: Response, status: number, message: string): void => {
    res.status(status).json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null });
  };

  // Authentification de /mcp : jeton d'agent (`afk_…`) si la fonction est activée, sinon jeton utilisateur Supabase.
  // Dans les deux cas, `req.userId` et `req.userJwt` (jeton Supabase de CETTE requête) sont renseignés.
  const mcpAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers["authorization"] ?? ""))?.[1];
    if (!bearer || !isAgentToken(bearer)) {
      await jwtMiddleware(req, res, () => {
        req.auth = { token: req.userJwt!, clientId: req.userId!, scopes: ["read", "write"] };
        next();
      });
      return;
    }
    if (!opts.agentTokens) { rpcError(res, 401, "Les jetons d'agent ne sont pas activés sur ce serveur."); return; }
    const record = opts.agentTokens.lookup(bearer);
    if (!record) { rpcError(res, 401, "Jeton d'agent inconnu ou révoqué."); return; }
    if (opts.rateLimiter && !opts.rateLimiter.allow(record.id)) {
      res.setHeader("Retry-After", "60");
      rpcError(res, 429, "Trop de requêtes pour ce jeton d'agent (limite par minute).");
      return;
    }
    try {
      const accessToken = await opts.agentTokens.accessTokenFor(record);
      req.userId = record.userId;
      req.userJwt = accessToken;
      req.agent = { id: record.id, scope: record.scope };
      req.auth = {
        token: accessToken,
        clientId: record.userId,
        scopes: record.scope === "write" ? ["read", "write"] : ["read"],
        extra: { agentTokenId: record.id },
      };
      next();
    } catch (err) {
      if (err instanceof AgentAuthError) { rpcError(res, err.status, err.message); return; }
      console.error("[agenticfocus-mcp] renouvellement de session du jeton d'agent impossible:", err);
      rpcError(res, 503, "Service d'authentification momentanément indisponible, réessayez.");
    }
  };

  // Gestion des jetons d'agent : réservée à l'utilisateur CONNECTÉ (jeton Supabase), jamais à un jeton d'agent.
  if (opts.agentTokens) {
    const store = opts.agentTokens;
    app.post("/agent-tokens", jwtMiddleware, async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { refresh_token?: unknown; label?: unknown; scope?: unknown };
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (typeof body.refresh_token !== "string" || body.refresh_token.length < 6) { rpcError(res, 400, "refresh_token requis."); return; }
      if (label.length < 1 || label.length > 60) { rpcError(res, 400, "label requis (1 à 60 caractères)."); return; }
      if (body.scope !== "read" && body.scope !== "write") { rpcError(res, 400, "scope doit valoir « read » ou « write »."); return; }
      try {
        const created = await store.create({ userId: req.userId!, label, scope: body.scope as Scope, refreshToken: body.refresh_token });
        console.error(JSON.stringify({ evt: "agent_token_created", agentTokenId: created.info.id, scope: created.info.scope }));
        res.status(201).json({ token: created.token, ...created.info });
      } catch (err) {
        if (err instanceof AgentAuthError) { rpcError(res, err.status, err.message); return; }
        console.error("[agenticfocus-mcp] création de jeton d'agent impossible:", err);
        rpcError(res, 503, "Création impossible pour le moment, réessayez.");
      }
    });

    app.get("/agent-tokens", jwtMiddleware, (req: Request, res: Response) => {
      res.json({ tokens: store.list(req.userId!) });
    });

    app.delete("/agent-tokens/:id", jwtMiddleware, (req: Request, res: Response) => {
      if (!store.revoke(req.userId!, String(req.params.id))) { rpcError(res, 404, "Jeton introuvable."); return; }
      console.error(JSON.stringify({ evt: "agent_token_revoked", agentTokenId: req.params.id }));
      res.json({ revoked: true });
    });
  }

  // POST /mcp — JSON-RPC client→server (initialize + tool calls)
  app.post("/mcp", mcpAuth, async (req: Request, res: Response) => {
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

    // `req.auth` (jeton de CETTE requête, déjà vérifié) est posé par `mcpAuth` : lu par les outils via `extra.authInfo`.
    await transport.handleRequest(req, res, req.body);
  });

  // GET /mcp — SSE stream (server→client)
  app.get("/mcp", mcpAuth, async (req: Request, res: Response) => {
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
  app.delete("/mcp", mcpAuth, async (req: Request, res: Response) => {
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

