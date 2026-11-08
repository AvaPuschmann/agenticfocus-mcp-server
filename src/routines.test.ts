/**
 * Tests de list_routines — Story 27-13 (lecture seule).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createFakeStore } from "./fakeSupabase.js";
import { runTool, TOOL_DEFINITIONS, type ToolContext } from "./tools.js";
import { WRITE_TOOLS } from "./server.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const R_MORNING = "rrrrrrrr-rrrr-4rrr-8rrr-000000000001";
const R_EVENING = "rrrrrrrr-rrrr-4rrr-8rrr-000000000002";
const R_OTHER = "rrrrrrrr-rrrr-4rrr-8rrr-000000000099";
const DOM = "dddddddd-dddd-4ddd-8ddd-000000000001";
const DOM_GONE = "dddddddd-dddd-4ddd-8ddd-0000000000ff";
const TPL = "tttttttt-tttt-4ttt-8ttt-000000000001";
const I = (n: number) => `iiiiiiii-iiii-4iii-8iii-${String(n).padStart(12, "0")}`;

const store = createFakeStore();
const ctx = (): ToolContext => ({ userId: ME, supabase: store.clientFor("jwt-A"), timeZone: "Europe/Paris" });
const call = async (args: unknown = {}) => JSON.parse(await runTool("list_routines", args, ctx()));
const rejected = async (args: unknown) => runTool("list_routines", args, ctx()).then(() => null, (e: unknown) => e as Error);

const routine = (id: string, over: Record<string, unknown> = {}) => ({
  id, user_id: ME, type: "morning", name: "Matin", trigger_time: "07:00", is_active: true, streak_count: 4,
  streak_last_completed_date: "2026-11-07", last_injected_date: "2026-11-08", created_at: 1, updated_at: 1, ...over,
});
const item = (n: number, routineId: string, over: Record<string, unknown> = {}) => ({
  id: I(n), routine_id: routineId, user_id: ME, template_id: null, snapshot_title: `Étape ${n}`, snapshot_domain_id: null,
  snapshot_story_points: 1, override_pomodoros: null, is_check_only: false, position: n, created_at: 1, updated_at: 1, ...over,
});

beforeEach(() => {
  store.reset();
  store.seed("domains", [{ id: DOM, user_id: ME, name: "Santé", color: "#4CAF50" }]);
  store.seed("task_templates", [{ id: TPL, user_id: ME, domain_id: DOM, title: "Méditer", default_pomodoros: 2 }]);
  store.seed("routines", [
    routine(R_MORNING),
    routine(R_EVENING, { type: "evening", name: "Soir", trigger_time: "21:30", is_active: false, streak_count: 0, streak_last_completed_date: null, last_injected_date: null }),
    routine(R_OTHER, { user_id: OTHER, name: "Secrète" }),
  ]);
  store.seed("routine_items", [
    item(2, R_MORNING, { snapshot_title: "Étirements", is_check_only: true }),
    item(1, R_MORNING, { snapshot_title: "Méditer", template_id: TPL, snapshot_domain_id: DOM, snapshot_story_points: 3 }),
    item(3, R_EVENING, { snapshot_title: "Bilan", override_pomodoros: 1 }),
    { ...item(9, R_OTHER), user_id: OTHER, snapshot_title: "Secret" },
  ]);
});

describe("list_routines", () => {
  it("renvoie les routines de l'utilisateur avec leurs éléments triés par position", async () => {
    const out = await call();
    expect(out).toMatchObject({ count: 2, truncated: false });
    expect(out.routines.map((r: { name: string }) => r.name)).toEqual(["Matin", "Soir"]); // tri par heure de déclenchement
    const morning = out.routines[0];
    expect(morning).toMatchObject({
      id: R_MORNING, type: "morning", trigger_time: "07:00", is_active: true,
      streak_count: 4, streak_last_completed_date: "2026-11-07", last_injected_date: "2026-11-08", item_count: 2,
    });
    expect(morning.items.map((i: { title: string }) => i.title)).toEqual(["Méditer", "Étirements"]);
  });

  it("enrichit chaque élément : nom du domaine, pomodoros effectifs (par défaut de l'activité), case à cocher", async () => {
    const [meditate, stretch] = (await call()).routines[0].items;
    expect(meditate).toEqual({
      id: I(1), position: 1, title: "Méditer", domain_id: DOM, domain_name: "Santé", story_points: 3,
      override_pomodoros: null, pomodoros: 2, is_check_only: false, template_id: TPL,
    });
    expect(stretch).toMatchObject({ is_check_only: true, domain_id: null, domain_name: null, pomodoros: null, template_id: null });
  });

  it("la surcharge de pomodoros l'emporte sur la valeur par défaut", async () => {
    store.seed("routine_items", [item(1, R_MORNING, { template_id: TPL, override_pomodoros: 5 })]);
    expect((await call()).routines[0].items[0]).toMatchObject({ override_pomodoros: 5, pomodoros: 5 });
  });

  it("une surcharge à 0 est conservée (0 pomodoro, pas « par défaut »)", async () => {
    store.seed("routine_items", [item(1, R_MORNING, { template_id: TPL, override_pomodoros: 0 })]);
    expect((await call()).routines[0].items[0]).toMatchObject({ override_pomodoros: 0, pomodoros: 0 });
  });

  it("domaine supprimé ou activité orpheline : noms et défauts à null, sans erreur", async () => {
    store.seed("routine_items", [item(1, R_MORNING, { snapshot_domain_id: DOM_GONE, template_id: "tttttttt-tttt-4ttt-8ttt-0000000000ff" })]);
    expect((await call()).routines[0].items[0]).toMatchObject({ domain_id: DOM_GONE, domain_name: null, pomodoros: null });
  });

  it("filtre par type et par activité", async () => {
    expect((await call({ type: "evening" })).routines.map((r: { id: string }) => r.id)).toEqual([R_EVENING]);
    expect((await call({ include_inactive: false })).routines.map((r: { id: string }) => r.id)).toEqual([R_MORNING]);
    expect((await call({ type: "evening", include_inactive: false })).count).toBe(0);
  });

  it("ne montre rien d'un autre utilisateur", async () => {
    const text = JSON.stringify(await call());
    expect(text).not.toContain("Secrète");
    expect(text).not.toContain("Secret");
    expect(text).not.toContain(R_OTHER);
  });

  it("aucune routine : liste vide, et aucune requête inutile sur les éléments", async () => {
    store.seed("routines", []);
    store.calls.length = 0;
    expect(await call()).toEqual({ count: 0, truncated: false, routines: [] });
    expect(store.selects("routine_items")).toHaveLength(0);
  });

  it("signale la troncature à 1 000 éléments", async () => {
    store.seed("routine_items", Array.from({ length: 1001 }, (_, i) => item(i, R_MORNING)));
    const out = await call();
    expect(out).toMatchObject({ truncated: true, item_limit: 1000 });
    expect(out.routines[0].items).toHaveLength(1000);
  });

  it("refuse un type inconnu et les arguments inconnus (dont user_id)", async () => {
    expect((await rejected({ type: "midi" }))?.message).toContain("morning");
    expect((await rejected({ user_id: OTHER }))?.message).toContain("user_id");
    expect((await rejected({ include_inactive: "oui" }))?.message).toContain("vrai ou faux");
  });

  it("toutes les lectures sont filtrées par user_id", async () => {
    await call();
    for (const table of ["routines", "routine_items", "domains", "task_templates"]) {
      for (const c of store.selects(table)) expect(c.filters, table).toContainEqual(["user_id", "eq", ME]);
    }
  });
});

describe("lecture seule", () => {
  it("n'écrit jamais en base, n'est pas un outil d'écriture et n'a aucun équivalent de suppression", async () => {
    await call();
    for (const table of ["routines", "routine_items"]) expect(store.writes(table)).toHaveLength(0);
    expect(WRITE_TOOLS.has("list_routines")).toBe(false);
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names.filter((n) => /routine/i.test(n))).toEqual(["list_routines"]);
  });
});
