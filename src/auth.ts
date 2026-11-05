/**
 * JWT verification middleware — Story 25-2 Sprint 24 Epic 25.
 *
 * Verifies the Authorization header on every incoming HTTP request :
 *   - Extracts `Authorization: Bearer <jwt>`
 *   - Verifies HS256 signature with SUPABASE_JWT_SECRET (Supabase project secret)
 *   - Verifies expiration (exp claim)
 *   - Attaches `req.userId` (sub claim) + `req.userJwt` for downstream propagation
 *
 * On failure : 401 JSON-RPC error response, request never reaches the MCP handler.
 *
 * Replaces the single-user env-var auth (SUPABASE_USER_JWT + USER_ID) from
 * the Story 23-7 POC and Story 25-1 V1 HTTP transport.
 */

import type { Request, Response, NextFunction } from "express";
import { jwtVerify, createRemoteJWKSet, decodeProtectedHeader, type JWTPayload } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

// ─── JWKS resolver (asymmetric signing keys) ──────────────────────────────────
// Supabase a migré les tokens utilisateur vers des JWT Signing Keys asymétriques
// (ES256/RS256). On résout les clés publiques via le endpoint JWKS du projet et on
// cache le résolveur (jose gère le refetch/rotation). Le HS256 (Legacy JWT secret)
// reste supporté en repli. — Story 25-5 (fix runtime ES256 2026-06-13).

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedJwksUrl: string | undefined;

function jwksFor(supabaseUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const url = `${supabaseUrl.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`;
  if (!cachedJwks || cachedJwksUrl !== url) {
    cachedJwks = createRemoteJWKSet(new URL(url));
    cachedJwksUrl = url;
  }
  return cachedJwks;
}

// ─── Type augmentation ────────────────────────────────────────────────────────
// Add userId / userJwt fields to Express Request — usable in any handler that runs after verifyJwtMiddleware.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      userJwt?: string;
      /** Lu par le transport MCP et transmis aux outils (`extra.authInfo`) : le jeton de CETTE requête. */
      auth?: AuthInfo;
    }
  }
}

// ─── Pure JWT verifier (testable) ─────────────────────────────────────────────

/**
 * Verify a Supabase user JWT.
 *
 * Détecte l'algorithme du token :
 *   - `HS256` → vérifie avec le Legacy JWT secret (`jwtSecret`).
 *   - `ES256` / `RS256` / `EdDSA` → vérifie via le JWKS du projet (`supabaseUrl` requis) —
 *     c'est le cas des nouvelles JWT Signing Keys asymétriques de Supabase.
 *
 * @throws if signature invalid, token expired, alg non supporté, ou claim `sub` manquant.
 */
export async function verifyJwtToken(
  jwt: string,
  jwtSecret: string,
  supabaseUrl?: string,
): Promise<{ sub: string; payload: JWTPayload }> {
  if (!jwt || jwt.length < 10) {
    throw new Error("JWT empty or too short");
  }

  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(jwt).alg;
  } catch {
    throw new Error("JWT header malformed");
  }

  let payload: JWTPayload;
  if (alg === "HS256") {
    if (!jwtSecret) {
      throw new Error("HS256 token but JWT secret not configured");
    }
    const secretBytes = new TextEncoder().encode(jwtSecret);
    ({ payload } = await jwtVerify(jwt, secretBytes, { algorithms: ["HS256"] }));
  } else {
    if (!supabaseUrl) {
      throw new Error(`Token alg '${alg ?? "?"}' requires JWKS verification but SUPABASE_URL is not configured`);
    }
    ({ payload } = await jwtVerify(jwt, jwksFor(supabaseUrl), {
      algorithms: ["ES256", "RS256", "EdDSA"],
    }));
  }

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new Error("JWT missing 'sub' (user id) claim");
  }

  return { sub, payload };
}

// ─── Express middleware ───────────────────────────────────────────────────────

/**
 * Returns a middleware that verifies the JWT and propagates userId + userJwt
 * to the request. On error, responds with JSON-RPC 401.
 *
 * Use this on every /mcp route (POST + GET + DELETE).
 */
export function verifyJwtMiddleware(jwtSecret: string, supabaseUrl?: string) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers["authorization"];

    if (!authHeader || typeof authHeader !== "string") {
      jsonRpcError(res, 401, "Missing Authorization header");
      return;
    }

    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (!match) {
      jsonRpcError(res, 401, "Authorization header must be 'Bearer <jwt>'");
      return;
    }

    const jwt = match[1];

    try {
      const { sub } = await verifyJwtToken(jwt, jwtSecret, supabaseUrl);
      req.userId = sub;
      req.userJwt = jwt;
      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonRpcError(res, 401, `JWT verification failed: ${message}`);
    }
  };
}

function jsonRpcError(res: Response, httpStatus: number, message: string): void {
  res.status(httpStatus).json({
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message,
    },
    id: null,
  });
}
