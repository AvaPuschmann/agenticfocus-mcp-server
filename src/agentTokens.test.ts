/**
 * Tests du stockage des jetons d'agent — Story 27-10.
 * Le faux Supabase reproduit la règle qui compte : un refresh_token est À USAGE UNIQUE (le réutiliser = session perdue).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  AgentTokenStore, AgentAuthError, SessionRevokedError, RateLimiter, MAX_TOKENS_PER_USER,
  encrypt, decrypt, parseKey, hashToken, isAgentToken, TOKEN_PREFIX, type RefreshFn, type RefreshedSession,
} from "./agentTokens.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const KEY = randomBytes(32);

interface FakeAuth {
  refresh: RefreshFn;
  calls: string[];
  mode: "ok" | "revoked" | "network";
  delayMs: number;
  userId: string;
  current: string;
}

/** Faux Supabase Auth : refresh_token à usage unique, rotation à chaque appel. */
function fakeAuth(initial = "rt-0"): FakeAuth {
  let n = 0;
  const auth: FakeAuth = {
    calls: [], mode: "ok", delayMs: 0, userId: ME, current: initial,
    refresh: async (token: string): Promise<RefreshedSession> => {
      auth.calls.push(token);
      if (auth.delayMs) await new Promise((r) => setTimeout(r, auth.delayMs));
      if (auth.mode === "network") throw new Error("Supabase injoignable");
      if (auth.mode === "revoked" || token !== auth.current) throw new SessionRevokedError();
      n += 1;
      auth.current = `rt-${n}`;
      return { accessToken: `at-${n}`, refreshToken: auth.current, expiresAt: Math.floor(clock.t / 1000) + 3600, userId: auth.userId };
    },
  };
  return auth;
}

const clock = { t: 1_800_000_000_000 };
let dir: string;
let file: string;
let auth: FakeAuth;
const makeStore = (a: FakeAuth = auth) => new AgentTokenStore({ file, key: KEY, refresh: a.refresh, now: () => clock.t });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-tokens-"));
  file = join(dir, "tokens.json");
  clock.t = 1_800_000_000_000;
  auth = fakeAuth();
});

describe("chiffrement", () => {
  it("aller-retour, avec un IV différent à chaque chiffrement", () => {
    const a = encrypt("secret", KEY, "id-1");
    const b = encrypt("secret", KEY, "id-1");
    expect(a).not.toBe(b);
    expect(decrypt(a, KEY, "id-1")).toBe("secret");
  });
  it("refuse une mauvaise clé, un secret lié à un autre jeton, ou un contenu altéré", () => {
    const blob = encrypt("secret", KEY, "id-1");
    expect(() => decrypt(blob, randomBytes(32), "id-1")).toThrow();
    expect(() => decrypt(blob, KEY, "id-2")).toThrow();
    const parts = blob.split(".");
    parts[3] = Buffer.from("altere").toString("base64url");
    expect(() => decrypt(parts.join("."), KEY, "id-1")).toThrow();
  });
  it("parseKey n'accepte que 32 octets en base64", () => {
    expect(parseKey(KEY.toString("base64"))).toHaveLength(32);
    for (const bad of [undefined, "", "trop-court", randomBytes(16).toString("base64"), randomBytes(48).toString("base64")]) {
      expect(parseKey(bad)).toBeNull();
    }
  });
});

