// W5 S3/S4 — server-side, SIGNATURE-VERIFIED read of the admin auth_token's role
// claim. The SUPER_ADMIN gate for acting-as-tenant (setting the acting_tenant
// cookie in /api/act-as, and the proxy translating it into the backend's
// x-tenant-id override) depends on this being verified — NEVER an unverified
// client claim. Fails closed (null) when JWT_SECRET is unset in production.
//
// Mirrors middleware.ts's verifyToken, but returns the role for authorization
// decisions in node-runtime route handlers. jose ships ESM-only; it is imported
// DYNAMICALLY inside the verify path so this module loads cleanly under jest
// (which doesn't transform jose) — jose is only pulled in when a token is
// actually verified at runtime (Next's node runtime handles ESM fine).

const JWT_SECRET = process.env.JWT_SECRET;
const secretKey = JWT_SECRET ? new TextEncoder().encode(JWT_SECRET) : null;

export async function getVerifiedTokenRole(
  token: string | undefined | null,
): Promise<string | null> {
  if (!token) return null;

  if (secretKey) {
    try {
      const { jwtVerify } = await import("jose/jwt/verify");
      const { payload } = await jwtVerify(token, secretKey, {
        algorithms: ["HS256"],
        clockTolerance: 30,
      });
      return typeof payload.role === "string" ? payload.role : null;
    } catch {
      return null;
    }
  }

  // No JWT_SECRET: fail closed in production. Dev keeps a structural-only read so
  // local work without a secret still functions (mirrors middleware.ts).
  if (process.env.NODE_ENV === "production") return null;
  try {
    const part = token.split(".")[1] ?? "";
    const pad = "===".slice(0, (4 - (part.length % 4)) % 4);
    const base64 = (part + pad).replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(
      typeof atob === "function"
        ? atob(base64)
        : Buffer.from(base64, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    return typeof json.role === "string" ? json.role : null;
  } catch {
    return null;
  }
}

export function isSuperAdminRole(role: string | null): boolean {
  return String(role || "").toUpperCase() === "SUPER_ADMIN";
}
