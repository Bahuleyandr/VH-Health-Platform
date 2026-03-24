// src/middleware.ts
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
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/api/:path*"],
};
