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
const mockRedirect = NextResponse.redirect as jest.MockedFunction<typeof NextResponse.redirect>;
const mockNext = NextResponse.next as jest.MockedFunction<typeof NextResponse.next>;
const mockJson = NextResponse.json as jest.MockedFunction<typeof NextResponse.json>;
const mockJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake NextRequest with the given pathname and optional auth_token cookie */
function makeRequest(pathname: string, authToken?: string): NextRequest {
  return {
    nextUrl: {
      pathname,
    },
    url: `http://localhost:3001${pathname}`,
    // Plain object is a valid HeadersInit for `new Headers(request.headers)`
    // in the middleware's CSP/nonce forwarding.
    headers: {},
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
    const req = makeRequest("/dashboard/admin-management", token);
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
    "/dashboard/admin-management",
    "/dashboard/clinical-governance",
  ];

  it.each(adminOnlyPaths)(
    "blocks STAFF from %s",
    async (path) => {
      const token = fakeJwt({
        role: "STAFF",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const req = makeRequest(path, token);
      await middleware(req);

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
      expect(redirectUrl.pathname).toBe("/dashboard");
    },
  );

  it.each(adminOnlyPaths)(
    "allows ADMIN to access %s",
    async (path) => {
      const token = fakeJwt({
        role: "ADMIN",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const req = makeRequest(path, token);
      await middleware(req);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(mockRedirect).not.toHaveBeenCalled();
    },
  );
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

  it.each(hrPlusPaths)(
    "blocks STAFF from %s",
    async (path) => {
      const token = fakeJwt({
        role: "STAFF",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const req = makeRequest(path, token);
      await middleware(req);

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
      expect(redirectUrl.pathname).toBe("/dashboard");
    },
  );

  it.each(hrPlusPaths)(
    "blocks DOCTOR from %s",
    async (path) => {
      const token = fakeJwt({
        role: "DOCTOR",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const req = makeRequest(path, token);
      await middleware(req);

      expect(mockRedirect).toHaveBeenCalledTimes(1);
      const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
      expect(redirectUrl.pathname).toBe("/dashboard");
    },
  );

  it.each(hrPlusPaths)(
    "allows HR to access %s",
    async (path) => {
      const token = fakeJwt({
        role: "HR",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const req = makeRequest(path, token);
      await middleware(req);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(mockRedirect).not.toHaveBeenCalled();
    },
  );

  it.each(hrPlusPaths)(
    "allows HR_STAFF to access %s",
    async (path) => {
      const token = fakeJwt({
        role: "HR_STAFF",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const req = makeRequest(path, token);
      await middleware(req);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(mockRedirect).not.toHaveBeenCalled();
    },
  );

  it.each(hrPlusPaths)(
    "allows ADMIN to access %s",
    async (path) => {
      const token = fakeJwt({
        role: "ADMIN",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const req = makeRequest(path, token);
      await middleware(req);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(mockRedirect).not.toHaveBeenCalled();
    },
  );
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

  it("denies SUPER_ADMIN-only segments to plain ADMIN (tenants)", async () => {
    const token = fakeJwt({
      role: "ADMIN",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeRequest("/dashboard/tenants", token);
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
});
