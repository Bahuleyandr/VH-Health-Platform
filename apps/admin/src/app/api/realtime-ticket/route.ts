// src/app/api/realtime-ticket/route.ts
//
// Server-side ticket exchange for the admin portal's real-time fabric.
// Reads the httpOnly `auth_token` cookie, calls backend `/realtime/ticket` to
// mint a short-lived (~60s) WS-scoped JWT, and returns it to the browser.
// The primary token is never exposed to JS — only this ticket is.

import { NextResponse } from "next/server";
import { getServerBackendUrl } from "@/lib/api-config";

const API_BASE_URL = getServerBackendUrl();
const SERVER_API_KEY = process.env.BACKEND_API_KEY || process.env.API_KEY || "";

function validateOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
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

export async function POST(request: Request) {
  const csrfError = validateOrigin(request);
  if (csrfError) return csrfError;

  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)auth_token=([^;]+)/.exec(cookieHeader);
  const token = match?.[1];
  if (!token) {
    return NextResponse.json(
      { message: "Not authenticated", success: false },
      { status: 401 },
    );
  }

  try {
    const upstream = await fetch(`${API_BASE_URL}/api/v1/realtime/ticket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-forwarded-proto": "https",
        ...(SERVER_API_KEY ? { "x-api-key": SERVER_API_KEY } : {}),
      },
    });
    const data = (await upstream.json().catch(() => ({}))) as {
      data?: { ticket?: string; ttlSeconds?: number };
      message?: string;
    };
    if (!upstream.ok) {
      return NextResponse.json(
        { message: data?.message ?? "Ticket rejected", success: false },
        { status: upstream.status },
      );
    }
    const ticket = data?.data?.ticket;
    if (!ticket) {
      return NextResponse.json(
        { message: "Empty ticket from backend", success: false },
        { status: 502 },
      );
    }
    return NextResponse.json({
      success: true,
      ticket,
      ttlSeconds: data?.data?.ttlSeconds ?? 60,
    });
  } catch {
    return NextResponse.json(
      { message: "Realtime ticket service unavailable", success: false },
      { status: 502 },
    );
  }
}
