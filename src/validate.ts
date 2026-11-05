/**
 * Validation stricte des arguments d'outils (Story 27-1).
 * Un agent se trompe : mieux vaut une erreur claire qu'une écriture partielle ou déformée.
 * Toute erreur ici est une `ToolInputError` : message lisible renvoyé à l'agent (`isError`), sans détail technique.
 */

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export type Args = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Les arguments doivent être un objet ; chaque clé doit être connue (une faute de frappe est une erreur, pas un oubli). */
export function checkArgs(raw: unknown, allowed: readonly string[]): Args {
  const args = raw === undefined || raw === null ? {} : raw;
  if (typeof args !== "object" || Array.isArray(args)) throw new ToolInputError("Les arguments doivent être un objet JSON.");
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new ToolInputError(`Argument inconnu « ${key} ». Arguments acceptés : ${allowed.join(", ") || "(aucun)"}.`);
    }
  }
  return args as Args;
}

const present = (args: Args, key: string): boolean => Object.prototype.hasOwnProperty.call(args, key) && args[key] !== undefined;

export function optString(args: Args, key: string, opts: { min?: number; max: number; nullable?: boolean }): string | null | undefined {
  if (!present(args, key)) return undefined;
  const v = args[key];
  if (v === null) {
    if (opts.nullable) return null;
    throw new ToolInputError(`« ${key} » ne peut pas être vide (null).`);
  }
  if (typeof v !== "string") throw new ToolInputError(`« ${key} » doit être un texte.`);
  const s = v.trim();
  if (s.length < (opts.min ?? 0)) throw new ToolInputError(`« ${key} » est trop court (minimum ${opts.min ?? 0} caractère).`);
  if (s.length > opts.max) throw new ToolInputError(`« ${key} » est trop long (maximum ${opts.max} caractères).`);
  return s;
}

export function reqString(args: Args, key: string, opts: { min?: number; max: number }): string {
  const v = optString(args, key, { min: 0, max: opts.max });
  if (v === undefined || v === null || v === "") throw new ToolInputError(`« ${key} » est obligatoire.`);
  return v;
}

export function optInt(args: Args, key: string, min: number, max: number): number | undefined {
  if (!present(args, key)) return undefined;
  const v = args[key];
  if (typeof v !== "number" || !Number.isInteger(v)) throw new ToolInputError(`« ${key} » doit être un nombre entier.`);
  if (v < min || v > max) throw new ToolInputError(`« ${key} » doit être entre ${min} et ${max}.`);
  return v;
}

export function optBool(args: Args, key: string): boolean | undefined {
  if (!present(args, key)) return undefined;
  if (typeof args[key] !== "boolean") throw new ToolInputError(`« ${key} » doit être vrai ou faux.`);
  return args[key] as boolean;
}

export function optEnum<T extends string>(args: Args, key: string, values: readonly T[], nullable = false): T | null | undefined {
  if (!present(args, key)) return undefined;
  const v = args[key];
  if (v === null && nullable) return null;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    throw new ToolInputError(`« ${key} » doit valoir : ${values.join(", ")}${nullable ? " (ou null pour effacer)" : ""}.`);
  }
  return v as T;
}

/** Date au format AAAA-MM-JJ, calendrier réel (le 2026-02-30 est refusé). */
export function isIsoDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function optDate(args: Args, key: string, nullable = false): string | null | undefined {
  if (!present(args, key)) return undefined;
  const v = args[key];
  if (v === null && nullable) return null;
  if (typeof v !== "string" || !isIsoDate(v)) throw new ToolInputError(`« ${key} » doit être une date réelle au format AAAA-MM-JJ.`);
  return v;
}

export function reqUuid(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new ToolInputError(`« ${key} » doit être un identifiant (UUID).`);
  return v;
}

export function optUuid(args: Args, key: string, nullable = false): string | null | undefined {
  if (!present(args, key)) return undefined;
  if (args[key] === null && nullable) return null;
  return reqUuid(args, key);
}

/** Nombre de jours entre deux dates AAAA-MM-JJ (inclusif de `from`, exclusif de `to`). */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}
