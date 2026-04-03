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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
