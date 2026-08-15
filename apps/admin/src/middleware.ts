// src/middleware.ts
import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose/jwt/verify";

const JWT_SECRET = process.env.JWT_SECRET;
const secretKey = JWT_SECRET ? new TextEncoder().encode(JWT_SECRET) : null;

if (!secretKey && process.env.NODE_ENV === "production") {
  console.error(
    "FATAL: JWT_SECRET is not set in production. " +
      "Middleware will reject all authenticated requests. " +
      "Set JWT_SECRET to enable JWT signature verification.",
  );
}

interface TokenResult {
  valid: boolean;
  role: string | null;
}

/**
 * Verify JWT with signature validation (when secret is available).
 * In production, fails closed when JWT_SECRET is not configured.
 */
async function verifyToken(token: string): Promise<TokenResult> {
  // Full signature verification
  if (secretKey) {
    try {
      const { payload } = await jwtVerify(token, secretKey, {
        clockTolerance: 30,
        // Explicit algorithm allowlist (audit finding M1) — first-party
        // tokens are HS256 only.
        algorithms: ["HS256"],
      });
      const role = typeof payload.role === "string" ? payload.role : null;
      return { valid: true, role };
    } catch {
      return { valid: false, role: null };
    }
  }

  // FAIL CLOSED in production: no JWT_SECRET means no auth possible
  if (process.env.NODE_ENV === "production") {
    return { valid: false, role: null };
  }

  // Development fallback: structural check only
  return parseTokenStructure(token);
}

/**
 * Fallback structural JWT check (no signature verification).
 * ONLY used in development when JWT_SECRET is not configured.
 */
function parseTokenStructure(token: string): TokenResult {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return { valid: false, role: null };

    const payload = parts[1] ?? "";
    const pad = "===".slice(0, (4 - (payload.length % 4)) % 4);
    const base64 = (payload + pad).replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(base64)) as Record<string, unknown>;

    if (typeof json.exp === "number") {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (nowSeconds >= json.exp - 30) return { valid: false, role: null };
    }

    const role = typeof json.role === "string" ? json.role : null;
    return { valid: true, role };
  } catch {
    return { valid: false, role: null };
  }
}

// DEFAULT-DENY route policy (audit finding H6/M8 2026-06-10): every
// /dashboard segment must have an entry in ROUTE_POLICY; unmapped paths are
// denied. The map, ranks, and matching live in src/lib/routePolicy.ts and a
// CI coverage test (src/__tests__/security/route-policy-coverage.test.ts)
// fails when a page.tsx has no policy entry.
import { policyForPath, roleSatisfiesPolicy } from "@/lib/routePolicy";
import { normalizePortalRole } from "@/lib/roles";

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

function trustedRedirectBase(request: NextRequest): string {
  if (!isProductionRuntime()) {
    return request.url;
  }

  const configured =
    process.env.ADMIN_CANONICAL_ORIGIN ||
    process.env.NEXT_PUBLIC_ALLOWED_ORIGIN ||
    "https://admin.vhhealth.app";

  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "https:") {
      throw new Error("admin canonical origin must use https");
    }
    return parsed.origin;
  } catch (error) {
    console.error(
      `[middleware] Invalid ADMIN_CANONICAL_ORIGIN/NEXT_PUBLIC_ALLOWED_ORIGIN: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return "https://admin.vhhealth.app";
  }
}

function trustedRedirectUrl(path: string, request: NextRequest): URL {
  return new URL(path, trustedRedirectBase(request));
}

/**
 * Optional IP allowlist. Set `ADMIN_IP_ALLOWLIST` to a comma-separated list
 * of exact client IPs or IPv4 CIDR ranges (e.g. "203.0.113.10,10.10.0.0/16").
 * When unset, development accepts traffic and production fails closed.
 *
 * Matches against the first entry in `X-Forwarded-For` (what reverse proxies
 * send) falling back to the raw remote address. Intended as a second layer
 * of defence alongside auth, not a replacement.
 */
function parseIpAllowlist(): string[] {
  const raw = process.env.ADMIN_IP_ALLOWLIST;
  if (!raw || raw.trim() === "") return [];

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = ((value << 8) + octet) >>> 0;
  }
  return value >>> 0;
}

function ipMatchesAllowlistEntry(ip: string, entry: string): boolean {
  if (ip === entry) return true;

  const normalizedIp = ip.replace(/^::ffff:/, "");
  if (normalizedIp === entry) return true;

  if (!entry.includes("/")) return false;

  const [network, bitsRaw] = entry.split("/");
  if (!network || !/^\d{1,2}$/.test(bitsRaw || "")) return false;

  const bits = Number(bitsRaw);
  if (bits < 0 || bits > 32) return false;

  const ipNum = ipv4ToNumber(normalizedIp);
  const netNum = ipv4ToNumber(network);
  if (ipNum == null || netNum == null) return false;

  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

function isIpAllowed(request: NextRequest): boolean {
  const allowlist = parseIpAllowlist();
  if (allowlist.length === 0) return !isProductionRuntime();

  const forwarded = request.headers.get("x-forwarded-for");
  const clientIp =
    (forwarded ? forwarded.split(",")[0].trim() : "") ||
    request.headers.get("x-real-ip") ||
    "";

  return (
    clientIp !== "" &&
    allowlist.some((entry) => ipMatchesAllowlistEntry(clientIp, entry))
  );
}

// ── Nonce-based CSP (audit finding M9) ──────────────────────────────────────
// script-src previously allowed 'unsafe-inline' (next.config.ts), neutering
// CSP as an XSS backstop. The CSP now comes from this middleware with a
// per-request nonce + 'strict-dynamic': Next.js App Router picks the nonce up
// from the request CSP header and stamps it on its own inline scripts.
// 'unsafe-eval' is needed ONLY by the Next.js dev server (HMR / react-refresh
// evaluate modules via eval) — production bundles are eval-free (Sentry v10
// does not eval at browser runtime; no app code uses eval/Function), so it
// is DROPPED from the prod CSP (M-ADM-2, staged step 2 of audit M9). Both
// 'unsafe-inline' (injection-relevant) and prod 'unsafe-eval' are GONE.
/**
 * ws(s) origin of the `NEXT_PUBLIC_WS_URL` override, or null when the
 * override is unset/unparseable. Mirrors the URL resolution in
 * src/hooks/useRealtimeChannel.ts `resolveWsUrl` — when the realtime fabric
 * lives on a different host than the API, its origin must be present in
 * connect-src or the browser blocks the socket.
 */
function wsOverrideOrigin(): string | null {
  const override = process.env.NEXT_PUBLIC_WS_URL;
  if (!override) return null;
  try {
    const u = new URL(override);
    const scheme =
      u.protocol === "https:" || u.protocol === "wss:" ? "wss:" : "ws:";
    return `${scheme}//${u.host}`;
  } catch {
    return null;
  }
}

