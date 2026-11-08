/**
 * Outils MCP d'AgenticFocus (Stories 27-1 et 25-6).
 *
 * Règles :
 *  - le client Supabase est celui DE LA REQUÊTE (jeton frais, RLS de l'utilisateur) : voir `index.ts` ;
 *  - `user_id` vient toujours du jeton, jamais de l'agent ;
 *  - AUCUN outil de suppression (décision de Philippe, 2026-11-05) : un agent ne détruit pas de données ;
 *  - aucune troncature silencieuse : les listes bornées indiquent `truncated`.
 */
import { randomUUID } from "node:crypto";
import {
  ToolInputError, checkArgs, optString, reqString, optInt, optBool, optEnum, optDate, reqUuid, optUuid, daysBetween,
  type Args,
} from "./validate.js";

import { type ToolContext, todayIn, dueDateToMs, nowMs, fail, assertOwned } from "./common.js";
import {
  createProject, updateProject, moveProject, archiveProject, PROJECT_TOOL_DEFINITIONS,
} from "./projects.js";
import {
  createDomain, updateDomain, listActivities, createActivity, updateActivity, LIBRARY_TOOL_DEFINITIONS,
} from "./library.js";
import { listRoutines, ROUTINE_TOOL_DEFINITIONS } from "./routines.js";

export { ToolInputError, todayIn, dueDateToMs };
export type { ToolContext };

export const LIST_LIMIT = 200;
export const MAX_RANGE_DAYS = 62;

const TASK_COLUMNS =
  "id, name, date, planned_pomodoros, completed_pomodoros, is_completed, story_points, impact, urgency, due_date, position, project_id, domain_id, note";

/** Position « en fin de liste » : dernière position du jour (ou du backlog) + 1. */
async function nextPosition(ctx: ToolContext, date: string | null): Promise<number> {
  let q = ctx.supabase.from("day_tasks").select("position").eq("user_id", ctx.userId);
  q = date === null ? q.is("date", null) : q.eq("date", date);
  const { data, error } = await q.order("position", { ascending: false }).limit(1);
  if (error) fail("Lecture de la position impossible", error);
  const last = (data as Array<{ position: number | null }> | null)?.[0]?.position ?? 0;
  return last + 1;
}

// ─── create_day_task ──────────────────────────────────────────────────────────

const CREATE_KEYS = ["name", "date", "backlog", "planned_pomodoros", "story_points", "impact", "urgency", "due_date", "domain_id", "project_id", "note"] as const;

export async function createDayTask(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, CREATE_KEYS);
  const name = reqString(args, "name", { max: 200 });
  const dateArg = optDate(args, "date");
  const backlog = optBool(args, "backlog") === true;
  if (dateArg !== undefined && backlog) throw new ToolInputError("Indiquez soit « date », soit « backlog: true », pas les deux.");
  const date = backlog ? null : dateArg ?? todayIn(ctx);

  const impact = optEnum(args, "impact", ["high", "low"] as const, true);
  const urgency = optEnum(args, "urgency", ["urgent", "not_urgent"] as const, true);
  const dueDate = optDate(args, "due_date", true);
  const domainId = optUuid(args, "domain_id", true);
  const projectId = optUuid(args, "project_id", true);
  const note = optString(args, "note", { max: 5000, nullable: true });
  if (domainId) await assertOwned(ctx, "domains", domainId, "Utilisez list_domains.");
  if (projectId) await assertOwned(ctx, "projects", projectId, "Utilisez list_projects.");

  const now = nowMs(ctx);
  const row = {
    id: randomUUID(),
    user_id: ctx.userId,
    name,
    date,
    planned_pomodoros: optInt(args, "planned_pomodoros", 0, 99) ?? 1,
    completed_pomodoros: 0,
    is_completed: false,
    position: await nextPosition(ctx, date),
    story_points: optInt(args, "story_points", 0, 999) ?? 0,
    impact: impact ?? null,
    urgency: urgency ?? null,
    due_date: dueDate ? dueDateToMs(dueDate) : null,
    project_id: projectId ?? null,
    domain_id: domainId ?? null,
    note: note ?? null,
    created_at: now,
    updated_at: now,
  };

  const { error } = await ctx.supabase.from("day_tasks").insert(row);
  if (error) fail("Création impossible", error);

  return JSON.stringify({
    success: true,
    id: row.id,
    name: row.name,
    date: row.date,
    position: row.position,
    planned_pomodoros: row.planned_pomodoros,
    story_points: row.story_points,
    message: row.date === null
      ? `Tâche « ${name} » ajoutée au backlog.`
      : `Tâche « ${name} » créée pour le ${row.date}.`,
  }, null, 2);
}

// ─── list_tasks / list_today_tasks ────────────────────────────────────────────

