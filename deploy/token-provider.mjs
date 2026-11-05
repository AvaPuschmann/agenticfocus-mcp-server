#!/usr/bin/env node
// Fournisseur de jeton pour Claude Code (`headersHelper`) — Story 27-9.
//
// Affiche sur la sortie standard l'en-tête d'authentification du serveur MCP, au format JSON attendu :
//     {"Authorization":"Bearer <jeton Supabase de l'utilisateur>"}
// Le jeton dure environ 1 h : il est mémorisé, renouvelé avec le refresh_token (à usage unique : le NOUVEAU est
// enregistré, écriture atomique), et on se reconnecte par mot de passe si le renouvellement échoue.
//
// Configuration : le fichier  ~/.agenticfocus/mcp-credentials.json  (ou le dossier AGENTICFOCUS_HOME) :
//     { "supabase_url": "https://<projet>.supabase.co", "anon_key": "<clé anon publique>",
//       "email": "<votre e-mail>", "password": "<votre mot de passe>" }
// Ce fichier contient un secret : lecture réservée à vous (Windows : dossier de votre profil), jamais dans git.
// (Les variables d'environnement contenant TOKEN, SECRET, PASSWORD, KEY ou AUTH sont retirées par Claude Code pour un
//  serveur déclaré dans un .mcp.json de projet : d'où un fichier, pas des variables.)
//
// Erreur : message sur la sortie d'erreur, code de sortie 1 (aucun jeton n'est jamais écrit dans les messages d'erreur).
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.AGENTICFOCUS_HOME || join(homedir(), ".agenticfocus");
const CREDENTIALS = join(HOME, "mcp-credentials.json");
const SESSION = join(HOME, "mcp-session.json");
const MARGIN_SECONDS = 120; // renouvelle un peu avant l'expiration

const read = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

const credentials = read(CREDENTIALS);
if (!credentials?.supabase_url || !credentials?.anon_key) {
  console.error(`Fichier de configuration absent ou incomplet : ${CREDENTIALS}`);
  process.exit(1);
}

async function tokenRequest(grantType, body) {
  const res = await fetch(`${credentials.supabase_url.replace(/\/$/, "")}/auth/v1/token?grant_type=${grantType}`, {
    method: "POST",
    headers: { apikey: credentials.anon_key, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000), // Claude Code abandonne le fournisseur après 10 s
  });
  let json = null;
  try { json = await res.json(); } catch { /* corps vide */ }
  return { ok: res.ok && !!json?.access_token, status: res.status, json };
}

function save(session) {
  const state = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600),
  };
  mkdirSync(HOME, { recursive: true });
  const tmp = SESSION + ".tmp";
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* sans effet sous Windows */ }
  renameSync(tmp, SESSION); // remplacement atomique : jamais de fichier à moitié écrit
  return state;
}

async function accessToken() {
  const state = read(SESSION);
  if (state?.access_token && (state.expires_at ?? 0) - Date.now() / 1000 > MARGIN_SECONDS) return state.access_token;

  if (state?.refresh_token) {
    const renewed = await tokenRequest("refresh_token", { refresh_token: state.refresh_token });
    if (renewed.ok) return save(renewed.json).access_token;
  }
  if (!credentials.email || !credentials.password) throw new Error("Renouvellement impossible et e-mail / mot de passe absents du fichier de configuration.");
  const login = await tokenRequest("password", { email: credentials.email, password: credentials.password });
  if (!login.ok) throw new Error(`Connexion Supabase refusée (HTTP ${login.status}).`);
  return save(login.json).access_token;
}

try {
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${await accessToken()}` }));
} catch (err) {
  console.error(String(err.message || err));
  process.exit(1);
}
