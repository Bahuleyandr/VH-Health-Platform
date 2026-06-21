// src/app/api/login/route.ts

// ADM-8: force-dynamic prevents Next.js from caching auth route responses at
// the framework layer, which would let stale session state (token or cookie)
// be served from cache on subsequent requests.
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerBackendUrl } from "@/lib/api-config";
import { assertSameOriginOrAllowed } from "@/lib/csrfOrigin";

const API_BASE_URL = getServerBackendUrl();
const SERVER_API_KEY = process.env.BACKEND_API_KEY || process.env.API_KEY || "";

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
  // CSRF check (shared strict policy — see lib/csrfOrigin.ts)
  const csrfError = assertSameOriginOrAllowed(request);
  if (csrfError) return csrfError;

  const body = await request.json();

  // Flow 1: Admin login (username + password). `deviceType: 'web'` is
  // pinned by this proxy — the admin app is web-only, and the backend
  // uses the claim to enforce the single-active-session policy and to
  // gate device-class-restricted routes.
  if (body.username && body.password) {
    return proxyLogin(
      `${API_BASE_URL}/api/v1/auth/admin/login`,
      { username: body.username, password: body.password, deviceType: 'web' },
    );
  }

  // Flow 2: Staff login (employeeId + password) from the admin web. Same
  // device-type pinning applies.
  if (body.employeeId && body.password) {
    return proxyLogin(
      `${API_BASE_URL}/api/v1/auth/staff/login`,
      { employeeId: body.employeeId, password: body.password, deviceType: 'web' },
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
        // Backend's HTTPS-redirect middleware trips when NODE_ENV=production
        // and this header isn't 'https'. We're always behind TLS one way
        // or another (Cloudflare Tunnel in prod, Tailscale serve in dev),
        // so it's safe + correct to set this for all server-to-server calls.
        "x-forwarded-proto": "https",
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

    // MFA challenge passthrough — when the backend returns a 2FA challenge
    // instead of a token, forward it verbatim so the client can prompt for
    // the authenticator code. No cookie is set yet.
    const payload = data?.data ?? data;
    if (payload?.requiresTwoFactor && payload?.challengeToken) {
      return NextResponse.json(data, { status: 200 });
    }

    // First-time MFA setup passthrough — SUPER_ADMIN accounts without TOTP
    // receive a short-lived setup token. Forward it so the client can render
    // the enrollment panel. No cookie is set yet.
    if (payload?.requiresMfaSetup && payload?.setupToken) {
      return NextResponse.json(data, { status: 200 });
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

/**
 * Remove JWT material (`token`, `accessToken`, `refreshToken`) from a backend
 * response envelope before it is returned to the browser. The token is carried
 * exclusively by the httpOnly `auth_token` cookie; echoing it in the JSON body
 * is dead weight the client ignores and undercuts the cookie design. Strips
 * both the top level and the nested `data` object (the standard envelope shape).
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

function setTokenCookie(
  token: string,
  responseBody: unknown,
): NextResponse {
  // The token is the credential and it now lives only in the httpOnly cookie
  // set below. Strip it from the JSON body so the browser never receives it
  // (the client reads only requiresTwoFactor/requiresMfaSetup/admin).
  const response = NextResponse.json(stripTokens(responseBody));

  response.cookies.set("auth_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 4, // 4 hours — matches backend admin JWT expiry
  });

  return response;
}
