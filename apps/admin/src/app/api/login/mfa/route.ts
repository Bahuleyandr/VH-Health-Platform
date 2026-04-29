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

    const response = NextResponse.json(data);
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
