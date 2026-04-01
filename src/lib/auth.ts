// src/lib/auth.ts

/**
 * Auth utilities for the admin portal.
 *
 * SECURITY: Tokens are stored ONLY in httpOnly cookies (set by /api/login).
 * We no longer store tokens in localStorage to prevent XSS token theft.
 * Only the admin user profile is cached in localStorage for UI purposes.
 */

const USER_KEY = "adminUser";

/* =========================
 * Local storage helpers
 * ========================= */

/**
 * Clear cached user data from localStorage.
 * Note: The auth token is in an httpOnly cookie and cleared via /api/logout.
 */
export function clearAuthStorage(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(USER_KEY);
}

/* =========================
 * JWT helpers (no `any`)
 * ========================= */

type JwtBase = {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  role?: string;
  permissions?: string[];
  [key: string]: unknown;
};

/** Base64url decode */
function b64urlToString(input: string): string {
  const pad = "===".slice(0, (4 - (input.length % 4)) % 4);
  const base64 = (input + pad).replace(/-/g, "+").replace(/_/g, "/");
  if (typeof window !== "undefined") {
    return decodeURIComponent(
      Array.prototype.map
        .call(
          atob(base64),
          (c: string) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2),
        )
        .join(""),
    );
  } else {
    return Buffer.from(base64, "base64").toString("utf8");
  }
}

/**
 * Parse a JWT payload into a typed object.
 * NOTE: This does NOT verify the signature - only use for reading claims
 * from tokens that have already been verified by the backend.
 */
export function parseJwt<T extends Record<string, unknown> = JwtBase>(
  token: string,
): T {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT");

  const payloadJson = b64urlToString(parts[1] ?? "");
  const payload = JSON.parse(payloadJson) as unknown;

  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid JWT payload");
  }
  return payload as T;
}

/** Get exp (seconds since epoch) from token, or null if missing/invalid */
export function getTokenExp(token: string): number | null {
  try {
    const payload = parseJwt<JwtBase>(token);
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Is token expired (with optional skew seconds, default 30s)? */
export function isTokenExpired(token: string, skewSeconds = 30): boolean {
  const exp = getTokenExp(token);
  if (!exp) return true;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return nowSeconds >= exp - skewSeconds;
}

/** Convenience: return `Authorization` header value for a token */
export function toBearer(token?: string | null): string | undefined {
  if (!token) return undefined;
  return `Bearer ${token}`;
}
