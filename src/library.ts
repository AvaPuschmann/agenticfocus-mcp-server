/**
 * Outils de la bibliothèque (Story 27-12) : créer et modifier les domaines et leurs activités.
 * Une « activité » de l'écran Bibliothèque est une ligne de `task_templates`. Seules les colonnes réellement
 * synchronisées avec Supabase sont écrites (celles lues par le desktop et par Android) : voir la fiche 27-12.
 * Aucun outil de suppression (décision de Philippe).
 */
import { randomUUID } from "node:crypto";
import { type ToolContext, nowMs, fail, assertOwned } from "./common.js";
import {
  ToolInputError, checkArgs, optString, reqString, optInt, optUuid, reqUuid,
} from "./validate.js";

export const MAX_DOMAIN_NAME = 60;
export const MAX_TITLE = 200;
export const MAX_NOTE = 5000;
export const DEFAULT_COLOR = "#4CAF50"; // première pastille de l'application
const LIST_LIMIT = 200;
const DOMAIN_SCAN_LIMIT = 1000;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

function optColor(args: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(args, "color") || args.color === undefined) return undefined;
  const v = args.color;
  if (typeof v !== "string" || !COLOR_RE.test(v.trim())) {
    throw new ToolInputError("« color » doit être une couleur hexadécimale #RRGGBB (ex. #4CAF50).");
  }
  return v.trim().toUpperCase();
}

/** Nom de domaine déjà pris par un AUTRE domaine de l'utilisateur (casse ignorée) : évite les doublons d'un agent qui réessaie. */
async function assertDomainNameFree(ctx: ToolContext, name: string, exceptId?: string): Promise<void> {
  const { data, error } = await ctx.supabase.from("domains").select("id, name").eq("user_id", ctx.userId).limit(DOMAIN_SCAN_LIMIT);
  if (error) fail("Vérification impossible", error);
  const wanted = name.toLocaleLowerCase("fr");
  const clash = ((data ?? []) as unknown as Array<{ id: string; name: string }>)
    .find((d) => d.id !== exceptId && d.name.toLocaleLowerCase("fr") === wanted);
  if (clash) throw new ToolInputError(`Un domaine « ${clash.name} » existe déjà (id ${clash.id}). Utilisez update_domain pour le modifier.`);
}

const DOMAIN_NOT_FOUND = "Domaine introuvable. Utilisez list_domains pour trouver son identifiant.";
const ACTIVITY_NOT_FOUND = "Activité introuvable. Utilisez list_activities pour trouver son identifiant.";

async function updateOwned(ctx: ToolContext, table: "domains" | "task_templates", id: string, patch: Record<string, unknown>, notFound: string): Promise<void> {
  const { data, error } = await ctx.supabase.from(table).update(patch).eq("id", id).eq("user_id", ctx.userId).select("id");
  if (error) fail("Modification impossible", error);
  // Inconnu OU appartenant à un autre utilisateur : même message (aucune fuite d'existence).
  if (!data || data.length === 0) throw new ToolInputError(notFound);
}

// ─── create_domain / update_domain ───────────────────────────────────────────

export async function createDomain(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["name", "color"]);
  const name = reqString(args, "name", { max: MAX_DOMAIN_NAME });
  const color = optColor(args) ?? DEFAULT_COLOR;
  await assertDomainNameFree(ctx, name);

  const row = { id: randomUUID(), user_id: ctx.userId, name, color, updated_at: nowMs(ctx) };
  const { error } = await ctx.supabase.from("domains").insert(row);
  if (error) fail("Création impossible", error);
  return JSON.stringify({ success: true, id: row.id, name, color, message: `Domaine « ${name} » créé.` }, null, 2);
}

export async function updateDomain(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["id", "name", "color"]);
  const id = reqUuid(args, "id");
  const patch: Record<string, unknown> = {};
  const name = optString(args, "name", { min: 1, max: MAX_DOMAIN_NAME });
  if (name !== undefined && name !== null) {
    await assertDomainNameFree(ctx, name, id);
    patch.name = name;
  }
  const color = optColor(args);
  if (color !== undefined) patch.color = color;
  if (Object.keys(patch).length === 0) throw new ToolInputError("Aucun champ à modifier (name, color).");
  patch.updated_at = nowMs(ctx);
  await updateOwned(ctx, "domains", id, patch, DOMAIN_NOT_FOUND);
  return JSON.stringify({ success: true, id, updated: Object.keys(patch).filter((k) => k !== "updated_at") }, null, 2);
}

// ─── list_activities ─────────────────────────────────────────────────────────

export async function listActivities(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["domain_id"]);
  const domainId = optUuid(args, "domain_id");
  let query = ctx.supabase
    .from("task_templates")
    .select("id, domain_id, title, note, story_points, default_pomodoros")
    .eq("user_id", ctx.userId);
  if (domainId) query = query.eq("domain_id", domainId);
  const { data, error } = await query.order("domain_id", { ascending: true }).order("title", { ascending: true }).limit(LIST_LIMIT + 1);
  if (error) fail("Lecture impossible", error);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const truncated = rows.length > LIST_LIMIT;
  return JSON.stringify({
    count: Math.min(rows.length, LIST_LIMIT), truncated, ...(truncated ? { limit: LIST_LIMIT } : {}),
    activities: rows.slice(0, LIST_LIMIT),
  }, null, 2);
}

// ─── create_activity / update_activity ───────────────────────────────────────

