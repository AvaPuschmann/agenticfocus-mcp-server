# AgenticFocus MCP Server

**Story 23-7 / Sprint 21 (POC stdio)** → **Story 25-1 / Sprint 24 (production HTTP transport)**.
MCP server exposing AgenticFocus CRUD tools to LLM clients via the Model Context Protocol — supports both **stdio** (Claude Desktop local) and **StreamableHTTPServerTransport** (Hermes Docker VPS, Claude Web, remote agents).

> Reference investigation : [`_bmad-output/research/mcp-investigation.md`](../_bmad-output/research/mcp-investigation.md)

---

## Transports — choose your mode

Set the `TRANSPORT` env var :

| Mode | Auth | Use case |
|---|---|---|
| **`http`** (default) | **JWT per-request** (multi-user) | Remote agents (Hermes Docker VPS, Claude Web), MCP Inspector remote |
| **`stdio`** | env vars (single-user legacy) | Claude Desktop local POC |

In HTTP mode the server exposes :
- `POST /mcp` — JSON-RPC requests (initialize handshake + tool calls), requires `Authorization: Bearer <jwt>`
- `GET /mcp` — server-sent events stream (server → client notifications), requires same JWT
- `DELETE /mcp` — explicit session termination, requires same JWT
- `GET /health` — Docker / reverse proxy health check (no auth, returns service status + active sessions count)

Session management is **stateful** : each client gets a `mcp-session-id` header after the initialize handshake and reuses it for subsequent requests. Sessions are bound to the user extracted from the JWT (`sub` claim) and cannot be hijacked by a different user (returns 403 if JWT user ≠ session owner). Sessions are kept in-memory ; restarting the server invalidates them.

## Authentication (HTTP mode — Story 25-2)

Every request must include `Authorization: Bearer <jwt>` where `<jwt>` is a Supabase user JWT (typically obtained via `supabase.auth.signInWithPassword()` or refresh flow). The server :

1. Verifies HS256 signature against `SUPABASE_JWT_SECRET` (set at server boot)
2. Verifies expiration (claim `exp`)
3. Extracts `sub` claim as the user id
4. Creates a per-session Supabase client scoped via the user's JWT — RLS policies apply normally, so the user only ever sees their own data

If the JWT is missing, malformed, expired, or signed with the wrong secret → 401 JSON-RPC error.

### Where to get `SUPABASE_JWT_SECRET`

Supabase Studio → Project Settings → API → JWT Secret. This is the HS256 shared secret used by Supabase Auth to sign user JWTs. **Do NOT confuse with the `anon` or `service_role` keys** — those are different.

### Why JWT per-request (Story 25-2 architecture)

The Sprint 21 POC used global env vars `SUPABASE_USER_JWT + USER_ID` (single-user, JWT redeployment every hour at refresh). Production needs multi-user — each Hermes/Claude Web/iOS user passes their own JWT, the server scopes RLS per-user without secret rotation pain.

---

## What it does

Exposes 3 tools to any MCP client (Claude Desktop, MCP Inspector, custom agent) :

| Tool | What |
|---|---|
| `create_day_task` | Create a task scheduled for a specific day (name, date, planned pomodoros, optional project/domain) |
| `list_today_tasks` | List today's tasks with progress + project name |
| `list_projects` | List Kanban projects (filter by status, include archived flag) |

The server connects directly to Supabase via REST API using a user-scoped JWT token. RLS policies apply normally (you only see your own data).

---

## Setup

### Prerequisites

- Node.js 18+ (tested with v24)
- Supabase user account with data in AgenticFocus
- Claude Desktop (or any MCP-compatible client)

### Install + build

```bash
cd "c:/KM/Assets/Claude/01 product/mcp-server"
npm install
npm run build
```

This produces `dist/index.js`.

### Required environment variables

| Var | Description | Where to get it |
|---|---|---|
| `SUPABASE_URL` | Your Supabase project URL | Supabase Studio → Project Settings → API → URL |
| `SUPABASE_ANON_KEY` | Public anon key | Same place → `anon` key |
| `SUPABASE_USER_JWT` | A user-scoped JWT token | Sign in via Supabase Studio Auth → Sessions, OR copy from desktop app DevTools (`localStorage.getItem('supabase.auth.token')`) |
| `USER_ID` | Your Supabase auth user UUID | Supabase Studio → Auth → Users → click your user → copy ID |

⚠ The JWT expires (usually ~1h). You'll need to refresh it periodically. For POC simplicity we don't handle refresh — V2 (Sprint 22+) story.

### Configure Claude Desktop

