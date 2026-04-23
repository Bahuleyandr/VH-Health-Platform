// src/app/api/login/mfa/setup-enroll/route.ts
//
// First leg of first-time SUPER_ADMIN MFA enrollment. The client holds a
// short-lived setup token from /api/login (when the backend returned
// requiresMfaSetup). We proxy to the backend's /auth/admin/mfa/setup-enroll
// with the setup token in the Authorization header, then return the QR data
// URL + otpauth URL + backup codes + encryptedSecret for the UI to display.
// No cookie is set here.

import { NextResponse } from "next/server";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "https://api.vhhealth.app";
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
  if (!body?.setupToken || typeof body.setupToken !== "string") {
    return NextResponse.json(
      { message: "setupToken is required", success: false },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(
      `${API_BASE_URL}/api/v1/auth/admin/mfa/setup-enroll`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${body.setupToken}`,
          ...(SERVER_API_KEY ? { "x-api-key": SERVER_API_KEY } : {}),
        },
      },
    );

    const data = await upstream.json();
    if (!upstream.ok) {
      return NextResponse.json(
        { message: data?.message ?? "Failed to start MFA setup", success: false },
        { status: upstream.status },
      );
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { message: "MFA setup service unavailable", success: false },
      { status: 502 },
    );
  }
}
