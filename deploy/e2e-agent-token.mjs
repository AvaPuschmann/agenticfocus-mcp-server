// Story 27-10 — preuve de bout en bout des JETONS D'AGENT : serveur local (build) + VRAI Supabase + compte de test B.
//
//   1. création de deux jetons (écriture, lecture seule) avec le script CLI `agent-token.mjs` (celui de Philippe) ;
//   2. jeton en écriture : les 16 outils, une tâche créée dans le compte B ; jeton en lecture : 5 outils, écriture refusée ;
//   3. REDÉMARRAGE du serveur (cache vidé) : les jetons survivent et la session est renouvelée pour de vrai (refresh réel) ;
//      deuxième redémarrage : le refresh_token ENREGISTRÉ au renouvellement précédent est bien celui qui sert ;
//   4. liste, révocation (refusé immédiatement), jeton inconnu, fonction désactivée sans clé ;
//   5. le fichier de jetons ne contient aucun secret en clair ; nettoyage.
//
// Usage (depuis mcp-server/) : npm run build && node deploy/e2e-agent-token.mjs
// Identifiants : ../agenticfocus-desktop/.env.test et .env (jamais affichés). Aucune donnée du compte réel n'est touchée.
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
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

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (authErr) { console.error("connexion de B impossible : " + authErr.message); process.exit(2); }
const userId = auth.user.id;
const cleanup = async () => { await sb.from("day_tasks").delete().eq("user_id", userId); };
await cleanup();

// dossier de configuration du script CLI (identifiants de B), supprimé avec le dossier temporaire du système
const work = mkdtempSync(join(tmpdir(), "e2e-agent-"));
writeFileSync(join(work, "mcp-credentials.json"), JSON.stringify({ supabase_url: SB_URL, anon_key: SB_KEY, email: EMAIL, password: PASSWORD }));
const tokenFile = join(work, "agent-tokens.json");
const KEY = randomBytes(32).toString("base64");
const PORT = 3097;
// MCP_BASE_URL=https://…  : teste un serveur déjà déployé (aucun serveur local ; redémarrages et fichier de jetons non testés).
const EXTERNAL = (process.env.MCP_BASE_URL || "").replace(/\/$/, "");
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;

let server = null;
async function startServer(extraEnv = { AGENT_TOKEN_KEY: KEY, AGENT_TOKEN_FILE: tokenFile }) {
  if (EXTERNAL) return () => "";
  const env = { ...process.env, TRANSPORT: "http", PORT: String(PORT), SUPABASE_URL: SB_URL, SUPABASE_ANON_KEY: SB_KEY, SUPABASE_JWT_SECRET: "inutile-pour-les-jetons-asymetriques" };
  delete env.AGENT_TOKEN_KEY; delete env.AGENT_TOKEN_FILE;
  server = spawn(process.execPath, ["dist/index.js"], { env: { ...env, ...extraEnv }, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  server.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + "/health")).ok) break; } catch { /* démarrage */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return () => log;
}
async function stopServer() {
  if (!server) return;
  server.kill();
  await new Promise((r) => server.once("exit", r));
  server = null;
}

const cli = (...args) => execFileSync(process.execPath, ["deploy/agent-token.mjs", ...args], {
  env: { ...process.env, AGENTICFOCUS_HOME: work, MCP_BASE_URL: BASE },
}).toString();

async function rpc(token, body, sid) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
  if (sid) headers["mcp-session-id"] = sid;
  const res = await fetch(BASE + "/mcp", { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  let json = null;
  try { json = data ? JSON.parse(data.slice(6)) : text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, sid: res.headers.get("mcp-session-id") };
}
async function open(token) {
  const init = await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
  if (init.status !== 200) return { status: init.status, sid: null };
  await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sid);
  return { status: 200, sid: init.sid };
}
const tools = async (token, sid) => ((await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid)).json?.result?.tools ?? []).map((t) => t.name).sort();
const call = async (token, sid, name, args = {}) => {
  const r = await rpc(token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }, sid);
  const result = r.json?.result;
  const text = result?.content?.[0]?.text ?? "";
  let data = null;
  try { data = JSON.parse(text); } catch { /* message d'erreur */ }
  return { isError: !!result?.isError, text, data };
};

