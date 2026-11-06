/**
 * Jetons d'agent (Story 27-10) : un secret long, révocable, à donner à Claude Desktop / claude.ai / mobile ou à Hermes
 * à la place du jeton Supabase d'une heure ou du mot de passe.
 *
 *  - le jeton (`afk_` + 256 bits) n'est jamais stocké : seule son empreinte SHA-256 l'est ; il n'est montré qu'une fois ;
 *  - chaque jeton possède une SESSION Supabase dédiée ; son refresh_token (à usage unique) est chiffré (AES-256-GCM)
 *    dans un fichier, et le NOUVEAU est enregistré AVANT d'être utilisé ;
 *  - le renouvellement est sérialisé par jeton : deux requêtes simultanées ne consomment qu'un seul refresh_token ;
 *  - la RLS s'applique (jamais de `service_role`) : l'agent ne voit que les données de l'utilisateur.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export const TOKEN_PREFIX = "afk_";
export type Scope = "read" | "write";

/** Session Supabase renvoyée par un renouvellement. */
export interface RefreshedSession {
  accessToken: string;
  refreshToken: string;
  /** Expiration de l'access token, en secondes depuis 1970. */
  expiresAt: number;
  userId: string;
}

/** Renouvelle une session Supabase à partir d'un refresh_token (usage unique). */
export type RefreshFn = (refreshToken: string) => Promise<RefreshedSession>;

/** Supabase a REFUSÉ le refresh_token (session révoquée, jeton déjà utilisé) : la session est perdue. */
export class SessionRevokedError extends Error {
  constructor(message = "Session Supabase refusée") {
    super(message);
    this.name = "SessionRevokedError";
  }
}

/** Erreur d'authentification présentable à l'agent (HTTP 401). */
export class AgentAuthError extends Error {
  constructor(message: string, public status = 401) {
    super(message);
    this.name = "AgentAuthError";
  }
}

export interface AgentTokenRecord {
  id: string;
  hash: string;
  userId: string;
  label: string;
  scope: Scope;
  createdAt: number;
  lastUsedAt: number | null;
  status: "active" | "broken";
  /** refresh_token chiffré (`v1.<iv>.<tag>.<texte>`), lié à l'identifiant du jeton. */
  refreshTokenEnc: string;
}

export type PublicTokenInfo = Omit<AgentTokenRecord, "hash" | "refreshTokenEnc">;

export const MAX_TOKENS_PER_USER = 10;
const EARLY_REFRESH_SECONDS = 60;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const isAgentToken = (bearer: string): boolean => bearer.startsWith(TOKEN_PREFIX);

/** Clé AES-256 : 32 octets en base64 (`openssl rand -base64 32`). Renvoie null si absente ou invalide. */
export function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw.trim(), "base64");
  return key.length === 32 ? key : null;
}

