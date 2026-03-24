// src/middleware.ts
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
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
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
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/api/proxy/:path*"],
};
