/**
 * Éléments communs aux outils (tâches : `tools.ts`, projets : `projects.ts`) : contexte d'appel, dates,
 * erreurs et vérification des références. Sans dépendance vers les outils eux-mêmes (pas de cycle d'import).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ToolInputError } from "./validate.js";

export interface ToolContext {
  userId: string;
  supabase: SupabaseClient;
  now?: () => Date;
  /** Fuseau de l'utilisateur pour « aujourd'hui » (le serveur tourne en UTC). */
  timeZone?: string;
}

const DEFAULT_TZ = "Europe/Paris";

/** « Aujourd'hui » AAAA-MM-JJ dans le fuseau de l'utilisateur (et non celui du serveur). */
export function todayIn(ctx: Pick<ToolContext, "now" | "timeZone">): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ctx.timeZone ?? DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format((ctx.now ?? (() => new Date()))());
  return parts; // en-CA → AAAA-MM-JJ
}

/** Échéance AAAA-MM-JJ → millisecondes à 12:00 UTC : la même date s'affiche dans tous les fuseaux proches de l'Europe. */
export function dueDateToMs(date: string): number {
  return Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), 12);
}

export const nowMs = (ctx: ToolContext): number => (ctx.now ?? (() => new Date()))().getTime();

export function fail(what: string, error: { message: string; code?: string }): never {
  throw new Error(`${what} : ${error.message}${error.code ? ` (${error.code})` : ""}`);
}

/** Un domaine ou un projet référencé doit exister pour CET utilisateur : message clair plutôt qu'une erreur de clé étrangère. */
export async function assertOwned(ctx: ToolContext, table: "domains" | "projects", id: string, hint: string): Promise<void> {
  const { data, error } = await ctx.supabase.from(table).select("id").eq("user_id", ctx.userId).eq("id", id).limit(1);
  if (error) fail("Vérification impossible", error);
  if (!data || data.length === 0) throw new ToolInputError(`${table === "domains" ? "domain_id" : "project_id"} inconnu. ${hint}`);
}
