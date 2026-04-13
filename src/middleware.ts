// src/middleware.ts
import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const JWT_SECRET = process.env.JWT_SECRET;
const secretKey = JWT_SECRET
  ? new TextEncoder().encode(JWT_SECRET)
  : null;

if (!secretKey && process.env.NODE_ENV === "production") {
  console.error(
    "FATAL: JWT_SECRET is not set in production. " +
    "Middleware will reject all authenticated requests. " +
    "Set JWT_SECRET to enable JWT signature verification.",
  );
}

interface TokenResult {
  valid: boolean;
  role: string | null;
}

/**
 * Verify JWT with signature validation (when secret is available).
 * In production, fails closed when JWT_SECRET is not configured.
 */
async function verifyToken(token: string): Promise<TokenResult> {
  // Full signature verification
  if (secretKey) {
    try {
      const { payload } = await jwtVerify(token, secretKey, {
        clockTolerance: 30,
      });
      const role = typeof payload.role === "string" ? payload.role : null;
      return { valid: true, role };
    } catch {
      return { valid: false, role: null };
    }
  }

  // FAIL CLOSED in production: no JWT_SECRET means no auth possible
  if (process.env.NODE_ENV === "production") {
    return { valid: false, role: null };
  }

  // Development fallback: structural check only
  return parseTokenStructure(token);
}

/**
 * Fallback structural JWT check (no signature verification).
 * ONLY used in development when JWT_SECRET is not configured.
 */
function parseTokenStructure(token: string): TokenResult {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return { valid: false, role: null };

    const payload = parts[1] ?? "";
    const pad = "===".slice(0, (4 - (payload.length % 4)) % 4);
    const base64 = (payload + pad).replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(base64)) as Record<string, unknown>;

    if (typeof json.exp === "number") {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (nowSeconds >= json.exp - 30) return { valid: false, role: null };
    }

    const role = typeof json.role === "string" ? json.role : null;
    return { valid: true, role };
  } catch {
    return { valid: false, role: null };
  }
}

// Routes restricted to ADMIN | SUPER_ADMIN only
const ADMIN_ONLY_PATHS = [
  "/dashboard/payroll",
  "/dashboard/users",
  "/dashboard/system-audit",
  "/dashboard/analytics",
  "/dashboard/settings",
  "/dashboard/audit",
  "/dashboard/attendance-audit",
  "/dashboard/admin-management",
];

// Routes available to HR | ADMIN | SUPER_ADMIN
const HR_PLUS_PATHS = [
  "/dashboard/leave-approvals",
  "/dashboard/incidents",
  "/dashboard/grievances",
  "/dashboard/staff-roster",
  "/dashboard/reporting",
];

const ROLE_RANK: Record<string, number> = {
  STAFF: 0,
  DOCTOR: 1,
  HR: 2,
  ADMIN: 3,
  SUPER_ADMIN: 4,
};

/**
 * Optional IP allowlist. Set `ADMIN_IP_ALLOWLIST` to a comma-separated list
 * of exact client IPs (e.g. "203.0.113.10,203.0.113.11"). When unset, the
 * allowlist is disabled and every client is accepted — the previous behaviour.
 *
 * Matches against the first entry in `X-Forwarded-For` (what reverse proxies
 * send) falling back to the raw remote address. Intended as a second layer
 * of defence alongside auth, not a replacement.
 */
function isIpAllowed(request: NextRequest): boolean {
  const raw = process.env.ADMIN_IP_ALLOWLIST;
  if (!raw || raw.trim() === "") return true; // allowlist disabled

  const allowlist = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowlist.length === 0) return true;

  const forwarded = request.headers.get("x-forwarded-for");
  const clientIp =
    (forwarded ? forwarded.split(",")[0].trim() : "") ||
    request.headers.get("x-real-ip") ||
    "";

  return clientIp !== "" && allowlist.includes(clientIp);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── IP allowlist (opt-in via env) ─────────────────────────────────────────
  // Applied only to dashboard + proxy routes (the matcher below). Login is
  // not gated here — it's covered by the /api/login CSRF origin check.
  if (!isIpAllowed(request)) {
    if (pathname.startsWith("/api/proxy")) {
      return NextResponse.json(
        { message: "Forbidden: IP not allowed" },
        { status: 403 },
      );
    }
    // For dashboard, render a minimal 403 so we don't leak the dashboard
    // tree to a blocked address.
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Auth is carried via the httpOnly "auth_token" cookie.
  const token = request.cookies.get("auth_token")?.value;

  // ── Dashboard route protection ──────────────────────────────────────────────
  if (pathname.startsWith("/dashboard")) {
    const { valid, role } = await verifyToken(token ?? "");

    if (!valid) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("redirect", pathname);
      return NextResponse.redirect(loginUrl);
    }

    const userRank = role ? (ROLE_RANK[role] ?? -1) : -1;

    // Block STAFF/DOCTOR from HR+ paths
    const isHRPlus = userRank >= ROLE_RANK.HR;
    if (!isHRPlus) {
      for (const restricted of HR_PLUS_PATHS) {
        if (pathname === restricted || pathname.startsWith(restricted + "/")) {
          return NextResponse.redirect(new URL("/dashboard", request.url));
        }
      }
    }

    // Block non-ADMIN from admin-only paths
    const isAdmin = userRank >= ROLE_RANK.ADMIN;
    if (!isAdmin) {
      for (const restricted of ADMIN_ONLY_PATHS) {
        if (pathname === restricted || pathname.startsWith(restricted + "/")) {
          return NextResponse.redirect(new URL("/dashboard", request.url));
        }
      }
    }

    const response = NextResponse.next();
    return response;
  }

  // ── Proxy route protection ──────────────────────────────────────────────────
  if (pathname.startsWith("/api/proxy")) {
    const { valid } = await verifyToken(token ?? "");
    if (!valid) {
      return NextResponse.json(
        { message: "Authentication required" },
        { status: 401 },
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/api/proxy/:path*"],
};
