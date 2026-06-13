#!/usr/bin/env bash
# E2E MCP — Story 25-5. À lancer SUR le VPS (le conteneur agenticfocus-mcp doit tourner).
# Prouve la chaîne complète : sign-in Supabase → JWT → handshake MCP → tools/call
# create_day_task → la tâche atterrit dans Supabase (RLS user-scoped) → sync app.
#
# Usage : bash e2e-test.sh
set -uo pipefail

ENV_FILE="$HOME/agenticfocus-mcp/.env"
ANON=$(grep '^SUPABASE_ANON_KEY=' "$ENV_FILE" | cut -d= -f2-)
SUPA=$(grep '^SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2-)
MCP_IP=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$v.IPAddress}} {{end}}' agenticfocus-mcp | awk '{print $1}')
BASE="http://${MCP_IP}:3000"

echo "MCP @ ${BASE}   |   Supabase @ ${SUPA}"
[ -z "$MCP_IP" ] && { echo "❌ conteneur agenticfocus-mcp introuvable (docker ps ?)"; exit 1; }

read -rp "Email Supabase : " EMAIL
read -rsp "Mot de passe   : " PW; echo

echo; echo "== 1. Sign-in Supabase → JWT utilisateur =="
SIGNIN=$(curl -sS "${SUPA}/auth/v1/token?grant_type=password" \
  -H "apikey: ${ANON}" -H "Content-Type: application/json" \
  -d "{\"email\":\"${EMAIL}\",\"password\":\"${PW}\"}")
JWT=$(printf '%s' "$SIGNIN" | grep -oE '"access_token":"[^"]+"' | head -1 | cut -d'"' -f4)
if [ -z "$JWT" ]; then
  echo "❌ Pas de JWT. Réponse Supabase :"; printf '%s' "$SIGNIN" | head -c 400; echo
  echo "→ (si tu te connectes via Google et non mot de passe, dis-le moi : on prendra le JWT depuis l'app)"
  exit 1
fi
echo "✅ JWT obtenu (longueur ${#JWT})"

A=(-H "Authorization: Bearer ${JWT}" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")

echo; echo "== 2. initialize → session MCP =="
INIT=$(curl -sS -D /tmp/mcp_h "${BASE}/mcp" "${A[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e-curl","version":"1.0"}}}')
SID=$(grep -i '^mcp-session-id:' /tmp/mcp_h | tr -d '\r' | awk '{print $2}')
if [ -z "$SID" ]; then
  echo "❌ Pas de session (auth refusée ?). Headers + corps :"; cat /tmp/mcp_h | head -5; printf '%s' "$INIT" | head -c 400; echo
  echo "→ Si 401 : le token user n'est peut-être pas signé en HS256 (nouvelles JWT Signing Keys). On ajustera."
  exit 1
fi
echo "✅ session = ${SID}"

echo; echo "== 3. notifications/initialized =="
curl -sS "${BASE}/mcp" "${A[@]}" -H "mcp-session-id: ${SID}" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null

echo; echo "== 4. tools/list (preuve auth + connexion) =="
curl -sS "${BASE}/mcp" "${A[@]}" -H "mcp-session-id: ${SID}" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -oE '"name":"[^"]+"' || echo "(parse SSE — voir brut)"

echo; echo "== 5. tools/call create_day_task =="
curl -sS "${BASE}/mcp" "${A[@]}" -H "mcp-session-id: ${SID}" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_day_task","arguments":{"name":"✅ Test MCP prod (E2E)","planned_pomodoros":2}}}' \
  | sed 's/^data: //' | tail -c 700; echo

echo; echo "== 6. list_today_tasks (re-lecture pour confirmer) =="
curl -sS "${BASE}/mcp" "${A[@]}" -H "mcp-session-id: ${SID}" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_today_tasks","arguments":{}}}' \
  | sed 's/^data: //' | grep -oE 'Test MCP prod[^"]*' | head -1 && echo "✅ la tâche est bien listée côté serveur"

echo; echo "🎯 Terminé — ouvre ton app AgenticFocus : la tâche « ✅ Test MCP prod (E2E) » doit apparaître pour aujourd'hui."
