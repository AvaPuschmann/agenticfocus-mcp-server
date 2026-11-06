/**
 * Outils de projets (Story 27-11) : créer, modifier, déplacer et archiver un projet du tableau Kanban.
 * Les règles de rangement (pas de 1024) et de dates de début / fin reproduisent celles de l'application
 * (`projectStore.ts` du desktop) pour que les projets créés par un agent se comportent comme les autres.
 * Aucun outil de suppression (décision de Philippe).
 */
import { randomUUID } from "node:crypto";
import { type ToolContext, nowMs, dueDateToMs, fail, assertOwned } from "./common.js";
import {
  ToolInputError, checkArgs, optString, reqString, optBool, optEnum, optDate, reqUuid, optUuid,
} from "./validate.js";

export const KANBAN_STATUSES = ["backlog", "todo", "doing", "done"] as const;
export type KanbanStatus = (typeof KANBAN_STATUSES)[number];

export const POSITION_STEP = 1024;
export const MAX_NAME = 120;
export const MAX_DESCRIPTION = 5000;
const COLUMN_LIMIT = 1000;

// ─── Règles de l'application (fonctions pures, testées séparément) ────────────

/** Position d'un projet inséré entre deux voisins ; écart trop faible → retombée « après le suivant + 1024 ». */
export function insertBetween(before: number, after: number): number {
  const mid = (before + after) / 2;
  if (mid - before < 1 || after - mid < 1) return after + POSITION_STEP;
  return mid;
}

/** Fin de colonne : plus grande position + 1024 (0 + 1024 si la colonne est vide). */
export function endPosition(positions: number[]): number {
  return positions.reduce((max, p) => Math.max(max, p), 0) + POSITION_STEP;
}

export interface Lifecycle {
  started_at: number | null;
  finished_at: number | null;
}

/** Dates d'un projet CRÉÉ directement dans une colonne. */
export function creationLifecycle(status: KanbanStatus, now: number): Lifecycle {
  return { started_at: status !== "backlog" ? now : null, finished_at: status === "done" ? now : null };
}

/** Dates après un déplacement de colonne (règles de l'application : début, fin, réouverture, retour au backlog). */
export function transitionLifecycle(old: KanbanStatus, next: KanbanStatus, current: Lifecycle, now: number): Lifecycle {
  let started = current.started_at;
  let finished = current.finished_at;
  if (next === "todo" && old === "backlog" && !started) started = now;
  if (next !== "backlog" && !started) started = now;
  if (next === "done" && old !== "done") finished = now;
  if (old === "done" && next !== "done") finished = null;
  if (next === "backlog" && old !== "backlog") {
    started = null;
    finished = null;
  }
  return { started_at: started, finished_at: finished };
}

// ─── Accès aux données ───────────────────────────────────────────────────────

interface Neighbor {
  id: string;
  kanban_position: number;
}

/** Projets actifs (non archivés) d'une colonne, par position croissante. */
async function activeColumn(ctx: ToolContext, status: KanbanStatus): Promise<Neighbor[]> {
  const { data, error } = await ctx.supabase
    .from("projects")
    .select("id, kanban_position")
    .eq("user_id", ctx.userId)
    .eq("kanban_status", status)
    .eq("is_archived", false)
    .order("kanban_position", { ascending: true })
    .limit(COLUMN_LIMIT);
  if (error) fail("Lecture de la colonne impossible", error);
  return (data ?? []) as unknown as Neighbor[];
}

const NOT_FOUND = "Projet introuvable. Utilisez list_projects pour trouver son identifiant.";

async function updateOwned(ctx: ToolContext, id: string, patch: Record<string, unknown>): Promise<void> {
  const { data, error } = await ctx.supabase.from("projects").update(patch).eq("id", id).eq("user_id", ctx.userId).select("id");
  if (error) fail("Modification impossible", error);
  // Inconnu OU appartenant à un autre utilisateur : même message (aucune fuite d'existence).
  if (!data || data.length === 0) throw new ToolInputError(NOT_FOUND);
}

// ─── create_project ──────────────────────────────────────────────────────────

