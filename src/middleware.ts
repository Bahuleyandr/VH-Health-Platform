// src/middleware.ts
<<<<<<< HEAD
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Routes that are always accessible without a token
const PUBLIC_PATHS = ["/login", "/", "/_next", "/api/auth", "/favicon.ico"];

// The dev bypass token that must never be accepted in production
const DEV_BYPASS_TOKEN = "dev-token-12345";

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
=======
import { NextRequest, NextResponse } from "next/server";

/**
 * Lightweight JWT payload check for Edge runtime.
 * Does NOT verify the signature — only checks structure and expiry.
 */
function isTokenStructurallyValid(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return false;

    const payload = parts[1] ?? "";
    const pad = "===".slice(0, (4 - (payload.length % 4)) % 4);
    const base64 = (payload + pad).replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(base64)) as Record<string, unknown>;

    // Check expiry with 30s clock-skew tolerance
    if (typeof json.exp === "number") {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (nowSeconds >= json.exp - 30) return false;
    }

    return true;
  } catch {
    return false;
  }
>>>>>>> 7ca9048 (Comprehensive code review fixes: security, consistency, UX, and a11y)
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
<<<<<<< HEAD

  // Always allow public paths
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Only enforce auth on dashboard routes (and any other protected paths)
  if (pathname.startsWith("/dashboard")) {
    // 1) Check cookie
    const cookieToken = request.cookies.get("adminToken")?.value;

    // 2) Check Authorization header
    const authHeader = request.headers.get("Authorization");
    const headerToken =
      authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

    const token = cookieToken || headerToken;

    // Reject if no token present or if it's the dev bypass token
    if (!token || token === DEV_BYPASS_TOKEN) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("redirectTo", pathname);
      return NextResponse.redirect(loginUrl);
    }

    // Token exists and is not the dev bypass — allow through.
    // Full JWT signature verification happens on the backend for every API call.
    return NextResponse.next();
=======
  const token = request.cookies.get("auth_token")?.value;

  // Dashboard routes: redirect to login if no valid token
  if (pathname.startsWith("/dashboard")) {
    if (!token || !isTokenStructurallyValid(token)) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("redirect", pathname);
      return NextResponse.redirect(loginUrl);
    }

    // Forward validated token downstream for proxy/API use
    const response = NextResponse.next();
    response.headers.set("x-auth-token", token);
    return response;
  }

  // Proxy routes: return 401 if no valid token
  if (pathname.startsWith("/api/proxy")) {
    if (!token || !isTokenStructurallyValid(token)) {
      return NextResponse.json(
        { message: "Authentication required" },
        { status: 401 },
      );
    }
>>>>>>> 7ca9048 (Comprehensive code review fixes: security, consistency, UX, and a11y)
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/api/proxy/:path*"],
};