const LIST_KEYS = ["date", "from", "to", "backlog", "include_completed"] as const;

export async function listTasks(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, LIST_KEYS);
  const date = optDate(args, "date");
  const from = optDate(args, "from");
  const to = optDate(args, "to");
  const backlog = optBool(args, "backlog") === true;
  const includeCompleted = optBool(args, "include_completed") ?? true;

  const modes = [date !== undefined, from !== undefined || to !== undefined, backlog].filter(Boolean).length;
  if (modes > 1) throw new ToolInputError("Choisissez un seul mode : « date », « from »/« to », ou « backlog: true ».");
  if ((from === undefined) !== (to === undefined)) throw new ToolInputError("« from » et « to » vont ensemble.");
  if (from && to) {
    const span = daysBetween(from, to) + 1;
    if (span < 1) throw new ToolInputError("« to » doit être postérieur ou égal à « from ».");
    if (span > MAX_RANGE_DAYS) throw new ToolInputError(`La plage est limitée à ${MAX_RANGE_DAYS} jours (demandé : ${span}).`);
  }

  let scope: Record<string, unknown>;
  let query = ctx.supabase.from("day_tasks").select(TASK_COLUMNS).eq("user_id", ctx.userId);
  if (backlog) { query = query.is("date", null); scope = { backlog: true }; }
  else if (from && to) { query = query.gte("date", from).lte("date", to); scope = { from, to }; }
  else { const d = date ?? todayIn(ctx); query = query.eq("date", d); scope = { date: d }; }
  if (!includeCompleted) query = query.eq("is_completed", false);

  // LIST_LIMIT + 1 lignes demandées : une de plus que la limite suffit à savoir qu'il y en a d'autres.
  const { data, error } = await query.order("date", { ascending: true }).order("position", { ascending: true }).limit(LIST_LIMIT + 1);
  if (error) fail("Lecture impossible", error);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const truncated = rows.length > LIST_LIMIT;
  const tasks = truncated ? rows.slice(0, LIST_LIMIT) : rows;

  return JSON.stringify({ ...scope, count: tasks.length, truncated, ...(truncated ? { limit: LIST_LIMIT } : {}), tasks }, null, 2);
}

/** Conservé : lit les tâches d'aujourd'hui, avec le nom du projet. */
export async function listTodayTasks(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["include_completed"]);
  const includeCompleted = optBool(args, "include_completed") ?? true;
  const listed = JSON.parse(await listTasks({ include_completed: includeCompleted }, ctx)) as {
    date: string; count: number; truncated: boolean; tasks: Array<Record<string, unknown>>;
  };

  const projectIds = [...new Set(listed.tasks.map((t) => t.project_id).filter((p): p is string => typeof p === "string"))];
  let names = new Map<string, string>();
  if (projectIds.length > 0) {
    const { data } = await ctx.supabase.from("projects").select("id, name").eq("user_id", ctx.userId).in("id", projectIds);
    names = new Map(((data ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]));
  }
  const tasks = listed.tasks.map((t) => ({ ...t, project_name: typeof t.project_id === "string" ? names.get(t.project_id) ?? null : null }));
  return JSON.stringify({ ...listed, tasks }, null, 2);
}

// ─── update_day_task / complete_day_task ──────────────────────────────────────

const UPDATE_KEYS = ["id", "name", "date", "backlog", "planned_pomodoros", "story_points", "impact", "urgency", "due_date", "domain_id", "project_id", "note"] as const;

