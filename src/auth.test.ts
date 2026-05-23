/**
 * Tests for verifyJwtToken + verifyJwtMiddleware — Story 25-2 Sprint 24.
 * AI-S21-A obligatoire (5 cas minimum).
 */

import { describe, it, expect, vi } from "vitest";
import { SignJWT } from "jose";
import { verifyJwtToken, verifyJwtMiddleware } from "./auth.js";

const SECRET = "test-secret-very-long-string-do-not-use-in-prod-1234567890";
const USER_ID = "d9dd9a28-ec9c-4a67-9253-f673021c1611";

async function makeJwt(opts: {
  secret?: string;
  sub?: string;
  expiresIn?: string;
  noSub?: boolean;
} = {}): Promise<string> {
  const builder = new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt();
  if (!opts.noSub) builder.setSubject(opts.sub ?? USER_ID);
  builder.setExpirationTime(opts.expiresIn ?? "1h");
  const secretBytes = new TextEncoder().encode(opts.secret ?? SECRET);
  return builder.sign(secretBytes);
}

// ─── verifyJwtToken (pure function) ──────────────────────────────────────────

describe("verifyJwtToken", () => {
  it("returns sub claim for a valid HS256 JWT signed with the right secret", async () => {
    const jwt = await makeJwt({});
    const { sub, payload } = await verifyJwtToken(jwt, SECRET);
    expect(sub).toBe(USER_ID);
    expect(payload.sub).toBe(USER_ID);
  });

  it("throws for a JWT signed with a different secret", async () => {
    const jwt = await makeJwt({ secret: "wrong-secret-very-long-string-1234567890" });
    await expect(verifyJwtToken(jwt, SECRET)).rejects.toThrow();
  });

  it("throws for an expired JWT", async () => {
    // Build a token expired 60s ago manually (jose's setExpirationTime accepts negative-relative)
    const expiredSecret = new TextEncoder().encode(SECRET);
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(USER_ID)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(expiredSecret);
    await expect(verifyJwtToken(jwt, SECRET)).rejects.toThrow();
  });

  it("throws for a JWT missing the 'sub' claim", async () => {
    const jwt = await makeJwt({ noSub: true });
    await expect(verifyJwtToken(jwt, SECRET)).rejects.toThrow(/sub/i);
  });

  it("throws for empty or too-short JWT input", async () => {
    await expect(verifyJwtToken("", SECRET)).rejects.toThrow();
    await expect(verifyJwtToken("abc", SECRET)).rejects.toThrow();
  });

  it("throws when jwtSecret is empty", async () => {
    const jwt = await makeJwt({});
    await expect(verifyJwtToken(jwt, "")).rejects.toThrow();
  });
});

// ─── verifyJwtMiddleware (Express integration via mocks) ─────────────────────

function makeMockRes() {
  const res: { statusCode?: number; body?: unknown; status: (n: number) => typeof res; json: (b: unknown) => typeof res } = {
    statusCode: undefined,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return res;
}

describe("verifyJwtMiddleware", () => {
  it("attaches userId + userJwt to req and calls next() on valid JWT", async () => {
    const jwt = await makeJwt({});
    const req = { headers: { authorization: `Bearer ${jwt}` }, userId: undefined, userJwt: undefined } as never;
    const res = makeMockRes() as never;
    const next = vi.fn();

    const mw = verifyJwtMiddleware(SECRET);
    await mw(req, res, next);

    expect((req as { userId?: string }).userId).toBe(USER_ID);
    expect((req as { userJwt?: string }).userJwt).toBe(jwt);
    expect(next).toHaveBeenCalledTimes(1);
    expect((res as { statusCode?: number }).statusCode).toBeUndefined();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const req = { headers: {} } as never;
    const res = makeMockRes();
    const next = vi.fn();

    const mw = verifyJwtMiddleware(SECRET);
    await mw(req, res as never, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32001 },
      id: null,
    });
  });

  it("returns 401 when Authorization header is malformed (no Bearer prefix)", async () => {
    const jwt = await makeJwt({});
    const req = { headers: { authorization: jwt } } as never; // missing "Bearer "
    const res = makeMockRes();
    const next = vi.fn();

    const mw = verifyJwtMiddleware(SECRET);
    await mw(req, res as never, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when JWT signature is invalid (wrong secret)", async () => {
    const jwt = await makeJwt({ secret: "wrong-secret-very-long-string-1234567890" });
    const req = { headers: { authorization: `Bearer ${jwt}` } } as never;
    const res = makeMockRes();
    const next = vi.fn();

    const mw = verifyJwtMiddleware(SECRET);
    await mw(req, res as never, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