function buildCsp(nonce: string): string {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";
  const wsOrigin = apiUrl.replace(/^http/, "ws");
  const wsOverride = wsOverrideOrigin();
  const connectSrc = [
    "'self'",
    apiUrl,
    wsOrigin,
    // NEXT_PUBLIC_WS_URL override origin (skip when it duplicates the
    // API-derived ws origin).
    ...(wsOverride && wsOverride !== wsOrigin ? [wsOverride] : []),
    "https://*.sentry.io",
    "https://*.ingest.sentry.io",
  ].join(" ");
  // Keep 'unsafe-eval' in dev for HMR; remove it from production.
  const isDev = process.env.NODE_ENV !== "production";
  const scriptSrc = isDev
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSrc}`,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

function withCsp<T extends NextResponse>(response: T, csp: string): T {
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const nonce = btoa(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`,
  );
  const csp = buildCsp(nonce);
  // Forward the nonce + CSP on the REQUEST so Next.js stamps the nonce onto
  // its framework inline scripts during render.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const isProtectedSurface =
    pathname.startsWith("/dashboard") || pathname.startsWith("/api/proxy");

  // ── IP allowlist (opt-in via env) ─────────────────────────────────────────
  // Applied only to dashboard + proxy routes. Login is not gated here —
  // it's covered by the /api/login CSRF origin check.
  if (isProtectedSurface && !isIpAllowed(request)) {
    if (pathname.startsWith("/api/proxy")) {
      return NextResponse.json(
        { message: "Forbidden: IP not allowed" },
        { status: 403 },
      );
    }
    // For dashboard, render a minimal 403 so we don't leak the dashboard
    // tree to a blocked address.
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Auth is carried via the httpOnly "auth_token" cookie.
  const token = request.cookies.get("auth_token")?.value;

  // ── Dashboard route protection ──────────────────────────────────────────────
  if (pathname.startsWith("/dashboard")) {
    const { valid, role } = await verifyToken(token ?? "");

    if (!valid) {
      const loginUrl = trustedRedirectUrl("/login", request);
      loginUrl.searchParams.set("redirect", pathname);
      return withCsp(NextResponse.redirect(loginUrl), csp);
    }

    if (!normalizePortalRole(role)) {
      const loginUrl = trustedRedirectUrl("/login", request);
      loginUrl.searchParams.set("reason", "unsupported_role");
      return withCsp(NextResponse.redirect(loginUrl), csp);
    }

    // ── DEFAULT-DENY role gate (H6/M8) ───────────────────────────────────
    // No policy entry ⇒ deny. The dashboard home ("" segment) is mapped to
    // ANY_AUTHENTICATED, so the redirect target itself always resolves.
    const policy = policyForPath(pathname);
    if (!policy) {
      console.warn(
        `[middleware] DENY (no route policy entry): ${pathname} — add one to src/lib/routePolicy.ts`,
      );
      return withCsp(
        NextResponse.redirect(trustedRedirectUrl("/dashboard", request)),
        csp,
      );
    }
    if (!roleSatisfiesPolicy(role, policy)) {
      return withCsp(
        NextResponse.redirect(trustedRedirectUrl("/dashboard", request)),
        csp,
      );
    }

    return withCsp(
      NextResponse.next({ request: { headers: requestHeaders } }),
      csp,
    );
  }

  // ── Proxy route protection ──────────────────────────────────────────────────
  if (pathname.startsWith("/api/proxy")) {
    const { valid, role } = await verifyToken(token ?? "");
    if (!valid) {
      return NextResponse.json(
        { message: "Authentication required" },
        { status: 401 },
      );
    }
    if (!normalizePortalRole(role)) {
      return NextResponse.json(
        { message: "Forbidden: unsupported portal role" },
        { status: 403 },
      );
    }
  }

  return withCsp(
    NextResponse.next({ request: { headers: requestHeaders } }),
    csp,
  );
}

export const config = {
  // Matches every page (for the nonce CSP) while skipping static assets;
  // auth + IP-allowlist logic above remains scoped to /dashboard and
  // /api/proxy inside the handler.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|ico|webp|woff2?)$).*)",
  ],
};
