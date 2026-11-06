#!/usr/bin/env node
// Gestion des jetons d'agent du serveur MCP (Story 27-10), à lancer sur VOTRE PC.
//
//   node deploy/agent-token.mjs create --label "Claude Desktop" [--scope write|read]
//   node deploy/agent-token.mjs list
//   node deploy/agent-token.mjs revoke <identifiant>
//
// `create` : se connecte avec votre e-mail et mot de passe (fichier ~/.agenticfocus/mcp-credentials.json, créé par
// setup-claude-credentials.ps1), ouvre une session Supabase DÉDIÉE à ce jeton (vos autres sessions ne sont pas touchées),
// la confie au serveur, et affiche le jeton d'agent UNE SEULE FOIS. Collez-le dans le connecteur de Claude Desktop
// (Request headers : Authorization = Bearer afk_…) ou dans la configuration d'Hermes. Il n'est pas récupérable ensuite :
// en cas de perte, révoquez-le et recréez-en un.
//
// Variables : MCP_BASE_URL (défaut https://mcp.109-176-198-7.sslip.io), AGENTICFOCUS_HOME (défaut ~/.agenticfocus).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.AGENTICFOCUS_HOME || join(homedir(), ".agenticfocus");
const BASE = (process.env.MCP_BASE_URL || "https://mcp.109-176-198-7.sslip.io").replace(/\/$/, "");

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const fail = (message) => { console.error(message); process.exit(1); };

let credentials;
try { credentials = JSON.parse(readFileSync(join(HOME, "mcp-credentials.json"), "utf8")); } catch { /* traité ci-dessous */ }
if (!credentials?.supabase_url || !credentials?.anon_key || !credentials?.email || !credentials?.password) {
  fail(`Configuration absente : lancez d'abord setup-claude-credentials.ps1 (fichier attendu : ${join(HOME, "mcp-credentials.json")}).`);
}

async function login() {
  const res = await fetch(`${credentials.supabase_url.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: credentials.anon_key, "content-type": "application/json" },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) fail(`Connexion Supabase refusée (HTTP ${res.status}).`);
  return body;
}

async function api(method, path, accessToken, payload) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const describe = (res) => res.body?.error?.message ?? `HTTP ${res.status}`;

if (command === "create") {
  const label = flag("label");
  const scope = flag("scope") ?? "write";
  if (!label) fail('Indiquez un libellé : create --label "Claude Desktop"');
  if (scope !== "read" && scope !== "write") fail("--scope doit valoir read ou write.");
  const session = await login();
  const res = await api("POST", "/agent-tokens", session.access_token, { refresh_token: session.refresh_token, label, scope });
  if (res.status === 404) fail("Le serveur n'a pas activé les jetons d'agent (clé AGENT_TOKEN_KEY absente).");
  if (res.status !== 201) fail(`Création refusée : ${describe(res)}`);
  console.log("");
  console.log(`Jeton d'agent créé : « ${res.body.label} » (${res.body.scope === "read" ? "lecture seule" : "lecture et écriture"}), identifiant ${res.body.id}`);
  console.log("");
  console.log("  " + res.body.token);
  console.log("");
  console.log("Copiez-le MAINTENANT : il ne sera plus jamais affiché.");
  console.log("Claude Desktop : Customize > Connectors > Add custom connector, URL " + BASE + "/mcp ,");
  console.log("  authentification « No sign-in », Request headers : Authorization = Bearer <le jeton ci-dessus>");
} else if (command === "list") {
  const session = await login();
  const res = await api("GET", "/agent-tokens", session.access_token);
  if (res.status === 404) fail("Le serveur n'a pas activé les jetons d'agent.");
  if (res.status !== 200) fail(`Lecture refusée : ${describe(res)}`);
  if (res.body.tokens.length === 0) console.log("Aucun jeton d'agent.");
  for (const t of res.body.tokens) {
    const used = t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString("fr-FR") : "jamais";
    console.log(`${t.id}  ${t.scope === "read" ? "lecture " : "écriture"}  ${t.status === "active" ? "actif   " : "À RECRÉER"}  créé ${new Date(t.createdAt).toLocaleDateString("fr-FR")}  utilisé : ${used}  « ${t.label} »`);
  }
} else if (command === "revoke") {
  const id = rest[0];
  if (!id) fail("Indiquez l'identifiant : revoke <identifiant> (voir la commande list).");
  const session = await login();
  const res = await api("DELETE", `/agent-tokens/${encodeURIComponent(id)}`, session.access_token);
  if (res.status === 404) fail("Jeton introuvable (identifiant incorrect ou déjà révoqué).");
  if (res.status !== 200) fail(`Révocation refusée : ${describe(res)}`);
  console.log("Jeton révoqué : il est refusé immédiatement.");
} else {
  fail('Usage : agent-token.mjs create --label "Claude Desktop" [--scope write|read] | list | revoke <identifiant>');
}
