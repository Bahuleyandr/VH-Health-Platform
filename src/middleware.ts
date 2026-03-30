// src/middleware.ts
import { NextRequest, NextResponse } from "next/server";

/**
 * Lightweight JWT payload check for Edge runtime.
 * Does NOT verify the HMAC signature — only checks structure and expiry.
 *
 * ⚠️  SECURITY NOTICE: This is a UX redirect gate, NOT a security boundary.
 *
 * The Edge runtime does not have access to the signing secret, so signature
 * verification is unavoidable to omit here. A forged or tampered token with a
 * future `exp` value would pass this check and reach the Next.js page layer.
 *
 * ALL data-level security is enforced at the backend API:
 *   - The /api/proxy route validates the real auth_token cookie before forwarding.
 *   - The backend itself verifies the JWT signature and RBAC on every request.
 *
 * This middleware only provides fast client-side redirects (e.g., bounce
 * unauthenticated users to /login) to improve UX. Do not rely on it for
 * access control decisions that affect data.
 */
function parseTokenEdge(token: string): { valid: boolean; role: string | null } {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return { valid: false, role: null };

    const payload = parts[1] ?? "";
    const pad = "===".slice(0, (4 - (payload.length % 4)) % 4);
    const base64 = (payload + pad).replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(base64)) as Record<string, unknown>;

    // Check expiry with 30s clock-skew tolerance
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

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Auth is carried exclusively via the httpOnly "auth_token" cookie set by the backend.
  // The non-httpOnly "adminToken" cookie has been removed (XSS risk).
  const token = request.cookies.get("auth_token")?.value;

  // ── Dashboard route protection ──────────────────────────────────────────────
  if (pathname.startsWith("/dashboard")) {
    const { valid, role } = parseTokenEdge(token ?? "");

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

    // Forward validated token downstream
    const response = NextResponse.next();
    if (token) response.headers.set("x-auth-token", token);
    return response;
  }

  // ── Proxy route protection ──────────────────────────────────────────────────
  if (pathname.startsWith("/api/proxy")) {
    const { valid } = parseTokenEdge(token ?? "");
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