describe("création", () => {
  it("renvoie un jeton afk_ de 256 bits ; le fichier ne contient NI le jeton NI aucun refresh_token en clair", async () => {
    const store = makeStore();
    const { token, info } = await store.create({ userId: ME, label: "Claude Desktop", scope: "write", refreshToken: "rt-0" });
    expect(token).toMatch(/^afk_[A-Za-z0-9_-]{43}$/);
    expect(isAgentToken(token)).toBe(true);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).toContain(hashToken(token));
    expect(raw).not.toMatch(/rt-\d/);
    expect(raw).not.toMatch(/at-\d/);
    expect(info).toMatchObject({ label: "Claude Desktop", scope: "write", status: "active", userId: ME });
    expect(JSON.stringify(info)).not.toContain(hashToken(token));
  });

  it("deux jetons créés sont différents", async () => {
    const store = makeStore();
    const a = await store.create({ userId: ME, label: "a", scope: "read", refreshToken: "rt-0" });
    const b = await store.create({ userId: ME, label: "b", scope: "read", refreshToken: "rt-1" });
    expect(a.token).not.toBe(b.token);
  });

  it("refuse le refresh_token d'un AUTRE utilisateur : rien n'est stocké", async () => {
    auth.userId = OTHER;
    const store = makeStore();
    const err = await store.create({ userId: ME, label: "x", scope: "write", refreshToken: "rt-0" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentAuthError);
    expect((err as AgentAuthError).status).toBe(403);
    expect(store.list(ME)).toHaveLength(0);
    expect(store.list(OTHER)).toHaveLength(0);
  });

  it("refuse un refresh_token invalide (400) et propage une panne réseau sans rien stocker", async () => {
    const store = makeStore();
    const bad = await store.create({ userId: ME, label: "x", scope: "write", refreshToken: "faux" }).catch((e: unknown) => e);
    expect((bad as AgentAuthError).status).toBe(400);
    auth.mode = "network";
    await expect(store.create({ userId: ME, label: "x", scope: "write", refreshToken: "rt-0" })).rejects.toThrow("injoignable");
    expect(store.list(ME)).toHaveLength(0);
  });

  it(`limite à ${MAX_TOKENS_PER_USER} jetons par utilisateur (409)`, async () => {
    const store = makeStore();
    let rt = "rt-0";
    for (let i = 0; i < MAX_TOKENS_PER_USER; i++) {
      await store.create({ userId: ME, label: `t${i}`, scope: "read", refreshToken: rt });
      rt = auth.current;
    }
    const err = await store.create({ userId: ME, label: "de trop", scope: "read", refreshToken: rt }).catch((e: unknown) => e);
    expect((err as AgentAuthError).status).toBe(409);
  });
});

