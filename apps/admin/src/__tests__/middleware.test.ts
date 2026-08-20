/**
 * Tests for src/middleware.ts
 *
 * Covers:
 *   - parseTokenStructure: structural JWT validation (dev fallback)
 *   - DEFAULT-DENY route policy enforcement (audit finding H6/M8) via
 *     src/lib/routePolicy.ts
 *   - Dashboard routes are protected (redirect to /login when unauthenticated)
 *   - Role-based access control on restricted paths
 *   - Nonce-based CSP header (audit finding M9)
 *   - Proxy route protection
 *   - Matcher configuration
 */

// ---------------------------------------------------------------------------
// Mock jose — prevent real JWT verification; we control outcomes per test.
// jest.mock calls are hoisted above imports by the transformer, so the
// factory must not reference outer variables declared with const/let.
// ---------------------------------------------------------------------------
jest.mock("jose/jwt/verify", () => ({
  jwtVerify: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock NextResponse — capture redirect / json / next calls.
// Same hoisting caveat: inline all jest.fn() calls in the factory.
// ---------------------------------------------------------------------------
jest.mock("next/server", () => ({
  NextRequest: jest.fn(),
  NextResponse: {
    // The middleware sets the CSP header on every response (M9), so each
    // mock response carries a recordable `headers.set`.
    redirect: jest.fn((url: URL) => ({
      type: "redirect",
      url: url.toString(),
      headers: { set: jest.fn() },
    })),
    next: jest.fn(() => ({ type: "next", headers: { set: jest.fn() } })),
    json: jest.fn((body: unknown, init?: { status?: number }) => ({
      type: "json",
      body,
      status: init?.status,
      headers: { set: jest.fn() },
    })),
  },
}));

import { middleware, config } from "@/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose/jwt/verify";

// Grab references to the mock functions for assertions
const mockRedirect = NextResponse.redirect as jest.MockedFunction<
  typeof NextResponse.redirect
>;
const mockNext = NextResponse.next as jest.MockedFunction<
  typeof NextResponse.next
>;
const mockJson = NextResponse.json as jest.MockedFunction<
  typeof NextResponse.json
>;
const mockJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake NextRequest with the given pathname and optional auth_token cookie */
function makeRequest(
  pathname: string,
  authToken?: string,
  options: { origin?: string; headers?: HeadersInit } = {},
): NextRequest {
  const origin = options.origin || "http://localhost:3001";
  return {
    nextUrl: {
      pathname,
    },
    url: `${origin}${pathname}`,
    // Plain object is a valid HeadersInit for `new Headers(request.headers)`
    // in the middleware's CSP/nonce forwarding.
    headers: new Headers(options.headers),
    cookies: {
      get: jest.fn((name: string) =>
        name === "auth_token" && authToken ? { value: authToken } : undefined,
      ),
    },
  } as unknown as NextRequest;
}

/**
 * Build a JWT-like token whose payload encodes to the given object.
 * This is NOT cryptographically signed — only the structure matters
 * for parseTokenStructure.
 */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(JSON.stringify(payload));
  const sig = "fakesig";
  return `${header}.${body}.${sig}`;
}

// ---------------------------------------------------------------------------
// Setup: ensure no JWT_SECRET so verifyToken falls through to
// parseTokenStructure in dev mode.
// ---------------------------------------------------------------------------
beforeAll(() => {
  delete process.env.JWT_SECRET;
  // Ensure we are NOT in production mode so parseTokenStructure is used
  (process.env as Record<string, string>).NODE_ENV = "test";
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ADMIN_CANONICAL_ORIGIN;
  delete process.env.ADMIN_IP_ALLOWLIST;
  delete process.env.NEXT_PUBLIC_ALLOWED_ORIGIN;
  delete process.env.NEXT_PUBLIC_WS_URL;
  delete process.env.NEXT_PUBLIC_METABASE_ORIGIN;
  (process.env as Record<string, string>).NODE_ENV = "test";
  // By default, jwtVerify should NOT be called (no secretKey)
  mockJwtVerify.mockReset();
});

// ---------------------------------------------------------------------------
// Matcher configuration
// ---------------------------------------------------------------------------
describe("middleware matcher config", () => {
  // M9: the matcher now covers every page (the CSP nonce must be on every
  // response) while excluding static assets; auth/IP gating stays
  // path-scoped inside the handler.
  it("has a single broad matcher that excludes static assets", () => {
    expect(config.matcher).toHaveLength(1);
    expect(config.matcher[0]).toContain("_next/static");
  });
});

// ---------------------------------------------------------------------------
// Dashboard route protection — unauthenticated
// ---------------------------------------------------------------------------
describe("middleware — dashboard protection (no token)", () => {
  it("redirects to /login when no auth_token cookie is present", async () => {
    const req = makeRequest("/dashboard");
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.pathname).toBe("/login");
  });

  it("includes redirect query param pointing to original path", async () => {
    const req = makeRequest("/dashboard/appointments");
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.searchParams.get("redirect")).toBe(
      "/dashboard/appointments",
    );
  });

  it("redirects when token is empty string", async () => {
    const req = makeRequest("/dashboard", "");
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
  });

  it("uses configured admin origin for production login redirects", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = "https://admin.vhhealth.app";
    process.env.ADMIN_IP_ALLOWLIST = "203.0.113.0/24";
    const req = makeRequest("/dashboard", undefined, {
      origin: "https://attacker.example",
      headers: { "x-forwarded-for": "203.0.113.10" },
    });

    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.origin).toBe("https://admin.vhhealth.app");
    expect(redirectUrl.toString()).not.toContain("attacker.example");
  });
});

