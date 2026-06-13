// src/app/api/login/route.ts

// ADM-8: force-dynamic prevents Next.js from caching auth route responses at
// the framework layer, which would let stale session state (token or cookie)
// be served from cache on subsequent requests.
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerBackendUrl } from "@/lib/api-config";

const API_BASE_URL = getServerBackendUrl();
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
    // Also allow any *.vhhealth.app origin in addition to exact match
    const allowedHosts = allowed.split(',').map((s: string) => s.trim());
    const originHost = new URL(origin).origin;
    const isAllowed = allowedHosts.some((h: string) => {
      if (h === origin) return true;
      // Wildcard: *.vhhealth.app matches any subdomain
      if (h.startsWith('https://') && h.endsWith('.vhhealth.app')) {
        return originHost === h;
      }
      return false;
    });
    if (!isAllowed) {
      return NextResponse.json(
        { message: 'Forbidden: Origin not allowed', success: false },
        { status: 403 },
      );
    }
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
