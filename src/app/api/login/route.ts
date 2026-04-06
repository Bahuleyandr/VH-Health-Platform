// src/app/api/login/route.ts

import { NextResponse } from "next/server";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "https://api.vhhealth.app";
const SERVER_API_KEY = process.env.BACKEND_API_KEY || process.env.API_KEY || "";

/**
 * CSRF Origin validation.
 * Rejects requests from origins that don't match the allowed origin.
 */
function validateOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get('origin');
  const allowed = process.env.NEXT_PUBLIC_ALLOWED_ORIGIN || 'http://localhost:3000';
  // Allow requests with no origin (same-origin, curl, server-side)
  if (origin && origin !== allowed) {
    return NextResponse.json(
      { message: 'Forbidden: Origin not allowed', success: false },
      { status: 403 },
    );
  }
  return null;
}

/**
 * Login API route — proxies credentials to the backend and sets the
 * returned token as an httpOnly cookie.
 *
 * SECURITY: This route does NOT accept arbitrary tokens from the client.
 * It forwards login credentials to the backend, and only sets the cookie
 * with the token that the backend returns.
 *
 * Accepts two login flows:
 * 1. Admin login:  { username, password }
 * 2. Staff login:  { employeeId, password }
 */
export async function POST(request: Request) {
  // CSRF check
  const csrfError = validateOrigin(request);
  if (csrfError) return csrfError;

  const body = await request.json();

  // Flow 1: Admin login (username + password)
  if (body.username && body.password) {
    return proxyLogin(
      `${API_BASE_URL}/api/v1/auth/admin/login`,
      { username: body.username, password: body.password },
    );
  }

  // Flow 2: Staff login (employeeId + password)
  if (body.employeeId && body.password) {
    return proxyLogin(
      `${API_BASE_URL}/api/v1/auth/staff/login`,
      { employeeId: body.employeeId, password: body.password },
    );
  }

  return NextResponse.json(
    { message: "Invalid login request" },
    { status: 400 },
  );
}

async function proxyLogin(
  url: string,
  credentials: Record<string, string>,
): Promise<NextResponse> {
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(SERVER_API_KEY ? { "x-api-key": SERVER_API_KEY } : {}),
      },
      body: JSON.stringify(credentials),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return NextResponse.json(
        { message: data?.message ?? "Login failed", success: false },
        { status: upstream.status },
      );
    }

    // Extract token from backend response envelope
    const token =
      data?.data?.token ??
      data?.data?.accessToken ??
      data?.token ??
      data?.accessToken;

    if (!token) {
      return NextResponse.json(
        { message: "No token in server response", success: false },
        { status: 502 },
      );
    }

    return setTokenCookie(token, data);
  } catch {
    return NextResponse.json(
      { message: "Login service unavailable", success: false },
      { status: 502 },
    );
  }
}

function setTokenCookie(
  token: string,
  responseBody: unknown,
): NextResponse {
  const response = NextResponse.json(responseBody);

  response.cookies.set("auth_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 4, // 4 hours — matches backend admin JWT expiry
  });

  return response;
}
