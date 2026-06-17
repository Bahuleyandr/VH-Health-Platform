/**
 * Auth-flow unit tests — first coverage of the login + refresh paths.
 *
 * These are unit tests against `src/lib/api-client.ts` that stub `fetch`
 * directly. Full component-level tests against <LoginClient /> will come
 * later; this file scaffolds the admin test infra for Phase 2.
 */

import { adminLogin, refreshToken, staffLogin } from "@/lib/api-client";

type FetchArgs = [RequestInfo | URL, RequestInit | undefined];
let fetchCalls: FetchArgs[] = [];
const TEST_ADMIN_USERNAME = "admin-fixture";
const TEST_LOGIN_SECRET = "login-fixture-secret";
const PASSWORD_FIELD = "password";

function mockFetch(handler: (input: FetchArgs[0], init: FetchArgs[1]) => Response | Promise<Response>) {
  fetchCalls = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: FetchArgs[0],
    init?: FetchArgs[1],
  ) => {
    fetchCalls.push([input, init]);
    return handler(input, init);
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  // Reset localStorage cached admin between tests
  localStorage.clear();
});

describe("adminLogin", () => {
  it("resolves with {admin} on a cookie-only login (token is in the httpOnly cookie, not the body)", async () => {
    // The real /api/login route strips token/accessToken/refreshToken from the
    // body — the credential lives ONLY in the httpOnly auth_token cookie — so
    // the client must NOT depend on a body token. Mock the stripped shape.
    mockFetch(async () =>
      jsonResponse(200, {
        data: {
          admin: { uid: "a1", name: "Admin One", username: TEST_ADMIN_USERNAME, role: "ADMIN" },
        },
      }),
    );

    const result = await adminLogin(TEST_ADMIN_USERNAME, TEST_LOGIN_SECRET);
    expect(result.success).toBe(true);
    expect(result.requiresTwoFactor).toBe(false);
    if (!result.requiresTwoFactor && !result.requiresMfaSetup) {
      expect(result.admin?.username).toBe(TEST_ADMIN_USERNAME);
    }

    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0];
    expect(String(url)).toBe("/api/login");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      username: TEST_ADMIN_USERNAME,
      [PASSWORD_FIELD]: TEST_LOGIN_SECRET,
    });
  });

  it("returns MFA challenge when backend asks for a second factor", async () => {
    mockFetch(async () =>
      jsonResponse(200, {
        data: {
          requiresTwoFactor: true,
          challengeToken: "chal-xyz",
          expiresAt: "2026-04-13T12:00:00Z",
          admin: { username: TEST_ADMIN_USERNAME },
        },
      }),
    );

    const result = await adminLogin(TEST_ADMIN_USERNAME, TEST_LOGIN_SECRET);
    expect(result.success).toBe(true);
    expect(result.requiresTwoFactor).toBe(true);
    if (result.requiresTwoFactor) {
      expect(result.challengeToken).toBe("chal-xyz");
      expect(result.expiresAt).toBe("2026-04-13T12:00:00Z");
      expect(result.admin?.username).toBe(TEST_ADMIN_USERNAME);
    }
  });

  it("throws on 401 with backend-provided message", async () => {
    mockFetch(async () =>
      jsonResponse(401, { message: "Invalid credentials", success: false }),
    );

    await expect(adminLogin(TEST_ADMIN_USERNAME, "wrong")).rejects.toThrow(
      "Invalid credentials",
    );
  });

  it("throws with generic fallback when backend returns no message", async () => {
    mockFetch(async () => jsonResponse(500, { success: false }));
    await expect(adminLogin(TEST_ADMIN_USERNAME, "pw")).rejects.toThrow(/Login failed/);
  });

  it("does NOT throw on a cookie-only response with no body token (stripTokens regression guard)", async () => {
    // Regression guard: /api/login no longer returns the token in the body
    // (cookie-only). The client must treat 200 + admin as success, never throw
    // "No token received". A prior version of this test asserted the throw and
    // thereby masked a login-breaking regression.
    mockFetch(async () =>
      jsonResponse(200, {
        data: { admin: { uid: "a1", username: TEST_ADMIN_USERNAME, role: "ADMIN" } },
      }),
    );
    const result = await adminLogin(TEST_ADMIN_USERNAME, "pw");
    expect(result.success).toBe(true);
    if (!result.requiresTwoFactor && !result.requiresMfaSetup) {
      expect(result.admin?.username).toBe(TEST_ADMIN_USERNAME);
    }
  });
});

describe("staffLogin", () => {
  it("POSTs staff credentials to /api/login and caches the staff profile", async () => {
    mockFetch(async () =>
      jsonResponse(200, {
        data: {
          // Cookie-only: the route strips accessToken/token from the body.
          staff: {
            id: 1005,
            uid: "staff-uid",
            name: "Test HR",
            employeeId: "EMP-1005",
            role: "HR_STAFF",
            permissions: [],
          },
        },
      }),
    );

    const result = await staffLogin("EMP-1005", TEST_LOGIN_SECRET);
    expect(result.success).toBe(true);
    expect(result.user?.role).toBe("HR_STAFF");

    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0];
    expect(String(url)).toBe("/api/login");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      employeeId: "EMP-1005",
      [PASSWORD_FIELD]: TEST_LOGIN_SECRET,
    });
    expect(JSON.parse(localStorage.getItem("adminUser") || "{}").role).toBe("HR_STAFF");
  });
});

describe("refreshToken", () => {
  it("POSTs to /api/refresh with credentials: include", async () => {
    mockFetch(async () => new Response(null, { status: 200 }));

    await refreshToken();

    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0];
    expect(String(url)).toBe("/api/refresh");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
  });

  it("throws and clears cached admin on non-OK response", async () => {
    localStorage.setItem(
      "adminUser",
      JSON.stringify({ uid: "a1", name: "A", role: "ADMIN", permissions: [] }),
    );
    mockFetch(async () => jsonResponse(401, { message: "Expired" }));

    await expect(refreshToken()).rejects.toThrow(/Refresh failed/);
    expect(localStorage.getItem("adminUser")).toBeNull();
  });
});
