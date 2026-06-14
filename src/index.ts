#!/usr/bin/env node
/**
 * AgenticFocus MCP Server — Story 25-2 Sprint 24 Epic 25
 *
 * Multi-user MCP server : auth via Authorization: Bearer <jwt> header on
 * every HTTP request. Each session is bound to the user extracted from the
 * JWT (sub claim), with its own Supabase client scoped via that JWT for
 * RLS enforcement.
 *
 * Transports :
 *   - stdio (POC original Story 23-7, kept for Claude Desktop local — single user
 *     auth via env vars SUPABASE_USER_JWT + USER_ID, legacy mode)
 *   - StreamableHTTPServerTransport (production : JWT per-request, multi-user)
 *
 * Tools (unchanged from Sprint 21 POC) :
 *   - create_day_task   : create a task scheduled for a specific day
 *   - list_today_tasks  : list tasks for today
 *   - list_projects     : list active Kanban projects
 *
 * Selection via env var TRANSPORT=stdio|http (default: http).
 */

import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { verifyJwtMiddleware } from "./auth.js";

// ─── Env config ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const TRANSPORT = (process.env.TRANSPORT ?? "http").toLowerCase();
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Legacy stdio mode env vars (single-user) — used only when TRANSPORT=stdio.
const STDIO_USER_JWT = process.env.SUPABASE_USER_JWT;
const STDIO_USER_ID = process.env.USER_ID;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    "[agenticfocus-mcp] Missing required env vars. Need: SUPABASE_URL, SUPABASE_ANON_KEY",
  );
  process.exit(1);
}

if (TRANSPORT === "http" && !SUPABASE_JWT_SECRET) {
  console.error(
    "[agenticfocus-mcp] HTTP transport requires SUPABASE_JWT_SECRET env var (Supabase Studio → Settings → API → JWT Secret)",
  );
  process.exit(1);
}

if (TRANSPORT === "stdio" && (!STDIO_USER_JWT || !STDIO_USER_ID)) {
  console.error(
    "[agenticfocus-mcp] stdio transport requires SUPABASE_USER_JWT + USER_ID env vars (legacy single-user mode)",
  );
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nowMs(): number {
  return Date.now();
}

/**
 * Create a Supabase client scoped to a specific user via their JWT.
 * RLS policies apply normally — the user sees only their own data.
 */
function makeSupabaseClient(userJwt: string): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    global: {
      headers: {
        Authorization: `Bearer ${userJwt}`,
      },
    },
  });
}

// ─── Tool implementations (parametrized by userId + supabase) ─────────────────

interface CreateDayTaskArgs {
  name: string;
  date?: string;
  planned_pomodoros?: number;
  project_id?: string;
  domain_id?: string;
  note?: string;
}

async function toolCreateDayTask(
  args: CreateDayTaskArgs,
  ctx: { userId: string; supabase: SupabaseClient },
): Promise<string> {
  const name = args.name?.trim();
  if (!name) throw new Error("name is required and must be non-empty");

  const date = args.date || todayIsoDate();
  const plannedPomos = Math.max(1, Math.min(99, args.planned_pomodoros ?? 1));
  const now = nowMs();

  const row = {
    id: randomUUID(),
    user_id: ctx.userId,
    name,
    date,
    planned_pomodoros: plannedPomos,
    completed_pomodoros: 0,
    is_completed: false,
    position: 0,
    project_id: args.project_id ?? null,
    domain_id: args.domain_id ?? null,
    note: args.note ?? null,
    created_at: now,
    updated_at: now,
  };

  const { error } = await ctx.supabase.from("day_tasks").insert(row);
  if (error) {
    throw new Error(`Supabase insert failed: ${error.message} (${error.code})`);
  }

  return JSON.stringify(
    {
      success: true,
      id: row.id,
      name: row.name,
      date: row.date,
      planned_pomodoros: row.planned_pomodoros,
      project_id: row.project_id,
      message: `Task "${name}" created for ${date} with ${plannedPomos} pomodoro(s).`,
    },
    null,
    2,
  );
}

interface ListTodayTasksArgs {
  include_completed?: boolean;
}

async function toolListTodayTasks(
  args: ListTodayTasksArgs,
  ctx: { userId: string; supabase: SupabaseClient },
): Promise<string> {
  const today = todayIsoDate();
  const includeCompleted = args.include_completed ?? true;

  let query = ctx.supabase
    .from("day_tasks")
    .select("id, name, planned_pomodoros, completed_pomodoros, is_completed, project_id, note")
    .eq("user_id", ctx.userId)
    .eq("date", today);

  if (!includeCompleted) query = query.eq("is_completed", false);

  const { data, error } = await query;
  if (error) throw new Error(`Supabase select failed: ${error.message}`);

  const projectIds = Array.from(new Set((data || []).map((t) => t.project_id).filter(Boolean)));
  let projectsMap = new Map<string, string>();
  if (projectIds.length > 0) {
    const { data: projects } = await ctx.supabase
      .from("projects")
      .select("id, name")
      .in("id", projectIds as string[]);
    if (projects) projectsMap = new Map(projects.map((p) => [p.id, p.name]));
  }

  const enriched = (data || []).map((t) => ({
    ...t,
    project_name: t.project_id ? projectsMap.get(t.project_id) ?? null : null,
  }));

  return JSON.stringify({ date: today, count: enriched.length, tasks: enriched }, null, 2);
}

