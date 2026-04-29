// src/app/api/refresh/route.ts
//
// Server-side token refresh. Reads the current auth_token cookie, calls the
// backend's /auth/refresh-token endpoint with it, and rotates the cookie to
// the new token. Never accepts a client-supplied token as input (that would
// let the browser mint arbitrary session cookies).

import { NextResponse } from "next/server";
import { getServerBackendUrl } from "@/lib/api-config";

const API_BASE_URL = getServerBackendUrl();
const SERVER_API_KEY = process.env.BACKEND_API_KEY || process.env.API_KEY || "";

function validateOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) return null; // same-origin requests may omit Origin

  const allowed =
    process.env.NEXT_PUBLIC_ALLOWED_ORIGIN || "http://localhost:3000";
  const allowedHosts = allowed.split(",").map((s) => s.trim());
  const isAllowed = allowedHosts.some((h) => h === origin);
  if (!isAllowed) {
    return NextResponse.json(
      { message: "Forbidden: Origin not allowed", success: false },
      { status: 403 },
    );
  }
  return null;
}

function clearCookieResponse(status: number, body: unknown): NextResponse {
  const response = NextResponse.json(body, { status });
  response.cookies.set("auth_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function POST(request: Request) {
  const csrfError = validateOrigin(request);
  if (csrfError) return csrfError;

  // Read existing cookie — Next.js parses it for us.
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)auth_token=([^;]+)/.exec(cookieHeader);
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

    if (!newToken) {
      return clearCookieResponse(502, {
        message: "No token in refresh response",
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
    return response;
  } catch {
    return NextResponse.json(
      { message: "Refresh service unavailable", success: false },
      { status: 502 },
    );
  }
}
