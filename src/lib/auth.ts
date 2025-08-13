// src/lib/auth.ts

/**
 * Auth utilities for the admin portal.
 * - Type-safe JWT parsing (no `any`)
 * - LocalStorage helpers for token/user
 * - Expiry checks with small clock skew
 */

const TOKEN_KEY = "adminToken";
const USER_KEY = "adminUser";

/* =========================
 * Local storage helpers
 * ========================= */

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthStorage(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/* =========================
 * JWT helpers (no `any`)
 * ========================= */

type JwtBase = {
  // Standard JWT fields
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number; // seconds since epoch
  nbf?: number;
  iat?: number;
  jti?: string;

  // Custom claims we often see on admin tokens
  role?: string;
  permissions?: string[];
  [key: string]: unknown;
};

/** Base64url decode */
function b64urlToString(input: string): string {
  const pad = "===".slice(0, (4 - (input.length % 4)) % 4);
  const base64 = (input + pad).replace(/-/g, "+").replace(/_/g, "/");
  if (typeof window !== "undefined") {
    // atob expects base64 (not base64url) — ok after the replacements above
    return decodeURIComponent(
      Array.prototype.map
        .call(
          atob(base64),
          (c: string) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2),
        )
        .join(""),
    );
  } else {
    // Node
    return Buffer.from(base64, "base64").toString("utf8");
  }
}

/**
 * Parse a JWT payload into a typed object.
 * Usage: const payload = parseJwt<{ role: 'ADMIN' | 'SUPER_ADMIN' }>(token)
 */
export function parseJwt<T extends Record<string, unknown> = JwtBase>(
  token: string,
): T {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT");

  const payloadJson = b64urlToString(parts[1] ?? "");
  const payload = JSON.parse(payloadJson) as unknown;

  // Runtime guard
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