interface ListProjectsArgs {
  include_archived?: boolean;
  kanban_status?: "backlog" | "todo" | "doing" | "done";
}

async function toolListProjects(
  args: ListProjectsArgs,
  ctx: { userId: string; supabase: SupabaseClient },
): Promise<string> {
  let query = ctx.supabase
    .from("projects")
    .select("id, name, description, kanban_status, kanban_position, target_date, domain_id, is_archived, started_at, finished_at")
    .eq("user_id", ctx.userId)
    .order("kanban_status")
    .order("kanban_position");

  if (!args.include_archived) query = query.eq("is_archived", false);
  if (args.kanban_status) query = query.eq("kanban_status", args.kanban_status);

  const { data, error } = await query;
  if (error) throw new Error(`Supabase select failed: ${error.message}`);

  return JSON.stringify({ count: (data || []).length, projects: data }, null, 2);
}

// ─── MCP server factory (per-user) ────────────────────────────────────────────
// One Server instance per session, bound to the specific user extracted from the JWT.

function createMcpServer(userId: string, userJwt: string): Server {
  const supabase = makeSupabaseClient(userJwt);

  const server = new Server(
    {
      name: "agenticfocus-mcp-server",
      version: "0.4.0-jwks",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "create_day_task",
        description:
          "Create a new task scheduled for a specific day. Returns the created task with its UUID. Use this when the user wants to add a task to their day planner.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Task title" },
            date: {
              type: "string",
              description: "ISO date YYYY-MM-DD (default: today)",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            },
            planned_pomodoros: {
              type: "integer",
              minimum: 1,
              maximum: 99,
              default: 1,
              description: "Number of 25-min pomodoro sessions planned (default 1)",
            },
            project_id: { type: "string", description: "Optional UUID to link the task to a project (see list_projects)" },
            domain_id: { type: "string", description: "Optional UUID for a life domain (Sport, Pro, etc.)" },
            note: { type: "string", description: "Optional free-text note" },
          },
          required: ["name"],
        },
      },
      {
        name: "list_today_tasks",
        description:
          "List all tasks scheduled for today, including their progress (planned vs completed pomodoros), completion status, and linked project name if any. Use this when the user asks about their day planning.",
        inputSchema: {
          type: "object",
          properties: {
            include_completed: {
              type: "boolean",
              default: true,
              description: "Whether to include tasks already marked as completed",
            },
          },
        },
      },
      {
        name: "list_projects",
        description:
          "List Kanban projects with their status (backlog/todo/doing/done), position, target date, and lifecycle timestamps. Use this to find a project_id when creating tasks.",
        inputSchema: {
          type: "object",
          properties: {
            include_archived: {
              type: "boolean",
              default: false,
              description: "Include archived projects (default: false)",
            },
            kanban_status: {
              type: "string",
              enum: ["backlog", "todo", "doing", "done"],
              description: "Filter by Kanban column (optional)",
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const ctx = { userId, supabase };

    try {
      let result: string;
      switch (name) {
        case "create_day_task":
          result = await toolCreateDayTask(args as unknown as CreateDayTaskArgs, ctx);
          break;
        case "list_today_tasks":
          result = await toolListTodayTasks(args as unknown as ListTodayTasksArgs, ctx);
          break;
        case "list_projects":
          result = await toolListProjects(args as unknown as ListProjectsArgs, ctx);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ─── Stdio transport boot (legacy single-user) ────────────────────────────────

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  // stdio mode uses the legacy env vars — single-user.
  const server = createMcpServer(STDIO_USER_ID!, STDIO_USER_JWT!);
  await server.connect(transport);
  console.error("[agenticfocus-mcp] stdio transport running (single-user via env vars). Ready to serve.");
}

// ─── HTTP transport boot (multi-user via JWT per-request) ─────────────────────

async function runHttp(port: number): Promise<void> {
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
      version: "0.4.0-jwks",
      sessions: Object.keys(transports).length,
    });
  });

  // JWT verification middleware applied to all /mcp routes.
  // Passe SUPABASE_URL pour permettre la vérification JWKS des tokens ES256/RS256
  // (nouvelles JWT Signing Keys Supabase), avec repli HS256 via le secret.
  const jwtMiddleware = verifyJwtMiddleware(SUPABASE_JWT_SECRET!, SUPABASE_URL);

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
      const server = createMcpServer(userId, userJwt);
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

  app.listen(port, () => {
    console.error(`[agenticfocus-mcp] HTTP transport listening on :${port}/mcp (multi-user, JWT-authenticated)`);
    console.error(`[agenticfocus-mcp] Health check: http://localhost:${port}/health`);
  });
}

// ─── Boot dispatcher ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (TRANSPORT === "stdio") {
    await runStdio();
  } else if (TRANSPORT === "http") {
    await runHttp(PORT);
  } else {
    console.error(`[agenticfocus-mcp] Unknown TRANSPORT='${TRANSPORT}'. Expected 'stdio' or 'http'.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[agenticfocus-mcp] Fatal error:", err);
  process.exit(1);
});
