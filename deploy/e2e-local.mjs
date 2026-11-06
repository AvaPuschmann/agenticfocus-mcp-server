// Stories 25-6 / 27-1 — preuve de bout en bout : le serveur MCP (build local) contre le VRAI Supabase, avec le compte de test B.
//
//   1. connexion de B DEUX fois (jeton 1 puis jeton 2 : deux jetons valides différents, comme un renouvellement) ;
//   2. session MCP ouverte avec le jeton 1, outils appelés avec le jeton 2 (25-6) ;
//   3. créer (jour, backlog, avec champs), lire (jour, plage, backlog), modifier, déplacer, cocher, domaines ;
//   4. contrôle direct en base (lignes, position, user_id) ;
//   5. aucun outil de suppression ; nettoyage des données de B.
//
// Usage (depuis mcp-server/) : npm run build && node deploy/e2e-local.mjs
// Identifiants : ../agenticfocus-desktop/.env.test et .env (jamais affichés). Aucune donnée du compte réel n'est touchée.
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const ENV_DIR = "../agenticfocus-desktop/";
for (const file of [ENV_DIR + ".env.test", ENV_DIR + ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.includes("=") || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    if (!(k in process.env) && line.slice(i + 1).trim()) process.env[k] = line.slice(i + 1).trim();
  }
}
const { TEST_B_EMAIL: EMAIL, TEST_B_PASSWORD: PASSWORD, VITE_SUPABASE_URL: SB_URL, VITE_SUPABASE_ANON_KEY: SB_KEY } = process.env;
if (!EMAIL || !PASSWORD || !SB_URL || !SB_KEY) { console.error("Variables manquantes (.env.test / .env du desktop)"); process.exit(2); }

let failures = 0;
const ok = (m) => console.log("  OK     " + m);
const ko = (m) => { failures++; console.log("  ECHEC  " + m); };
const check = (c, a, b) => (c ? ok(a) : ko(b));

async function login() {
  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error) { console.error("connexion de B impossible : " + error.message); process.exit(2); }
  return { sb, token: data.session.access_token, userId: data.user.id };
}

const PORT = 3099;
// MCP_BASE_URL=https://…  : teste un serveur déjà déployé (aucun serveur local lancé).
const EXTERNAL = (process.env.MCP_BASE_URL || "").replace(/\/$/, "");
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;
const first = await login();
await new Promise((r) => setTimeout(r, 1100)); // jetons émis à des secondes différentes
const second = await login();
const sb = second.sb;
const userId = second.userId;
check(first.token !== second.token, "deux jetons valides distincts pour le même utilisateur", "les deux jetons sont identiques (test non probant)");

const cleanup = async () => { await sb.from("day_tasks").delete().eq("user_id", userId); };
await cleanup();

const server = EXTERNAL ? null : spawn(process.execPath, ["dist/index.js"], {
  env: { ...process.env, TRANSPORT: "http", PORT: String(PORT), SUPABASE_URL: SB_URL, SUPABASE_ANON_KEY: SB_KEY, SUPABASE_JWT_SECRET: "inutile-pour-les-jetons-asymetriques" },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverLog = "";
server?.stderr.on("data", (d) => { serverLog += d; });
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(BASE + "/health")).ok) break; } catch { /* démarrage */ }
  await new Promise((r) => setTimeout(r, 250));
}

