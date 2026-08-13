// src/lib/csrfOrigin.ts
//
// Single source of truth for the admin portal's CSRF Origin/Referer allowlist.
//
// Before this helper, every cookie-mutating auth route (login, logout, refresh,
// realtime-ticket, and the three MFA legs) carried its own hand-rolled copy of
// the check, and they had drifted apart:
//   - some waved a *missing* Origin straight through (a forged cross-site
//     fetch that omits Origin could ride the auth cookie),
//   - some still carried stale `*.vhhealth.app` wildcard logic that the
//     comma-separated exact-match allowlist already subsumes,
//   - only the reverse proxy (`api/proxy/[...path]/route.ts`) implemented the
//     strict policy (reject missing Origin on unsafe methods + Referer
//     fallback).
//
// `assertSameOriginOrAllowed` consolidates them onto the proxy's strict policy
// (SEC-8). It accepts a plain `Request` so it works for both the auth route
// handlers and the proxy's `NextRequest` (NextRequest extends Request).

import { NextResponse } from "next/server";

/**
 * Resolve the CSRF origin allowlist.
 *
 * SEC-8: in production we REFUSE to fall back to "http://localhost:3001" — a
 * localhost default paired with credentialed cookies silently disables CSRF
 * protection on a deployed instance. `NEXT_PUBLIC_*` vars are inlined at build
 * time, so an unset value here hard-errors rather than shipping a wide-open
 * surface. Dev/test keep the localhost default for convenience.
 *
 * Resolved per-call (not memoized at module load) so the auth routes — which
 * are `force-dynamic` and may be loaded before env is pinned in tests — always
 * read the current allowlist. The work is a tiny string split.
 */
export function resolveAllowedOrigins(): string[] {
  const configured = process.env.NEXT_PUBLIC_ALLOWED_ORIGIN;
  if (!configured || !configured.trim()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "NEXT_PUBLIC_ALLOWED_ORIGIN must be set in production — refusing to " +
          "default to localhost (would disable CSRF protection).",
      );
    }
    return ["http://localhost:3001"];
  }
  return configured
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF Origin validation for unsafe (cookie-mutating) requests.
 *
 * Returns a 403 `NextResponse` to short-circuit the handler when the request
 * fails the check, or `null` when it passes (caller proceeds).
 *
 * Policy (matches the reverse proxy, SEC-8):
 *  - GET/HEAD/OPTIONS are exempt (safe methods per RFC 7231).
 *  - Unsafe methods REQUIRE a valid Origin (or, failing that, a Referer whose
 *    origin) matches the allowlist. A *missing* Origin/Referer is rejected, not
 *    waved through — a forged cross-site form/fetch that omits Origin must not
 *    be able to ride the user's auth cookie.
 *
 * All admin auth routes are POST-only, so in practice every call is gated; the
 * safe-method exemption is kept for correctness if a route ever adds GET.
 */
export function assertSameOriginOrAllowed(request: Request): NextResponse | null {
  if (SAFE_METHODS.has(request.method)) return null;

  const reject = () =>
    NextResponse.json(
      { message: "Forbidden: cross-origin request blocked", success: false },
      { status: 403 },
    );

  // Prefer the Origin header; fall back to the Referer's origin for clients
  // that omit Origin on same-origin requests but still send a Referer.
  let candidate = request.headers.get("origin");
  if (!candidate) {
    const referer = request.headers.get("referer");
    if (referer) {
      try {
        candidate = new URL(referer).origin;
      } catch {
        return reject();
      }
    }
  }

  // No Origin and no usable Referer → cannot prove same-origin → reject.
  if (!candidate) return reject();

  if (!resolveAllowedOrigins().includes(candidate)) return reject();
  return null;
}
