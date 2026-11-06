/**
 * Tests des outils de projets — Story 27-11.
 * Les règles de rangement (pas de 1024) et de dates reproduisent celles de l'application desktop (projectStore.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createFakeStore } from "./fakeSupabase.js";
import { runTool, TOOL_DEFINITIONS, ToolInputError, type ToolContext } from "./tools.js";
import {
  insertBetween, endPosition, creationLifecycle, transitionLifecycle, POSITION_STEP, MAX_NAME, KANBAN_STATUSES,
  type KanbanStatus, type Lifecycle,
} from "./projects.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const DOM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DOM_OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const P = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const NOW_DATE = new Date("2026-11-05T23:30:00Z");
const NOW = NOW_DATE.getTime();

const store = createFakeStore();
const ctx = (): ToolContext => ({ userId: ME, supabase: store.clientFor("jwt-A"), now: () => NOW_DATE, timeZone: "Europe/Paris" });
const call = async (name: string, args: unknown) => JSON.parse(await runTool(name, args, ctx()));
const rejected = async (name: string, args: unknown) => runTool(name, args, ctx()).then(() => null, (e: unknown) => e as Error);

const project = (n: number, over: Record<string, unknown> = {}) => ({
  id: P(n), user_id: ME, name: `Projet ${n}`, description: null, kanban_status: "todo", kanban_position: 1024 * n,
  target_date: null, domain_id: null, is_archived: false, tag_ids: [], started_at: null, finished_at: null,
  created_at: 1, updated_at: 1, ...over,
});
const row = (n: number) => store.tables.projects.find((r) => r.id === P(n))!;

beforeEach(() => {
  store.reset();
  store.seed("domains", [{ id: DOM, user_id: ME, name: "Pro" }, { id: DOM_OTHER, user_id: OTHER, name: "Autre" }]);
});

describe("règles de l'application (fonctions pures)", () => {
  it("insertBetween : milieu des deux positions, ou « suivant + 1024 » si l'écart est trop faible", () => {
    expect(insertBetween(1024, 2048)).toBe(1536);
    expect(insertBetween(0, 1024)).toBe(512);
    expect(insertBetween(1, 2)).toBe(2 + POSITION_STEP);
  });

  it("endPosition : plus grande position + 1024 ; colonne vide = 1024", () => {
    expect(endPosition([])).toBe(1024);
    expect(endPosition([1024, 3072, 2048])).toBe(4096);
  });

  it("dates d'un projet créé : début hors backlog, fin seulement en done", () => {
    expect(creationLifecycle("backlog", NOW)).toEqual({ started_at: null, finished_at: null });
    expect(creationLifecycle("todo", NOW)).toEqual({ started_at: NOW, finished_at: null });
    expect(creationLifecycle("doing", NOW)).toEqual({ started_at: NOW, finished_at: null });
    expect(creationLifecycle("done", NOW)).toEqual({ started_at: NOW, finished_at: NOW });
  });

  const none: Lifecycle = { started_at: null, finished_at: null };
  const T = (old: KanbanStatus, next: KanbanStatus, cur = none) => transitionLifecycle(old, next, cur, NOW);
  it.each([
    ["backlog → todo : début", () => T("backlog", "todo"), { started_at: NOW, finished_at: null }],
    ["backlog → doing : début", () => T("backlog", "doing"), { started_at: NOW, finished_at: null }],
    ["backlog → done : début et fin", () => T("backlog", "done"), { started_at: NOW, finished_at: NOW }],
    ["todo → done : fin, début conservé", () => T("todo", "done", { started_at: 5, finished_at: null }), { started_at: 5, finished_at: NOW }],
    ["done → doing : réouverture, fin effacée, début conservé", () => T("done", "doing", { started_at: 5, finished_at: 9 }), { started_at: 5, finished_at: null }],
    ["done → backlog : tout effacé", () => T("done", "backlog", { started_at: 5, finished_at: 9 }), { started_at: null, finished_at: null }],
    ["doing → backlog : tout effacé", () => T("doing", "backlog", { started_at: 5, finished_at: null }), { started_at: null, finished_at: null }],
    ["todo → doing : début déjà posé, jamais écrasé", () => T("todo", "doing", { started_at: 5, finished_at: null }), { started_at: 5, finished_at: null }],
    ["doing → doing : inchangé", () => T("doing", "doing", { started_at: 5, finished_at: null }), { started_at: 5, finished_at: null }],
    ["backlog → backlog : inchangé", () => T("backlog", "backlog"), { started_at: null, finished_at: null }],
  ])("transition %s", (_label, run, expected) => {
    expect(run()).toEqual(expected);
  });
});

describe("create_project", () => {
  it("valeurs par défaut : backlog, première position, aucune date, pas de tags, non archivé, bon utilisateur", async () => {
    const out = await call("create_project", { name: "  Refonte du site  " });
    expect(out).toMatchObject({ success: true, kanban_status: "backlog", kanban_position: 1024, target_date: null });
    expect(store.tables.projects[0]).toMatchObject({
      user_id: ME, name: "Refonte du site", description: null, kanban_status: "backlog", kanban_position: 1024, target_date: null,
      domain_id: null, is_archived: false, tag_ids: [], started_at: null, finished_at: null, created_at: NOW, updated_at: NOW,
    });
  });

  it("rangé en fin de colonne (+1024) : sans compter les projets archivés ni ceux des autres utilisateurs ni ceux des autres colonnes", async () => {
    store.seed("projects", [
      project(1, { kanban_position: 1024 }),
      project(2, { kanban_position: 2048 }),
      project(3, { kanban_position: 9999, is_archived: true }),
      project(4, { kanban_position: 5000, user_id: OTHER }),
      project(5, { kanban_position: 7000, kanban_status: "doing" }),
    ]);
    const out = await call("create_project", { name: "Nouveau", kanban_status: "todo" });
    expect(out.kanban_position).toBe(3072);
  });

  it("créé directement en doing ou done : dates de début et de fin comme l'application", async () => {
    await call("create_project", { name: "En cours", kanban_status: "doing" });
    await call("create_project", { name: "Terminé", kanban_status: "done" });
    expect(store.tables.projects.find((r) => r.name === "En cours")).toMatchObject({ started_at: NOW, finished_at: null });
    expect(store.tables.projects.find((r) => r.name === "Terminé")).toMatchObject({ started_at: NOW, finished_at: NOW });
  });

  it("enregistre description, échéance (12:00 UTC) et domaine", async () => {
    await call("create_project", { name: "Complet", description: " texte ", target_date: "2026-12-31", domain_id: DOM });
    expect(store.tables.projects[0]).toMatchObject({ description: "texte", target_date: Date.UTC(2026, 11, 31, 12), domain_id: DOM });
  });

  it("une description vide devient null (comme l'application)", async () => {
    await call("create_project", { name: "Vide", description: "   " });
    expect(store.tables.projects[0].description).toBeNull();
  });

  it(`nom de 1 à ${MAX_NAME} caractères`, async () => {
    await call("create_project", { name: "x".repeat(MAX_NAME) });
    expect((await rejected("create_project", { name: "x".repeat(MAX_NAME + 1) }))!.message).toContain("trop long");
    expect((await rejected("create_project", { name: "   " }))!.message).toContain("obligatoire");
    expect(store.tables.projects).toHaveLength(1);
  });

  it.each([
    ["colonne inconnue", { name: "x", kanban_status: "archive" }, "backlog, todo, doing, done"],
    ["date impossible", { name: "x", target_date: "2026-02-30" }, "date réelle"],
    ["user_id fourni par l'agent", { name: "x", user_id: OTHER }, "Argument inconnu"],
    ["tags non gérés", { name: "x", tag_ids: [] }, "Argument inconnu"],
    ["archivage à la création", { name: "x", is_archived: true }, "Argument inconnu"],
    ["domaine non UUID", { name: "x", domain_id: "abc" }, "UUID"],
  ])("refuse : %s", async (_l, args, fragment) => {
    const err = await rejected("create_project", args);
    expect(err).toBeInstanceOf(ToolInputError);
    expect(err!.message).toContain(fragment);
    expect(store.writes("projects")).toHaveLength(0);
  });

  it("refuse un domaine inconnu ou d'un autre utilisateur, sans rien créer", async () => {
    for (const id of [P(99), DOM_OTHER]) {
      expect((await rejected("create_project", { name: "x", domain_id: id }))!.message).toContain("list_domains");
    }
    expect(store.writes("projects")).toHaveLength(0);
  });

  it("une erreur Supabase est remontée avec son code", async () => {
    store.failNext({ message: "permission denied", code: "42501" });
    expect((await rejected("create_project", { name: "x" }))!.message).toContain("42501");
  });
});

describe("update_project", () => {
  beforeEach(() => store.seed("projects", [
    project(1, { description: "ancienne", target_date: 5, domain_id: DOM, kanban_status: "doing", started_at: 7 }),
    project(2, { user_id: OTHER, name: "Privé" }),
  ]));

  it("ne modifie QUE les champs fournis ; la colonne, les dates et l'archivage ne bougent pas", async () => {
    const out = await call("update_project", { id: P(1), name: "Renommé", target_date: "2027-01-15" });
    expect(out.updated.sort()).toEqual(["name", "target_date"]);
    expect(row(1)).toMatchObject({
      name: "Renommé", target_date: Date.UTC(2027, 0, 15, 12), description: "ancienne", domain_id: DOM,
      kanban_status: "doing", kanban_position: 1024, started_at: 7, is_archived: false, updated_at: NOW,
    });
  });

  it("null efface description, échéance et domaine ; une description vide aussi", async () => {
    await call("update_project", { id: P(1), description: null, target_date: null, domain_id: null });
    expect(row(1)).toMatchObject({ description: null, target_date: null, domain_id: null });
    await call("update_project", { id: P(1), description: "retour" });
    await call("update_project", { id: P(1), description: "  " });
    expect(row(1).description).toBeNull();
  });

  it("un projet d'un AUTRE utilisateur ou inconnu : même message « introuvable », rien n'est modifié", async () => {
    const foreign = await rejected("update_project", { id: P(2), name: "Piraté" });
    const unknown = await rejected("update_project", { id: P(99), name: "x" });
    expect(foreign).toBeInstanceOf(ToolInputError);
    expect(foreign!.message).toContain("introuvable");
    expect(foreign!.message).toBe(unknown!.message);
    expect(row(2).name).toBe("Privé");
  });

  it("filtre la modification sur l'identifiant ET sur user_id", async () => {
    await call("update_project", { id: P(1), name: "x" });
    const filters = store.writes("projects")[0].filters;
    expect(filters).toContainEqual(["id", "eq", P(1)]);
    expect(filters).toContainEqual(["user_id", "eq", ME]);
  });

  it.each([
    ["aucun champ", { id: P(1) }, "move_project"],
    ["colonne (réservée à move_project)", { id: P(1), kanban_status: "done" }, "Argument inconnu"],
    ["archivage (réservé à archive_project)", { id: P(1), is_archived: true }, "Argument inconnu"],
    ["nom vide", { id: P(1), name: " " }, "trop court"],
    ["nom trop long", { id: P(1), name: "x".repeat(MAX_NAME + 1) }, "trop long"],
    ["id non UUID", { id: "12", name: "x" }, "UUID"],
  ])("refuse : %s", async (_l, args, fragment) => {
    const err = await rejected("update_project", args);
    expect(err).toBeInstanceOf(ToolInputError);
    expect(err!.message).toContain(fragment);
    expect(store.writes("projects")).toHaveLength(0);
  });

  it("refuse un domaine d'un autre utilisateur", async () => {
    expect((await rejected("update_project", { id: P(1), domain_id: DOM_OTHER }))!.message).toContain("list_domains");
    expect(row(1).domain_id).toBe(DOM);
  });
});

describe("move_project", () => {
  // colonne doing : A(1)=1024, B(2)=2048, C(3)=3072 ; todo : D(4)=1024 ; archivé en doing : E(5)=4096
  beforeEach(() => store.seed("projects", [
    project(1, { kanban_status: "doing", kanban_position: 1024, started_at: 10 }),
    project(2, { kanban_status: "doing", kanban_position: 2048, started_at: 10 }),
    project(3, { kanban_status: "doing", kanban_position: 3072, started_at: 10 }),
    project(4, { kanban_status: "todo", kanban_position: 1024 }),
    project(5, { kanban_status: "doing", kanban_position: 4096, is_archived: true }),
    project(6, { user_id: OTHER, kanban_status: "doing", kanban_position: 99999 }),
    project(7, { kanban_status: "backlog", kanban_position: 1024 }),
  ]));

  it("sans voisin : fin de la colonne de destination (archivés et autres utilisateurs ignorés)", async () => {
    const out = await call("move_project", { id: P(4), kanban_status: "doing" });
    expect(out).toMatchObject({ kanban_status: "doing", kanban_position: 4096 });
    expect(row(4)).toMatchObject({ kanban_status: "doing", kanban_position: 4096, updated_at: NOW });
  });

  it("vers une colonne vide : 1024", async () => {
    await call("move_project", { id: P(4), kanban_status: "done" });
    expect(row(4).kanban_position).toBe(1024);
  });

  it("below_project_id : juste sous ce projet (entre lui et le suivant)", async () => {
    await call("move_project", { id: P(4), kanban_status: "doing", below_project_id: P(1) });
    expect(row(4).kanban_position).toBe(1536);
  });

  it("below_project_id sur le dernier : dernier + 1024", async () => {
    await call("move_project", { id: P(4), kanban_status: "doing", below_project_id: P(3) });
    expect(row(4).kanban_position).toBe(4096);
  });

  it("above_project_id : juste au-dessus (entre le précédent et lui ; avant le premier : milieu entre 0 et lui)", async () => {
    await call("move_project", { id: P(4), kanban_status: "doing", above_project_id: P(2) });
    expect(row(4).kanban_position).toBe(1536);
    await call("move_project", { id: P(7), kanban_status: "doing", above_project_id: P(1) });
    expect(row(7).kanban_position).toBe(512);
  });

  it("réordonner dans la même colonne : le projet déplacé n'est pas son propre voisin ; dates inchangées", async () => {
    await call("move_project", { id: P(1), kanban_status: "doing", below_project_id: P(3) });
    expect(row(1)).toMatchObject({ kanban_position: 4096, kanban_status: "doing", started_at: 10, finished_at: null });
  });

  it("écart trop faible entre deux voisins : retombée sur « suivant + 1024 » (règle de l'application)", async () => {
    store.seed("projects", [
      project(1, { kanban_status: "doing", kanban_position: 1 }),
      project(2, { kanban_status: "doing", kanban_position: 2 }),
      project(4, { kanban_status: "todo" }),
    ]);
    await call("move_project", { id: P(4), kanban_status: "doing", below_project_id: P(1) });
    expect(row(4).kanban_position).toBe(2 + POSITION_STEP);
  });

  it("applique les règles de dates de l'application à chaque déplacement", async () => {
    await call("move_project", { id: P(4), kanban_status: "doing" }); // todo sans début → doing : début
    expect(row(4)).toMatchObject({ started_at: NOW, finished_at: null });
    await call("move_project", { id: P(4), kanban_status: "done" }); // doing → done : fin
    expect(row(4)).toMatchObject({ started_at: NOW, finished_at: NOW });
    await call("move_project", { id: P(4), kanban_status: "todo" }); // done → todo : réouverture
    expect(row(4)).toMatchObject({ started_at: NOW, finished_at: null });
    await call("move_project", { id: P(4), kanban_status: "backlog" }); // retour au backlog : tout effacé
    expect(row(4)).toMatchObject({ started_at: null, finished_at: null });
  });

  it.each([
    ["voisin d'une autre colonne", { id: P(4), kanban_status: "doing", below_project_id: P(7) }, "colonne doing"],
    ["voisin archivé", { id: P(4), kanban_status: "doing", above_project_id: P(5) }, "non archivé"],
    ["voisin inconnu", { id: P(4), kanban_status: "doing", below_project_id: P(99) }, "colonne doing"],
    ["voisin d'un autre utilisateur", { id: P(4), kanban_status: "doing", below_project_id: P(6) }, "colonne doing"],
    ["les deux voisins", { id: P(4), kanban_status: "doing", below_project_id: P(1), above_project_id: P(2) }, "pas les deux"],
    ["lui-même comme voisin", { id: P(4), kanban_status: "doing", below_project_id: P(4) }, "lui-même"],
    ["colonne absente", { id: P(4) }, "obligatoire"],
    ["colonne inconnue", { id: P(4), kanban_status: "archive" }, "backlog, todo, doing, done"],
    ["projet inconnu", { id: P(99), kanban_status: "doing" }, "introuvable"],
    ["projet d'un autre utilisateur", { id: P(6), kanban_status: "todo" }, "introuvable"],
    ["argument inconnu", { id: P(4), kanban_status: "doing", position: 3 }, "Argument inconnu"],
  ])("refuse : %s", async (_l, args, fragment) => {
    const err = await rejected("move_project", args);
    expect(err).toBeInstanceOf(ToolInputError);
    expect(err!.message).toContain(fragment);
    expect(store.writes("projects")).toHaveLength(0);
  });

  it("lit et modifie uniquement les projets de l'utilisateur (filtres user_id)", async () => {
    await call("move_project", { id: P(4), kanban_status: "doing" });
    for (const q of store.selects("projects")) expect(q.filters).toContainEqual(["user_id", "eq", ME]);
    expect(store.writes("projects")[0].filters).toContainEqual(["user_id", "eq", ME]);
  });
});

describe("archive_project", () => {
  beforeEach(() => store.seed("projects", [
    project(1, { kanban_status: "done", kanban_position: 4096, started_at: 3, finished_at: 9 }),
    project(2, { user_id: OTHER }),
  ]));

  it("archive par défaut, sans toucher à la colonne, au rang ni aux dates ; désarchive avec archived: false", async () => {
    expect(await call("archive_project", { id: P(1) })).toMatchObject({ success: true, is_archived: true });
    expect(row(1)).toMatchObject({ is_archived: true, kanban_status: "done", kanban_position: 4096, started_at: 3, finished_at: 9, updated_at: NOW });
    await call("archive_project", { id: P(1), archived: false });
    expect(row(1).is_archived).toBe(false);
  });

  it("un projet archivé n'est plus compté pour le rangement des nouveaux projets", async () => {
    await call("archive_project", { id: P(1) });
    const out = await call("create_project", { name: "Après", kanban_status: "done" });
    expect(out.kanban_position).toBe(1024);
  });

  it("projet d'un autre utilisateur ou inconnu : « introuvable », rien n'est modifié", async () => {
    expect((await rejected("archive_project", { id: P(2) }))!.message).toContain("introuvable");
    expect((await rejected("archive_project", { id: P(99) }))!.message).toContain("introuvable");
    expect(row(2).is_archived).toBe(false);
  });

  it("refuse un booléen invalide et les arguments inconnus", async () => {
    expect(await rejected("archive_project", { id: P(1), archived: "oui" })).toBeInstanceOf(ToolInputError);
    expect((await rejected("archive_project", { id: P(1), delete: true }))!.message).toContain("Argument inconnu");
  });
});

describe("garde-fous des outils de projets", () => {
  it("les 4 outils existent, aucun ne supprime, tous refusent les arguments inconnus", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    for (const n of ["create_project", "update_project", "move_project", "archive_project"]) expect(names).toContain(n);
    expect(names.filter((n) => /delete|remove|destroy|drop/i.test(n))).toEqual([]);
    for (const t of TOOL_DEFINITIONS.filter((x) => x.name.endsWith("_project"))) {
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties, t.name).toBe(false);
    }
  });

  it("les colonnes de l'application sont exactement : backlog, todo, doing, done", () => {
    expect([...KANBAN_STATUSES]).toEqual(["backlog", "todo", "doing", "done"]);
  });
});
