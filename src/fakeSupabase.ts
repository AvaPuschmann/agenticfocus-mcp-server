/**
 * Faux client Supabase en mémoire pour les tests des outils (Stories 25-6 et 27-1).
 * Reproduit ce qui compte pour nos garanties : filtres eq / is / gte / lte / in, tri, limite, insert (doublon refusé),
 * update (renvoie les lignes modifiées avec `.select()`), erreurs injectables, journal des requêtes, et le jeton
 * (`jwt`) avec lequel le client a été créé — pour prouver QUEL jeton part vers Supabase.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type Row = Record<string, unknown>;
type Err = { message: string; code?: string };
type Filter = [col: string, op: "eq" | "is" | "gte" | "lte" | "in", value: unknown];

export interface FakeCall {
  table: string;
  op: "select" | "insert" | "update";
  filters: Filter[];
  order: Array<[string, boolean]>;
  limit?: number;
  payload?: Row;
  jwt: string;
}

export function createFakeStore() {
  const tables: Record<string, Row[]> = {};
  const calls: FakeCall[] = [];
  let nextError: Err | null = null;

  const clone = (r: Row): Row => JSON.parse(JSON.stringify(r)) as Row;
  const matches = (row: Row, filters: Filter[]) =>
    filters.every(([c, op, v]) => {
      const x = row[c] ?? null;
      if (op === "eq") return x === v;
      if (op === "is") return x === v;
      if (op === "gte") return x !== null && (x as string) >= (v as string);
      if (op === "lte") return x !== null && (x as string) <= (v as string);
      return (v as unknown[]).includes(x);
    });

  class Query implements PromiseLike<{ data: Row[] | null; error: Err | null }> {
    private call: FakeCall;
    constructor(private table: string, jwt: string) {
      this.call = { table, op: "select", filters: [], order: [], jwt };
    }
    select(_cols?: string) { return this; }
    eq(c: string, v: unknown) { this.call.filters.push([c, "eq", v]); return this; }
    is(c: string, v: null) { this.call.filters.push([c, "is", v]); return this; }
    gte(c: string, v: unknown) { this.call.filters.push([c, "gte", v]); return this; }
    lte(c: string, v: unknown) { this.call.filters.push([c, "lte", v]); return this; }
    in(c: string, v: unknown[]) { this.call.filters.push([c, "in", v]); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.call.order.push([c, o?.ascending !== false]); return this; }
    limit(n: number) { this.call.limit = n; return this; }
    insert(row: Row) { this.call.op = "insert"; this.call.payload = row; return this; }
    update(values: Row) { this.call.op = "update"; this.call.payload = values; return this; }

    then<R1 = { data: Row[] | null; error: Err | null }, R2 = never>(
      ok?: ((v: { data: Row[] | null; error: Err | null }) => R1 | PromiseLike<R1>) | null,
      ko?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      return this.exec().then(ok, ko);
    }

    private async exec(): Promise<{ data: Row[] | null; error: Err | null }> {
      calls.push({ ...this.call, payload: this.call.payload ? clone(this.call.payload) : undefined });
      if (nextError) {
        const error = nextError;
        nextError = null;
        return { data: null, error };
      }
      const rows = (tables[this.table] ??= []);
      const { op, filters, order, limit, payload } = this.call;

      if (op === "insert") {
        if (rows.some((r) => r.id === payload!.id)) return { data: null, error: { message: "duplicate key", code: "23505" } };
        rows.push(clone(payload!));
        return { data: null, error: null };
      }
      if (op === "update") {
        const hit = rows.filter((r) => matches(r, filters));
        for (const r of hit) Object.assign(r, clone(payload!));
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      let out = rows.filter((r) => matches(r, filters));
      for (const [c, asc] of [...order].reverse()) {
        out = [...out].sort((a, b) => {
          const x = a[c] as never;
          const y = b[c] as never;
          if (x === y) return 0;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          return (x < y ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      if (limit !== undefined) out = out.slice(0, limit);
      return { data: out.map(clone), error: null };
    }
  }

  return {
    tables,
    calls,
    /** Client Supabase « créé avec ce jeton » (comme `createClient(url, key, { global: { headers } })`). */
    clientFor: (jwt: string): SupabaseClient => ({ from: (t: string) => new Query(t, jwt) }) as unknown as SupabaseClient,
    seed: (table: string, rows: Row[]) => { tables[table] = rows.map(clone); },
    failNext: (error: Err) => { nextError = error; },
    reset: () => {
      for (const k of Object.keys(tables)) delete tables[k];
      calls.length = 0;
      nextError = null;
    },
    writes: (table: string) => calls.filter((c) => c.table === table && c.op !== "select"),
    selects: (table: string) => calls.filter((c) => c.table === table && c.op === "select"),
  };
}