let getLog = () => "";
try {
  getLog = await startServer();

  console.log("1. Création avec le script CLI");
  const outW = cli("create", "--label", "e2e écriture", "--scope", "write");
  const outR = cli("create", "--label", "e2e lecture", "--scope", "read");
  const write = /afk_[A-Za-z0-9_-]{43}/.exec(outW)?.[0];
  const read = /afk_[A-Za-z0-9_-]{43}/.exec(outR)?.[0];
  check(!!write && !!read && write !== read, "deux jetons afk_ créés (écriture, lecture seule), affichés une fois", "jetons non affichés par le script");
  const listed = cli("list");
  check(/e2e écriture/.test(listed) && /e2e lecture/.test(listed) && !listed.includes(write) && !listed.includes(read), "list : les deux jetons, SANS secret", `list : ${listed.slice(0, 160)}`);
  const writeId = /^(\S+)\s+écriture/m.exec(listed)?.[1];

  console.log("\n2. Utilisation");
  const w = await open(write);
  check(w.status === 200, "session ouverte avec le jeton en écriture", `ouverture refusée : ${w.status}`);
  const names = await tools(write, w.sid);
  check(names.length === 19, `jeton en écriture : 19 outils`, `outils : ${names.join(",")}`);
  const created = await call(write, w.sid, "create_day_task", { name: "E2E jeton d'agent", backlog: true });
  check(created.data?.success === true, "tâche créée via le jeton d'agent", `création : ${created.text}`);
  const row = (await sb.from("day_tasks").select("*").eq("user_id", userId)).data?.[0];
  check(row?.name === "E2E jeton d'agent" && row?.user_id === userId && row?.date === null, "la ligne est dans le compte B (bon utilisateur, backlog)", `ligne : ${JSON.stringify(row)}`);

  const r = await open(read);
  const rnames = await tools(read, r.sid);
  check(rnames.length === 7 && !rnames.some((n) => /create|update|complete/.test(n)), `jeton en lecture : ${rnames.join(", ")}`, `outils en lecture : ${rnames.join(",")}`);
  const denied = await call(read, r.sid, "create_day_task", { name: "Interdit" });
  check(denied.isError && /lecture seule/.test(denied.text), "écriture refusée au jeton en lecture seule", `écriture non refusée : ${denied.text}`);
  const seen = await call(read, r.sid, "list_tasks", { backlog: true });
  check(seen.data?.count === 1, "le jeton en lecture voit la tâche", `lecture : ${seen.text.slice(0, 100)}`);
  check((await sb.from("day_tasks").select("id").eq("user_id", userId)).data?.length === 1, "aucune tâche créée par le jeton en lecture", "une tâche a été créée en lecture seule");

  console.log("\n3. Redémarrages du serveur (cache vidé : vrai renouvellement de session à chaque fois)");
  if (EXTERNAL) console.log("  info   serveur déjà déployé : redémarrages non testés ici");
  for (const round of EXTERNAL ? [] : [1, 2]) {
    await stopServer();
    getLog = await startServer();
    const s = await open(write);
    const again = s.sid ? await call(write, s.sid, "list_tasks", { backlog: true }) : null;
    check(again?.data?.count === 1, `redémarrage ${round} : le jeton fonctionne, session renouvelée avec le refresh_token enregistré`, `redémarrage ${round} : ${s.status} ${again?.text ?? ""}`);
  }

  console.log("\n4. Révocation et refus");
  const rev = cli("revoke", writeId);
  check(/révoqué/.test(rev), "révocation par le script", `révocation : ${rev}`);
  const after = await open(write);
  check(after.status === 401, "jeton révoqué : refusé immédiatement (401)", `jeton révoqué accepté : ${after.status}`);
  const stillRead = await open(read);
  check(stillRead.status === 200, "l'autre jeton n'est pas touché", `autre jeton : ${stillRead.status}`);
  check((await open("afk_" + "x".repeat(43))).status === 401, "jeton inconnu : 401", "jeton inconnu accepté");

  console.log("\n5. Secrets et fonction désactivée");
  if (EXTERNAL) {
    console.log("  info   serveur déjà déployé : fichier de jetons et désactivation sans clé non testés ici");
    throw new Error("__fin_externe__");
  }
  const raw = readFileSync(tokenFile, "utf8");
  check(!raw.includes(write) && !raw.includes(read) && !raw.includes(auth.session.refresh_token), "le fichier de jetons ne contient aucun jeton en clair", "secret en clair dans le fichier");
  const sessionsInFile = JSON.parse(raw).tokens.map((t) => t.refreshTokenEnc);
  check(sessionsInFile.every((e) => /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/.test(e)), "refresh_tokens chiffrés (AES-GCM)", "format de chiffrement inattendu");
  await stopServer();
  getLog = await startServer({});
  check((await open(read)).status === 401, "sans AGENT_TOKEN_KEY : les jetons d'agent sont refusés", "jeton accepté sans clé");
  const errs = getLog().split("\n").filter((l) => /afk_/.test(l));
  check(errs.length === 0, "aucun jeton dans les journaux du serveur", "un jeton apparaît dans les journaux");
} catch (e) {
  if (e.message !== "__fin_externe__") ko("parcours interrompu : " + String(e.message).split("\n")[0]);
} finally {
  await stopServer();
  await cleanup();
  const left = (await sb.from("day_tasks").select("id").eq("user_id", userId)).data?.length ?? -1;
  check(left === 0, "nettoyage : données de test supprimées", `nettoyage incomplet : ${left}`);
  await sb.auth.signOut();
}

console.log(failures === 0 ? "\nRÉSULTAT : conforme." : `\nRÉSULTAT : ${failures} échec(s).`);
process.exitCode = failures === 0 ? 0 : 1;
