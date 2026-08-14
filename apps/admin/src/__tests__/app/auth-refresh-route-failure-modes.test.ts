// src/__tests__/app/auth-refresh-route-failure-modes.test.ts
//
// `/api/refresh` is the admin portal's session-rotation endpoint: it is the one
// route that reads the long-lived `refresh_token` cookie and mints a new access
// cookie from it. `auth-refresh-route.test.ts` covers the happy path (rotate and
// do not leak). This file covers the refusal paths — the branches that decide
// whether a caller gets a new session, whether the existing session is torn
// down, and whether the refresh credential is ever put on the wire.
//
// Each test asserts observable behaviour: status code, response body, whether
// the upstream call happened at all, and the exact cookie attributes emitted.

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
        secure?: boolean;
      }
    | undefined;
};

let refresh: Handler;

beforeAll(async () => {
  refresh = (await import("@/app/api/refresh/route")).POST as Handler;
});

beforeEach(() => fetchMock.mockReset());

function cookiesOf(response: Response): CookieBag {
  return (response as Response & { cookies: CookieBag }).cookies;
}

/** Build a POST to /api/refresh. `headers` fully replaces the defaults. */
function refreshRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest("https://admin.vhhealth.app/api/refresh", {
    method: "POST",
    headers,
  });
}

