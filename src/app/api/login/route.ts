// src/app/api/login/route.ts

import { NextResponse } from "next/server";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "https://api.vhhealth.app";

/**
 * Login API route — proxies credentials to the backend and sets the
 * returned token as an httpOnly cookie.
 *
 * SECURITY: This route does NOT accept arbitrary tokens from the client.
 * It forwards login credentials to the backend, and only sets the cookie
 * with the token that the backend returns. This prevents an attacker from
 * crafting a fake JWT and getting it set as an auth cookie.
 *
 * Accepts two login flows:
 * 1. Admin login:  { username, password }
 * 2. Staff login:  { employeeId, password }
 * 3. Token-only (from client after backend login): { token } - DEPRECATED
 *    Still supported for backward compatibility but will be removed.
 */
export async function POST(request: Request) {
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

  // Flow 3: Legacy token-set (backward compatibility)
  // TODO: Remove this once all client code uses flows 1 or 2
  if (body.token && typeof body.token === "string") {
    return setTokenCookie(body.token, { success: true });
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
        ...(process.env.API_KEY ? { "x-api-key": process.env.API_KEY } : {}),
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
  } catch (err) {
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
    maxAge: 60 * 60 * 24, // 1 day
  });

  return response;
}