Edit `claude_desktop_config.json` :
- Mac : `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows : `%APPDATA%\Claude\claude_desktop_config.json`

Add :

```json
{
  "mcpServers": {
    "agenticfocus": {
      "command": "node",
      "args": ["C:\\KM\\Assets\\Claude\\01 product\\mcp-server\\dist\\index.js"],
      "env": {
        "SUPABASE_URL": "https://YOUR_PROJECT.supabase.co",
        "SUPABASE_ANON_KEY": "eyJhbGciOi...",
        "SUPABASE_USER_JWT": "eyJhbGciOi...",
        "USER_ID": "d9dd9a28-ec9c-4a67-9253-f673021c1611"
      }
    }
  }
}
```

Restart Claude Desktop. Look for the 🔌 plug icon in the input area — clicking it should show `agenticfocus` server with 3 tools.

---

## Test via MCP Inspector (no Claude Desktop required)

### HTTP mode (Story 25-2, JWT per-request multi-user)

In one terminal, start the server :

```powershell
$env:SUPABASE_URL="https://YOUR.supabase.co"
$env:SUPABASE_ANON_KEY="eyJ..."
$env:SUPABASE_JWT_SECRET="your-jwt-secret-from-supabase-studio"
$env:TRANSPORT="http"
$env:PORT="3000"
npm run dev
```

Sanity check it's alive :

```powershell
curl http://localhost:3000/health
# → {"status":"ok","service":"agenticfocus-mcp","transport":"http","version":"0.3.0-jwt","sessions":0}
```

Get a user JWT (from Supabase Studio Auth → Sessions, or from the desktop/mobile app's localStorage `supabase.auth.token`).

Test with curl :

```powershell
$JWT="eyJhbGc..."  # your user JWT
curl -X POST http://localhost:3000/mcp `
  -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" `
  -H "Authorization: Bearer $JWT" `
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.1"}},"id":1}'
# Response : 200 OK + mcp-session-id header
```

In another terminal, launch MCP Inspector :

```bash
npx @modelcontextprotocol/inspector
```

Then in the Inspector UI :
1. Transport : `Streamable HTTP`
2. URL : `http://localhost:3000/mcp`
3. **Authentication** : paste your JWT in the `Authorization` field with value `Bearer <jwt>` (or use the Auth tab)
4. Click `Connect` → should show the 3 tools
5. Click `list_today_tasks` → JSON response with your tasks for today

### Stdio mode (POC legacy)

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_USER_JWT=... USER_ID=... npm run inspect:stdio
```

This opens a web UI where you can manually invoke each tool with sample inputs.

---

## Example prompts (Claude Desktop)

> "Crée-moi une tâche 'Réviser PR Sprint 21' pour aujourd'hui avec 2 pomodoros."

Claude calls `create_day_task({ name: "Réviser PR Sprint 21", planned_pomodoros: 2 })` → task appears in AgenticFocus mobile/desktop in ~2s via Supabase Realtime.

> "Liste-moi mes tâches du jour."

Claude calls `list_today_tasks()` → returns array, formatted naturally.

> "Quels sont mes projets en cours dans la colonne Doing ?"

Claude calls `list_projects({ kanban_status: "doing" })` → returns active projects.

---

## Limitations (POC)

- Auth JWT expire ~1h, pas de refresh automatique (Sprint 22)
- Pas d'IPC desktop : pas de `start_pomodoro` (le TimerService est interne à Tauri/Android)
- 3 outils seulement — P2 (mark_complete, create_project, get_goals, search_templates) en backlog
- Pas de tests automatisés — Sprint 22 ajoute coverage

Voir [`_bmad-output/research/mcp-investigation.md`](../_bmad-output/research/mcp-investigation.md) section 8 pour la liste complète.

---

## Sprint 21 Story 23-7 closure (stdio POC)

Build : `npm run build` → `dist/index.js` ~5KB
LOC : ~270 lignes (`src/index.ts` + config + README)

Decision Sprint 22+ : production-ize (~4.5j estimé) selon ratio valeur/effort.

---

## Sprint 24 Story 25-1 — HTTP transport

**Date** : 2026-05-23
**Effort** : 2 SP

Foundation for Epic 25 Production. Le serveur écoute désormais en HTTP avec `StreamableHTTPServerTransport` (MCP SDK 1.29+, successeur officiel SSE). Le mode stdio reste fonctionnel pour rétro-compatibilité Claude Desktop.

**Suite Epic 25** :
- Story 25-2 : Auth header JWT per-request (remplace env var SUPABASE_USER_JWT global)
- Story 25-3 : Dockerfile multi-stage + build registry + déploiement VPS Hostinger
- Story 25-4 : Reverse proxy HTTPS + DNS mcp.agenticfocus.app + Let's Encrypt
- Story 25-5 : Tests E2E Hermes (Docker VPS) + MCP Inspector distant
