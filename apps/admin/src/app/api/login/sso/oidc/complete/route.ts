export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerBackendUrl } from "@/lib/api-config";
import { sanitizePostLoginRedirect } from "@/lib/postLoginRedirect";

const SERVER_API_KEY = process.env.BACKEND_API_KEY || process.env.API_KEY || "";
const HANDOFF_COOKIE = "vh_admin_sso_handoff";

function cookieDomain(hostHeader: string | null): string | undefined {
  const host = (hostHeader || "").split(":")[0].toLowerCase();
  if (!host || host === "localhost" || host === "127.0.0.1") return undefined;
  const parts = host.split(".");
  if (parts.length < 2) return undefined;
  return `.${parts.slice(-2).join(".")}`;
}

function clearHandoff(response: NextResponse, request: Request) {
  response.cookies.set(HANDOFF_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    domain: cookieDomain(request.headers.get("host")),
  });
}

export async function GET(request: Request) {
  try {
    const upstream = await fetch(
      `${getServerBackendUrl()}/api/v1/auth/admin/sso/oidc/complete`,
      {
        method: "POST",
        headers: {
          Cookie: request.headers.get("cookie") || "",
          "x-forwarded-proto": "https",
          ...(SERVER_API_KEY ? { "x-api-key": SERVER_API_KEY } : {}),
        },
        cache: "no-store",
      },
    );
    const data = await upstream.json().catch(() => ({}));
    const payload = data?.data ?? data;
    const token = payload?.token;
    const refreshToken = payload?.refreshToken;
    if (!upstream.ok || !token || !refreshToken) {
      const response = NextResponse.redirect(
        new URL("/login?sso=failed", request.url),
      );
      clearHandoff(response, request);
      return response;
    }

    // returnTo originates from a client-controlled query parameter — apply
    // the same strict open-redirect validation as the password login paths.
    const response = NextResponse.redirect(
      new URL(sanitizePostLoginRedirect(payload.returnTo), request.url),
    );
    response.cookies.set("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 4,
    });
    response.cookies.set("refresh_token", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api/refresh",
      maxAge: 60 * 60 * 24 * 30,
    });
    clearHandoff(response, request);
    return response;
  } catch {
    const response = NextResponse.redirect(
      new URL("/login?sso=unavailable", request.url),
    );
    clearHandoff(response, request);
    return response;
  }
}
