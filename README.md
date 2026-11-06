# AgenticFocus MCP Server

Serveur MCP (Model Context Protocol) qui permet à un agent (Claude, Hermes…) de **lire et d'ajouter des tâches** dans AgenticFocus, avec les droits de l'utilisateur. Version **0.6.0** (Epics 25 et 27).

- **Transport HTTP** (production, multi-utilisateur) : `POST/GET/DELETE /mcp`, `GET /health`.
- **Transport stdio** (Claude Desktop en local, un seul utilisateur, hérité du POC).

## Principe

```
Agent ──Bearer <jeton Supabase de l'utilisateur>──►  MCP  ──même jeton──►  Supabase (RLS)
```

L'agent s'authentifie **comme l'utilisateur** (sa session Supabase). Le serveur vérifie le jeton, puis parle à Supabase avec ce jeton : les règles d'accès (RLS) s'appliquent, l'agent ne voit que les données de l'utilisateur. La clé `service_role` n'est **jamais** utilisée.

## Outils (7)

| Outil | Rôle |
|---|---|
| `create_day_task` | Crée une tâche **pour un jour** (`date`, défaut aujourd'hui) **ou dans le backlog** (`backlog: true`). Options : `planned_pomodoros` (1-99), `story_points` (1-21), `impact` (`high`/`low`), `urgency` (`urgent`/`not_urgent`), `due_date`, `domain_id`, `project_id`, `note`. Rangée **en fin de liste**. |
| `list_tasks` | Lit les tâches d'un jour (`date`), d'une plage (`from` + `to`, 62 jours max) ou du backlog (`backlog: true`). Limité à 200 : `truncated` vaut `true` s'il y en a plus. |
| `list_today_tasks` | Tâches d'aujourd'hui avec avancement et nom du projet. |
| `update_day_task` | Modifie une tâche (`id`) : seuls les champs fournis changent ; `date` / `backlog: true` la déplace (rangée en fin de liste) ; `null` efface impact, urgence, échéance, note, domaine, projet. |
| `complete_day_task` | Coche (`completed: true`, défaut) ou décoche une tâche. Ne touche pas aux compteurs de pomodoros. |
| `list_domains` | Domaines de vie et leurs identifiants (pour `domain_id`). |
| `list_projects` | Projets Kanban et leurs identifiants (pour `project_id`). |

**Garde-fous (décision du 2026-11-05)** : **aucun outil ne supprime** ; les arguments sont validés strictement (un argument inconnu, comme `user_id` ou `title`, est une erreur) ; `user_id` vient toujours du jeton ; une tâche d'un autre utilisateur est « introuvable » (aucune fuite) ; « aujourd'hui » suit le fuseau de l'utilisateur.

## Authentification (HTTP)

Chaque requête porte `Authorization: Bearer <jwt>`, un jeton d'utilisateur Supabase (connexion `signInWithPassword` ou renouvellement `refresh_token`).

1. Signature vérifiée : **ES256/RS256/EdDSA** via le JWKS du projet (`SUPABASE_URL`), ou HS256 via `SUPABASE_JWT_SECRET` (repli).
2. Expiration vérifiée ; `sub` = identifiant de l'utilisateur.
3. **Le jeton de CHAQUE requête est utilisé pour les appels à Supabase** (Story 25-6) : une session ouverte plus d'une heure continue de fonctionner tant que l'agent envoie un jeton valide et renouvelé. Le jeton d'une session ne peut servir qu'à son propriétaire (403 sinon).
4. Jeton absent, falsifié ou expiré : 401, sans accès aux données.

Les jetons durent environ **1 heure** ; le refresh token est **à usage unique** (enregistrer le nouveau à chaque renouvellement). Les sessions MCP sont en mémoire : un redémarrage du serveur impose un nouveau `initialize`.

## Jetons d'agent (Claude Desktop, claude.ai, mobile, Hermes)

Un jeton Supabase dure 1 heure ; Claude Desktop et claude.ai n'acceptent qu'un en-tête **fixe**. Le **jeton d'agent** (`afk_…`) est un secret long, **révocable**, éventuellement **en lecture seule**, qui remplace le jeton d'1 h (et le mot de passe côté Hermes).

- **Créer** (sur votre PC, une fois ; nécessite `~/.agenticfocus/mcp-credentials.json`, créé par `deploy/setup-claude-credentials.ps1`) :
  `node deploy/agent-token.mjs create --label "Claude Desktop" --scope write` (ou `--scope read`) → le jeton est affiché **une seule fois**.
- **Lister / révoquer** : `node deploy/agent-token.mjs list`, `node deploy/agent-token.mjs revoke <identifiant>` (refusé immédiatement).
- **Claude Desktop / claude.ai / mobile** : Customize → Connectors → **Add custom connector**, URL `https://mcp.109-176-198-7.sslip.io/mcp`, authentification **No sign-in**, **Request headers** : `Authorization` = `Bearer afk_…` (la valeur est envoyée telle quelle ; non modifiable ensuite : supprimer et recréer le connecteur). La section Request headers est en bêta (limitée à certaines organisations). Les requêtes partent du cloud d'Anthropic : le serveur doit rester public.
- **Hermes** : variable `AGENTICFOCUS_AGENT_TOKEN=afk_…` (voir `hermes_mcp_client.py`) : plus de mot de passe sur le VPS.
- **Fonctionnement** : le serveur ne garde que l'**empreinte SHA-256** du jeton ; il associe à chaque jeton une **session Supabase dédiée** dont le refresh_token (à usage unique) est **chiffré AES-256-GCM** (clé `AGENT_TOKEN_KEY`) dans un fichier sur un volume (`/data`), renouvelé automatiquement (un seul renouvellement à la fois par jeton, nouveau refresh_token enregistré **avant** usage). La RLS s'applique (jamais `service_role`). Limites : 10 jetons par utilisateur, 120 requêtes par minute et par jeton ; journal d'audit (identifiant du jeton, outil, résultat ; jamais le jeton).
- **Activation** : sans `AGENT_TOKEN_KEY` valide (32 octets en base64, générés par `openssl rand -base64 32`), la fonction est **désactivée** (les jetons utilisateur Supabase fonctionnent toujours). En production : volume + clé, voir `deploy/docker-compose.agent-tokens.yml`.
- Un jeton « à recréer » (session Supabase révoquée, par exemple après un changement de mot de passe) répond 401 avec un message clair : en créer un nouveau.

## Variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `SUPABASE_URL` | oui | URL du projet Supabase |
| `SUPABASE_ANON_KEY` | oui | Clé `anon` (publique par conception) |
| `AGENT_TOKEN_KEY` | non | Clé AES-256 (32 octets base64) : active les jetons d'agent |
| `AGENT_TOKEN_FILE` | non | Fichier des jetons (défaut `/data/agent-tokens.json`, à monter en volume) |
| `AGENT_RATE_LIMIT` | non | Requêtes par minute et par jeton d'agent (défaut 120) |
| `SUPABASE_JWT_SECRET` | HTTP | Secret HS256 (repli ; les jetons ES256 passent par le JWKS) |
| `TRANSPORT` | non | `http` (défaut) ou `stdio` |
| `PORT` | non | Port HTTP (défaut 3000) |
| `USER_TIMEZONE` | non | Fuseau de l'utilisateur pour « aujourd'hui » (défaut `Europe/Paris`) |
| `SUPABASE_USER_JWT`, `USER_ID` | stdio | Mode mono-utilisateur local |

## Développement

```bash
npm install
npm run build          # tsc → dist/
npm test               # vitest : outils, validation, serveur HTTP de bout en bout
npm run dev:http       # serveur local (PORT=3000)
node deploy/e2e-local.mjs   # preuve contre le vrai Supabase avec le compte de test B (build requis)
node deploy/e2e-agent-token.mjs   # idem pour les jetons d'agent (création CLI, portée, redémarrages, révocation)
```

`deploy/e2e-local.mjs` lit les identifiants du compte de test dans `../agenticfocus-desktop/.env.test` (jamais affichés) et supprime ses données à la fin. Il ouvre une session avec un jeton, puis appelle les outils avec un second jeton.

## Utilisation

- **Hermes (Python)** : `_bmad-output/scripts/hermes_mcp_client.py` (connexion et renouvellement automatiques du jeton, rejeu après 401/403/404 de session).
- **Claude** : voir `_bmad-output/implementation-artifacts/27-9-hermes-claude-brancher-le-mcp.md`.
- **Inspecteur MCP** : `npx @modelcontextprotocol/inspector`, transport *Streamable HTTP*, URL `/mcp`, en-tête `Authorization: Bearer <jwt>`.

Exemple d'appel (curl, après `initialize`) :

```bash
curl -X POST https://mcp.109-176-198-7.sslip.io/mcp \
  -H "Authorization: Bearer $JWT" -H "Mcp-Session-Id: $SID" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_day_task","arguments":{"name":"Relire le contrat","backlog":true}}}'
```

## Docker et déploiement

Image multi-étapes Node 22-alpine, utilisateur non-root, `HEALTHCHECK` sur `/health`.

```bash
docker build -t agenticfocus-mcp:0.6.0 .
docker run --rm -p 3000:3000 -e SUPABASE_URL=… -e SUPABASE_ANON_KEY=… -e SUPABASE_JWT_SECRET=… agenticfocus-mcp:0.6.0
```

**Production** : VPS Hostinger, `https://mcp.109-176-198-7.sslip.io`, Traefik en reverse proxy. **Ne pas redéployer depuis `docker-compose.yml` / `deploy/docker-compose.prod.yml` du dépôt sans vérifier le tag d'image** : l'image `ghcr.io/…:0.3.0-jwt` référencée par d'anciens fichiers ne contient pas la vérification ES256. La procédure pas à pas (construction de l'image sur le VPS, annulation) est dans la Story 27-9.

## Limites

- Pas de suppression, ni de sous-tâches, objectifs, routines ou bilans (Epic 27, suite).
- Pas de démarrage de pomodoro (le minuteur est interne aux applications).
- Sessions MCP en mémoire (un redémarrage les invalide).
- Un jeton d'1 heure impose un fournisseur de jeton côté agent (Hermes : module Python fourni).
