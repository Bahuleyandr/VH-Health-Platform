/**
 * Tests for src/middleware.ts
 *
 * Covers:
 *   - parseTokenStructure: structural JWT validation (dev fallback)
 *   - ADMIN_ONLY_PATHS and HR_PLUS_PATHS definitions
 *   - ROLE_RANK ordering
 *   - Dashboard routes are protected (redirect to /login when unauthenticated)
 *   - Role-based access control on restricted paths
 *   - Proxy route protection
 *   - Matcher configuration
 */

// ---------------------------------------------------------------------------
// Mock jose — prevent real JWT verification; we control outcomes per test.
// jest.mock calls are hoisted above imports by the transformer, so the
// factory must not reference outer variables declared with const/let.
// ---------------------------------------------------------------------------
jest.mock("jose", () => ({
  jwtVerify: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock NextResponse — capture redirect / json / next calls.
// Same hoisting caveat: inline all jest.fn() calls in the factory.
// ---------------------------------------------------------------------------
jest.mock("next/server", () => ({
  NextRequest: jest.fn(),
  NextResponse: {
    redirect: jest.fn((url: URL) => ({
      type: "redirect",
      url: url.toString(),
    })),
    next: jest.fn(() => ({ type: "next" })),
    json: jest.fn((body: unknown, init?: { status?: number }) => ({
      type: "json",
      body,
      status: init?.status,
    })),
  },
}));

import { middleware, config } from "@/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

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
  it("matches dashboard routes", () => {
    expect(config.matcher).toContain("/dashboard/:path*");
  });

  it("matches proxy routes", () => {
    expect(config.matcher).toContain("/api/proxy/:path*");
  });

  it("has exactly 2 matchers", () => {
    expect(config.matcher).toHaveLength(2);
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
    "/dashboard/attendance-audit",
    "/dashboard/admin-management",
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
// HR_PLUS_PATHS enforcement
// ---------------------------------------------------------------------------
describe("HR_PLUS_PATHS", () => {
  const hrPlusPaths = [
    "/dashboard/leave-approvals",
    "/dashboard/incidents",
    "/dashboard/grievances",
    "/dashboard/staff-roster",
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