export async function createProject(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["name", "description", "kanban_status", "target_date", "domain_id"]);
  const name = reqString(args, "name", { max: MAX_NAME });
  const description = optString(args, "description", { max: MAX_DESCRIPTION, nullable: true });
  const status = optEnum(args, "kanban_status", KANBAN_STATUSES) ?? "backlog";
  const target = optDate(args, "target_date", true);
  const domainId = optUuid(args, "domain_id", true);
  if (domainId) await assertOwned(ctx, "domains", domainId, "Utilisez list_domains.");

  const column = await activeColumn(ctx, status);
  const now = nowMs(ctx);
  const row = {
    id: randomUUID(),
    user_id: ctx.userId,
    name,
    description: description || null,
    kanban_status: status,
    kanban_position: endPosition(column.map((p) => p.kanban_position)),
    target_date: target ? dueDateToMs(target) : null,
    domain_id: domainId ?? null,
    is_archived: false,
    tag_ids: [] as string[],
    ...creationLifecycle(status, now),
    created_at: now,
    updated_at: now,
  };
  const { error } = await ctx.supabase.from("projects").insert(row);
  if (error) fail("Création impossible", error);

  return JSON.stringify({
    success: true,
    id: row.id,
    name: row.name,
    kanban_status: row.kanban_status,
    kanban_position: row.kanban_position,
    target_date: row.target_date,
    message: `Projet « ${name} » créé dans la colonne ${status}.`,
  }, null, 2);
}

// ─── update_project ──────────────────────────────────────────────────────────

export async function updateProject(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["id", "name", "description", "target_date", "domain_id"]);
  const id = reqUuid(args, "id");
  const patch: Record<string, unknown> = {};

  const name = optString(args, "name", { min: 1, max: MAX_NAME });
  if (name !== undefined) patch.name = name;
  const description = optString(args, "description", { max: MAX_DESCRIPTION, nullable: true });
  if (description !== undefined) patch.description = description || null;
  const target = optDate(args, "target_date", true);
  if (target !== undefined) patch.target_date = target === null ? null : dueDateToMs(target);
  const domainId = optUuid(args, "domain_id", true);
  if (domainId !== undefined) {
    if (domainId) await assertOwned(ctx, "domains", domainId, "Utilisez list_domains.");
    patch.domain_id = domainId;
  }

  if (Object.keys(patch).length === 0) {
    throw new ToolInputError("Aucun champ à modifier (la colonne se change avec move_project, l'archivage avec archive_project).");
  }
  patch.updated_at = nowMs(ctx);
  await updateOwned(ctx, id, patch);
  return JSON.stringify({ success: true, id, updated: Object.keys(patch).filter((k) => k !== "updated_at") }, null, 2);
}

// ─── move_project ────────────────────────────────────────────────────────────

export async function moveProject(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["id", "kanban_status", "below_project_id", "above_project_id"]);
  const id = reqUuid(args, "id");
  const status = optEnum(args, "kanban_status", KANBAN_STATUSES);
  if (status === undefined || status === null) throw new ToolInputError(`« kanban_status » est obligatoire : ${KANBAN_STATUSES.join(", ")}.`);
  const below = optUuid(args, "below_project_id");
  const above = optUuid(args, "above_project_id");
  if (below && above) throw new ToolInputError("Indiquez below_project_id OU above_project_id, pas les deux.");
  if (below === id || above === id) throw new ToolInputError("Un projet ne peut pas être placé par rapport à lui-même.");

  const { data, error } = await ctx.supabase
    .from("projects")
    .select("id, kanban_status, started_at, finished_at")
    .eq("id", id)
    .eq("user_id", ctx.userId)
    .limit(1);
  if (error) fail("Lecture du projet impossible", error);
  const project = (data ?? [])[0] as unknown as { kanban_status: KanbanStatus; started_at: number | null; finished_at: number | null } | undefined;
  if (!project) throw new ToolInputError(NOT_FOUND);

  // Colonne de destination SANS le projet déplacé (réordonner dans la même colonne est permis).
  const column = (await activeColumn(ctx, status)).filter((p) => p.id !== id);
  let position: number;
  if (below || above) {
    const neighborId = (below ?? above)!;
    const index = column.findIndex((p) => p.id === neighborId);
    if (index < 0) throw new ToolInputError(`${below ? "below_project_id" : "above_project_id"} doit être un projet non archivé de la colonne ${status}.`);
    if (below) {
      const next = column[index + 1];
      position = next ? insertBetween(column[index].kanban_position, next.kanban_position) : column[index].kanban_position + POSITION_STEP;
    } else {
      const previous = column[index - 1];
      position = insertBetween(previous ? previous.kanban_position : 0, column[index].kanban_position);
    }
  } else {
    position = endPosition(column.map((p) => p.kanban_position));
  }

  const now = nowMs(ctx);
  const life = transitionLifecycle(project.kanban_status, status, { started_at: project.started_at, finished_at: project.finished_at }, now);
  await updateOwned(ctx, id, { kanban_status: status, kanban_position: position, ...life, updated_at: now });
  return JSON.stringify({ success: true, id, kanban_status: status, kanban_position: position }, null, 2);
}

