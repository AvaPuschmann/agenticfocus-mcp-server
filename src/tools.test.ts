/**
 * Tests des outils MCP — Story 27-1 (AI-S21-A : cas nominaux, erreurs, isolation entre utilisateurs, limites).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createFakeStore } from "./fakeSupabase.js";
import {
  runTool, TOOL_DEFINITIONS, ToolInputError, todayIn, dueDateToMs, LIST_LIMIT,
  type ToolContext,
} from "./tools.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const T2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const DOM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DOM_OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PROJ = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// 2026-11-05 23:30 UTC = 2026-11-06 00:30 à Paris : « aujourd'hui » dépend du fuseau de l'utilisateur.
const NOW = new Date("2026-11-05T23:30:00Z");

const store = createFakeStore();
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  userId: ME, supabase: store.clientFor("jwt-A"), now: () => NOW, timeZone: "Europe/Paris", ...over,
});
const call = async (name: string, args: unknown, c: ToolContext = ctx()) => JSON.parse(await runTool(name, args, c));
const rejected = async (name: string, args: unknown, c: ToolContext = ctx()) =>
  runTool(name, args, c).then(() => null, (e: unknown) => e as Error);

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id, user_id: ME, name: `Tâche ${id.slice(-1)}`, date: "2026-11-06", planned_pomodoros: 1, completed_pomodoros: 0,
  is_completed: false, position: 1, story_points: 1, impact: null, urgency: null, due_date: null, project_id: null,
  domain_id: null, note: null, created_at: 1, updated_at: 1, ...over,
});

beforeEach(() => {
  store.reset();
  store.seed("domains", [{ id: DOM, user_id: ME, name: "Sport", color: "#fff" }, { id: DOM_OTHER, user_id: OTHER, name: "Autre", color: "#000" }]);
});

describe("fuseau et dates", () => {
  it("« aujourd'hui » est celui de l'utilisateur (Paris), pas celui du serveur (UTC)", () => {
    expect(todayIn({ now: () => NOW, timeZone: "Europe/Paris" })).toBe("2026-11-06");
    expect(todayIn({ now: () => NOW, timeZone: "UTC" })).toBe("2026-11-05");
  });
  it("une échéance est enregistrée à 12:00 UTC (même date affichée dans les fuseaux proches)", () => {
    expect(dueDateToMs("2026-11-20")).toBe(Date.UTC(2026, 10, 20, 12));
  });
});

describe("create_day_task", () => {
  it("crée la tâche d'aujourd'hui (fuseau de l'utilisateur) en première position, avec les valeurs par défaut", async () => {
    const out = await call("create_day_task", { name: "  Écrire le rapport  " });
    expect(out).toMatchObject({ success: true, date: "2026-11-06", position: 1, planned_pomodoros: 1, story_points: 0 });
    const row = store.tables.day_tasks[0];
    expect(row).toMatchObject({
      user_id: ME, name: "Écrire le rapport", date: "2026-11-06", is_completed: false, completed_pomodoros: 0,
      impact: null, urgency: null, due_date: null, project_id: null, domain_id: null, note: null,
    });
  });

  it("range la tâche EN FIN DE LISTE du jour (dernière position + 1)", async () => {
    store.seed("day_tasks", [task(T1, { position: 1 }), task(T2, { position: 5 }), task("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", { date: "2026-11-07", position: 9 })]);
    const out = await call("create_day_task", { name: "Nouvelle", date: "2026-11-06" });
    expect(out.position).toBe(6);
  });

  it("une tâche de backlog n'a pas de date et sa position est celle du backlog", async () => {
    store.seed("day_tasks", [task(T1, { date: null, position: 3 }), task(T2, { position: 8 })]);
    const out = await call("create_day_task", { name: "Idée", backlog: true });
    expect(out).toMatchObject({ date: null, position: 4 });
    expect(store.tables.day_tasks.find((r) => r.name === "Idée")).toMatchObject({ date: null });
  });

  it("enregistre points, impact, urgence, échéance, domaine, note", async () => {
    await call("create_day_task", {
      name: "Complète", date: "2026-11-10", planned_pomodoros: 4, story_points: 5, impact: "high", urgency: "urgent",
      due_date: "2026-11-20", domain_id: DOM, note: "à relire",
    });
    expect(store.tables.day_tasks[0]).toMatchObject({
      planned_pomodoros: 4, story_points: 5, impact: "high", urgency: "urgent", due_date: Date.UTC(2026, 10, 20, 12),
      domain_id: DOM, note: "à relire",
    });
  });

  it("accepte les mêmes valeurs que l'application : 0 point, 50 points, 0 pomodoro (le 50 de la capture de Philippe)", async () => {
    await call("create_day_task", { name: "Zéro", story_points: 0, planned_pomodoros: 0 });
    await call("create_day_task", { name: "Cinquante", story_points: 50 });
    await call("create_day_task", { name: "Maximum", story_points: 999 });
    const rows = store.tables.day_tasks;
    expect(rows.find((r) => r.name === "Zéro")).toMatchObject({ story_points: 0, planned_pomodoros: 0 });
    expect(rows.find((r) => r.name === "Cinquante")).toMatchObject({ story_points: 50, planned_pomodoros: 1 });
    expect(rows.find((r) => r.name === "Maximum")).toMatchObject({ story_points: 999 });
  });

  it("user_id vient du jeton : l'agent ne peut pas le fournir (argument inconnu), et aucune écriture n'a lieu", async () => {
    const err = await rejected("create_day_task", { name: "x", user_id: OTHER });
    expect(err).toBeInstanceOf(ToolInputError);
    expect(err!.message).toContain("user_id");
    expect(store.writes("day_tasks")).toHaveLength(0);
  });

  it.each([
    ["nom absent", {}, "obligatoire"],
    ["nom vide", { name: "   " }, "obligatoire"],
    ["nom trop long", { name: "x".repeat(201) }, "trop long"],
    ["faute de frappe (title)", { name: "x", title: "y" }, "Argument inconnu"],
    ["date impossible", { name: "x", date: "2026-02-30" }, "date réelle"],
    ["date mal formée", { name: "x", date: "06/11/2026" }, "AAAA-MM-JJ"],
    ["date ET backlog", { name: "x", date: "2026-11-06", backlog: true }, "pas les deux"],
    ["pomodoros hors bornes", { name: "x", planned_pomodoros: 100 }, "entre 0 et 99"],
    ["pomodoros négatifs", { name: "x", planned_pomodoros: -1 }, "entre 0 et 99"],
    ["pomodoros décimaux", { name: "x", planned_pomodoros: 1.5 }, "entier"],
    ["points hors bornes", { name: "x", story_points: 1000 }, "entre 0 et 999"],
    ["points négatifs", { name: "x", story_points: -1 }, "entre 0 et 999"],
    ["impact invalide", { name: "x", impact: "medium" }, "high, low"],
    ["urgence invalide", { name: "x", urgency: "maybe" }, "urgent, not_urgent"],
    ["note trop longue", { name: "x", note: "n".repeat(5001) }, "trop long"],
    ["domaine non UUID", { name: "x", domain_id: "abc" }, "UUID"],
  ])("refuse : %s", async (_label, args, fragment) => {
    const err = await rejected("create_day_task", args);
    expect(err).toBeInstanceOf(ToolInputError);
    expect(err!.message).toContain(fragment);
    expect(store.writes("day_tasks")).toHaveLength(0);
  });

  it("refuse un domaine inconnu ou appartenant à un autre utilisateur, sans créer de tâche", async () => {
    for (const id of [PROJ, DOM_OTHER]) {
      const err = await rejected("create_day_task", { name: "x", domain_id: id });
      expect(err).toBeInstanceOf(ToolInputError);
      expect(err!.message).toContain("list_domains");
    }
    expect(store.writes("day_tasks")).toHaveLength(0);
  });

  it("refuse un projet inconnu avec une indication", async () => {
    const err = await rejected("create_day_task", { name: "x", project_id: PROJ });
    expect(err!.message).toContain("list_projects");
  });

  it("une erreur Supabase est remontée avec son code", async () => {
    store.failNext({ message: "permission denied", code: "42501" });
    const err = await rejected("create_day_task", { name: "x" });
    expect(err!.message).toContain("42501");
  });
});

describe("list_tasks / list_today_tasks", () => {
  beforeEach(() => {
    store.seed("day_tasks", [
      task(T1, { position: 2 }),
      task(T2, { position: 1, is_completed: true }),
      task("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", { date: "2026-11-08" }),
      task("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", { date: null }),
      task("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5", { user_id: OTHER }),
    ]);
  });

  it("par défaut : aujourd'hui (fuseau de l'utilisateur), triées par position, UNIQUEMENT les siennes", async () => {
    const out = await call("list_tasks", {});
    expect(out.date).toBe("2026-11-06");
    expect(out.tasks.map((t: { id: string }) => t.id)).toEqual([T2, T1]);
    expect(out.truncated).toBe(false);
  });

  it("filtre toujours sur user_id", async () => {
    await call("list_tasks", { backlog: true });
    expect(store.selects("day_tasks")[0].filters).toContainEqual(["user_id", "eq", ME]);
  });

  it("include_completed: false masque les tâches terminées", async () => {
    const out = await call("list_tasks", { include_completed: false });
    expect(out.tasks.map((t: { id: string }) => t.id)).toEqual([T1]);
  });

  it("une plage renvoie les jours demandés", async () => {
    const out = await call("list_tasks", { from: "2026-11-06", to: "2026-11-08" });
    expect(out.count).toBe(3);
  });

  it("le backlog ne renvoie que les tâches sans date", async () => {
    const out = await call("list_tasks", { backlog: true });
    expect(out.tasks.map((t: { name: string }) => t.name)).toEqual(["Tâche 4"]);
  });

  it.each([
    ["plage de 63 jours", { from: "2026-01-01", to: "2026-03-04" }, "62 jours"],
    ["fin avant début", { from: "2026-11-08", to: "2026-11-06" }, "postérieur"],
    ["from sans to", { from: "2026-11-06" }, "vont ensemble"],
    ["date ET backlog", { date: "2026-11-06", backlog: true }, "un seul mode"],
    ["date ET plage", { date: "2026-11-06", from: "2026-11-06", to: "2026-11-07" }, "un seul mode"],
  ])("refuse : %s", async (_l, args, fragment) => {
    const err = await rejected("list_tasks", args);
    expect(err).toBeInstanceOf(ToolInputError);
    expect(err!.message).toContain(fragment);
  });

  it("accepte une plage de 62 jours exactement", async () => {
    await expect(call("list_tasks", { from: "2026-01-01", to: "2026-03-03" })).resolves.toMatchObject({ truncated: false });
  });

  it("jamais de troncature silencieuse : 201 tâches → 200 renvoyées et truncated = true", async () => {
    store.seed("day_tasks", Array.from({ length: LIST_LIMIT + 1 }, (_, i) =>
      task(`aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`, { position: i })));
    const out = await call("list_tasks", {});
    expect(out).toMatchObject({ count: LIST_LIMIT, truncated: true, limit: LIST_LIMIT });
    expect(out.tasks).toHaveLength(LIST_LIMIT);
  });

  it("exactement 200 tâches : truncated = false", async () => {
    store.seed("day_tasks", Array.from({ length: LIST_LIMIT }, (_, i) =>
      task(`aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`, { position: i })));
    expect((await call("list_tasks", {})).truncated).toBe(false);
  });

  it("list_today_tasks ajoute le nom du projet (uniquement ceux de l'utilisateur)", async () => {
    store.seed("projects", [{ id: PROJ, user_id: ME, name: "Refonte" }]);
    store.seed("day_tasks", [task(T1, { project_id: PROJ })]);
    const out = await call("list_today_tasks", {});
    expect(out.tasks[0]).toMatchObject({ id: T1, project_name: "Refonte" });
    expect(store.selects("projects")[0].filters).toContainEqual(["user_id", "eq", ME]);
  });
});

describe("update_day_task", () => {
  beforeEach(() => {
    store.seed("day_tasks", [
      task(T1, { position: 2, note: "ancienne", impact: "low" }),
      task(T2, { user_id: OTHER, name: "Privée" }),
      task("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", { date: "2026-11-09", position: 7 }),
    ]);
  });
  const row = (id: string) => store.tables.day_tasks.find((r) => r.id === id)!;

  it("ne modifie QUE les champs fournis", async () => {
    const out = await call("update_day_task", { id: T1, name: "Renommée", story_points: 8 });
    expect(out.updated.sort()).toEqual(["name", "story_points"]);
    expect(row(T1)).toMatchObject({ name: "Renommée", story_points: 8, note: "ancienne", impact: "low", date: "2026-11-06", position: 2 });
    expect(row(T1).updated_at).toBe(NOW.getTime());
  });

  it("accepte 50 points puis 0 point en modification (comme l'éditeur de tâche de l'application)", async () => {
    await call("update_day_task", { id: T1, story_points: 50, planned_pomodoros: 4 });
    expect(row(T1)).toMatchObject({ story_points: 50, planned_pomodoros: 4 });
    await call("update_day_task", { id: T1, story_points: 0, planned_pomodoros: 0 });
    expect(row(T1)).toMatchObject({ story_points: 0, planned_pomodoros: 0 });
  });

  it("refuse les points et pomodoros hors bornes en modification", async () => {
    expect((await rejected("update_day_task", { id: T1, story_points: 1000 }))!.message).toContain("entre 0 et 999");
    expect((await rejected("update_day_task", { id: T1, planned_pomodoros: 100 }))!.message).toContain("entre 0 et 99");
    expect(store.writes("day_tasks")).toHaveLength(0);
  });

  it("null efface un champ (note, impact…)", async () => {
    await call("update_day_task", { id: T1, note: null, impact: null });
    expect(row(T1)).toMatchObject({ note: null, impact: null });
  });

  it("déplacer la tâche la range en FIN de liste du jour de destination", async () => {
    await call("update_day_task", { id: T1, date: "2026-11-09" });
    expect(row(T1)).toMatchObject({ date: "2026-11-09", position: 8 });
  });

  it("backlog: true la déplace au backlog", async () => {
    await call("update_day_task", { id: T1, backlog: true });
    expect(row(T1)).toMatchObject({ date: null, position: 1 });
  });

  it("une tâche d'un AUTRE utilisateur est traitée comme introuvable : aucune fuite, aucune modification", async () => {
    const err = await rejected("update_day_task", { id: T2, name: "Piratée" });
    expect(err).toBeInstanceOf(ToolInputError);
    expect(err!.message).toContain("introuvable");
    expect(row(T2).name).toBe("Privée");
  });

  it("un identifiant inconnu donne le MÊME message que celui d'un autre utilisateur", async () => {
    const unknown = await rejected("update_day_task", { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "x" });
    const foreign = await rejected("update_day_task", { id: T2, name: "x" });
    expect(unknown!.message).toBe(foreign!.message);
  });

  it("la requête de modification filtre sur l'identifiant ET sur user_id", async () => {
    await call("update_day_task", { id: T1, name: "x" });
    const filters = store.writes("day_tasks")[0].filters;
    expect(filters).toContainEqual(["id", "eq", T1]);
    expect(filters).toContainEqual(["user_id", "eq", ME]);
  });

  it.each([
    ["aucun champ", { id: T1 }, "Aucun champ"],
    ["date ET backlog", { id: T1, date: "2026-11-09", backlog: true }, "pas les deux"],
    ["backlog: false sans date", { id: T1, backlog: false }, "date"],
    ["id non UUID", { id: "12" }, "UUID"],
    ["id absent", { name: "x" }, "UUID"],
    ["nom vide", { id: T1, name: " " }, "trop court"],
    ["is_completed (réservé à complete_day_task)", { id: T1, is_completed: true }, "Argument inconnu"],
    ["user_id", { id: T1, user_id: OTHER }, "Argument inconnu"],
  ])("refuse : %s", async (_l, args, fragment) => {
    const err = await rejected("update_day_task", args);
    expect(err).toBeInstanceOf(ToolInputError);
    expect(err!.message).toContain(fragment);
    expect(store.writes("day_tasks")).toHaveLength(0);
  });
});

describe("complete_day_task", () => {
  beforeEach(() => store.seed("day_tasks", [task(T1, { completed_pomodoros: 2 }), task(T2, { user_id: OTHER })]));
  const row = (id: string) => store.tables.day_tasks.find((r) => r.id === id)!;

  it("coche par défaut, sans toucher aux compteurs de pomodoros", async () => {
    await call("complete_day_task", { id: T1 });
    expect(row(T1)).toMatchObject({ is_completed: true, completed_pomodoros: 2, planned_pomodoros: 1 });
  });

  it("completed: false décoche", async () => {
    await call("complete_day_task", { id: T1 });
    await call("complete_day_task", { id: T1, completed: false });
    expect(row(T1).is_completed).toBe(false);
  });

  it("refuse la tâche d'un autre utilisateur et un identifiant inconnu", async () => {
    expect((await rejected("complete_day_task", { id: T2 }))!.message).toContain("introuvable");
    expect(row(T2).is_completed).toBe(false);
    expect(await rejected("complete_day_task", { id: "nope" })).toBeInstanceOf(ToolInputError);
  });
});

describe("list_domains / list_projects", () => {
  it("list_domains ne renvoie que les domaines de l'utilisateur", async () => {
    const out = await call("list_domains", {});
    expect(out.count).toBe(1);
    expect(out.domains.map((d: { id: string }) => d.id)).toEqual([DOM]);
  });

  it("list_projects filtre par statut, exclut les archivés par défaut, et par utilisateur", async () => {
    store.seed("projects", [
      { id: PROJ, user_id: ME, name: "A", kanban_status: "doing", kanban_position: 1, is_archived: false },
      { id: T1, user_id: ME, name: "B", kanban_status: "todo", kanban_position: 1, is_archived: false },
      { id: T2, user_id: ME, name: "C", kanban_status: "doing", kanban_position: 2, is_archived: true },
      { id: DOM_OTHER, user_id: OTHER, name: "D", kanban_status: "doing", kanban_position: 1, is_archived: false },
    ]);
    const out = await call("list_projects", { kanban_status: "doing" });
    expect(out.projects.map((p: { name: string }) => p.name)).toEqual(["A"]);
    const all = await call("list_projects", { include_archived: true });
    expect(all.count).toBe(3);
  });
});

describe("garde-fous généraux", () => {
  it("AUCUN outil de suppression n'est exposé, et l'appeler échoue", async () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names.filter((n) => /delete|remove|destroy|drop/i.test(n))).toEqual([]);
    expect(names.sort()).toEqual(["archive_project", "complete_day_task", "create_activity", "create_day_task", "create_domain", "create_project", "list_activities", "list_domains", "list_projects", "list_routines", "list_tasks", "list_today_tasks", "move_project", "update_activity", "update_day_task", "update_domain", "update_project"]);
    expect(await rejected("delete_day_task", { id: T1 })).toBeInstanceOf(ToolInputError);
  });

  it("chaque outil refuse les arguments inconnus dans son schéma (additionalProperties: false)", () => {
    for (const t of TOOL_DEFINITIONS) {
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties, t.name).toBe(false);
    }
  });

  it("des arguments qui ne sont pas un objet sont refusés", async () => {
    expect(await rejected("list_tasks", "oups")).toBeInstanceOf(ToolInputError);
    expect(await rejected("list_tasks", [1])).toBeInstanceOf(ToolInputError);
  });

  it("les requêtes partent avec le client fourni (jeton de la requête)", async () => {
    await call("list_tasks", {}, ctx({ supabase: store.clientFor("jwt-B") }));
    expect(store.selects("day_tasks")[0].jwt).toBe("jwt-B");
  });
});
