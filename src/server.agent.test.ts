/**
 * Jetons d'agent, de bout en bout (Story 27-10) : vrai Express + protocole MCP + stockage chiffré + Supabase simulé.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { SignJWT } from "jose";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { buildHttpApp } from "./server.js";
import { createFakeStore } from "./fakeSupabase.js";
import { AgentTokenStore, RateLimiter, SessionRevokedError, type RefreshedSession } from "./agentTokens.js";

const SECRET = "test-secret-very-long-string-do-not-use-in-prod-1234567890";
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ALL_TOOLS = ["archive_project", "complete_day_task", "create_activity", "create_day_task", "create_domain", "create_project", "list_activities", "list_domains", "list_projects", "list_routines", "list_tasks", "list_today_tasks", "move_project", "update_activity", "update_day_task", "update_domain", "update_project"];
const READ_TOOLS = ["list_activities", "list_domains", "list_projects", "list_routines", "list_tasks", "list_today_tasks"];

const supa = createFakeStore();

// Faux Supabase Auth : refresh_token à usage unique, un refresh_token « de départ » par utilisateur.
const sessions = new Map<string, { current: string; userId: string }>();
let n = 0;
let revoked = false;
let lifetime = 3600; // durée de vie du jeton d'accès renvoyé par le faux Supabase (0 = déjà expiré)
const issueRefresh = (userId: string): string => {
  const rt = `rt-seed-${++n}`;
  sessions.set(rt, { current: rt, userId });
  return rt;
};
const refresh = async (token: string): Promise<RefreshedSession> => {
  const s = [...sessions.values()].find((x) => x.current === token);
  if (!s || revoked) throw new SessionRevokedError();
  s.current = `rt-next-${++n}`;
  return { accessToken: `at-${n}`, refreshToken: s.current, expiresAt: Math.floor(Date.now() / 1000) + lifetime, userId: s.userId };
};

let http: HttpServer;
let base = "";
let transports: ReturnType<typeof buildHttpApp>["transports"];
let store: AgentTokenStore;
let file: string;

async function start(opts: { agent: boolean; max?: number }) {
  file = join(mkdtempSync(join(tmpdir(), "agent-http-")), "tokens.json");
  store = new AgentTokenStore({ file, key: randomBytes(32), refresh });
  const built = buildHttpApp({
    jwtSecret: SECRET,
    makeClient: (jwt) => supa.clientFor(jwt),
    agentTokens: opts.agent ? store : undefined,
    rateLimiter: new RateLimiter(opts.max ?? 1000),
  });
  transports = built.transports;
  await new Promise<void>((resolve) => { http = built.app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}
async function stop() {
  for (const { transport } of Object.values(transports)) await transport.close();
  await new Promise<void>((resolve) => { http.close(() => resolve()); });
}

const userJwt = (sub = ME) =>
  new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));

interface Reply { status: number; json: any; sid: string | null }
async function call(path: string, method: string, token: string | null, body?: unknown, sid?: string | null): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (sid) headers["mcp-session-id"] = sid;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  let json: unknown = null;
  try { json = data ? JSON.parse(data.slice(6)) : text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, sid: res.headers.get("mcp-session-id") };
}
const rpc = (token: string | null, body: unknown, sid?: string | null) => call("/mcp", "POST", token, body, sid);

async function open(token: string): Promise<string> {
  const init = await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  expect(init.status).toBe(200);
  await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sid);
  return init.sid!;
}
const tool = (token: string, sid: string, name: string, args: unknown = {}) =>
  rpc(token, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, sid);
const toolNames = async (token: string, sid: string) =>
  ((await rpc(token, { jsonrpc: "2.0", id: 8, method: "tools/list" }, sid)).json.result.tools as Array<{ name: string }>).map((t) => t.name).sort();

async function makeAgentToken(scope: "read" | "write", sub = ME, label = "Claude Desktop"): Promise<{ token: string; id: string }> {
  const res = await call("/agent-tokens", "POST", await userJwt(sub), { refresh_token: issueRefresh(sub), label, scope });
  expect(res.status).toBe(201);
  return { token: res.json.token, id: res.json.id };
}

beforeEach(() => { supa.reset(); revoked = false; lifetime = 3600; });

describe("jetons d'agent — activés", () => {
  beforeAll(() => start({ agent: true, max: 1000 }));
  afterAll(stop);

  it("création → utilisation : l'agent crée une tâche pour l'utilisateur du jeton, avec la session Supabase DÉDIÉE (pas un jeton utilisateur)", async () => {
    const { token } = await makeAgentToken("write");
    const sid = await open(token);
    const out = await tool(token, sid, "create_day_task", { name: "Via Claude Desktop", backlog: true });
    expect(out.json.result.isError).toBeUndefined();
    expect(supa.tables.day_tasks[0]).toMatchObject({ user_id: ME, name: "Via Claude Desktop", date: null });
    const jwts = supa.calls.map((c) => c.jwt);
    expect(jwts.every((j) => /^at-\d+$/.test(j))).toBe(true);
  });

  it("jeton en LECTURE SEULE : les outils d'écriture sont absents de la liste ET refusés s'ils sont appelés", async () => {
    const { token } = await makeAgentToken("read");
    const sid = await open(token);
    expect(await toolNames(token, sid)).toEqual(READ_TOOLS);
    const out = await tool(token, sid, "create_day_task", { name: "Interdit" });
    expect(out.json.result.isError).toBe(true);
    expect(out.json.result.content[0].text).toContain("lecture seule");
    for (const name of ["update_day_task", "complete_day_task", "create_project", "update_project", "move_project", "archive_project", "create_domain", "update_domain", "create_activity", "update_activity"]) {
      const r = await tool(token, sid, name, { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" });
      expect(r.json.result.isError).toBe(true);
    }
    expect(supa.writes("day_tasks")).toHaveLength(0);
    const read = await tool(token, sid, "list_tasks", { backlog: true });
    expect(read.json.result.isError).toBeUndefined();
  });

  it("jeton en écriture et jeton utilisateur : les 17 outils", async () => {
    const { token } = await makeAgentToken("write");
    expect(await toolNames(token, await open(token))).toEqual(ALL_TOOLS);
    const jwt = await userJwt();
    expect(await toolNames(jwt, await open(jwt))).toEqual(ALL_TOOLS);
  });

  it("liste : ses jetons seulement, sans secret ; révocation : immédiate, et impossible pour un autre utilisateur", async () => {
    const mine = await makeAgentToken("write", ME, "mien");
    await makeAgentToken("write", OTHER, "autre");
    const list = await call("/agent-tokens", "GET", await userJwt());
    expect(list.json.tokens.map((t: { label: string }) => t.label)).toContain("mien");
    expect(list.json.tokens.map((t: { label: string }) => t.label)).not.toContain("autre");
    expect(JSON.stringify(list.json)).not.toContain(mine.token);

    const stranger = await call(`/agent-tokens/${mine.id}`, "DELETE", await userJwt(OTHER));
    expect(stranger.status).toBe(404);
    expect((await rpc(mine.token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).not.toBe(401);

    const revoke = await call(`/agent-tokens/${mine.id}`, "DELETE", await userJwt());
    expect(revoke.status).toBe(200);
    const after = await rpc(mine.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(after.status).toBe(401);
  });

  it("un jeton d'agent ne peut PAS créer, lister ni révoquer des jetons", async () => {
    const { token, id } = await makeAgentToken("write");
    expect((await call("/agent-tokens", "POST", token, { refresh_token: issueRefresh(ME), label: "x", scope: "write" })).status).toBe(401);
    expect((await call("/agent-tokens", "GET", token)).status).toBe(401);
    expect((await call(`/agent-tokens/${id}`, "DELETE", token)).status).toBe(401);
  });

  it("refuse : jeton inconnu, sans jeton, refresh_token d'un autre utilisateur, refresh_token invalide, champs invalides", async () => {
    expect((await rpc("afk_inconnu-inconnu-inconnu-inconnu-inconnu-123", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    expect((await call("/agent-tokens", "POST", null, { refresh_token: issueRefresh(ME), label: "x", scope: "write" })).status).toBe(401);
    expect((await call("/agent-tokens", "POST", await userJwt(OTHER), { refresh_token: issueRefresh(ME), label: "vol", scope: "write" })).status).toBe(403);
    expect((await call("/agent-tokens", "POST", await userJwt(), { refresh_token: "n'importe-quoi", label: "x", scope: "write" })).status).toBe(400);
    const jwt = await userJwt();
    expect((await call("/agent-tokens", "POST", jwt, { refresh_token: issueRefresh(ME), label: "", scope: "write" })).status).toBe(400);
    expect((await call("/agent-tokens", "POST", jwt, { refresh_token: issueRefresh(ME), label: "x", scope: "admin" })).status).toBe(400);
    expect((await call("/agent-tokens", "POST", jwt, { label: "x", scope: "write" })).status).toBe(400);
  });

  it("session Supabase révoquée : 401 avec un message clair, jamais d'accès aux données ; le jeton est marqué à recréer", async () => {
    lifetime = 0; // le jeton d'accès reçu à la création est déjà expiré : la requête suivante doit renouveler
    const { token, id } = await makeAgentToken("write");
    revoked = true;
    const res = await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.json)).toContain("Recréez");
    expect(supa.calls).toHaveLength(0);
    const list = await call("/agent-tokens", "GET", await userJwt());
    expect(list.json.tokens.find((t: { id: string }) => t.id === id).status).toBe("broken");
  });

  it("un jeton dont la session expire est renouvelé de façon transparente (la requête aboutit avec le nouveau jeton d'accès)", async () => {
    lifetime = 0;
    const { token } = await makeAgentToken("write");
    lifetime = 3600;
    const sid = await open(token);
    const out = await tool(token, sid, "list_tasks", { backlog: true });
    expect(out.json.result.isError).toBeUndefined();
    expect(supa.calls.length).toBeGreaterThan(0);
  });

  it("journal d'audit : identifiant du jeton, outil et résultat — JAMAIS le jeton ni la session", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { token, id } = await makeAgentToken("write");
    const sid = await open(token);
    await tool(token, sid, "list_tasks", { backlog: true });
    await tool(token, sid, "create_day_task", { name: "" });
    const logs = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();
    expect(logs).toContain(id);
    expect(logs).toContain('"tool":"list_tasks"');
    expect(logs).toContain('"outcome":"refused"');
    expect(logs).not.toContain(token);
    expect(logs).not.toMatch(/at-\d|rt-/);
  });

  it("le fichier de jetons ne contient aucun secret en clair", async () => {
    const { token } = await makeAgentToken("write");
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).not.toMatch(/rt-seed|rt-next|at-\d/);
  });
});

describe("jetons d'agent — limite de débit", () => {
  beforeAll(() => start({ agent: true, max: 5 }));
  afterAll(stop);

  it("au-delà de la limite par minute : 429 ; un autre jeton n'est pas touché", async () => {
    const a = await makeAgentToken("write", ME, "a");
    const b = await makeAgentToken("write", ME, "b");
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await rpc(a.token, { jsonrpc: "2.0", id: i, method: "ping" })).status);
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
    expect((await rpc(b.token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).not.toBe(429);
  });
});

describe("jetons d'agent — désactivés (pas de clé de chiffrement)", () => {
  beforeAll(() => start({ agent: false }));
  afterAll(stop);

  it("un jeton afk_ est refusé avec un message clair, les routes de gestion n'existent pas, les jetons utilisateur marchent", async () => {
    const res = await rpc("afk_quelque-chose-quelque-chose-quelque-chose-12", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.json)).toContain("pas activés");
    expect((await call("/agent-tokens", "GET", await userJwt())).status).toBe(404);
    const jwt = await userJwt();
    expect(await toolNames(jwt, await open(jwt))).toEqual(ALL_TOOLS);
  });
});
