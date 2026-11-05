/**
 * Tests de bout en bout du serveur HTTP (Story 25-6) : vrai Express + vrai protocole MCP (Streamable HTTP) + vraie
 * vérification de jeton, avec un client Supabase simulé qui mémorise le jeton avec lequel il a été créé.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SignJWT } from "jose";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { buildHttpApp, SERVER_VERSION } from "./server.js";
import { createFakeStore } from "./fakeSupabase.js";

const SECRET = "test-secret-very-long-string-do-not-use-in-prod-1234567890";
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const store = createFakeStore();
let http: HttpServer;
let base = "";
let transports: ReturnType<typeof buildHttpApp>["transports"];

beforeAll(async () => {
  const built = buildHttpApp({ jwtSecret: SECRET, makeClient: (jwt) => store.clientFor(jwt) });
  transports = built.transports;
  await new Promise<void>((resolve) => { http = built.app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const { transport } of Object.values(transports)) await transport.close();
  await new Promise<void>((resolve) => { http.close(() => resolve()); });
});
beforeEach(() => store.reset());

async function jwt(opts: { sub?: string; exp?: string; tag?: string } = {}): Promise<string> {
  return new SignJWT({ tag: opts.tag ?? "t" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(opts.sub ?? ME)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(new TextEncoder().encode(SECRET));
}

interface Reply { status: number; json: any; sessionId: string | null }

async function rpc(token: string | null, body: unknown, sessionId?: string | null): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  let json: unknown = null;
  try { json = data ? JSON.parse(data.slice(6)) : text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, sessionId: res.headers.get("mcp-session-id") };
}

async function openSession(token: string): Promise<string> {
  const init = await rpc(token, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  expect(init.status).toBe(200);
  expect(init.sessionId).toBeTruthy();
  await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
  return init.sessionId!;
}

const callTool = (token: string | null, sessionId: string, name: string, args: unknown = {}, id = 2) =>
  rpc(token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, sessionId);

describe("serveur MCP — santé et outils", () => {
  it("/health indique la version du serveur", async () => {
    const res = await (await fetch(`${base}/health`)).json();
    expect(res).toMatchObject({ status: "ok", version: SERVER_VERSION });
  });

  it("liste les 7 outils, dont aucun ne supprime", async () => {
    const t = await jwt();
    const sid = await openSession(t);
    const out = await rpc(t, { jsonrpc: "2.0", id: 3, method: "tools/list" }, sid);
    const names = out.json.result.tools.map((x: { name: string }) => x.name).sort();
    expect(names).toEqual(["complete_day_task", "create_day_task", "list_domains", "list_projects", "list_tasks", "list_today_tasks", "update_day_task"]);
  });
});

describe("Story 25-6 — le jeton de CHAQUE requête est utilisé, pas celui de l'ouverture de la session", () => {
  it("session ouverte avec le jeton A, appel avec le jeton B renouvelé (même utilisateur) : Supabase reçoit B", async () => {
    const tokenA = await jwt({ tag: "ancien" });
    const tokenB = await jwt({ tag: "renouvelé" });
    const sid = await openSession(tokenA);

    const out = await callTool(tokenB, sid, "list_tasks", { backlog: true });

    expect(out.json.result.isError).toBeUndefined();
    const jwts = store.calls.map((c) => c.jwt);
    expect(jwts.length).toBeGreaterThan(0);
    expect(jwts.every((j) => j === tokenB)).toBe(true);
    expect(jwts).not.toContain(tokenA);
  });

  it("chaque appel successif utilise SON jeton (A, puis B, puis C)", async () => {
    const [a, b, c] = [await jwt({ tag: "a" }), await jwt({ tag: "b" }), await jwt({ tag: "c" })];
    const sid = await openSession(a);
    for (const [i, t] of [a, b, c].entries()) await callTool(t, sid, "list_tasks", { backlog: true }, 10 + i);
    expect(store.calls.map((x) => x.jwt)).toEqual([a, b, c]);
  });

  it("un jeton expiré est refusé en 401 AVANT tout accès aux données, même dans une session valide", async () => {
    const sid = await openSession(await jwt());
    const expired = await jwt({ exp: "-1h" });
    const out = await callTool(expired, sid, "list_tasks");
    expect(out.status).toBe(401);
    expect(store.calls).toHaveLength(0);
  });

  it("sans jeton : 401 ; jeton falsifié : 401", async () => {
    const sid = await openSession(await jwt());
    expect((await callTool(null, sid, "list_tasks")).status).toBe(401);
    expect((await callTool((await jwt()) + "x", sid, "list_tasks")).status).toBe(401);
    expect(store.calls).toHaveLength(0);
  });

  it("le jeton d'un AUTRE utilisateur ne peut pas utiliser la session (403) et ne touche pas aux données", async () => {
    const sid = await openSession(await jwt({ sub: ME }));
    const out = await callTool(await jwt({ sub: OTHER }), sid, "list_tasks");
    expect(out.status).toBe(403);
    expect(store.calls).toHaveLength(0);
  });

  it("user_id des requêtes = utilisateur du jeton (jamais fourni par l'agent)", async () => {
    const t = await jwt({ sub: ME });
    const sid = await openSession(t);
    await callTool(t, sid, "create_day_task", { name: "Via MCP", date: "2026-11-06" });
    expect(store.tables.day_tasks[0]).toMatchObject({ user_id: ME, name: "Via MCP" });
  });
});

describe("erreurs d'outil via le protocole", () => {
  it("une saisie invalide renvoie isError avec un message lisible, sans écriture", async () => {
    const t = await jwt();
    const sid = await openSession(t);
    const out = await callTool(t, sid, "create_day_task", { name: "" });
    expect(out.json.result.isError).toBe(true);
    expect(out.json.result.content[0].text).toContain("obligatoire");
    expect(store.writes("day_tasks")).toHaveLength(0);
  });

  it("un outil inconnu (ex. suppression) renvoie isError", async () => {
    const t = await jwt();
    const sid = await openSession(t);
    const out = await callTool(t, sid, "delete_day_task", { id: "x" });
    expect(out.json.result.isError).toBe(true);
  });

  it("une requête sans session (hors initialize) est refusée en 400", async () => {
    const out = await rpc(await jwt(), { jsonrpc: "2.0", id: 9, method: "tools/list" });
    expect(out.status).toBe(400);
  });
});
