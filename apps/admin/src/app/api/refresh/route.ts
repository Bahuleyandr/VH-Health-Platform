// src/app/api/refresh/route.ts
//
// Server-side token refresh. Reads the dedicated refresh_token cookie, calls the
// backend's /auth/refresh-token endpoint with it, and rotates the cookie to
// the new token. Never accepts a client-supplied token as input (that would
// let the browser mint arbitrary session cookies).

// ADM-8: force-dynamic prevents Next.js from caching auth route responses at
// the framework layer, which would let stale session state be served from cache.
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerBackendUrl } from "@/lib/api-config";
import { assertSameOriginOrAllowed } from "@/lib/csrfOrigin";

const API_BASE_URL = getServerBackendUrl();
const SERVER_API_KEY = process.env.BACKEND_API_KEY || process.env.API_KEY || "";

function clearCookieResponse(status: number, body: unknown): NextResponse {
  const response = NextResponse.json(body, { status });
  response.cookies.set("auth_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  response.cookies.set("refresh_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/refresh",
    maxAge: 0,
  });
  return response;
}

export async function POST(request: Request) {
  const csrfError = assertSameOriginOrAllowed(request);
  if (csrfError) return csrfError;

  // Read existing cookie — Next.js parses it for us.
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)refresh_token=([^;]+)/.exec(cookieHeader);
  const currentToken = match?.[1];
  if (!currentToken) {
    return clearCookieResponse(401, {
      message: "No session to refresh",
      success: false,
    });
  }

  try {
    const upstream = await fetch(`${API_BASE_URL}/api/v1/auth/refresh-token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentToken}`,
        "Content-Type": "application/json",
        "x-forwarded-proto": "https",
        ...(SERVER_API_KEY ? { "x-api-key": SERVER_API_KEY } : {}),
      },
    });

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      return clearCookieResponse(401, {
        message:
          (data as { message?: string })?.message ?? "Refresh rejected",
        success: false,
      });
    }

    const payload = (data as { data?: unknown })?.data ?? data;
    const newToken =
      (payload as { token?: string; accessToken?: string })?.token ??
      (payload as { token?: string; accessToken?: string })?.accessToken;
    const newRefreshToken = (payload as { refreshToken?: string })?.refreshToken;

    if (!newToken || !newRefreshToken) {
      return clearCookieResponse(502, {
        message: "Incomplete session credentials in refresh response",
        success: false,
      });
    }

    const response = NextResponse.json({ success: true });
    response.cookies.set("auth_token", newToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 4, // 4h — matches backend admin JWT expiry
    });
    response.cookies.set("refresh_token", newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api/refresh",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch {
    return NextResponse.json(
      { message: "Refresh service unavailable", success: false },
      { status: 502 },
    );
  }
}
