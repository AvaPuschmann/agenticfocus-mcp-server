/**
 * Tests des objectifs (jour / semaine / mois) — Story 27-14.
 * Les clés de période reproduisent celles du desktop (GoalsCard.tsx) et d'Android (IsoFields) : semaine ISO.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createFakeStore } from "./fakeSupabase.js";
import { runTool, TOOL_DEFINITIONS, type ToolContext } from "./tools.js";
import { WRITE_TOOLS } from "./server.js";
import { weekKeyOf, periodKeyOf, flagsOf, statusOf, MAX_GOAL_TEXT } from "./goals.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW_DATE = new Date("2026-11-08T09:00:00Z"); // dimanche 8 novembre 2026 (Paris), semaine ISO 45
const NOW = NOW_DATE.getTime();

const store = createFakeStore();
const ctx = (): ToolContext => ({ userId: ME, supabase: store.clientFor("jwt-A"), now: () => NOW_DATE, timeZone: "Europe/Paris" });
const call = async (name: string, args: unknown = {}) => JSON.parse(await runTool(name, args, ctx()));
const rejected = async (name: string, args: unknown) => runTool(name, args, ctx()).then(() => null, (e: unknown) => e as Error);

const goal = (n: number, over: Record<string, unknown> = {}) => ({
  id: `gggggggg-gggg-4ggg-8ggg-${String(n).padStart(12, "0")}`, user_id: ME, type: "day", period_key: "2026-11-08",
  text: `Objectif ${n}`, is_completed: false, is_missed: false, created_at: 1, updated_at: n, ...over,
});

beforeEach(() => store.reset());

describe("clés de période (règles de l'application)", () => {
  it.each([
    ["2026-11-08", "2026-W45"], // dimanche : appartient à la semaine du lundi 2
    ["2026-11-02", "2026-W45"], // lundi
    ["2026-11-09", "2026-W46"],
    ["2026-01-01", "2026-W01"], // jeudi
    ["2025-12-29", "2026-W01"], // lundi de décembre appartenant à la semaine 1 de 2026
    ["2024-12-30", "2025-W01"],
    ["2027-01-01", "2026-W53"], // vendredi : encore la semaine 53 de 2026
    ["2020-12-31", "2020-W53"],
    ["2021-01-03", "2020-W53"],
    ["2021-01-04", "2021-W01"],
    ["2026-12-31", "2026-W53"],
  ])("semaine ISO de %s = %s", (date, expected) => {
    expect(weekKeyOf(date)).toBe(expected);
  });

  it("jour, semaine et mois", () => {
    expect(periodKeyOf("day", "2026-11-08")).toBe("2026-11-08");
    expect(periodKeyOf("week", "2026-11-08")).toBe("2026-W45");
    expect(periodKeyOf("month", "2026-11-08")).toBe("2026-11");
  });

  it("tri-état : jamais « atteint » et « raté » à la fois", () => {
    expect(flagsOf("todo")).toEqual({ is_completed: false, is_missed: false });
    expect(flagsOf("achieved")).toEqual({ is_completed: true, is_missed: false });
    expect(flagsOf("missed")).toEqual({ is_completed: false, is_missed: true });
    expect(statusOf({ is_completed: true, is_missed: false })).toBe("achieved");
    expect(statusOf({ is_completed: false, is_missed: true })).toBe("missed");
    expect(statusOf({ is_completed: false, is_missed: false })).toBe("todo");
  });
});

describe("set_goal — création", () => {
  it("crée l'objectif du jour (aujourd'hui, fuseau de Paris) avec les colonnes de l'application", async () => {
    const out = await call("set_goal", { type: "day", text: "  Finir le MCP " });
    expect(out).toMatchObject({ success: true, created: true, type: "day", period_key: "2026-11-08", text: "Finir le MCP", status: "todo" });
    expect(store.tables.goals).toHaveLength(1);
    expect(store.tables.goals[0]).toEqual({
      id: out.id, user_id: ME, type: "day", period_key: "2026-11-08", text: "Finir le MCP",
      is_completed: false, is_missed: false, created_at: NOW, updated_at: NOW,
    });
  });

  it("« aujourd'hui » suit le fuseau de l'utilisateur, pas celui du serveur", async () => {
    const late = { ...ctx(), now: () => new Date("2026-11-08T23:30:00Z") }; // déjà le 9 à Paris
    const out = JSON.parse(await runTool("set_goal", { type: "day", text: "Tard" }, late));
    expect(out.period_key).toBe("2026-11-09");
  });

  it("semaine et mois : la période vient de la date fournie", async () => {
    const w = await call("set_goal", { type: "week", date: "2027-01-01", text: "Semaine 53" });
    const m = await call("set_goal", { type: "month", date: "2026-02-15", text: "Février" });
    expect(w.period_key).toBe("2026-W53");
    expect(m.period_key).toBe("2026-02");
  });

  it("peut créer directement « atteint » ou « raté »", async () => {
    await call("set_goal", { type: "day", date: "2026-11-01", text: "A", status: "achieved" });
    await call("set_goal", { type: "day", date: "2026-11-02", text: "B", status: "missed" });
    expect(store.tables.goals.map((g) => [g.is_completed, g.is_missed])).toEqual([[true, false], [false, true]]);
  });

  it("refuse la création sans texte, ou avec un texte vide", async () => {
    expect((await rejected("set_goal", { type: "day" }))?.message).toContain("text");
    expect((await rejected("set_goal", { type: "day", status: "achieved" }))?.message).toContain("text");
    expect((await rejected("set_goal", { type: "day", text: "   " }))?.message).toContain("text");
    expect(store.writes("goals")).toHaveLength(0);
  });
});

describe("set_goal — un seul objectif par période", () => {
  it("un second appel pour la même période MODIFIE : jamais de doublon", async () => {
    const first = await call("set_goal", { type: "week", date: "2026-11-03", text: "Premier texte" });
    const second = await call("set_goal", { type: "week", date: "2026-11-08", text: "Second texte" }); // même semaine ISO 45
    expect(second).toMatchObject({ created: false, id: first.id, text: "Second texte" });
    expect(store.tables.goals).toHaveLength(1);
    expect(store.writes("goals").map((c) => c.op)).toEqual(["insert", "update"]);
  });

  it("changer le statut seul conserve le texte ; changer le texte seul conserve le statut", async () => {
    const created = await call("set_goal", { type: "day", text: "Texte", status: "achieved" });
    await call("set_goal", { type: "day", status: "missed" });
    expect(store.tables.goals[0]).toMatchObject({ text: "Texte", is_completed: false, is_missed: true });
    await call("set_goal", { type: "day", text: "Nouveau" });
    expect(store.tables.goals[0]).toMatchObject({ id: created.id, text: "Nouveau", is_completed: false, is_missed: true });
    await call("set_goal", { type: "day", status: "todo" });
    expect(store.tables.goals[0]).toMatchObject({ is_completed: false, is_missed: false });
  });

  it("la modification met à jour updated_at mais pas created_at", async () => {
    store.seed("goals", [goal(1, { created_at: 5, updated_at: 5 })]);
    await call("set_goal", { type: "day", status: "achieved" });
    expect(store.tables.goals[0]).toMatchObject({ created_at: 5, updated_at: NOW });
  });

  it("refuse une modification sans aucun champ", async () => {
    store.seed("goals", [goal(1)]);
    expect((await rejected("set_goal", { type: "day" }))?.message).toContain("Aucun champ");
  });

  it("types et périodes distincts : objectifs indépendants", async () => {
    await call("set_goal", { type: "day", text: "Jour" });
    await call("set_goal", { type: "week", text: "Semaine" });
    await call("set_goal", { type: "month", text: "Mois" });
    await call("set_goal", { type: "day", date: "2026-11-07", text: "Hier" });
    expect(store.tables.goals).toHaveLength(4);
  });

  it("l'objectif d'un autre utilisateur n'est ni modifié ni vu comme un doublon", async () => {
    store.seed("goals", [goal(9, { user_id: OTHER, text: "Secret" })]);
    const out = await call("set_goal", { type: "day", text: "Le mien" });
    expect(out.created).toBe(true);
    expect(store.tables.goals).toHaveLength(2);
    expect(store.tables.goals.find((g) => g.user_id === OTHER)).toMatchObject({ text: "Secret" });
  });
});

describe("set_goal — validation", () => {
  it.each([
    [{}, "type"],
    [{ type: "year", text: "x" }, "type"],
    [{ type: "day", text: "x", status: "done" }, "status"],
    [{ type: "day", text: "x", date: "2026-02-30" }, "date"],
    [{ type: "day", text: "x".repeat(MAX_GOAL_TEXT + 1) }, "trop long"],
    [{ type: "day", text: "x", user_id: OTHER }, "user_id"],
    [{ type: "day", text: null }, "text"],
  ])("refuse %j", async (args, fragment) => {
    expect((await rejected("set_goal", args))?.message).toContain(fragment);
    expect(store.writes("goals")).toHaveLength(0);
  });

  it("toute modification est filtrée par user_id", async () => {
    store.seed("goals", [goal(1)]);
    await call("set_goal", { type: "day", text: "Changé" });
    const update = store.writes("goals").find((c) => c.op === "update")!;
    expect(update.filters).toContainEqual(["user_id", "eq", ME]);
  });
});

describe("list_goals", () => {
  beforeEach(() => {
    store.seed("goals", [
      goal(1, { type: "day", period_key: "2026-11-08", text: "Jour", is_completed: true }),
      goal(2, { type: "week", period_key: "2026-W45", text: "Semaine", is_missed: true }),
      goal(3, { type: "month", period_key: "2026-11", text: "Mois" }),
      goal(4, { type: "day", period_key: "2026-11-07", text: "Hier" }),
      goal(5, { type: "week", period_key: "2026-W44", text: "Semaine précédente" }),
      goal(9, { user_id: OTHER, text: "Secret" }),
    ]);
  });

  it("par défaut : les 3 objectifs d'aujourd'hui avec leurs statuts et les clés de période", async () => {
    const out = await call("list_goals");
    expect(out.date).toBe("2026-11-08");
    expect(out.period_keys).toEqual({ day: "2026-11-08", week: "2026-W45", month: "2026-11" });
    expect(out.goals.day).toMatchObject({ text: "Jour", status: "achieved", type: "day" });
    expect(out.goals.week).toMatchObject({ text: "Semaine", status: "missed" });
    expect(out.goals.month).toMatchObject({ text: "Mois", status: "todo" });
    expect(JSON.stringify(out)).not.toContain("Secret");
  });

  it("une date donnée : null pour les périodes sans objectif", async () => {
    const out = await call("list_goals", { date: "2026-10-15" });
    expect(out.period_keys).toEqual({ day: "2026-10-15", week: "2026-W42", month: "2026-10" });
    expect(out.goals).toEqual({ day: null, week: null, month: null });
  });

  it("historique d'un type : période la plus récente d'abord", async () => {
    const out = await call("list_goals", { type: "day" });
    expect(out).toMatchObject({ type: "day", count: 2, truncated: false });
    expect(out.goals.map((g: { period_key: string }) => g.period_key)).toEqual(["2026-11-08", "2026-11-07"]);
  });

  it("historique : limite et troncature signalée", async () => {
    store.seed("goals", Array.from({ length: 5 }, (_, i) => goal(i + 1, { period_key: `2026-11-0${i + 1}`, text: `J${i + 1}` })));
    const out = await call("list_goals", { type: "day", limit: 3 });
    expect(out).toMatchObject({ count: 3, truncated: true, limit: 3 });
    expect(out.goals.map((g: { text: string }) => g.text)).toEqual(["J5", "J4", "J3"]);
  });

  it("refuse date + type, limit sans type, valeurs invalides et arguments inconnus", async () => {
    expect((await rejected("list_goals", { date: "2026-11-08", type: "day" }))?.message).toContain("pas les deux");
    expect((await rejected("list_goals", { limit: 5 }))?.message).toContain("limit");
    expect((await rejected("list_goals", { type: "day", limit: 0 }))?.message).toContain("entre 1 et 100");
    expect((await rejected("list_goals", { type: "day", limit: 101 }))?.message).toContain("entre 1 et 100");
    expect((await rejected("list_goals", { type: "decade" }))?.message).toContain("type");
    expect((await rejected("list_goals", { user_id: OTHER }))?.message).toContain("user_id");
  });

  it("toutes les lectures sont filtrées par user_id et n'écrivent rien", async () => {
    await call("list_goals");
    await call("list_goals", { type: "week" });
    for (const c of store.selects("goals")) expect(c.filters).toContainEqual(["user_id", "eq", ME]);
    expect(store.writes("goals")).toHaveLength(0);
  });
});

describe("garde-fous", () => {
  it("set_goal est un outil d'écriture, list_goals non ; aucun outil ne supprime un objectif", () => {
    expect(WRITE_TOOLS.has("set_goal")).toBe(true);
    expect(WRITE_TOOLS.has("list_goals")).toBe(false);
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names.filter((n) => /goal/i.test(n)).sort()).toEqual(["list_goals", "set_goal"]);
    expect(names.filter((n) => /delete|remove|supprim/i.test(n))).toEqual([]);
  });

  it("une erreur Supabase est signalée (pas de succès silencieux)", async () => {
    store.failNext({ message: "boom", code: "XX000" });
    expect(await rejected("set_goal", { type: "day", text: "Z" })).toBeInstanceOf(Error);
  });
});
