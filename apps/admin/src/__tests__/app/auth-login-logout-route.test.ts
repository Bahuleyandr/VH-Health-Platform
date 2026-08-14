// src/__tests__/app/auth-login-logout-route.test.ts
//
// `/api/login` is the only route that mints an admin session cookie, and
// `/api/logout` is the only one that destroys it. `auth-refresh-route.test.ts`
// asserts the happy path (cookies set, credentials not echoed). This file
// covers the refusal and passthrough paths — in particular the two MFA legs,
// which return 200 and MUST NOT mint a session, and the malformed/incomplete
// upstream answers, which must not half-authenticate the caller.

import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = "https://admin.vhhealth.app";

jest.mock("@/lib/api-config", () => ({
  getServerBackendUrl: () => "https://backend.test",
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

type Handler = (request: NextRequest) => Promise<Response>;
type CookieBag = {
  get: (name: string) =>
    | {
        value: string;
        path?: string;
        maxAge?: number;
        httpOnly?: boolean;
        sameSite?: string;
      }
    | undefined;
};

let login: Handler;
let logout: Handler;

beforeAll(async () => {
  login = (await import("@/app/api/login/route")).POST as Handler;
  logout = (await import("@/app/api/logout/route")).POST as Handler;
});

beforeEach(() => fetchMock.mockReset());

function cookiesOf(response: Response): CookieBag {
  return (response as Response & { cookies: CookieBag }).cookies;
}

function post(
  path: string,
  body?: unknown,
  headers: Record<string, string> = { origin: "https://admin.vhhealth.app" },
): NextRequest {
  return new NextRequest(`https://admin.vhhealth.app${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** No session was minted: neither credential cookie is present on the response. */
function expectNoSessionMinted(response: Response) {
  const cookies = cookiesOf(response);
  expect(cookies.get("auth_token")).toBeUndefined();
  expect(cookies.get("refresh_token")).toBeUndefined();
}

// ---------------------------------------------------------------------------
// /api/login — CSRF + request shape
// ---------------------------------------------------------------------------

describe("/api/login request gating", () => {
  it("rejects a cross-site Origin before reading the credential body", async () => {
    const response = await login(
      post(
        "/api/login",
        { username: "root", password: "secret" },
        { origin: "https://evil.example.com" },
      ),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expectNoSessionMinted(response);
  });

  it("returns 400 for a body carrying neither credential pair", async () => {
    const response = await login(post("/api/login", { username: "root" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      message: "Invalid login request",
    });
    // No identifier/secret pair means nothing to verify — the backend must not
    // be probed with a partial credential.
    expect(fetchMock).not.toHaveBeenCalled();
    expectNoSessionMinted(response);
  });

  it("routes an employeeId login to the staff endpoint and pins deviceType=web", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { token: "staff-access", refreshToken: "staff-refresh" },
      }),
    );

    const response = await login(
      post("/api/login", { employeeId: "EMP-42", password: "secret" }),
    );

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://backend.test/api/v1/auth/staff/login");
    // deviceType is pinned server-side: the backend keys its single-active-
    // session policy and device-class RBAC off this claim, so the browser must
    // not get to choose it.
    expect(JSON.parse(String(init.body))).toEqual({
      employeeId: "EMP-42",
      password: "secret",
      deviceType: "web",
    });
    expect(cookiesOf(response).get("auth_token")?.value).toBe("staff-access");
  });

  it("routes a username login to the admin endpoint and pins deviceType=web", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { token: "admin-access", refreshToken: "admin-refresh" },
      }),
    );

    await login(post("/api/login", { username: "root", password: "secret" }));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://backend.test/api/v1/auth/admin/login");
    expect(JSON.parse(String(init.body))).toEqual({
      username: "root",
      password: "secret",
      deviceType: "web",
    });
  });
});

// ---------------------------------------------------------------------------
// /api/login — MFA passthroughs (200 responses that must NOT mint a session)
// ---------------------------------------------------------------------------

describe("/api/login MFA passthroughs", () => {
  it("forwards a two-factor challenge WITHOUT setting any session cookie", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { requiresTwoFactor: true, challengeToken: "challenge-abc" },
      }),
    );

    const response = await login(
      post("/api/login", { username: "root", password: "secret" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { requiresTwoFactor: true, challengeToken: "challenge-abc" },
    });
    // The whole point of the second factor: password-only must not yield a
    // usable session cookie.
    expectNoSessionMinted(response);
  });

  it("forwards a first-time MFA setup token WITHOUT setting any session cookie", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { requiresMfaSetup: true, setupToken: "setup-abc" },
      }),
    );

    const response = await login(
      post("/api/login", { username: "root", password: "secret" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { requiresMfaSetup: true, setupToken: "setup-abc" },
    });
    expectNoSessionMinted(response);
  });

  it("does not treat a bare requiresTwoFactor flag (no challengeToken) as a challenge", async () => {
    // Both halves are required. A truthy flag with no challenge token is a
    // malformed answer, and falling through to token extraction must not
    // produce a session either.
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { requiresTwoFactor: true } }),
    );

    const response = await login(
      post("/api/login", { username: "root", password: "secret" }),
    );

    expect(response.status).toBe(502);
    expectNoSessionMinted(response);
  });
});

// ---------------------------------------------------------------------------
// /api/login — upstream failure modes
// ---------------------------------------------------------------------------

describe("/api/login upstream failure modes", () => {
  it("propagates the backend's status and message on rejected credentials", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: "Invalid credentials" }, 401),
    );

    const response = await login(
      post("/api/login", { username: "root", password: "wrong" }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      message: "Invalid credentials",
      success: false,
    });
    expectNoSessionMinted(response);
  });

  it("falls back to a generic message when the backend rejects without one", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 423));

    const response = await login(
      post("/api/login", { username: "root", password: "secret" }),
    );

    expect(response.status).toBe(423);
    await expect(response.json()).resolves.toEqual({
      message: "Login failed",
      success: false,
    });
  });

  it("returns 502 when a 200 carries an access token but no refresh token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { token: "only-access" } }),
    );

    const response = await login(
      post("/api/login", { username: "root", password: "secret" }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      message: "Incomplete session credentials in server response",
      success: false,
    });
    // Half a session is not a session: setting auth_token with no refresh
    // credential would strand the operator at the 4h mark with no rotation.
    expectNoSessionMinted(response);
  });

  it("accepts an unwrapped envelope and the accessToken alias", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        accessToken: "flat-access",
        refreshToken: "flat-refresh",
      }),
    );

    const response = await login(
      post("/api/login", { username: "root", password: "secret" }),
    );

    expect(response.status).toBe(200);
    const cookies = cookiesOf(response);
    expect(cookies.get("auth_token")?.value).toBe("flat-access");
    expect(cookies.get("refresh_token")?.value).toBe("flat-refresh");
  });

  it("returns 502 without leaking transport detail when the backend is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("ECONNREFUSED 10.0.0.5:5000"));

    const response = await login(
      post("/api/login", { username: "root", password: "secret" }),
    );

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({
      message: "Login service unavailable",
      success: false,
    });
    // Internal topology must not reach the browser on a login error page.
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
    expectNoSessionMinted(response);
  });

  it("returns 502 when the backend answers 200 with a non-JSON body", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const response = await login(
      post("/api/login", { username: "root", password: "secret" }),
    );

    // `data = await upstream.json()` throws, so this lands in the catch.
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      message: "Login service unavailable",
    });
    expectNoSessionMinted(response);
  });
});

// ---------------------------------------------------------------------------
// /api/login — token stripping + cookie scoping on success
// ---------------------------------------------------------------------------

describe("/api/login successful session mint", () => {
  const upstreamBody = {
    success: true,
    message: "Login successful",
    token: "top-level-access",
    refreshToken: "top-level-refresh",
    data: {
      token: "nested-access",
      accessToken: "nested-alias",
      refreshToken: "nested-refresh",
      admin: { uid: "admin-1", role: "ADMIN" },
    },
  };

  it("strips every JWT field from BOTH envelope levels before answering", async () => {
    fetchMock.mockResolvedValue(jsonResponse(upstreamBody));

    const response = await login(
      post("/api/login", { username: "root", password: "secret" }),
    );

    const body = await response.json();
    const serialised = JSON.stringify(body);
    for (const secret of [
      "top-level-access",
      "top-level-refresh",
      "nested-access",
      "nested-alias",
      "nested-refresh",
    ]) {
      expect(serialised).not.toContain(secret);
    }
    // The non-credential payload the client actually reads survives intact.
    expect(body.data.admin).toEqual({ uid: "admin-1", role: "ADMIN" });
    expect(body.message).toBe("Login successful");
  });

  it("scopes the minted cookies (httpOnly, SameSite=Strict, paths, lifetimes)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(upstreamBody));

    const response = await login(
      post("/api/login", { username: "root", password: "secret" }),
    );
    const cookies = cookiesOf(response);

    const auth = cookies.get("auth_token");
    expect(auth?.value).toBe("nested-access");
    expect(auth?.httpOnly).toBe(true);
    expect(auth?.sameSite).toBe("strict");
    expect(auth?.path).toBe("/");
    expect(auth?.maxAge).toBe(60 * 60 * 4);

    const refresh = cookies.get("refresh_token");
    expect(refresh?.value).toBe("nested-refresh");
    expect(refresh?.httpOnly).toBe(true);
    expect(refresh?.sameSite).toBe("strict");
    // Path-scoped so the 30-day credential is not attached to ordinary
    // same-site traffic.
    expect(refresh?.path).toBe("/api/refresh");
    expect(refresh?.maxAge).toBe(60 * 60 * 24 * 30);
  });
});

// ---------------------------------------------------------------------------
// /api/logout
// ---------------------------------------------------------------------------

describe("/api/logout", () => {
  it("refuses a cross-site POST and leaves the session intact", async () => {
    const response = await logout(
      post("/api/logout", undefined, { origin: "https://evil.example.com" }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ success: false });
    // A forged cross-site logout is a real (if minor) attack: it would let any
    // page on the internet sign the operator out mid-shift.
    const cookies = cookiesOf(response);
    expect(cookies.get("auth_token")).toBeUndefined();
    expect(cookies.get("refresh_token")).toBeUndefined();
  });

  it("refuses a POST with no Origin and no Referer", async () => {
    const response = await logout(post("/api/logout", undefined, {}));

    expect(response.status).toBe(403);
  });

  it("expires both cookies on their original paths", async () => {
    const response = await logout(post("/api/logout"));
    const cookies = cookiesOf(response);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });

    const auth = cookies.get("auth_token");
    expect(auth?.value).toBe("");
    expect(auth?.maxAge).toBe(0);
    expect(auth?.path).toBe("/");
    expect(auth?.httpOnly).toBe(true);
    expect(auth?.sameSite).toBe("strict");

    const refresh = cookies.get("refresh_token");
    expect(refresh?.value).toBe("");
    expect(refresh?.maxAge).toBe(0);
    // Must match the path the cookie was set on, or the browser keeps the real
    // refresh_token and the "logout" is cosmetic.
    expect(refresh?.path).toBe("/api/refresh");
    expect(refresh?.httpOnly).toBe(true);
    expect(refresh?.sameSite).toBe("strict");
  });
});