// ---------------------------------------------------------------------------
// Dashboard route protection — authenticated
// ---------------------------------------------------------------------------
describe("middleware — dashboard protection (valid token)", () => {
  it("allows access to /dashboard with valid ADMIN token", async () => {
    const token = fakeJwt({
      role: "ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard", token);
    await middleware(req);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("allows SUPER_ADMIN access to any dashboard route", async () => {
    const token = fakeJwt({
      role: "SUPER_ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard/admin-management", token);
    await middleware(req);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Expired token
// ---------------------------------------------------------------------------
describe("middleware — expired token", () => {
  it("redirects to /login when token is expired", async () => {
    const token = fakeJwt({
      role: "ADMIN",
      exp: Math.floor(Date.now() / 1000) - 600, // expired 10 min ago
    });
    const req = makeRequest("/dashboard", token);
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.pathname).toBe("/login");
  });
});

// ---------------------------------------------------------------------------
// Malformed token
// ---------------------------------------------------------------------------
describe("middleware — malformed token", () => {
  it("redirects to /login for completely invalid token", async () => {
    const req = makeRequest("/dashboard", "not-a-jwt");
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
  });

  it("redirects to /login for token with only one part", async () => {
    const req = makeRequest("/dashboard", "onlyonepart");
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ROLE_RANK ordering
// ---------------------------------------------------------------------------
describe("ROLE_RANK ordering", () => {
  // We verify the role hierarchy indirectly through middleware behavior.
  // STAFF < DOCTOR < HR < ADMIN < SUPER_ADMIN

  it("STAFF is blocked from admin-only paths", async () => {
    const token = fakeJwt({
      role: "STAFF",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard/admin-management", token);
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.pathname).toBe("/dashboard");
  });

  it("DOCTOR is blocked from admin-only paths", async () => {
    const token = fakeJwt({
      role: "DOCTOR",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard/users", token);
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.pathname).toBe("/dashboard");
  });

  it("HR is blocked from admin-only paths", async () => {
    const token = fakeJwt({
      role: "HR",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard/settings", token);
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.pathname).toBe("/dashboard");
  });

  it("ADMIN is allowed on admin-only paths", async () => {
    const token = fakeJwt({
      role: "ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard/settings", token);
    await middleware(req);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("SUPER_ADMIN is allowed on admin-only paths", async () => {
    const token = fakeJwt({
      role: "SUPER_ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard/users", token);
    await middleware(req);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ADMIN_ONLY_PATHS enforcement
// ---------------------------------------------------------------------------
describe("ADMIN_ONLY_PATHS", () => {
  const adminOnlyPaths = [
    "/dashboard/payroll",
    "/dashboard/users",
    "/dashboard/system-audit",
    "/dashboard/analytics",
    "/dashboard/settings",
    "/dashboard/audit",
    "/dashboard/clinical-governance",
  ];

  it.each(adminOnlyPaths)("blocks STAFF from %s", async (path) => {
    const token = fakeJwt({
      role: "STAFF",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest(path, token);
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.pathname).toBe("/dashboard");
  });

  it.each(adminOnlyPaths)("allows ADMIN to access %s", async (path) => {
    const token = fakeJwt({
      role: "ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest(path, token);
    await middleware(req);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Clinical AI control-plane route
// ---------------------------------------------------------------------------
describe("CLINICAL_AI_CONTROL_PATHS", () => {
  it("blocks DOCTOR from Clinical AI governance", async () => {
    const token = fakeJwt({
      role: "DOCTOR",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard/clinical-ai", token);
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.pathname).toBe("/dashboard");
  });

  it("allows IT_ADMIN to access Clinical AI governance", async () => {
    const token = fakeJwt({
      role: "IT_ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard/clinical-ai", token);
    await middleware(req);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("allows ADMIN to access Clinical AI governance", async () => {
    const token = fakeJwt({
      role: "ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard/clinical-ai/settings", token);
    await middleware(req);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HR_PLUS_PATHS enforcement
// ---------------------------------------------------------------------------
describe("HR_PLUS_PATHS", () => {
  const hrPlusPaths = [
    "/dashboard/leave-approvals",
    "/dashboard/incidents",
    "/dashboard/grievances",
    "/dashboard/staff-roster",
    "/dashboard/attendance-audit",
    "/dashboard/reporting",
  ];

  it.each(hrPlusPaths)("blocks STAFF from %s", async (path) => {
    const token = fakeJwt({
      role: "STAFF",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest(path, token);
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.pathname).toBe("/dashboard");
  });

  it.each(hrPlusPaths)("blocks DOCTOR from %s", async (path) => {
    const token = fakeJwt({
      role: "DOCTOR",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest(path, token);
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.pathname).toBe("/dashboard");
  });

  it.each(hrPlusPaths)("allows HR to access %s", async (path) => {
    const token = fakeJwt({
      role: "HR",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest(path, token);
    await middleware(req);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it.each(hrPlusPaths)("allows HR_STAFF to access %s", async (path) => {
    const token = fakeJwt({
      role: "HR_STAFF",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest(path, token);
    await middleware(req);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it.each(hrPlusPaths)("allows ADMIN to access %s", async (path) => {
    const token = fakeJwt({
      role: "ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest(path, token);
    await middleware(req);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Sub-path matching (e.g., /dashboard/settings/general)
// ---------------------------------------------------------------------------
describe("middleware — sub-path matching", () => {
  it("blocks STAFF from sub-paths of admin-only routes", async () => {
    const token = fakeJwt({
      role: "STAFF",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard/settings/general", token);
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.pathname).toBe("/dashboard");
  });

  it("blocks DOCTOR from sub-paths of HR+ routes", async () => {
    const token = fakeJwt({
      role: "DOCTOR",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard/reporting/monthly", token);
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.pathname).toBe("/dashboard");
  });
});

// ---------------------------------------------------------------------------
// Non-restricted dashboard paths
// ---------------------------------------------------------------------------
describe("middleware — non-restricted dashboard paths", () => {
  it("allows STAFF to access /dashboard (main)", async () => {
    const token = fakeJwt({
      role: "STAFF",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard", token);
    await middleware(req);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("allows DOCTOR to access /dashboard/appointments", async () => {
    const token = fakeJwt({
      role: "DOCTOR",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard/appointments", token);
    await middleware(req);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Proxy route protection
// ---------------------------------------------------------------------------
describe("middleware — /api/proxy protection", () => {
  it("fails closed in production when ADMIN_IP_ALLOWLIST is missing", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    const req = makeRequest("/api/proxy/some-endpoint");

    await middleware(req);

    expect(mockJson).toHaveBeenCalledTimes(1);
    expect(mockJson).toHaveBeenCalledWith(
      { message: "Forbidden: IP not allowed" },
      { status: 403 },
    );
  });

  it("accepts production clients inside an ADMIN_IP_ALLOWLIST CIDR", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.ADMIN_IP_ALLOWLIST = "203.0.113.0/24";
    const req = makeRequest("/api/proxy/some-endpoint", undefined, {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });

    await middleware(req);

    expect(mockJson).toHaveBeenCalledWith(
      { message: "Authentication required" },
      { status: 401 },
    );
  });

  it("returns 401 JSON when no token is present on proxy route", async () => {
    const req = makeRequest("/api/proxy/some-endpoint");
    await middleware(req);

    expect(mockJson).toHaveBeenCalledTimes(1);
    expect(mockJson).toHaveBeenCalledWith(
      { message: "Authentication required" },
      { status: 401 },
    );
  });

  it("allows proxy requests with valid token", async () => {
    const token = fakeJwt({
      role: "ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/api/proxy/some-endpoint", token);
    await middleware(req);

    expect(mockNext).toHaveBeenCalled();
    expect(mockJson).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Non-matched routes (passthrough)
// ---------------------------------------------------------------------------
describe("middleware — non-matched routes", () => {
  it("calls NextResponse.next() for unmatched paths", async () => {
    const req = makeRequest("/login");
    await middleware(req);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Default-deny (audit finding H6/M8): unmapped dashboard segments are denied
// ---------------------------------------------------------------------------
describe("middleware — default-deny route policy", () => {
  it("redirects ANY role away from an unmapped dashboard segment", async () => {
    const token = fakeJwt({
      role: "SUPER_ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    // SUPER_ADMIN passes every ROLE check — but an UNMAPPED segment must
    // still deny, proving the gate is the policy map, not the role.
    const req = makeRequest("/dashboard/brand-new-unmapped-page", token);
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.pathname).toBe("/dashboard");
  });

  it.each([
    "/dashboard/tenants",
    "/dashboard/entitlements",
    "/dashboard/admin-management",
  ])("denies SUPER_ADMIN-only segment %s to plain ADMIN", async (path) => {
    const token = fakeJwt({
      role: "ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest(path, token);
    await middleware(req);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
    expect(redirectUrl.pathname).toBe("/dashboard");
  });
});

// ---------------------------------------------------------------------------
// Nonce-based CSP (audit finding M9)
// ---------------------------------------------------------------------------
describe("middleware — CSP header (M9)", () => {
  it("sets a nonce + strict-dynamic CSP with NO 'unsafe-inline' in script-src", async () => {
    const token = fakeJwt({
      role: "ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard", token);
    const res = (await middleware(req)) as unknown as {
      headers: { set: jest.Mock };
    };

    const cspCall = res.headers.set.mock.calls.find(
      (c: unknown[]) => c[0] === "Content-Security-Policy",
    );
    expect(cspCall).toBeDefined();
    const csp = cspCall![1] as string;
    expect(csp).toContain("'nonce-");
    expect(csp).toContain("'strict-dynamic'");
    const scriptSrc = csp
      .split(";")
      .find((d: string) => d.trim().startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("sets the CSP on login (unauthenticated) responses too", async () => {
    const req = makeRequest("/login");
    const res = (await middleware(req)) as unknown as {
      headers: { set: jest.Mock };
    };
    expect(
      res.headers.set.mock.calls.some(
        (c: unknown[]) => c[0] === "Content-Security-Policy",
      ),
    ).toBe(true);
  });

  it("keeps 'unsafe-eval' in script-src in development (Next HMR needs it)", async () => {
    (process.env as Record<string, string>).NODE_ENV = "development";
    const token = fakeJwt({
      role: "ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard", token);
    const res = (await middleware(req)) as unknown as {
      headers: { set: jest.Mock };
    };
    const cspCall = res.headers.set.mock.calls.find(
      (c: unknown[]) => c[0] === "Content-Security-Policy",
    );
    const scriptSrc = (cspCall![1] as string)
      .split(";")
      .find((d: string) => d.trim().startsWith("script-src"))!;
    expect(scriptSrc).toContain("'unsafe-eval'");
  });

  // Regression: the NEXT_PUBLIC_WS_URL override was honored by api-config's
  // WS_BASE_URL but the CSP only allowed the API-derived ws origin, so an
  // overridden realtime host was blocked by connect-src.
  it("includes the NEXT_PUBLIC_WS_URL override origin in connect-src", async () => {
    process.env.NEXT_PUBLIC_WS_URL = "wss://realtime.vhhealth.app";
    const req = makeRequest("/login");
    const res = (await middleware(req)) as unknown as {
      headers: { set: jest.Mock };
    };
    const cspCall = res.headers.set.mock.calls.find(
      (c: unknown[]) => c[0] === "Content-Security-Policy",
    );
    const connectSrc = (cspCall![1] as string)
      .split(";")
      .find((d: string) => d.trim().startsWith("connect-src"))!;
    expect(connectSrc).toContain("wss://realtime.vhhealth.app");
    // The API-derived ws origin stays allowed alongside the override.
    expect(connectSrc).toContain("'self'");
  });

  it("normalizes an http(s) NEXT_PUBLIC_WS_URL override to its ws(s) origin", async () => {
    process.env.NEXT_PUBLIC_WS_URL = "https://realtime.vhhealth.app/some/path";
    const req = makeRequest("/login");
    const res = (await middleware(req)) as unknown as {
      headers: { set: jest.Mock };
    };
    const cspCall = res.headers.set.mock.calls.find(
      (c: unknown[]) => c[0] === "Content-Security-Policy",
    );
    const connectSrc = (cspCall![1] as string)
      .split(";")
      .find((d: string) => d.trim().startsWith("connect-src"))!;
    expect(connectSrc).toContain("wss://realtime.vhhealth.app");
    expect(connectSrc).not.toContain("/some/path");
  });

  it("keeps the CSP unchanged when NEXT_PUBLIC_WS_URL is unset", async () => {
    const req = makeRequest("/login");
    const res = (await middleware(req)) as unknown as {
      headers: { set: jest.Mock };
    };
    const cspCall = res.headers.set.mock.calls.find(
      (c: unknown[]) => c[0] === "Content-Security-Policy",
    );
    const connectSrc = (cspCall![1] as string)
      .split(";")
      .find((d: string) => d.trim().startsWith("connect-src"))!;
    expect(connectSrc).not.toContain("realtime.vhhealth.app");
    // Exactly the pre-existing sources: self, API URL, API-derived ws
    // origin, and the Sentry hosts.
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";
    expect(connectSrc.trim()).toBe(
      `connect-src 'self' ${apiUrl} ${apiUrl.replace(/^http/, "ws")} ` +
        "https://*.sentry.io https://*.ingest.sentry.io",
    );
  });

  // Embedded BI (wt/bi-app): frame-src exists ONLY when the Metabase origin
  // env is configured; without it the emitted policy is byte-identical to
  // the pre-BI CSP (no frame-src directive at all).
  it("omits frame-src entirely when NEXT_PUBLIC_METABASE_ORIGIN is unset", async () => {
    const req = makeRequest("/login");
    const res = (await middleware(req)) as unknown as {
      headers: { set: jest.Mock };
    };
    const cspCall = res.headers.set.mock.calls.find(
      (c: unknown[]) => c[0] === "Content-Security-Policy",
    );
    const csp = cspCall![1] as string;
    expect(csp).not.toContain("frame-src");
    // frame-ancestors 'none' (who may frame US) is untouched.
    expect(csp).toContain("frame-ancestors 'none'");
    // The directive tail around the omitted frame-src is byte-identical to
    // the pre-BI policy.
    expect(csp).toContain(
      "child-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  });

  it("adds frame-src 'self' + the Metabase origin when NEXT_PUBLIC_METABASE_ORIGIN is set", async () => {
    process.env.NEXT_PUBLIC_METABASE_ORIGIN =
      "https://analytics.vhhealth.hospital.local";
    const req = makeRequest("/login");
    const res = (await middleware(req)) as unknown as {
      headers: { set: jest.Mock };
    };
    const cspCall = res.headers.set.mock.calls.find(
      (c: unknown[]) => c[0] === "Content-Security-Policy",
    );
    const csp = cspCall![1] as string;
    const frameSrc = csp
      .split(";")
      .find((d: string) => d.trim().startsWith("frame-src"))!;
    expect(frameSrc.trim()).toBe(
      "frame-src 'self' https://analytics.vhhealth.hospital.local",
    );
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("normalizes the Metabase env value to its origin and ignores garbage", async () => {
    process.env.NEXT_PUBLIC_METABASE_ORIGIN =
      "https://analytics.vhhealth.hospital.local/some/path";
    let res = (await middleware(makeRequest("/login"))) as unknown as {
      headers: { set: jest.Mock };
    };
    let csp = res.headers.set.mock.calls.find(
      (c: unknown[]) => c[0] === "Content-Security-Policy",
    )![1] as string;
    expect(csp).toContain(
      "frame-src 'self' https://analytics.vhhealth.hospital.local",
    );
    expect(csp).not.toContain("/some/path");

    // Unparseable value ⇒ fall back to no frame-src (fail closed).
    process.env.NEXT_PUBLIC_METABASE_ORIGIN = "not a url";
    res = (await middleware(makeRequest("/login"))) as unknown as {
      headers: { set: jest.Mock };
    };
    csp = res.headers.set.mock.calls.find(
      (c: unknown[]) => c[0] === "Content-Security-Policy",
    )![1] as string;
    expect(csp).not.toContain("frame-src");
  });

  it("DROPS 'unsafe-eval' from script-src in production (M-ADM-2)", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.ADMIN_IP_ALLOWLIST = "203.0.113.0/24";
    const token = fakeJwt({
      role: "ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard", token, {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    const res = (await middleware(req)) as unknown as {
      headers: { set: jest.Mock };
    };
    const cspCall = res.headers.set.mock.calls.find(
      (c: unknown[]) => c[0] === "Content-Security-Policy",
    );
    const scriptSrc = (cspCall![1] as string)
      .split(";")
      .find((d: string) => d.trim().startsWith("script-src"))!;
    // The hardening: prod CSP no longer permits eval (Sentry/app are eval-free).
    expect(scriptSrc).not.toContain("unsafe-eval");
    // The nonce + strict-dynamic XSS backstop stays intact.
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).toContain("'nonce-");
  });
});