async function rpc(token, body, sessionId) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(BASE + "/mcp", { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  let json = null;
  try { json = data ? JSON.parse(data.slice(6)) : text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, sessionId: res.headers.get("mcp-session-id") };
}
let nextId = 10;
let sid = null;
// Toujours le JETON 2 pour les appels, alors que la session a été ouverte avec le jeton 1.
const tool = async (name, args = {}) => {
  const r = await rpc(second.token, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, sid);
  const result = r.json?.result;
  const text = result?.content?.[0]?.text ?? "";
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* message d'erreur */ }
  return { status: r.status, isError: !!result?.isError, text, data: parsed };
};

try {
  console.log("\n1. Session ouverte avec le jeton 1, appels avec le jeton 2 (25-6)");
  const init = await rpc(first.token, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
  });
  sid = init.sessionId;
  check(init.status === 200 && !!sid, "session ouverte (jeton 1)", `ouverture refusée : ${init.status}`);
  await rpc(first.token, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);

  const tools = await rpc(second.token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
  const names = (tools.json?.result?.tools ?? []).map((t) => t.name).sort();
  check(names.length === 7 && !names.some((n) => /delete|remove/i.test(n)), `7 outils, aucun outil de suppression (${names.join(", ")})`, `outils inattendus : ${names.join(", ")}`);

  console.log("\n2. Créer");
  const day = "2026-11-12";
  const t1 = await tool("create_day_task", { name: "E2E MCP : première", date: day, planned_pomodoros: 2, story_points: 3, impact: "high", urgency: "urgent", due_date: "2026-11-20", note: "créée par l'agent" });
  check(t1.data?.success === true, `tâche 1 créée (position ${t1.data?.position})`, `création refusée : ${t1.text}`);
  const t2 = await tool("create_day_task", { name: "E2E MCP : seconde", date: day });
  check(t2.data?.position === (t1.data?.position ?? 0) + 1, "la seconde est rangée APRÈS la première (position +1)", `positions : ${t1.data?.position} puis ${t2.data?.position}`);
  const t3 = await tool("create_day_task", { name: "E2E MCP : backlog", backlog: true });
  check(t3.data?.date === null, "tâche de backlog sans date", `backlog : ${t3.text}`);
  const bad = await tool("create_day_task", { name: "x", user_id: "autre" });
  check(bad.isError && /user_id/.test(bad.text), "argument user_id refusé (le jeton décide)", `user_id accepté : ${bad.text}`);

  console.log("\n3. Contrôle direct en base");
  const rows = (await sb.from("day_tasks").select("*").eq("user_id", userId).order("position")).data ?? [];
  check(rows.length === 3, "3 lignes en base, toutes au bon utilisateur", `${rows.length} lignes`);
  const r1 = rows.find((r) => r.id === t1.data?.id);
  check(r1 && r1.date === day && r1.story_points === 3 && r1.impact === "high" && r1.urgency === "urgent" && r1.planned_pomodoros === 2 && r1.note === "créée par l'agent" && r1.due_date === Date.UTC(2026, 10, 20, 12),
    "champs enregistrés tels que demandés (points, impact, urgence, échéance, note)", `ligne : ${JSON.stringify(r1)}`);

  console.log("\n4. Lire");
  const byDay = await tool("list_tasks", { date: day });
  check(byDay.data?.count === 2 && byDay.data.tasks[0].id === t1.data?.id, "list_tasks par date : 2 tâches dans l'ordre", `lecture : ${byDay.text.slice(0, 120)}`);
  const range = await tool("list_tasks", { from: "2026-11-01", to: "2026-11-30" });
  check(range.data?.count === 2, "list_tasks par plage", `plage : ${range.data?.count}`);
  const backlog = await tool("list_tasks", { backlog: true });
  check(backlog.data?.count === 1, "list_tasks backlog : 1 tâche", `backlog : ${backlog.data?.count}`);
  const domains = await tool("list_domains");
  check(Array.isArray(domains.data?.domains), "list_domains répond", `domaines : ${domains.text.slice(0, 100)}`);
  const projects = await tool("list_projects");
  check(Array.isArray(projects.data?.projects), "list_projects répond", `projets : ${projects.text.slice(0, 100)}`);

  console.log("\n5. Modifier, déplacer, cocher");
  const up = await tool("update_day_task", { id: t2.data?.id, name: "E2E MCP : seconde (renommée)", note: "ajoutée" });
  check(up.data?.success === true, "tâche modifiée", `modification : ${up.text}`);
  const mv = await tool("update_day_task", { id: t3.data?.id, date: day });
  check(mv.data?.success === true, "tâche du backlog planifiée au jour", `déplacement : ${mv.text}`);
  const done = await tool("complete_day_task", { id: t1.data?.id });
  check(done.data?.is_completed === true, "tâche cochée", `cochage : ${done.text}`);
  const after = (await sb.from("day_tasks").select("*").eq("user_id", userId)).data ?? [];
  const a1 = after.find((r) => r.id === t1.data?.id);
  const a2 = after.find((r) => r.id === t2.data?.id);
  const a3 = after.find((r) => r.id === t3.data?.id);
  check(a1?.is_completed === true && a1?.completed_pomodoros === 0, "cochée, compteurs de pomodoros intacts", `a1 : ${JSON.stringify(a1)}`);
  check(a2?.name === "E2E MCP : seconde (renommée)" && a2?.note === "ajoutée" && a2?.story_points === 0, "seuls les champs fournis ont changé", `a2 : ${JSON.stringify(a2)}`);
  check(a3?.date === day && a3?.position > (a2?.position ?? 0), "tâche planifiée rangée après les autres du jour", `a3 : ${JSON.stringify(a3)}`);
  const open = await tool("list_tasks", { date: day, include_completed: false });
  check(open.data?.count === 2, "include_completed: false masque la tâche cochée", `ouvertes : ${open.data?.count}`);

  console.log("\n6. Garde-fous");
  const gone = await tool("update_day_task", { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "fantôme" });
  check(gone.isError && /introuvable/.test(gone.text), "identifiant inconnu : « introuvable »", `inconnu : ${gone.text}`);
  const del = await tool("delete_day_task", { id: t1.data?.id });
  check(del.isError, "aucun outil de suppression", `suppression possible : ${del.text}`);
  check((await sb.from("day_tasks").select("id").eq("user_id", userId)).data?.length === 3, "les 3 tâches existent toujours", "des tâches ont disparu");
  const anon = await fetch(BASE + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  check(anon.status === 401, "sans jeton : 401", `sans jeton : ${anon.status}`);
} catch (e) {
  ko("parcours interrompu : " + String(e.message).split("\n")[0]);
} finally {
  server?.kill();
  await cleanup();
  const left = (await sb.from("day_tasks").select("id").eq("user_id", userId)).data?.length ?? -1;
  check(left === 0, "nettoyage : données de test supprimées", `nettoyage incomplet : ${left}`);
  const errors = serverLog.split("\n").filter((l) => /failed|error/i.test(l) && !/session/.test(l));
  check(EXTERNAL || errors.length === 0, "aucune erreur dans les journaux du serveur (serveur local seulement)", "journaux : " + errors.slice(0, 2).join(" | "));
  await sb.auth.signOut();
}

console.log(failures === 0 ? "\nRÉSULTAT : conforme." : `\nRÉSULTAT : ${failures} échec(s).`);
process.exitCode = failures === 0 ? 0 : 1;
