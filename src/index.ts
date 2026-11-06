#!/usr/bin/env node
/**
 * AgenticFocus MCP Server — Epic 25 (transport, auth, déploiement) + Epic 27 (outils pour les agents).
 *
 * Multi-utilisateur : `Authorization: Bearer <jwt>` sur CHAQUE requête HTTP. Chaque requête d'outil utilise un client
 * Supabase créé avec LE JETON DE CETTE REQUÊTE (Story 25-6) : une session ouverte plus d'une heure continue de
 * fonctionner avec les jetons renouvelés par l'agent. La RLS s'applique : l'utilisateur ne voit que ses données.
 *
 * Transports :
 *   - stdio (Claude Desktop local, mono-utilisateur : SUPABASE_USER_JWT + USER_ID)
 *   - StreamableHTTPServerTransport (production, multi-utilisateur)
 *
 * Outils : voir `tools.ts` (création, lecture, modification, cochage, domaines, projets ; AUCUNE suppression).
 * Transport choisi par TRANSPORT=stdio|http (défaut : http).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createMcpServer, buildHttpApp } from "./server.js";
import { AgentTokenStore, RateLimiter, parseKey, supabaseRefresh } from "./agentTokens.js";

// ─── Env config ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const TRANSPORT = (process.env.TRANSPORT ?? "http").toLowerCase();
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Jetons d'agent (Story 27-10) : activés seulement si AGENT_TOKEN_KEY est une clé valide (32 octets en base64).
const AGENT_TOKEN_KEY = process.env.AGENT_TOKEN_KEY;
const AGENT_TOKEN_FILE = process.env.AGENT_TOKEN_FILE ?? "/data/agent-tokens.json";
const AGENT_RATE_LIMIT = parseInt(process.env.AGENT_RATE_LIMIT ?? "120", 10);

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

// ─── Stdio transport boot (legacy single-user) ────────────────────────────────

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  // stdio mode uses the legacy env vars — single-user.
  const server = createMcpServer(STDIO_USER_ID!, makeSupabaseClient, STDIO_USER_JWT!);
  await server.connect(transport);
  console.error("[agenticfocus-mcp] stdio transport running (single-user via env vars). Ready to serve.");
}

// ─── HTTP transport boot (multi-user via JWT per-request) ─────────────────────

async function runHttp(port: number): Promise<void> {
  let agentTokens: AgentTokenStore | undefined;
  if (AGENT_TOKEN_KEY) {
    const key = parseKey(AGENT_TOKEN_KEY);
    if (!key) {
      console.error("[agenticfocus-mcp] AGENT_TOKEN_KEY invalide (32 octets en base64 attendus : openssl rand -base64 32) : jetons d'agent DÉSACTIVÉS.");
    } else {
      agentTokens = new AgentTokenStore({ file: AGENT_TOKEN_FILE, key, refresh: supabaseRefresh(SUPABASE_URL!, SUPABASE_ANON_KEY!) });
      console.error(`[agenticfocus-mcp] jetons d'agent activés (fichier ${AGENT_TOKEN_FILE}, ${AGENT_RATE_LIMIT} requêtes/min par jeton).`);
    }
  } else {
    console.error("[agenticfocus-mcp] jetons d'agent désactivés (AGENT_TOKEN_KEY absent).");
  }
  const { app } = buildHttpApp({
    jwtSecret: SUPABASE_JWT_SECRET!,
    supabaseUrl: SUPABASE_URL,
    makeClient: makeSupabaseClient,
    agentTokens,
    rateLimiter: new RateLimiter(AGENT_RATE_LIMIT),
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