export async function createActivity(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["domain_id", "title", "note", "story_points", "default_pomodoros"]);
  const domainId = reqUuid(args, "domain_id");
  const title = reqString(args, "title", { max: MAX_TITLE });
  const note = optString(args, "note", { max: MAX_NOTE, nullable: true });
  await assertOwned(ctx, "domains", domainId, "Utilisez list_domains (create_domain pour en créer un).");

  const row = {
    id: randomUUID(),
    user_id: ctx.userId,
    domain_id: domainId,
    title,
    note: note || null,
    story_points: optInt(args, "story_points", 0, 999) ?? 1,
    default_pomodoros: optInt(args, "default_pomodoros", 0, 99) ?? 1,
    updated_at: nowMs(ctx),
  };
  const { error } = await ctx.supabase.from("task_templates").insert(row);
  if (error) fail("Création impossible", error);
  return JSON.stringify({
    success: true, id: row.id, domain_id: domainId, title, story_points: row.story_points, default_pomodoros: row.default_pomodoros,
    message: `Activité « ${title} » ajoutée à la bibliothèque.`,
  }, null, 2);
}

export async function updateActivity(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["id", "title", "note", "story_points", "default_pomodoros", "domain_id"]);
  const id = reqUuid(args, "id");
  const patch: Record<string, unknown> = {};
  const title = optString(args, "title", { min: 1, max: MAX_TITLE });
  if (title !== undefined) patch.title = title;
  const note = optString(args, "note", { max: MAX_NOTE, nullable: true });
  if (note !== undefined) patch.note = note || null;
  const points = optInt(args, "story_points", 0, 999);
  if (points !== undefined) patch.story_points = points;
  const pomos = optInt(args, "default_pomodoros", 0, 99);
  if (pomos !== undefined) patch.default_pomodoros = pomos;
  const domainId = optUuid(args, "domain_id");
  if (domainId !== undefined && domainId !== null) {
    await assertOwned(ctx, "domains", domainId, "Utilisez list_domains.");
    patch.domain_id = domainId;
  }
  if (Object.keys(patch).length === 0) throw new ToolInputError("Aucun champ à modifier.");
  patch.updated_at = nowMs(ctx);
  await updateOwned(ctx, "task_templates", id, patch, ACTIVITY_NOT_FOUND);
  return JSON.stringify({ success: true, id, updated: Object.keys(patch).filter((k) => k !== "updated_at") }, null, 2);
}

// ─── Définitions MCP ─────────────────────────────────────────────────────────

const COLOR_SCHEMA = { type: "string", pattern: "^#[0-9A-Fa-f]{6}$", description: `Couleur hexadécimale #RRGGBB (défaut ${DEFAULT_COLOR})` };

export const LIBRARY_TOOL_DEFINITIONS = [
  {
    name: "create_domain",
    description:
      "Crée un domaine de vie dans la bibliothèque (Sport, Pro…) avec une couleur. Un nom déjà utilisé (casse ignorée) est refusé. Renvoie son identifiant, à utiliser dans create_activity, create_day_task, create_project.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: MAX_DOMAIN_NAME, description: "Nom du domaine" },
        color: COLOR_SCHEMA,
      },
      required: ["name"],
    },
  },
  {
    name: "update_domain",
    description: "Renomme un domaine et/ou change sa couleur (par id). Seuls les champs fournis changent. Ne supprime pas le domaine.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Identifiant du domaine (list_domains)" },
        name: { type: "string", minLength: 1, maxLength: MAX_DOMAIN_NAME },
        color: COLOR_SCHEMA,
      },
      required: ["id"],
    },
  },
  {
    name: "list_activities",
    description:
      "Liste les activités de la bibliothèque (modèles de tâches rattachés à un domaine : titre, note, points, pomodoros par défaut), éventuellement pour un seul domaine. Limité à 200 : « truncated » vaut true s'il y en a davantage.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { domain_id: { type: "string", description: "Ne lister que les activités de ce domaine (list_domains)" } },
    },
  },
  {
    name: "create_activity",
    description:
      "Ajoute une activité (modèle de tâche réutilisable) à un domaine de la bibliothèque. Points et pomodoros par défaut : 1 chacun, comme dans l'application. Renvoie son identifiant.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        domain_id: { type: "string", description: "Identifiant du domaine (list_domains)" },
        title: { type: "string", minLength: 1, maxLength: MAX_TITLE, description: "Titre de l'activité" },
        note: { type: ["string", "null"], maxLength: MAX_NOTE, description: "Note libre" },
        story_points: { type: "integer", minimum: 0, maximum: 999, description: "Points de valeur (défaut 1)" },
        default_pomodoros: { type: "integer", minimum: 0, maximum: 99, description: "Pomodoros par défaut (défaut 1)" },
      },
      required: ["domain_id", "title"],
    },
  },
  {
    name: "update_activity",
    description:
      "Modifie une activité de la bibliothèque (par id) : titre, note (null l'efface), points, pomodoros par défaut, ou domaine (pour la déplacer). Seuls les champs fournis changent. Ne supprime pas l'activité.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Identifiant de l'activité (list_activities)" },
        title: { type: "string", minLength: 1, maxLength: MAX_TITLE },
        note: { type: ["string", "null"], maxLength: MAX_NOTE },
        story_points: { type: "integer", minimum: 0, maximum: 999 },
        default_pomodoros: { type: "integer", minimum: 0, maximum: 99 },
        domain_id: { type: "string", description: "Déplace l'activité vers ce domaine" },
      },
      required: ["id"],
    },
  },
];
