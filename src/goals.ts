/**
 * Objectifs du mois, de la semaine et du jour (Story 27-14).
 * Règles de l'application (desktop `GoalsCard.tsx` / `PlannerPanel.tsx`, Android `GoalsCard.kt`) :
 *  - clés de période : jour AAAA-MM-JJ, semaine ISO AAAA-Wnn, mois AAAA-MM ;
 *  - un seul objectif par (utilisateur, type, période) ;
 *  - texte jamais vide ; tri-état : à faire (0,0) · atteint (1,0) · raté (0,1).
 * Aucun outil de suppression (décision de Philippe).
 */
import { randomUUID } from "node:crypto";
import { type ToolContext, todayIn, nowMs, fail } from "./common.js";
import { ToolInputError, checkArgs, optString, optEnum, optDate, optInt } from "./validate.js";

export const GOAL_TYPES = ["day", "week", "month"] as const;
export type GoalType = (typeof GOAL_TYPES)[number];
export const GOAL_STATUSES = ["todo", "achieved", "missed"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const MAX_GOAL_TEXT = 500;
const HISTORY_DEFAULT = 30;
const HISTORY_MAX = 100;

// ─── Règles de l'application (fonctions pures, testées séparément) ────────────

/** Semaine ISO « AAAA-Wnn » d'une date AAAA-MM-JJ (le jeudi de la semaine donne l'année et le numéro). */
export function weekKeyOf(date: string): string {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)));
  const mondayIndex = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(d.getTime() + (3 - mondayIndex) * 86_400_000);
  const year = thursday.getUTCFullYear();
  const dayOfYear = Math.round((thursday.getTime() - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  return `${year}-W${String(Math.ceil(dayOfYear / 7)).padStart(2, "0")}`;
}

/** Clé de période d'un objectif de ce type pour cette date. */
export function periodKeyOf(type: GoalType, date: string): string {
  return type === "day" ? date : type === "week" ? weekKeyOf(date) : date.slice(0, 7);
}

/** Statut → (is_completed, is_missed) ; jamais (true, true). */
export function flagsOf(status: GoalStatus): { is_completed: boolean; is_missed: boolean } {
  return { is_completed: status === "achieved", is_missed: status === "missed" };
}

export function statusOf(row: { is_completed?: unknown; is_missed?: unknown }): GoalStatus {
  return row.is_completed === true ? "achieved" : row.is_missed === true ? "missed" : "todo";
}

// ─── Accès aux données ───────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const present = (r: Row) => ({
  id: r.id, type: r.type, period_key: r.period_key, text: r.text, status: statusOf(r),
});

async function findGoal(ctx: ToolContext, type: GoalType, periodKey: string): Promise<Row | undefined> {
  const { data, error } = await ctx.supabase
    .from("goals")
    .select("id, type, period_key, text, is_completed, is_missed")
    .eq("user_id", ctx.userId).eq("type", type).eq("period_key", periodKey)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) fail("Lecture impossible", error);
  return ((data ?? []) as Row[])[0];
}

// ─── list_goals ──────────────────────────────────────────────────────────────

export async function listGoals(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["date", "type", "limit"]);
  const date = optDate(args, "date");
  const type = optEnum(args, "type", GOAL_TYPES);
  const limit = optInt(args, "limit", 1, HISTORY_MAX);
  if (date !== undefined && type !== undefined) throw new ToolInputError("Indiquez soit « date » (les 3 objectifs de cette date), soit « type » (historique), pas les deux.");
  if (limit !== undefined && type === undefined) throw new ToolInputError("« limit » ne s'utilise qu'avec « type » (historique).");

  if (type) {
    const max = limit ?? HISTORY_DEFAULT;
    const { data, error } = await ctx.supabase
      .from("goals")
      .select("id, type, period_key, text, is_completed, is_missed")
      .eq("user_id", ctx.userId).eq("type", type)
      .order("period_key", { ascending: false })
      .limit(max + 1);
    if (error) fail("Lecture impossible", error);
    const rows = (data ?? []) as Row[];
    const truncated = rows.length > max;
    return JSON.stringify({ type, count: Math.min(rows.length, max), truncated, ...(truncated ? { limit: max } : {}), goals: rows.slice(0, max).map(present) }, null, 2);
  }

  const day = date ?? todayIn(ctx);
  const keys = { day: periodKeyOf("day", day), week: periodKeyOf("week", day), month: periodKeyOf("month", day) };
  const { data, error } = await ctx.supabase
    .from("goals")
    .select("id, type, period_key, text, is_completed, is_missed")
    .eq("user_id", ctx.userId)
    .in("period_key", [keys.day, keys.week, keys.month])
    .order("updated_at", { ascending: false })
    .limit(30);
  if (error) fail("Lecture impossible", error);
  const rows = (data ?? []) as Row[];
  const pick = (t: GoalType) => {
    const hit = rows.find((r) => r.type === t && r.period_key === keys[t]);
    return hit ? present(hit) : null;
  };
  return JSON.stringify({ date: day, period_keys: keys, goals: { day: pick("day"), week: pick("week"), month: pick("month") } }, null, 2);
}

