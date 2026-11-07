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

// Bibliothèque (27-12) : on ne supprime QUE les lignes créées par ce test (domaines / activités éventuels du compte B conservés).
const E2E_PREFIX = "E2E bibliothèque";
const cleanup = async () => {
  await sb.from("day_tasks").delete().eq("user_id", userId);
  await sb.from("projects").delete().eq("user_id", userId);
  const { data: doms } = await sb.from("domains").select("id").eq("user_id", userId).like("name", E2E_PREFIX + "%");
  const ids = (doms ?? []).map((d) => d.id);
  if (ids.length) await sb.from("task_templates").delete().eq("user_id", userId).in("domain_id", ids);
  if (ids.length) await sb.from("domains").delete().eq("user_id", userId).in("id", ids);
};
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
  check(names.length === 16 && !names.some((n) => /delete|remove/i.test(n)), `16 outils, aucun outil de suppression (${names.join(", ")})`, `outils inattendus : ${names.join(", ")}`);

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

  console.log("\n5b. Projets (Story 27-11)");
  const pr1 = await tool("create_project", { name: "E2E projet A", description: "créé par l'agent", target_date: "2026-12-31" });
  check(pr1.data?.success === true && pr1.data.kanban_position === 1024, `projet A créé en backlog (position ${pr1.data?.kanban_position})`, `création : ${pr1.text}`);
  const pr2 = await tool("create_project", { name: "E2E projet B", kanban_status: "todo" });
  const pr3 = await tool("create_project", { name: "E2E projet C", kanban_status: "todo" });
  check(pr3.data?.kanban_position === 2048, "C rangé après B dans la colonne todo (+1024)", `positions : ${pr2.data?.kanban_position}, ${pr3.data?.kanban_position}`);
  const pRows = (await sb.from("projects").select("*").eq("user_id", userId)).data ?? [];
  const rA = pRows.find((r) => r.id === pr1.data?.id);
  const rB = pRows.find((r) => r.id === pr2.data?.id);
  check(rA && rA.user_id === userId && rA.kanban_status === "backlog" && rA.started_at === null && rA.is_archived === false && rA.target_date === Date.UTC(2026, 11, 31, 12) && Array.isArray(rA.tag_ids) && rA.tag_ids.length === 0,
    "projet A en base : bon utilisateur, backlog, sans date de début, échéance 12:00 UTC, pas de tags", `ligne A : ${JSON.stringify(rA)}`);
  check(rB && rB.kanban_status === "todo" && typeof rB.started_at === "number" && rB.finished_at === null, "projet B en todo : date de début posée", `ligne B : ${JSON.stringify(rB)}`);

  const reorder = await tool("move_project", { id: pr3.data?.id, kanban_status: "todo", above_project_id: pr2.data?.id });
  check(reorder.data?.success === true && reorder.data.kanban_position === 512, "C réordonné au-dessus de B (position 512)", `réordonnancement : ${reorder.text}`);
  const toDone = await tool("move_project", { id: pr2.data?.id, kanban_status: "done" });
  const rB2 = ((await sb.from("projects").select("*").eq("id", pr2.data?.id)).data ?? [])[0];
  check(toDone.data?.success === true && rB2?.kanban_status === "done" && typeof rB2.finished_at === "number" && rB2.started_at === rB?.started_at, "B terminé : date de fin posée, début conservé", `B : ${JSON.stringify(rB2)}`);
  const reopen = await tool("move_project", { id: pr2.data?.id, kanban_status: "doing" });
  const rB3 = ((await sb.from("projects").select("*").eq("id", pr2.data?.id)).data ?? [])[0];
  check(reopen.data?.success === true && rB3?.finished_at === null && rB3?.started_at === rB?.started_at, "B rouvert : date de fin effacée", `B : ${JSON.stringify(rB3)}`);

  const upP = await tool("update_project", { id: pr1.data?.id, name: "E2E projet A (renommé)", description: null });
  const rA2 = ((await sb.from("projects").select("*").eq("id", pr1.data?.id)).data ?? [])[0];
  check(upP.data?.success === true && rA2?.name === "E2E projet A (renommé)" && rA2?.description === null && rA2?.kanban_status === "backlog", "projet A renommé, description effacée, colonne inchangée", `A : ${JSON.stringify(rA2)}`);

  const linked = await tool("create_day_task", { name: "E2E tâche du projet", backlog: true, project_id: pr1.data?.id });
  check(linked.data?.success === true, "une tâche peut être rattachée au projet créé", `rattachement : ${linked.text}`);
  const arch = await tool("archive_project", { id: pr3.data?.id });
  const rC = ((await sb.from("projects").select("*").eq("id", pr3.data?.id)).data ?? [])[0];
  check(arch.data?.is_archived === true && rC?.is_archived === true && rC?.kanban_status === "todo", "C archivé (colonne conservée)", `C : ${JSON.stringify(rC)}`);

  const listP = await tool("list_projects", {});
  check(listP.data?.count === 2 && !listP.data.projects.some((x) => x.id === pr3.data?.id), "list_projects : 2 projets actifs, l'archivé est masqué", `list_projects : ${listP.data?.count}`);
  const listAll = await tool("list_projects", { include_archived: true });
  check(listAll.data?.count === 3, "include_archived : 3 projets", `include_archived : ${listAll.data?.count}`);
  const badMove = await tool("move_project", { id: pr1.data?.id, kanban_status: "doing", below_project_id: pr3.data?.id });
  check(badMove.isError && /non archivé/.test(badMove.text), "voisin archivé refusé", `voisin archivé : ${badMove.text}`);
  const noDel = await tool("delete_project", { id: pr1.data?.id });
  check(noDel.isError && (await sb.from("projects").select("id").eq("user_id", userId)).data?.length === 3, "aucun outil de suppression de projet", "un projet a pu être supprimé");
  await tool("complete_day_task", { id: linked.data?.id }); // tâche liée : cochable, projet intact

  console.log("\n5c. Bibliothèque : domaines et activités (Story 27-12)");
  const before = (await sb.from("domains").select("id").eq("user_id", userId)).data?.length ?? 0;
  const d1 = await tool("create_domain", { name: E2E_PREFIX + " A", color: "#9c27b0" });
  check(d1.data?.success === true && d1.data.color === "#9C27B0", "domaine A créé (couleur normalisée)", `création domaine : ${d1.text}`);
  const dRow = ((await sb.from("domains").select("*").eq("id", d1.data?.id)).data ?? [])[0];
  check(dRow && dRow.user_id === userId && dRow.name === E2E_PREFIX + " A" && dRow.color === "#9C27B0" && typeof dRow.updated_at === "number",
    "domaine A en base : bon utilisateur, nom, couleur, updated_at", `ligne : ${JSON.stringify(dRow)}`);
  const dDup = await tool("create_domain", { name: (E2E_PREFIX + " a").toUpperCase() });
  check(dDup.isError && /existe déjà/.test(dDup.text), "doublon de nom refusé (casse ignorée)", `doublon : ${dDup.text}`);
  const d2 = await tool("create_domain", { name: E2E_PREFIX + " B" });
  check(d2.data?.color === "#4CAF50", "domaine B : couleur par défaut", `défaut : ${d2.text}`);
  const renamed = await tool("update_domain", { id: d1.data?.id, name: E2E_PREFIX + " A (renommé)", color: "#2196f3" });
  const dRow2 = ((await sb.from("domains").select("*").eq("id", d1.data?.id)).data ?? [])[0];
  check(renamed.data?.success === true && dRow2?.name === E2E_PREFIX + " A (renommé)" && dRow2?.color === "#2196F3" && dRow2.updated_at >= dRow.updated_at, "domaine A renommé et recoloré", `A : ${JSON.stringify(dRow2)}`);
  const listD = await tool("list_domains");
  check(listD.data?.count === before + 2 && listD.data.domains.some((d) => d.id === d1.data?.id), "list_domains voit les 2 nouveaux domaines", `list_domains : ${listD.data?.count} (avant ${before})`);

  const act1 = await tool("create_activity", { domain_id: d1.data?.id, title: "E2E activité 1", note: "modèle créé par l'agent", story_points: 3, default_pomodoros: 2 });
  const act2 = await tool("create_activity", { domain_id: d1.data?.id, title: "E2E activité 2" });
  check(act1.data?.success === true && act2.data?.story_points === 1 && act2.data?.default_pomodoros === 1, "activités créées (défauts 1 / 1)", `activités : ${act1.text} / ${act2.text}`);
  const aRow = ((await sb.from("task_templates").select("*").eq("id", act1.data?.id)).data ?? [])[0];
  check(aRow && aRow.user_id === userId && aRow.domain_id === d1.data?.id && aRow.title === "E2E activité 1" && aRow.note === "modèle créé par l'agent" && aRow.story_points === 3 && aRow.default_pomodoros === 2 && typeof aRow.updated_at === "number",
    "activité 1 en base : bon utilisateur, domaine, titre, note, points, pomodoros", `ligne : ${JSON.stringify(aRow)}`);
  const foreign = await tool("create_activity", { domain_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: "orpheline" });
  check(foreign.isError && /domain_id inconnu/.test(foreign.text), "domaine inconnu refusé (pas d'activité orpheline)", `orpheline : ${foreign.text}`);

  const listA = await tool("list_activities", { domain_id: d1.data?.id });
  check(listA.data?.count === 2 && listA.data.activities[0].title === "E2E activité 1", "list_activities filtré par domaine : 2 activités triées", `list_activities : ${listA.text.slice(0, 160)}`);
  const upA = await tool("update_activity", { id: act1.data?.id, title: "E2E activité 1 (modifiée)", note: null, story_points: 8, domain_id: d2.data?.id });
  const aRow2 = ((await sb.from("task_templates").select("*").eq("id", act1.data?.id)).data ?? [])[0];
  check(upA.data?.success === true && aRow2?.title === "E2E activité 1 (modifiée)" && aRow2?.note === null && aRow2?.story_points === 8 && aRow2?.default_pomodoros === 2 && aRow2?.domain_id === d2.data?.id,
    "activité 1 modifiée et déplacée vers B (note effacée, pomodoros conservés)", `ligne : ${JSON.stringify(aRow2)}`);
  const noDelLib = await tool("delete_domain", { id: d1.data?.id });
  check(noDelLib.isError && (await sb.from("domains").select("id").eq("id", d1.data?.id)).data?.length === 1, "aucun outil de suppression de domaine", "un domaine a pu être supprimé");

  console.log("\n6. Garde-fous");
  const gone = await tool("update_day_task", { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "fantôme" });
  check(gone.isError && /introuvable/.test(gone.text), "identifiant inconnu : « introuvable »", `inconnu : ${gone.text}`);
  const del = await tool("delete_day_task", { id: t1.data?.id });
  check(del.isError, "aucun outil de suppression", `suppression possible : ${del.text}`);
  check((await sb.from("day_tasks").select("id").eq("user_id", userId)).data?.length === 4, "les 4 tâches existent toujours", "des tâches ont disparu");
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
