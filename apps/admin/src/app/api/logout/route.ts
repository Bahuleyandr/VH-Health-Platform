// ADM-8: force-dynamic prevents Next.js from caching auth route responses at
// the framework layer, which would let stale session state be served from cache.
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { assertSameOriginOrAllowed } from "@/lib/csrfOrigin";

export async function POST(request: Request) {
  // CSRF Origin validation (shared strict policy — see lib/csrfOrigin.ts)
  const csrfError = assertSameOriginOrAllowed(request);
  if (csrfError) return csrfError;

  const response = NextResponse.json({ success: true });

  // Clear the auth cookie
  response.cookies.set("auth_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0, // Expire immediately
  });

  return response;
}