export function encrypt(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decrypt(blob: string, key: Buffer, aad: string): string {
  const [version, iv, tag, body] = blob.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Format de secret chiffré inconnu");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

const publicInfo = ({ hash: _h, refreshTokenEnc: _r, ...rest }: AgentTokenRecord): PublicTokenInfo => rest;

export interface StoreOptions {
  file: string;
  key: Buffer;
  refresh: RefreshFn;
  /** Horloge en millisecondes (injectable pour les tests). */
  now?: () => number;
}

export class AgentTokenStore {
  private readonly file: string;
  private readonly key: Buffer;
  private readonly refreshFn: RefreshFn;
  private readonly now: () => number;
  private records: AgentTokenRecord[] = [];
  private readonly cache = new Map<string, { accessToken: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<string>>();
  private lastPersistedUse = 0;

  constructor(opts: StoreOptions) {
    this.file = opts.file;
    this.key = opts.key;
    this.refreshFn = opts.refresh;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  // ── persistance ────────────────────────────────────────────────────────────

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as { version?: number; tokens?: AgentTokenRecord[] };
      this.records = Array.isArray(data.tokens) ? data.tokens : [];
    } catch {
      this.records = []; // premier démarrage : fichier absent
    }
  }

  /** Écriture atomique (fichier temporaire puis renommage) : jamais de fichier à moitié écrit. */
  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, tokens: this.records }), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* sans effet sous Windows */ }
    renameSync(tmp, this.file);
  }

  // ── gestion ───────────────────────────────────────────────────────────────

  /**
   * Crée un jeton à partir d'un refresh_token de l'utilisateur. Le refresh_token est d'abord CONSOMMÉ (renouvellement)
   * pour prouver qu'il est valide et qu'il appartient bien à `userId` ; le nouveau est stocké chiffré.
   * Le secret en clair n'est renvoyé qu'ici.
   */
  async create(input: { userId: string; label: string; scope: Scope; refreshToken: string }): Promise<{ token: string; info: PublicTokenInfo }> {
    if (this.records.filter((r) => r.userId === input.userId).length >= MAX_TOKENS_PER_USER) {
      throw new AgentAuthError(`Limite atteinte : ${MAX_TOKENS_PER_USER} jetons par utilisateur. Révoquez-en un.`, 409);
    }
    let session: RefreshedSession;
    try {
      session = await this.refreshFn(input.refreshToken);
    } catch (err) {
      if (err instanceof SessionRevokedError) throw new AgentAuthError("refresh_token refusé par Supabase.", 400);
      throw err;
    }
    if (session.userId !== input.userId) throw new AgentAuthError("Ce refresh_token n'appartient pas à l'utilisateur du jeton.", 403);

    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const id = randomUUID();
    const record: AgentTokenRecord = {
      id,
      hash: hashToken(token),
      userId: input.userId,
      label: input.label,
      scope: input.scope,
      createdAt: this.now(),
      lastUsedAt: null,
      status: "active",
      refreshTokenEnc: encrypt(session.refreshToken, this.key, id),
    };
    this.records.push(record);
    this.persist();
    this.cache.set(id, { accessToken: session.accessToken, expiresAt: session.expiresAt });
    return { token, info: publicInfo(record) };
  }

  list(userId: string): PublicTokenInfo[] {
    return this.records.filter((r) => r.userId === userId).map(publicInfo);
  }

  /** Révoque un jeton de CET utilisateur (celui d'un autre n'existe pas pour lui). */
  revoke(userId: string, id: string): boolean {
    const index = this.records.findIndex((r) => r.id === id && r.userId === userId);
    if (index < 0) return false;
    this.records.splice(index, 1);
    this.cache.delete(id);
    this.persist();
    return true;
  }

  // ── utilisation ────────────────────────────────────────────────────────────

  /** Retrouve l'enregistrement d'un jeton sans rien renouveler (comparaison en temps constant). */
  lookup(token: string): AgentTokenRecord | null {
    const hash = Buffer.from(hashToken(token), "hex");
    return this.records.find((r) => timingSafeEqual(Buffer.from(r.hash, "hex"), hash)) ?? null;
  }

  /** Jeton d'accès Supabase valide pour ce jeton d'agent (renouvelé et enregistré si nécessaire). */
  async accessTokenFor(record: AgentTokenRecord): Promise<string> {
    if (record.status === "broken") {
      throw new AgentAuthError("Ce jeton d'agent n'est plus valide (session Supabase perdue). Recréez-en un.");
    }
    const cached = this.cache.get(record.id);
    if (cached && cached.expiresAt - this.now() / 1000 > EARLY_REFRESH_SECONDS) {
      this.markUsed(record);
      return cached.accessToken;
    }
    // Un seul renouvellement à la fois pour ce jeton : le refresh_token est à usage unique.
    let pending = this.inflight.get(record.id);
    if (!pending) {
      pending = this.renew(record).finally(() => this.inflight.delete(record.id));
      this.inflight.set(record.id, pending);
    }
    const accessToken = await pending;
    this.markUsed(record);
    return accessToken;
  }

  private async renew(record: AgentTokenRecord): Promise<string> {
    let session: RefreshedSession;
    try {
      session = await this.refreshFn(decrypt(record.refreshTokenEnc, this.key, record.id));
    } catch (err) {
      if (err instanceof SessionRevokedError) {
        record.status = "broken";
        this.persist();
        this.cache.delete(record.id);
        throw new AgentAuthError("Ce jeton d'agent n'est plus valide (session Supabase révoquée). Recréez-en un.");
      }
      throw err; // panne réseau : le jeton reste actif, la requête échoue (503)
    }
    if (session.userId !== record.userId) {
      record.status = "broken";
      this.persist();
      throw new AgentAuthError("Session incohérente : jeton désactivé.", 403);
    }
    // Le NOUVEAU refresh_token est enregistré AVANT toute utilisation : une coupure ne le fait pas perdre.
    record.refreshTokenEnc = encrypt(session.refreshToken, this.key, record.id);
    this.persist();
    this.cache.set(record.id, { accessToken: session.accessToken, expiresAt: session.expiresAt });
    return session.accessToken;
  }

  /** Date de dernier usage : mise à jour en mémoire, écrite au plus une fois par minute. */
  private markUsed(record: AgentTokenRecord): void {
    const t = this.now();
    record.lastUsedAt = t;
    if (t - this.lastPersistedUse > 60_000) {
      this.lastPersistedUse = t;
      this.persist();
    }
  }
}

/** Limite de débit : `max` requêtes par fenêtre glissante d'une minute et par clé. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max = 120, private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}

  /** true si la requête est autorisée. */
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

/** Renouvellement réel auprès de Supabase Auth. */
export function supabaseRefresh(supabaseUrl: string, anonKey: string): RefreshFn {
  return async (refreshToken) => {
    let res: Response;
    try {
      res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: anonKey, "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      throw new Error(`Supabase injoignable : ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = (await res.json().catch(() => null)) as {
      access_token?: string; refresh_token?: string; expires_at?: number; expires_in?: number; user?: { id?: string };
    } | null;
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new SessionRevokedError();
    if (!res.ok || !body?.access_token || !body.refresh_token || !body.user?.id) {
      throw new Error(`Renouvellement Supabase impossible (HTTP ${res.status})`);
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_at ?? Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600),
      userId: body.user.id,
    };
  };
}