describe("recherche et révocation", () => {
  it("retrouve un jeton, ignore un jeton inconnu ou presque identique", async () => {
    const store = makeStore();
    const { token } = await store.create({ userId: ME, label: "x", scope: "write", refreshToken: "rt-0" });
    expect(store.lookup(token)?.userId).toBe(ME);
    expect(store.lookup(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a"))).toBeNull();
    expect(store.lookup(TOKEN_PREFIX + "inconnu")).toBeNull();
  });

  it("la liste ne montre que SES jetons, sans aucun secret", async () => {
    const store = makeStore();
    await store.create({ userId: ME, label: "mien", scope: "read", refreshToken: "rt-0" });
    auth.userId = OTHER;
    await store.create({ userId: OTHER, label: "autre", scope: "read", refreshToken: auth.current });
    const mine = store.list(ME);
    expect(mine.map((t) => t.label)).toEqual(["mien"]);
    expect(Object.keys(mine[0]).sort()).toEqual(["createdAt", "id", "label", "lastUsedAt", "scope", "status", "userId"]);
  });

  it("révoque le sien (refusé ensuite, persistant) ; celui d'un autre est introuvable et reste valide", async () => {
    const store = makeStore();
    const { token, info } = await store.create({ userId: ME, label: "x", scope: "write", refreshToken: "rt-0" });
    expect(store.revoke(OTHER, info.id)).toBe(false);
    expect(store.lookup(token)).not.toBeNull();
    expect(store.revoke(ME, info.id)).toBe(true);
    expect(store.lookup(token)).toBeNull();
    expect(makeStore().lookup(token)).toBeNull(); // persistant
  });
});

describe("renouvellement de la session", () => {
  it("jeton d'accès encore valide : AUCUN appel à Supabase", async () => {
    const store = makeStore();
    const { token } = await store.create({ userId: ME, label: "x", scope: "write", refreshToken: "rt-0" });
    const before = auth.calls.length;
    expect(await store.accessTokenFor(store.lookup(token)!)).toBe("at-1");
    expect(await store.accessTokenFor(store.lookup(token)!)).toBe("at-1");
    expect(auth.calls.length).toBe(before);
  });

  it("à moins d'une minute de l'expiration : renouvelé", async () => {
    const store = makeStore();
    const { token } = await store.create({ userId: ME, label: "x", scope: "write", refreshToken: "rt-0" });
    clock.t += 3600_000 - 30_000;
    expect(await store.accessTokenFor(store.lookup(token)!)).toBe("at-2");
  });

  it("le NOUVEAU refresh_token est enregistré (un redémarrage du serveur ne casse pas le jeton)", async () => {
    const store = makeStore();
    const { token } = await store.create({ userId: ME, label: "x", scope: "write", refreshToken: "rt-0" });
    clock.t += 7200_000;
    await store.accessTokenFor(store.lookup(token)!); // rt-1 consommé, rt-2 stocké
    const restarted = makeStore(); // nouveau processus : cache vide, relit le fichier
    expect(await restarted.accessTokenFor(restarted.lookup(token)!)).toBe("at-3");
  });

  it("5 requêtes simultanées avec un jeton expiré ne consomment qu'UN SEUL refresh_token", async () => {
    const store = makeStore();
    const { token } = await store.create({ userId: ME, label: "x", scope: "write", refreshToken: "rt-0" });
    clock.t += 7200_000;
    auth.delayMs = 20;
    const before = auth.calls.length;
    const results = await Promise.all(Array.from({ length: 5 }, () => store.accessTokenFor(store.lookup(token)!)));
    expect(new Set(results)).toEqual(new Set(["at-2"]));
    expect(auth.calls.length - before).toBe(1);
  });

  it("session révoquée côté Supabase : jeton marqué « à recréer », message clair, plus aucun appel ensuite", async () => {
    const store = makeStore();
    const { token } = await store.create({ userId: ME, label: "x", scope: "write", refreshToken: "rt-0" });
    clock.t += 7200_000;
    auth.mode = "revoked";
    const err = await store.accessTokenFor(store.lookup(token)!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentAuthError);
    expect((err as Error).message).toContain("Recréez");
    const calls = auth.calls.length;
    await expect(store.accessTokenFor(store.lookup(token)!)).rejects.toBeInstanceOf(AgentAuthError);
    expect(auth.calls.length).toBe(calls);
    expect(store.list(ME)[0].status).toBe("broken");
    expect(JSON.parse(readFileSync(file, "utf8")).tokens[0].status).toBe("broken"); // persistant
  });

  it("panne réseau : la requête échoue mais le jeton reste actif et réessaie ensuite", async () => {
    const store = makeStore();
    const { token } = await store.create({ userId: ME, label: "x", scope: "write", refreshToken: "rt-0" });
    clock.t += 7200_000;
    auth.mode = "network";
    await expect(store.accessTokenFor(store.lookup(token)!)).rejects.toThrow("injoignable");
    expect(store.list(ME)[0].status).toBe("active");
    auth.mode = "ok";
    expect(await store.accessTokenFor(store.lookup(token)!)).toBe("at-2");
  });

  it("une session qui change d'utilisateur désactive le jeton (jamais de repli sur un autre compte)", async () => {
    const store = makeStore();
    const { token } = await store.create({ userId: ME, label: "x", scope: "write", refreshToken: "rt-0" });
    clock.t += 7200_000;
    auth.userId = OTHER;
    const err = await store.accessTokenFor(store.lookup(token)!).catch((e: unknown) => e);
    expect((err as AgentAuthError).status).toBe(403);
    expect(store.list(ME)[0].status).toBe("broken");
  });

  it("un fichier de jetons falsifié (secret recopié d'un autre jeton) n'est pas déchiffrable", async () => {
    const store = makeStore();
    const a = await store.create({ userId: ME, label: "a", scope: "write", refreshToken: "rt-0" });
    const b = await store.create({ userId: ME, label: "b", scope: "write", refreshToken: auth.current });
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.tokens[1].refreshTokenEnc = data.tokens[0].refreshTokenEnc; // secret de a collé sur b
    writeFileSync(file, JSON.stringify(data));
    const tampered = makeStore();
    clock.t += 7200_000;
    await expect(tampered.accessTokenFor(tampered.lookup(b.token)!)).rejects.toThrow();
    void a;
  });

  it("enregistre la date de dernier usage", async () => {
    const store = makeStore();
    const { token } = await store.create({ userId: ME, label: "x", scope: "write", refreshToken: "rt-0" });
    expect(store.list(ME)[0].lastUsedAt).toBeNull();
    await store.accessTokenFor(store.lookup(token)!);
    expect(store.list(ME)[0].lastUsedAt).toBe(clock.t);
  });
});

describe("limite de débit", () => {
  it("autorise `max` requêtes par minute et par clé, puis refuse ; la fenêtre glisse", () => {
    let t = 0;
    const limiter = new RateLimiter(3, 60_000, () => t);
    expect([1, 2, 3, 4].map(() => limiter.allow("a"))).toEqual([true, true, true, false]);
    expect(limiter.allow("b")).toBe(true); // une autre clé n'est pas touchée
    t = 59_999;
    expect(limiter.allow("a")).toBe(false);
    t = 60_001;
    expect(limiter.allow("a")).toBe(true);
  });
});
