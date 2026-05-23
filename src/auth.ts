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
import { jwtVerify, type JWTPayload } from "jose";

// ─── Type augmentation ────────────────────────────────────────────────────────
// Add userId / userJwt fields to Express Request — usable in any handler that runs after verifyJwtMiddleware.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      userJwt?: string;
    }
  }
}

// ─── Pure JWT verifier (testable) ─────────────────────────────────────────────

/**
 * Verify a Supabase JWT signed HS256 with the project's JWT secret.
 *
 * @throws if signature invalid, token expired, or claim `sub` missing/empty.
 */
export async function verifyJwtToken(
  jwt: string,
  jwtSecret: string,
): Promise<{ sub: string; payload: JWTPayload }> {
  if (!jwt || jwt.length < 10) {
    throw new Error("JWT empty or too short");
  }
  if (!jwtSecret) {
    throw new Error("JWT secret not configured");
  }

  const secretBytes = new TextEncoder().encode(jwtSecret);
  const { payload } = await jwtVerify(jwt, secretBytes, {
    algorithms: ["HS256"],
  });

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
export function verifyJwtMiddleware(jwtSecret: string) {
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
      const { sub } = await verifyJwtToken(jwt, jwtSecret);
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