// ─── set_goal ────────────────────────────────────────────────────────────────

export async function setGoal(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["type", "date", "text", "status"]);
  const type = optEnum(args, "type", GOAL_TYPES);
  if (type === undefined || type === null) throw new ToolInputError(`« type » est obligatoire : ${GOAL_TYPES.join(", ")}.`);
  const date = optDate(args, "date") ?? todayIn(ctx);
  const text = optString(args, "text", { min: 1, max: MAX_GOAL_TEXT });
  const status = optEnum(args, "status", GOAL_STATUSES);
  const periodKey = periodKeyOf(type, date);

  const existing = await findGoal(ctx, type, periodKey);
  const now = nowMs(ctx);

  if (!existing) {
    if (text === undefined || text === null || text === "") {
      throw new ToolInputError(`Aucun objectif ${type} pour ${periodKey} : « text » est obligatoire pour le créer.`);
    }
    const row = {
      id: randomUUID(), user_id: ctx.userId, type, period_key: periodKey, text,
      ...flagsOf(status ?? "todo"), created_at: now, updated_at: now,
    };
    const { error } = await ctx.supabase.from("goals").insert(row);
    if (error) fail("Création impossible", error);
    return JSON.stringify({ success: true, created: true, id: row.id, type, period_key: periodKey, text, status: status ?? "todo" }, null, 2);
  }

  const patch: Record<string, unknown> = {};
  if (text !== undefined && text !== null) patch.text = text;
  if (status !== undefined && status !== null) Object.assign(patch, flagsOf(status));
  if (Object.keys(patch).length === 0) throw new ToolInputError("Aucun champ à modifier (text, status).");
  patch.updated_at = now;
  const { data, error } = await ctx.supabase.from("goals").update(patch).eq("id", existing.id as string).eq("user_id", ctx.userId).select("id");
  if (error) fail("Modification impossible", error);
  if (!data || data.length === 0) throw new ToolInputError("Objectif introuvable.");
  const after = { ...existing, ...patch };
  return JSON.stringify({ success: true, created: false, id: existing.id, type, period_key: periodKey, text: after.text, status: statusOf(after) }, null, 2);
}

// ─── Définitions MCP ─────────────────────────────────────────────────────────

const DATE = "^\\d{4}-\\d{2}-\\d{2}$";

export const GOAL_TOOL_DEFINITIONS = [
  {
    name: "list_goals",
    description:
      "Lit les objectifs. Par défaut : ceux du jour, de la semaine (ISO) et du mois d'une date (« date », défaut aujourd'hui), null pour une période sans objectif. Avec « type » (day, week ou month) : l'historique de ce type, période la plus récente d'abord (« limit » 1-100, défaut 30). Statut : todo (à faire), achieved (atteint) ou missed (raté).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        date: { type: "string", pattern: DATE, description: "Jour AAAA-MM-JJ : donne le jour, la semaine et le mois à lire (défaut aujourd'hui). Incompatible avec type." },
        type: { type: "string", enum: [...GOAL_TYPES], description: "Historique des objectifs de ce type" },
        limit: { type: "integer", minimum: 1, maximum: HISTORY_MAX, description: "Nombre maximum d'objectifs de l'historique (défaut 30, avec type)" },
      },
    },
  },
  {
    name: "set_goal",
    description:
      "Crée ou modifie l'objectif d'un jour, d'une semaine ou d'un mois (un seul par période : jamais de doublon). « date » (défaut aujourd'hui) désigne la période : le jour lui-même, sa semaine ISO ou son mois. À la création « text » est obligatoire ; ensuite on peut changer le texte et/ou le statut (todo, achieved, missed). Ne supprime jamais.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: [...GOAL_TYPES], description: "day, week ou month" },
        date: { type: "string", pattern: DATE, description: "Un jour de la période visée AAAA-MM-JJ (défaut aujourd'hui)" },
        text: { type: "string", minLength: 1, maxLength: MAX_GOAL_TEXT, description: "Texte de l'objectif" },
        status: { type: "string", enum: [...GOAL_STATUSES], description: "todo = à faire, achieved = atteint, missed = raté" },
      },
      required: ["type"],
    },
  },
];
