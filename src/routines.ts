/**
 * Lecture des routines du matin et du soir (Story 27-13). Lecture seule : aucun outil d'écriture ni de suppression.
 * Les éléments d'une routine sont une copie figée (snapshot) de l'activité de la Bibliothèque au moment de l'ajout.
 */
import { type ToolContext, fail } from "./common.js";
import { checkArgs, optBool, optEnum } from "./validate.js";

export const ROUTINE_TYPES = ["morning", "evening"] as const;
const ITEM_LIMIT = 1000;
const ROUTINE_LIMIT = 50; // l'application en limite le nombre (V1 : 2) ; borne de sécurité

type Row = Record<string, unknown>;

export async function listRoutines(raw: unknown, ctx: ToolContext): Promise<string> {
  const args = checkArgs(raw, ["type", "include_inactive"]);
  const type = optEnum(args, "type", ROUTINE_TYPES);
  const includeInactive = optBool(args, "include_inactive") ?? true;

  let rq = ctx.supabase
    .from("routines")
    .select("id, type, name, trigger_time, is_active, streak_count, streak_last_completed_date, last_injected_date")
    .eq("user_id", ctx.userId);
  if (type) rq = rq.eq("type", type);
  if (!includeInactive) rq = rq.eq("is_active", true);
  const { data: routineRows, error: routineError } = await rq.order("trigger_time", { ascending: true }).limit(ROUTINE_LIMIT);
  if (routineError) fail("Lecture impossible", routineError);
  const routines = (routineRows ?? []) as Row[];
  if (routines.length === 0) return JSON.stringify({ count: 0, truncated: false, routines: [] }, null, 2);

  const { data: itemRows, error: itemError } = await ctx.supabase
    .from("routine_items")
    .select("id, routine_id, template_id, snapshot_title, snapshot_domain_id, snapshot_story_points, override_pomodoros, is_check_only, position")
    .eq("user_id", ctx.userId)
    .in("routine_id", routines.map((r) => r.id))
    .order("position", { ascending: true })
    .limit(ITEM_LIMIT + 1);
  if (itemError) fail("Lecture impossible", itemError);
  const allItems = (itemRows ?? []) as Row[];
  const truncated = allItems.length > ITEM_LIMIT;
  const items = truncated ? allItems.slice(0, ITEM_LIMIT) : allItems;

  // Noms de domaine et pomodoros par défaut des activités liées (une requête chacune, seulement si nécessaire).
  const domainIds = [...new Set(items.map((i) => i.snapshot_domain_id).filter((v): v is string => typeof v === "string"))];
  const templateIds = [...new Set(items.map((i) => i.template_id).filter((v): v is string => typeof v === "string"))];
  const domainNames = new Map<string, string>();
  const templateDefaults = new Map<string, number>();
  if (domainIds.length > 0) {
    const { data, error } = await ctx.supabase.from("domains").select("id, name").eq("user_id", ctx.userId).in("id", domainIds);
    if (error) fail("Lecture impossible", error);
    for (const d of (data ?? []) as Row[]) domainNames.set(d.id as string, d.name as string);
  }
  if (templateIds.length > 0) {
    const { data, error } = await ctx.supabase.from("task_templates").select("id, default_pomodoros").eq("user_id", ctx.userId).in("id", templateIds);
    if (error) fail("Lecture impossible", error);
    for (const t of (data ?? []) as Row[]) if (typeof t.default_pomodoros === "number") templateDefaults.set(t.id as string, t.default_pomodoros);
  }

  const out = routines.map((r) => {
    const mine = items.filter((i) => i.routine_id === r.id).map((i) => {
      const override = typeof i.override_pomodoros === "number" ? i.override_pomodoros : null;
      const fallback = typeof i.template_id === "string" ? templateDefaults.get(i.template_id) ?? null : null;
      const domainId = typeof i.snapshot_domain_id === "string" ? i.snapshot_domain_id : null;
      return {
        id: i.id,
        position: i.position,
        title: i.snapshot_title,
        domain_id: domainId,
        domain_name: domainId ? domainNames.get(domainId) ?? null : null,
        story_points: i.snapshot_story_points,
        override_pomodoros: override,
        pomodoros: override ?? fallback,
        is_check_only: i.is_check_only === true,
        template_id: i.template_id ?? null,
      };
    });
    return {
      id: r.id,
      type: r.type,
      name: r.name,
      trigger_time: r.trigger_time,
      is_active: r.is_active === true,
      streak_count: r.streak_count ?? 0,
      streak_last_completed_date: r.streak_last_completed_date ?? null,
      last_injected_date: r.last_injected_date ?? null,
      item_count: mine.length,
      items: mine,
    };
  });

  return JSON.stringify({ count: out.length, truncated, ...(truncated ? { item_limit: ITEM_LIMIT } : {}), routines: out }, null, 2);
}

// ─── Définition MCP ──────────────────────────────────────────────────────────

export const ROUTINE_TOOL_DEFINITIONS = [
  {
    name: "list_routines",
    description:
      "Lit les routines de l'utilisateur (matin / soir) avec leurs éléments dans l'ordre : heure de déclenchement, active ou non, série en cours, et pour chaque élément titre, domaine, points, pomodoros (surcharge, sinon valeur par défaut de l'activité) et indicateur « simple case à cocher ». Lecture seule. Limité à 1 000 éléments : « truncated » vaut true s'il y en a davantage.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: [...ROUTINE_TYPES], description: "Ne lire que la routine du matin (morning) ou du soir (evening)" },
        include_inactive: { type: "boolean", description: "Inclure les routines désactivées (défaut true)" },
      },
    },
  },
];