export async function updateDayTask(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, UPDATE_KEYS);
  const id = reqUuid(args, "id");
  const patch: Record<string, unknown> = {};

  const name = optString(args, "name", { min: 1, max: 200 });
  if (name !== undefined) patch.name = name;
  const pomos = optInt(args, "planned_pomodoros", 0, 99);
  if (pomos !== undefined) patch.planned_pomodoros = pomos;
  const points = optInt(args, "story_points", 0, 999);
  if (points !== undefined) patch.story_points = points;
  const impact = optEnum(args, "impact", ["high", "low"] as const, true);
  if (impact !== undefined) patch.impact = impact;
  const urgency = optEnum(args, "urgency", ["urgent", "not_urgent"] as const, true);
  if (urgency !== undefined) patch.urgency = urgency;
  const due = optDate(args, "due_date", true);
  if (due !== undefined) patch.due_date = due === null ? null : dueDateToMs(due);
  const note = optString(args, "note", { max: 5000, nullable: true });
  if (note !== undefined) patch.note = note;
  const domainId = optUuid(args, "domain_id", true);
  if (domainId !== undefined) {
    if (domainId) await assertOwned(ctx, "domains", domainId, "Utilisez list_domains.");
    patch.domain_id = domainId;
  }
  const projectId = optUuid(args, "project_id", true);
  if (projectId !== undefined) {
    if (projectId) await assertOwned(ctx, "projects", projectId, "Utilisez list_projects.");
    patch.project_id = projectId;
  }

  const dateArg = optDate(args, "date");
  const backlog = optBool(args, "backlog");
  if (dateArg !== undefined && backlog === true) throw new ToolInputError("Indiquez soit « date », soit « backlog: true », pas les deux.");
  if (backlog === false && dateArg === undefined) throw new ToolInputError("« backlog: false » ne suffit pas : indiquez la « date » de destination.");
  if (dateArg !== undefined || backlog === true) {
    const target = backlog === true ? null : dateArg!;
    patch.date = target;
    patch.position = await nextPosition(ctx, target); // déplacée : rangée en fin de liste de destination
  }

  if (Object.keys(patch).length === 0) throw new ToolInputError("Aucun champ à modifier.");
  patch.updated_at = nowMs(ctx);

  const { data, error } = await ctx.supabase.from("day_tasks").update(patch).eq("id", id).eq("user_id", ctx.userId).select("id");
  if (error) fail("Modification impossible", error);
  // Introuvable OU appartenant à un autre utilisateur : même message (aucune fuite d'existence).
  if (!data || data.length === 0) throw new ToolInputError("Tâche introuvable. Utilisez list_tasks pour trouver son identifiant.");

  const changed = Object.keys(patch).filter((k) => k !== "updated_at");
  return JSON.stringify({ success: true, id, updated: changed }, null, 2);
}

export async function completeDayTask(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["id", "completed"]);
  const id = reqUuid(args, "id");
  const completed = optBool(args, "completed") ?? true;
  const { data, error } = await ctx.supabase
    .from("day_tasks").update({ is_completed: completed, updated_at: nowMs(ctx) }).eq("id", id).eq("user_id", ctx.userId).select("id");
  if (error) fail("Modification impossible", error);
  if (!data || data.length === 0) throw new ToolInputError("Tâche introuvable. Utilisez list_tasks pour trouver son identifiant.");
  return JSON.stringify({ success: true, id, is_completed: completed }, null, 2);
}

// ─── list_domains / list_projects ─────────────────────────────────────────────

export async function listDomains(raw: unknown, ctx: ToolContext): Promise<string> {
  checkArgs(raw, []);
  const { data, error } = await ctx.supabase.from("domains").select("id, name, color").eq("user_id", ctx.userId).order("name", { ascending: true }).limit(LIST_LIMIT + 1);
  if (error) fail("Lecture impossible", error);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const truncated = rows.length > LIST_LIMIT;
  return JSON.stringify({ count: Math.min(rows.length, LIST_LIMIT), truncated, domains: rows.slice(0, LIST_LIMIT) }, null, 2);
}

export async function listProjects(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["include_archived", "kanban_status"]);
  const includeArchived = optBool(args, "include_archived") === true;
  const status = optEnum(args, "kanban_status", ["backlog", "todo", "doing", "done"] as const);

  let query = ctx.supabase
    .from("projects")
    .select("id, name, description, kanban_status, kanban_position, target_date, domain_id, is_archived, started_at, finished_at")
    .eq("user_id", ctx.userId)
    .order("kanban_status")
    .order("kanban_position");
  if (!includeArchived) query = query.eq("is_archived", false);
  if (status) query = query.eq("kanban_status", status);

  const { data, error } = await query.limit(LIST_LIMIT + 1);
  if (error) fail("Lecture impossible", error);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const truncated = rows.length > LIST_LIMIT;
  return JSON.stringify({ count: Math.min(rows.length, LIST_LIMIT), truncated, projects: rows.slice(0, LIST_LIMIT) }, null, 2);
}

// ─── Registre ─────────────────────────────────────────────────────────────────

type Handler = (args: unknown, ctx: ToolContext) => Promise<string>;

const HANDLERS: Record<string, Handler> = {
  create_day_task: createDayTask,
  list_tasks: listTasks,
  list_today_tasks: listTodayTasks,
  update_day_task: updateDayTask,
  complete_day_task: completeDayTask,
  list_domains: listDomains,
  list_projects: listProjects,
  create_project: createProject,
  update_project: updateProject,
  move_project: moveProject,
  archive_project: archiveProject,
  create_domain: createDomain,
  update_domain: updateDomain,
  list_activities: listActivities,
  create_activity: createActivity,
  update_activity: updateActivity,
  list_routines: listRoutines,
};

export async function runTool(name: string, args: unknown, ctx: ToolContext): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) throw new ToolInputError(`Outil inconnu : ${name}.`);
  return handler(args, ctx);
}

