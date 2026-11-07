/**
 * Tests des outils de la bibliothèque (domaines et activités) — Story 27-12.
 * Seules les colonnes réellement synchronisées avec Supabase (desktop `toSupabasePayload`, DTO Android) sont écrites.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createFakeStore } from "./fakeSupabase.js";
import { runTool, TOOL_DEFINITIONS, type ToolContext } from "./tools.js";
import { DEFAULT_COLOR, MAX_DOMAIN_NAME, MAX_TITLE, MAX_NOTE } from "./library.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const D1 = "dddddddd-dddd-4ddd-8ddd-000000000001";
const D2 = "dddddddd-dddd-4ddd-8ddd-000000000002";
const D_OTHER = "dddddddd-dddd-4ddd-8ddd-000000000099";
const A = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const NOW_DATE = new Date("2026-11-07T10:00:00Z");
const NOW = NOW_DATE.getTime();

const store = createFakeStore();
const ctx = (): ToolContext => ({ userId: ME, supabase: store.clientFor("jwt-A"), now: () => NOW_DATE, timeZone: "Europe/Paris" });
const call = async (name: string, args: unknown) => JSON.parse(await runTool(name, args, ctx()));
const rejected = async (name: string, args: unknown) => runTool(name, args, ctx()).then(() => null, (e: unknown) => e as Error);

const activity = (n: number, over: Record<string, unknown> = {}) => ({
  id: A(n), user_id: ME, domain_id: D1, title: `Activité ${n}`, note: null, story_points: 1, default_pomodoros: 1, updated_at: 1, ...over,
});

beforeEach(() => {
  store.reset();
  store.seed("domains", [
    { id: D1, user_id: ME, name: "Sport", color: "#2196F3", updated_at: 1 },
    { id: D2, user_id: ME, name: "Pro", color: "#FF9800", updated_at: 1 },
    { id: D_OTHER, user_id: OTHER, name: "Santé", color: "#E91E63", updated_at: 1 },
  ]);
});

describe("create_domain", () => {
  it("crée un domaine avec la couleur par défaut, uniquement les colonnes synchronisées", async () => {
    const out = await call("create_domain", { name: "  Famille " });
    expect(out).toMatchObject({ success: true, name: "Famille", color: DEFAULT_COLOR });
    const row = store.tables.domains.find((r) => r.id === out.id)!;
    expect(row).toEqual({ id: out.id, user_id: ME, name: "Famille", color: DEFAULT_COLOR, updated_at: NOW });
  });

  it("normalise la couleur en majuscules", async () => {
    const out = await call("create_domain", { name: "Art", color: "#9c27b0" });
    expect(out.color).toBe("#9C27B0");
  });

  it.each(["rouge", "#FFF", "#GGGGGG", "9C27B0", "#9C27B0FF", 5])("refuse la couleur %j", async (color) => {
    expect((await rejected("create_domain", { name: "X", color }))?.message).toContain("color");
    expect(store.writes("domains")).toHaveLength(0);
  });

  it("refuse un nom vide, trop long, ou un doublon (casse ignorée)", async () => {
    expect((await rejected("create_domain", {}))?.message).toContain("name");
    expect((await rejected("create_domain", { name: "   " }))?.message).toContain("name");
    expect((await rejected("create_domain", { name: "x".repeat(MAX_DOMAIN_NAME + 1) }))?.message).toContain("trop long");
    const dup = await rejected("create_domain", { name: "sport" });
    expect(dup?.message).toContain("existe déjà");
    expect(dup?.message).toContain(D1);
    expect(store.writes("domains")).toHaveLength(0);
  });

  it("un homonyme chez un AUTRE utilisateur n'est pas un doublon", async () => {
    const out = await call("create_domain", { name: "Santé" });
    expect(out.success).toBe(true);
  });

  it("refuse user_id et les arguments inconnus", async () => {
    expect((await rejected("create_domain", { name: "X", user_id: OTHER }))?.message).toContain("user_id");
    expect(store.writes("domains")).toHaveLength(0);
  });
});

describe("update_domain", () => {
  it("renomme et change la couleur ; seuls les champs fournis changent", async () => {
    const out = await call("update_domain", { id: D1, name: "Sport & santé" });
    expect(out.updated).toEqual(["name"]);
    expect(store.tables.domains.find((r) => r.id === D1)).toMatchObject({ name: "Sport & santé", color: "#2196F3", updated_at: NOW });
    await call("update_domain", { id: D1, color: "#4caf50" });
    expect(store.tables.domains.find((r) => r.id === D1)).toMatchObject({ name: "Sport & santé", color: "#4CAF50" });
  });

  it("peut se renommer avec sa propre casse différente (pas un doublon de soi-même)", async () => {
    expect((await call("update_domain", { id: D1, name: "SPORT" })).success).toBe(true);
  });

  it("refuse le nom d'un autre domaine", async () => {
    expect((await rejected("update_domain", { id: D1, name: "pro" }))?.message).toContain("existe déjà");
    expect(store.tables.domains.find((r) => r.id === D1)!.name).toBe("Sport");
  });

  it("refuse sans champ, avec un nom null, ou avec un id invalide", async () => {
    expect((await rejected("update_domain", { id: D1 }))?.message).toContain("Aucun champ");
    expect((await rejected("update_domain", { id: D1, name: null }))?.message).toContain("name");
    expect((await rejected("update_domain", { id: "pas-un-uuid", name: "X" }))?.message).toContain("UUID");
  });

  it("domaine d'un autre utilisateur ou inconnu : « introuvable », et rien n'est modifié", async () => {
    expect((await rejected("update_domain", { id: D_OTHER, name: "Piraté" }))?.message).toContain("introuvable");
    expect((await rejected("update_domain", { id: A(7), name: "Inconnu" }))?.message).toContain("introuvable");
    expect(store.tables.domains.find((r) => r.id === D_OTHER)!.name).toBe("Santé");
  });
});

describe("create_activity", () => {
  it("crée avec les défauts de l'application (1 point, 1 pomodoro) et uniquement les colonnes synchronisées", async () => {
    const out = await call("create_activity", { domain_id: D1, title: "Courir 30 min" });
    expect(out).toMatchObject({ success: true, domain_id: D1, title: "Courir 30 min", story_points: 1, default_pomodoros: 1 });
    expect(store.tables.task_templates.find((r) => r.id === out.id)).toEqual({
      id: out.id, user_id: ME, domain_id: D1, title: "Courir 30 min", note: null, story_points: 1, default_pomodoros: 1, updated_at: NOW,
    });
  });

  it("accepte note, points et pomodoros, y compris 0", async () => {
    const out = await call("create_activity", { domain_id: D2, title: "Revue", note: "  hebdo ", story_points: 0, default_pomodoros: 0 });
    expect(store.tables.task_templates.find((r) => r.id === out.id)).toMatchObject({ note: "hebdo", story_points: 0, default_pomodoros: 0 });
  });

  it("refuse un domaine inconnu ou d'un autre utilisateur, sans écrire", async () => {
    expect((await rejected("create_activity", { domain_id: D_OTHER, title: "X" }))?.message).toContain("domain_id inconnu");
    expect((await rejected("create_activity", { domain_id: A(5), title: "X" }))?.message).toContain("domain_id inconnu");
    expect(store.writes("task_templates")).toHaveLength(0);
  });

  it("refuse les valeurs hors bornes et les champs manquants", async () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ title: "X" }, "domain_id"],
      [{ domain_id: D1 }, "title"],
      [{ domain_id: D1, title: "x".repeat(MAX_TITLE + 1) }, "trop long"],
      [{ domain_id: D1, title: "X", note: "n".repeat(MAX_NOTE + 1) }, "trop long"],
      [{ domain_id: D1, title: "X", story_points: 1000 }, "entre 0 et 999"],
      [{ domain_id: D1, title: "X", story_points: -1 }, "entre 0 et 999"],
      [{ domain_id: D1, title: "X", story_points: 1.5 }, "entier"],
      [{ domain_id: D1, title: "X", default_pomodoros: 100 }, "entre 0 et 99"],
      [{ domain_id: D1, title: "X", impact: "high" }, "impact"],
      [{ domain_id: D1, title: "X", user_id: OTHER }, "user_id"],
    ];
    for (const [args, fragment] of bad) expect((await rejected("create_activity", args))?.message, JSON.stringify(args)).toContain(fragment);
    expect(store.writes("task_templates")).toHaveLength(0);
  });
});

describe("update_activity", () => {
  beforeEach(() => {
    store.seed("task_templates", [
      activity(1, { note: "à effacer" }),
      activity(2, { domain_id: D2 }),
      activity(9, { user_id: OTHER, domain_id: D_OTHER, title: "Secrète" }),
    ]);
  });
  const row = (n: number) => store.tables.task_templates.find((r) => r.id === A(n))!;

  it("modifie titre, points, pomodoros ; le reste est intact", async () => {
    const out = await call("update_activity", { id: A(1), title: "Nouveau titre", story_points: 5, default_pomodoros: 3 });
    expect(out.updated).toEqual(["title", "story_points", "default_pomodoros"]);
    expect(row(1)).toMatchObject({ title: "Nouveau titre", story_points: 5, default_pomodoros: 3, note: "à effacer", domain_id: D1, updated_at: NOW });
  });

  it("null efface la note ; une note vide aussi", async () => {
    await call("update_activity", { id: A(1), note: null });
    expect(row(1).note).toBeNull();
    await call("update_activity", { id: A(2), note: "x" });
    await call("update_activity", { id: A(2), note: "  " });
    expect(row(2).note).toBeNull();
  });

  it("déplace vers un autre domaine de l'utilisateur", async () => {
    await call("update_activity", { id: A(1), domain_id: D2 });
    expect(row(1).domain_id).toBe(D2);
  });

  it("refuse un domaine étranger ou null, sans rien modifier", async () => {
    expect((await rejected("update_activity", { id: A(1), domain_id: D_OTHER }))?.message).toContain("domain_id inconnu");
    expect((await rejected("update_activity", { id: A(1), domain_id: null }))?.message).toContain("domain_id");
    expect(row(1).domain_id).toBe(D1);
  });

  it("refuse sans champ et refuse les bornes", async () => {
    expect((await rejected("update_activity", { id: A(1) }))?.message).toContain("Aucun champ");
    expect((await rejected("update_activity", { id: A(1), title: "" }))?.message).toContain("title");
    expect((await rejected("update_activity", { id: A(1), story_points: 1000 }))?.message).toContain("999");
  });

  it("activité d'un autre utilisateur ou inconnue : « introuvable », rien n'est modifié", async () => {
    expect((await rejected("update_activity", { id: A(9), title: "Piraté" }))?.message).toContain("introuvable");
    expect((await rejected("update_activity", { id: A(8), title: "Inconnue" }))?.message).toContain("introuvable");
    expect(row(9).title).toBe("Secrète");
  });
});

describe("list_activities", () => {
  beforeEach(() => {
    store.seed("task_templates", [
      activity(1, { title: "Zumba" }),
      activity(2, { title: "Abdos" }),
      activity(3, { domain_id: D2, title: "Revue" }),
      activity(9, { user_id: OTHER, domain_id: D_OTHER, title: "Secrète" }),
    ]);
  });

  it("liste celles de l'utilisateur seulement, triées par domaine puis titre", async () => {
    const out = await call("list_activities", {});
    expect(out.count).toBe(3);
    expect(out.truncated).toBe(false);
    expect(out.activities.map((a: { title: string }) => a.title)).toEqual(["Abdos", "Zumba", "Revue"]);
    expect(JSON.stringify(out)).not.toContain("Secrète");
    expect(out.activities[0]).toMatchObject({ id: A(2), domain_id: D1, title: "Abdos", note: null, story_points: 1, default_pomodoros: 1 });
  });

  it("filtre par domaine", async () => {
    const out = await call("list_activities", { domain_id: D2 });
    expect(out.activities.map((a: { title: string }) => a.title)).toEqual(["Revue"]);
  });

  it("signale la troncature à 200", async () => {
    store.seed("task_templates", Array.from({ length: 201 }, (_, i) => activity(i + 1, { title: `T${String(i).padStart(3, "0")}` })));
    const out = await call("list_activities", {});
    expect(out).toMatchObject({ count: 200, truncated: true, limit: 200 });
    expect(out.activities).toHaveLength(200);
  });

  it("refuse un domain_id invalide", async () => {
    expect((await rejected("list_activities", { domain_id: "x" }))?.message).toContain("UUID");
  });
});

describe("garde-fous", () => {
  it("aucun outil de la bibliothèque ne supprime ; les écritures passent toutes par insert / update", async () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names.filter((n) => /delete|remove|supprim/i.test(n))).toEqual([]);
    await call("create_domain", { name: "Nouveau" });
    await call("update_domain", { id: D1, name: "Autre" });
    await call("create_activity", { domain_id: D1, title: "T" });
    expect([...store.writes("domains"), ...store.writes("task_templates")].every((c) => c.op === "insert" || c.op === "update")).toBe(true);
  });

  it("toute modification est filtrée par user_id", async () => {
    store.seed("task_templates", [activity(1)]);
    await call("update_domain", { id: D1, color: "#009688" });
    await call("update_activity", { id: A(1), title: "T2" });
    for (const c of [...store.writes("domains"), ...store.writes("task_templates")].filter((c) => c.op === "update")) {
      expect(c.filters).toContainEqual(["user_id", "eq", ME]);
    }
  });

  it("une erreur Supabase est signalée (pas de succès silencieux)", async () => {
    store.failNext({ message: "boom", code: "XX000" });
    expect(await rejected("create_domain", { name: "Z" })).toBeInstanceOf(Error);
  });
});