/** Same-origin POST carrying the given cookie header (omitted when undefined). */
function sameOriginRequest(cookie?: string): NextRequest {
  return refreshRequest({
    origin: "https://admin.vhhealth.app",
    ...(cookie === undefined ? {} : { cookie }),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A response whose body is not parseable JSON — exercises `.json().catch()`. */
function malformedJsonResponse(status = 200): Response {
  return new Response("<html>502 Bad Gateway</html>", {
    status,
    headers: { "content-type": "text/html" },
  });
}

/**
 * Both cookies must be positively expired: empty value, `Max-Age=0`, still
 * httpOnly + SameSite=Strict, and each on the path it was originally scoped to
 * (a mismatched path leaves the real cookie alive in the browser).
 */
function expectSessionTornDown(response: Response) {
  const cookies = cookiesOf(response);

  const auth = cookies.get("auth_token");
  expect(auth).toBeDefined();
  expect(auth?.value).toBe("");
  expect(auth?.maxAge).toBe(0);
  expect(auth?.path).toBe("/");
  expect(auth?.httpOnly).toBe(true);
  expect(auth?.sameSite).toBe("strict");

  const refreshCookie = cookies.get("refresh_token");
  expect(refreshCookie).toBeDefined();
  expect(refreshCookie?.value).toBe("");
  expect(refreshCookie?.maxAge).toBe(0);
  expect(refreshCookie?.path).toBe("/api/refresh");
  expect(refreshCookie?.httpOnly).toBe(true);
  expect(refreshCookie?.sameSite).toBe("strict");
}

/** No Set-Cookie at all — the caller's existing session is left untouched. */
function expectSessionUntouched(response: Response) {
  const cookies = cookiesOf(response);
  expect(cookies.get("auth_token")).toBeUndefined();
  expect(cookies.get("refresh_token")).toBeUndefined();
}

// ---------------------------------------------------------------------------
// CSRF gate
// ---------------------------------------------------------------------------

describe("/api/refresh CSRF gate", () => {
  it("rejects a POST with no Origin and no Referer without touching the backend", async () => {
    const response = await refresh(
      refreshRequest({ cookie: "refresh_token=refresh-one" }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ success: false });
    // The refresh credential must never leave the process on a request we
    // could not prove is same-origin.
    expect(fetchMock).not.toHaveBeenCalled();
    // A CSRF rejection must not double as a logout: a forged cross-site POST
    // that expired the victim's cookies would be a denial-of-service primitive.
    expectSessionUntouched(response);
  });

  it("rejects a cross-site Origin", async () => {
    const response = await refresh(
      refreshRequest({
        origin: "https://evil.example.com",
        cookie: "refresh_token=refresh-one",
      }),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expectSessionUntouched(response);
  });

  it("rejects a cross-site Referer when Origin is omitted", async () => {
    const response = await refresh(
      refreshRequest({
        referer: "https://evil.example.com/attack",
        cookie: "refresh_token=refresh-one",
      }),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a same-origin Referer when Origin is omitted", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { token: "access-new", refreshToken: "refresh-new" },
      }),
    );

    const response = await refresh(
      refreshRequest({
        referer: "https://admin.vhhealth.app/dashboard",
        cookie: "refresh_token=refresh-one",
      }),
    );

    expect(response.status).toBe(200);
    expect(cookiesOf(response).get("auth_token")?.value).toBe("access-new");
  });
});

// ---------------------------------------------------------------------------
// Refresh-cookie extraction
// ---------------------------------------------------------------------------

describe("/api/refresh cookie extraction", () => {
  it("returns 401 and tears the session down when no Cookie header is sent", async () => {
    const response = await refresh(sameOriginRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      message: "No session to refresh",
      success: false,
    });
    // Nothing to authenticate with — the backend must not be called with a
    // bare "Bearer undefined".
    expect(fetchMock).not.toHaveBeenCalled();
    expectSessionTornDown(response);
  });

  it("returns 401 when a Cookie header exists but carries no refresh_token", async () => {
    const response = await refresh(
      sameOriginRequest("auth_token=access-one; theme=dark"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      message: "No session to refresh",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expectSessionTornDown(response);
  });

  it("does not accept a cookie whose name merely ends in refresh_token", async () => {
    // Cookie-name prefix confusion: `x_refresh_token` is a different cookie and
    // an attacker-plantable one on a sibling host. It must not be harvested as
    // the session's refresh credential.
    const response = await refresh(
      sameOriginRequest(
        "x_refresh_token=attacker-supplied; auth_token=access-one",
      ),
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads refresh_token when it is not the first cookie in the header", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { token: "access-new", refreshToken: "refresh-new" },
      }),
    );

    await refresh(
      sameOriginRequest(
        "theme=dark; auth_token=access-one; refresh_token=refresh-one",
      ),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://backend.test/api/v1/auth/refresh-token",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer refresh-one",
        }),
      }),
    );
  });

  it("sends only the refresh credential upstream — never the access cookie or raw Cookie header", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { token: "access-new", refreshToken: "refresh-new" },
      }),
    );

    await refresh(
      sameOriginRequest("auth_token=access-one; refresh_token=refresh-one"),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer refresh-one");
    expect(headers.cookie).toBeUndefined();
    expect(headers.Cookie).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain("access-one");
    // No request body: the token travels in the Authorization header only.
    expect(init.body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Upstream refusal / failure modes
// ---------------------------------------------------------------------------

describe("/api/refresh upstream failure modes", () => {
  it("propagates the backend's rejection message and tears the session down on 401", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: "Refresh token revoked", success: false }, 401),
    );

    const response = await refresh(
      sameOriginRequest("refresh_token=refresh-one"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      message: "Refresh token revoked",
      success: false,
    });
    expectSessionTornDown(response);
  });

  it("falls back to a generic message when the backend rejects without one", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const response = await refresh(
      sameOriginRequest("refresh_token=refresh-one"),
    );

    // Fail-closed: any non-2xx upstream answer ends the session rather than
    // leaving the browser holding a credential the backend already refused.
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      message: "Refresh rejected",
      success: false,
    });
    expectSessionTornDown(response);
  });

  it("does not crash on a non-JSON error body", async () => {
    fetchMock.mockResolvedValue(malformedJsonResponse(502));

    const response = await refresh(
      sameOriginRequest("refresh_token=refresh-one"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      message: "Refresh rejected",
      success: false,
    });
    expectSessionTornDown(response);
  });

  it("returns 502 and tears the session down when a 200 carries no access token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { refreshToken: "refresh-new" } }),
    );

    const response = await refresh(
      sameOriginRequest("refresh_token=refresh-one"),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      message: "Incomplete session credentials in refresh response",
      success: false,
    });
    expectSessionTornDown(response);
  });

  it("returns 502 when a 200 carries an access token but no rotated refresh token", async () => {
    // Half a rotation is worse than none: setting auth_token while leaving the
    // old refresh_token in place would silently pin the session to a credential
    // the backend believes it has retired.
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { token: "access-new" } }),
    );

    const response = await refresh(
      sameOriginRequest("refresh_token=refresh-one"),
    );

    expect(response.status).toBe(502);
    expectSessionTornDown(response);
  });

  it("returns 502 on a 200 whose body is not JSON at all", async () => {
    fetchMock.mockResolvedValue(malformedJsonResponse(200));

    const response = await refresh(
      sameOriginRequest("refresh_token=refresh-one"),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      message: "Incomplete session credentials in refresh response",
    });
    expectSessionTornDown(response);
  });

  it("returns 502 and LEAVES the session intact when the backend is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const response = await refresh(
      sameOriginRequest("refresh_token=refresh-one"),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      message: "Refresh service unavailable",
      success: false,
    });
    // Deliberate asymmetry vs. the rejection paths above: a transport blip is
    // not evidence the credential is bad, so it must not log the operator out
    // mid-shift.
    expectSessionUntouched(response);
  });
});

// ---------------------------------------------------------------------------
// Successful rotation — envelope shapes and cookie attributes
// ---------------------------------------------------------------------------