const DATE_PROP = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const IMPACT = { type: ["string", "null"], enum: ["high", "low", null], description: "Impact : high ou low (null pour effacer)" };
const URGENCY = { type: ["string", "null"], enum: ["urgent", "not_urgent", null], description: "Urgence : urgent ou not_urgent (null pour effacer)" };
const UUID_OR_NULL = { type: ["string", "null"] };

export const TOOL_DEFINITIONS = [
  {
    name: "create_day_task",
    description:
      "Crée une tâche dans le planning de l'utilisateur : pour un jour (date, défaut aujourd'hui) OU dans le backlog (backlog: true). La tâche est rangée en fin de liste. Renvoie son identifiant. Pour lier un domaine ou un projet, trouvez d'abord son identifiant avec list_domains / list_projects.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200, description: "Titre de la tâche" },
        date: { ...DATE_PROP, description: "Jour AAAA-MM-JJ (défaut : aujourd'hui). Incompatible avec backlog." },
        backlog: { type: "boolean", description: "true = tâche sans date (backlog)" },
        planned_pomodoros: { type: "integer", minimum: 0, maximum: 99, description: "Pomodoros prévus, 0 = aucun (défaut 1)" },
        story_points: { type: "integer", minimum: 0, maximum: 999, description: "Points de valeur, comme dans l'application : 0 si non évalué (défaut 0)" },
        impact: IMPACT,
        urgency: URGENCY,
        due_date: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Échéance AAAA-MM-JJ" },
        domain_id: { ...UUID_OR_NULL, description: "Identifiant de domaine (list_domains)" },
        project_id: { ...UUID_OR_NULL, description: "Identifiant de projet (list_projects)" },
        note: { type: ["string", "null"], maxLength: 5000, description: "Note libre" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_tasks",
    description:
      "Liste les tâches : d'un jour (date, défaut aujourd'hui), d'une plage (from + to, 62 jours maximum) ou du backlog (backlog: true). Limité à 200 tâches : « truncated » vaut true s'il y en a davantage.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        date: { ...DATE_PROP, description: "Jour AAAA-MM-JJ" },
        from: { ...DATE_PROP, description: "Début de plage (avec to)" },
        to: { ...DATE_PROP, description: "Fin de plage incluse (avec from)" },
        backlog: { type: "boolean", description: "true = tâches sans date" },
        include_completed: { type: "boolean", description: "Inclure les tâches terminées (défaut true)" },
      },
    },
  },
  {
    name: "list_today_tasks",
    description: "Liste les tâches d'aujourd'hui avec leur avancement et le nom du projet lié.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { include_completed: { type: "boolean", description: "Inclure les tâches terminées (défaut true)" } },
    },
  },
  {
    name: "update_day_task",
    description:
      "Modifie une tâche existante (par id). Seuls les champs fournis changent. Pour la déplacer : date ou backlog: true (elle est rangée en fin de liste de destination). null efface impact, urgency, due_date, note, domain_id, project_id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Identifiant de la tâche (list_tasks)" },
        name: { type: "string", minLength: 1, maxLength: 200 },
        date: { ...DATE_PROP, description: "Déplace la tâche à ce jour" },
        backlog: { type: "boolean", description: "true = déplace la tâche au backlog" },
        planned_pomodoros: { type: "integer", minimum: 0, maximum: 99 },
        story_points: { type: "integer", minimum: 0, maximum: 999 },
        impact: IMPACT,
        urgency: URGENCY,
        due_date: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        domain_id: UUID_OR_NULL,
        project_id: UUID_OR_NULL,
        note: { type: ["string", "null"], maxLength: 5000 },
      },
      required: ["id"],
    },
  },
  {
    name: "complete_day_task",
    description: "Coche (completed: true, défaut) ou décoche (completed: false) une tâche. Ne modifie pas les compteurs de pomodoros.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Identifiant de la tâche (list_tasks)" },
        completed: { type: "boolean", description: "true = terminée (défaut), false = à faire" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_domains",
    description: "Liste les domaines de vie (Sport, Pro…) avec leur identifiant et leur couleur, à utiliser dans create_day_task / update_day_task / create_activity.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "list_projects",
    description: "Liste les projets Kanban (statut backlog/todo/doing/done, position, échéance). Sert à trouver un project_id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        include_archived: { type: "boolean", description: "Inclure les projets archivés (défaut false)" },
        kanban_status: { type: "string", enum: ["backlog", "todo", "doing", "done"], description: "Filtrer par colonne" },
      },
    },
  },
  ...PROJECT_TOOL_DEFINITIONS,
  ...LIBRARY_TOOL_DEFINITIONS,
  ...ROUTINE_TOOL_DEFINITIONS,
];

export type { Args };