// ─── archive_project ─────────────────────────────────────────────────────────

export async function archiveProject(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["id", "archived"]);
  const id = reqUuid(args, "id");
  const archived = optBool(args, "archived") ?? true;
  await updateOwned(ctx, id, { is_archived: archived, updated_at: nowMs(ctx) });
  return JSON.stringify({ success: true, id, is_archived: archived }, null, 2);
}

// ─── Définitions MCP ─────────────────────────────────────────────────────────

const STATUS_SCHEMA = {
  type: "string",
  enum: [...KANBAN_STATUSES],
  description: "Colonne du tableau Kanban : backlog (idée), todo (prévu), doing (en cours), done (terminé)",
};
const DATE = "^\\d{4}-\\d{2}-\\d{2}$";

export const PROJECT_TOOL_DEFINITIONS = [
  {
    name: "create_project",
    description:
      "Crée un projet dans le tableau Kanban, rangé en fin de la colonne choisie (backlog par défaut). Renvoie son identifiant, à utiliser dans create_day_task / update_day_task (project_id) pour y rattacher des tâches.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: MAX_NAME, description: "Nom du projet" },
        description: { type: ["string", "null"], maxLength: MAX_DESCRIPTION, description: "Description libre" },
        kanban_status: { ...STATUS_SCHEMA, description: STATUS_SCHEMA.description + " (défaut : backlog)" },
        target_date: { type: ["string", "null"], pattern: DATE, description: "Échéance AAAA-MM-JJ" },
        domain_id: { type: ["string", "null"], description: "Identifiant de domaine (list_domains)" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_project",
    description:
      "Modifie le nom, la description, l'échéance ou le domaine d'un projet (par id). Seuls les champs fournis changent ; null efface description, échéance ou domaine. Ne change ni la colonne (move_project) ni l'archivage (archive_project).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Identifiant du projet (list_projects)" },
        name: { type: "string", minLength: 1, maxLength: MAX_NAME },
        description: { type: ["string", "null"], maxLength: MAX_DESCRIPTION },
        target_date: { type: ["string", "null"], pattern: DATE },
        domain_id: { type: ["string", "null"] },
      },
      required: ["id"],
    },
  },
  {
    name: "move_project",
    description:
      "Déplace un projet vers une colonne du Kanban (ou le réordonne dans sa colonne). Sans voisin, il va en fin de colonne ; sinon indiquez below_project_id (juste sous ce projet) OU above_project_id (juste au-dessus). Les dates de début et de fin du projet sont mises à jour comme dans l'application.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Identifiant du projet (list_projects)" },
        kanban_status: STATUS_SCHEMA,
        below_project_id: { type: "string", description: "Placer le projet juste sous ce projet (de la colonne de destination)" },
        above_project_id: { type: "string", description: "Placer le projet juste au-dessus de ce projet (de la colonne de destination)" },
      },
      required: ["id", "kanban_status"],
    },
  },
  {
    name: "archive_project",
    description: "Archive un projet (archived: true, défaut) ou le désarchive (archived: false). Un projet archivé disparaît du tableau mais n'est pas supprimé.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Identifiant du projet (list_projects)" },
        archived: { type: "boolean", description: "true = archiver (défaut), false = désarchiver" },
      },
      required: ["id"],
    },
  },
];
