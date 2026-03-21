// src/app/api/login/route.ts

import { NextResponse } from "next/server";

/**
 * Lightweight JWT validation — checks structure and expiry only.
 * Does not verify signature (that's the backend's job).
 */
function validateTokenStructure(token: string): { valid: boolean; reason?: string } {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return { valid: false, reason: "Invalid token format" };

    const payload = parts[1] ?? "";
    const pad = "===".slice(0, (4 - (payload.length % 4)) % 4);
    const base64 = (payload + pad).replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(base64)) as Record<string, unknown>;

    if (typeof json.exp === "number") {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (nowSeconds >= json.exp) return { valid: false, reason: "Token is expired" };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: "Invalid token format" };
  }
}

export async function POST(request: Request) {
  const { token } = await request.json();

  if (!token || typeof token !== "string") {
    return NextResponse.json({ message: "Token is required" }, { status: 400 });
  }

  const { valid, reason } = validateTokenStructure(token);
  if (!valid) {
    return NextResponse.json({ message: reason }, { status: 400 });
  }

  const response = NextResponse.json({ success: true });

  response.cookies.set("auth_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 24, // 1 day
  });

  return response;
}