describe("/api/refresh successful rotation", () => {
  it("accepts an unwrapped envelope (token at the top level)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ token: "access-flat", refreshToken: "refresh-flat" }),
    );

    const response = await refresh(
      sameOriginRequest("refresh_token=refresh-one"),
    );

    expect(response.status).toBe(200);
    const cookies = cookiesOf(response);
    expect(cookies.get("auth_token")?.value).toBe("access-flat");
    expect(cookies.get("refresh_token")?.value).toBe("refresh-flat");
  });

  it("accepts `accessToken` as an alias for `token`", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { accessToken: "access-alias", refreshToken: "refresh-alias" },
      }),
    );

    const response = await refresh(
      sameOriginRequest("refresh_token=refresh-one"),
    );

    expect(response.status).toBe(200);
    expect(cookiesOf(response).get("auth_token")?.value).toBe("access-alias");
  });

  it("returns only {success:true} and never echoes either credential in the body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          token: "access-secret",
          refreshToken: "refresh-secret",
          admin: { uid: "admin-1", role: "ADMIN" },
        },
      }),
    );

    const response = await refresh(
      sameOriginRequest("refresh_token=refresh-one"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true });
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("access-secret");
    expect(serialised).not.toContain("refresh-secret");
  });

  it("scopes the rotated cookies correctly (httpOnly, SameSite=Strict, paths, lifetimes)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { token: "access-new", refreshToken: "refresh-new" },
      }),
    );

    const response = await refresh(
      sameOriginRequest("refresh_token=refresh-one"),
    );
    const cookies = cookiesOf(response);

    const auth = cookies.get("auth_token");
    expect(auth?.httpOnly).toBe(true);
    expect(auth?.sameSite).toBe("strict");
    expect(auth?.path).toBe("/");
    expect(auth?.maxAge).toBe(60 * 60 * 4); // matches backend admin JWT expiry

    const rotated = cookies.get("refresh_token");
    expect(rotated?.httpOnly).toBe(true);
    expect(rotated?.sameSite).toBe("strict");
    // Path-scoped to this route so the long-lived credential is not attached
    // to every same-site request.
    expect(rotated?.path).toBe("/api/refresh");
    expect(rotated?.maxAge).toBe(60 * 60 * 24 * 30);
  });
});

// ---------------------------------------------------------------------------
// Server-side API key selection (resolved once, at module load)
// ---------------------------------------------------------------------------

describe("/api/refresh backend API key forwarding", () => {
  /** Re-import the route under a pinned env so the module-scope key is re-read. */
  async function loadRouteWith(env: {
    BACKEND_API_KEY?: string;
    API_KEY?: string;
  }): Promise<Handler> {
    const previous = {
      BACKEND_API_KEY: process.env.BACKEND_API_KEY,
      API_KEY: process.env.API_KEY,
    };
    delete process.env.BACKEND_API_KEY;
    delete process.env.API_KEY;
    if (env.BACKEND_API_KEY !== undefined)
      process.env.BACKEND_API_KEY = env.BACKEND_API_KEY;
    if (env.API_KEY !== undefined) process.env.API_KEY = env.API_KEY;

    let handler: Handler;
    try {
      await jest.isolateModulesAsync(async () => {
        handler = (await import("@/app/api/refresh/route")).POST as Handler;
      });
    } finally {
      delete process.env.BACKEND_API_KEY;
      delete process.env.API_KEY;
      if (previous.BACKEND_API_KEY !== undefined)
        process.env.BACKEND_API_KEY = previous.BACKEND_API_KEY;
      if (previous.API_KEY !== undefined)
        process.env.API_KEY = previous.API_KEY;
    }
    return handler!;
  }

  async function capturedHeaders(
    handler: Handler,
  ): Promise<Record<string, string>> {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { token: "access-new", refreshToken: "refresh-new" },
      }),
    );
    await handler(sameOriginRequest("refresh_token=refresh-one"));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return init.headers as Record<string, string>;
  }

  it("forwards BACKEND_API_KEY as x-api-key", async () => {
    const handler = await loadRouteWith({ BACKEND_API_KEY: "primary-key" });
    const headers = await capturedHeaders(handler);

    expect(headers["x-api-key"]).toBe("primary-key");
    // The backend rejects the refresh unless it believes the call is server-side.
    expect(headers["x-forwarded-proto"]).toBe("https");
  });

  it("falls back to the legacy API_KEY name", async () => {
    const handler = await loadRouteWith({ API_KEY: "legacy-key" });
    const headers = await capturedHeaders(handler);

    expect(headers["x-api-key"]).toBe("legacy-key");
  });

  it("prefers BACKEND_API_KEY when both are set", async () => {
    const handler = await loadRouteWith({
      BACKEND_API_KEY: "primary-key",
      API_KEY: "legacy-key",
    });
    const headers = await capturedHeaders(handler);

    expect(headers["x-api-key"]).toBe("primary-key");
  });

  it("omits x-api-key entirely when neither name is configured", async () => {
    const handler = await loadRouteWith({});
    const headers = await capturedHeaders(handler);

    // An empty-string header would be sent as a real (blank) API key; the route
    // must drop the header instead.
    expect(headers).not.toHaveProperty("x-api-key");
  });
});
