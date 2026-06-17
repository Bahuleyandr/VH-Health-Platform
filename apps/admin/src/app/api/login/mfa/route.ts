// src/app/api/login/mfa/route.ts
//
// Completes the admin 2FA step after /api/login returns a
// { requiresTwoFactor, challengeToken } payload. Proxies to
// /api/v1/auth/admin/mfa/challenge/verify and — on success — sets the
// httpOnly auth_token cookie, matching the non-MFA login flow.

import { NextResponse } from "next/server";
import { getServerBackendUrl } from "@/lib/api-config";

const API_BASE_URL = getServerBackendUrl();
const SERVER_API_KEY = process.env.BACKEND_API_KEY || process.env.API_KEY || "";

function validateOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  const allowed = process.env.NEXT_PUBLIC_ALLOWED_ORIGIN || "http://localhost:3000";
  if (origin && origin !== allowed) {
    const allowedHosts = allowed.split(",").map((s: string) => s.trim());
    const originHost = new URL(origin).origin;
    const isAllowed = allowedHosts.some((h: string) => {
      if (h === origin) return true;
      if (h.startsWith("https://") && h.endsWith(".vhhealth.app")) {
        return originHost === h;
      }
      return false;
    });
    if (!isAllowed) {
      return NextResponse.json(
        { message: "Forbidden: Origin not allowed", success: false },
        { status: 403 },
      );
    }
  }
  return null;
}

/**
 * Remove JWT material (`token`, `accessToken`, `refreshToken`) from a backend
 * response envelope before it is returned to the browser. The token is carried
 * exclusively by the httpOnly `auth_token` cookie. Strips both the top level
 * and the nested `data` object (the standard envelope shape).
 */
function stripTokens(responseBody: unknown): unknown {
  if (!responseBody || typeof responseBody !== "object") return responseBody;

  const omit = (obj: Record<string, unknown>): Record<string, unknown> => {
    const { token, accessToken, refreshToken, ...rest } = obj;
    void token;
    void accessToken;
    void refreshToken;
    return rest;
  };

  const top = omit(responseBody as Record<string, unknown>);
  if (top.data && typeof top.data === "object") {
    top.data = omit(top.data as Record<string, unknown>);
  }
  return top;
}

export async function POST(request: Request) {
  const csrfError = validateOrigin(request);
  if (csrfError) return csrfError;

  const body = await request.json().catch(() => null);
  if (!body?.challengeToken || !body?.code) {
    return NextResponse.json(
      { message: "challengeToken and code are required", success: false },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(
      `${API_BASE_URL}/api/v1/auth/admin/mfa/challenge/verify`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-proto": "https",
          ...(SERVER_API_KEY ? { "x-api-key": SERVER_API_KEY } : {}),
        },
        body: JSON.stringify({
          challengeToken: body.challengeToken,
          code: body.code,
          useBackupCode: Boolean(body.useBackupCode),
        }),
      },
    );

    const data = await upstream.json();

    if (!upstream.ok) {
      return NextResponse.json(
        { message: data?.message ?? "MFA verification failed", success: false },
        { status: upstream.status },
      );
    }

    const token = data?.data?.token ?? data?.token;
    if (!token) {
      return NextResponse.json(
        { message: "No token in MFA response", success: false },
        { status: 502 },
      );
    }

    // The token is the credential and now lives only in the httpOnly cookie set
    // below — strip it from the JSON body so the browser never receives it.
    const response = NextResponse.json(stripTokens(data));
    response.cookies.set("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 4,
    });
    return response;
  } catch {
    return NextResponse.json(
      { message: "MFA verification service unavailable", success: false },
      { status: 502 },
    );
  }
}
