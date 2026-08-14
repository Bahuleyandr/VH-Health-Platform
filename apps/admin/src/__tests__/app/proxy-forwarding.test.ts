// src/__tests__/app/proxy-forwarding.test.ts
//
// `/api/proxy/[...path]` is the admin portal's only route to the backend: every
// authenticated call the browser makes is relayed through it, and it is where
// the bearer token and the server-only API key are attached. `proxy-csrf`,
// `proxy-path-allowlist`, `proxy-permissions` and `proxy-tenant-headers` cover
// the four refusal gates. This file covers what happens *after* those gates —
// which verbs are exposed, how request bodies are relayed, and which response
// headers survive the hop.

import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = "https://admin.vhhealth.app";

const getVerifiedTokenRole = jest.fn();
jest.mock("@/lib/serverTokenRole", () => ({
  getVerifiedTokenRole: (...a: unknown[]) => getVerifiedTokenRole(...a),
  isSuperAdminRole: (r: string | null) =>
    String(r || "").toUpperCase() === "SUPER_ADMIN",
}));

const ORIGIN = "https://admin.vhhealth.app";
const TENANT = "a5a5a5a5-c5c5-4a5a-8a5a-a5a5c5c5aa01";
// api/v1/records is on the proxy allowlist and carries no permission gate, so
// these tests exercise forwarding rather than re-testing authorization.
const UNGATED = "api/v1/records/abc";

type Handler = (req: NextRequest) => Promise<Response> | Response;
let GET: Handler;
let POST: Handler;
let PUT: Handler;
let PATCH: Handler;
let DELETE: Handler;
let OPTIONS: Handler;

let fetchMock: jest.SpyInstance;

beforeAll(async () => {
  const route = await import("@/app/api/proxy/[...path]/route");
  GET = route.GET as Handler;
  POST = route.POST as Handler;
  PUT = route.PUT as Handler;
  PATCH = route.PATCH as Handler;
  DELETE = route.DELETE as Handler;
  OPTIONS = route.OPTIONS as Handler;
});

beforeEach(() => {
  getVerifiedTokenRole.mockReset();
  getVerifiedTokenRole.mockResolvedValue("ADMIN");
  fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response);
});
afterEach(() => fetchMock.mockRestore());

function makeReq(
  method: string,
  path = UNGATED,
  {
    cookie = "auth_token=valid-token",
    headers = {},
    body,
  }: {
    cookie?: string;
    headers?: Record<string, string>;
    body?: BodyInit;
  } = {},
): NextRequest {
  return new NextRequest(`${ORIGIN}/api/proxy/${path}`, {
    method,
    headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

function forwardedInit(): RequestInit {
  return (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit;
}

function forwardedHeaders(): Record<string, string> {
  return (forwardedInit().headers ?? {}) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Verb surface
// ---------------------------------------------------------------------------

describe("proxy verb surface", () => {
  it.each([
    ["PATCH", () => PATCH],
    ["DELETE", () => DELETE],
  ])(
    "%s is exported, relays the method upstream, and attaches the bearer",
    async (method, handler) => {
      const res = await handler()(makeReq(method));

      expect(res.status).toBe(200);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain(`/${UNGATED}`);
      expect(init.method).toBe(method);
      expect(forwardedHeaders()["Authorization"]).toBe("Bearer valid-token");
    },
  );

  it.each([
    ["PATCH", () => PATCH],
    ["DELETE", () => DELETE],
  ])("%s is still CSRF-gated (unsafe method)", async (method, handler) => {
    const res = await handler()(
      makeReq(method, UNGATED, {
        headers: { origin: "https://evil.example.com" },
      }),
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("OPTIONS is exempt from the CSRF origin check but still needs a session", async () => {
    const noOrigin = new NextRequest(`${ORIGIN}/api/proxy/${UNGATED}`, {
      method: "OPTIONS",
    });

    const res = await OPTIONS(noOrigin);

    // Reaches the auth gate rather than being stopped at CSRF — proving the
    // safe-method exemption is wired, not that OPTIONS is unauthenticated.
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("OPTIONS with a session relays upstream", async () => {
    const res = await OPTIONS(makeReq("OPTIONS"));

    expect(res.status).toBe(200);
    expect(forwardedInit().method).toBe("OPTIONS");
  });
});

// ---------------------------------------------------------------------------
// Path traversal
// ---------------------------------------------------------------------------

describe("proxy path traversal guard", () => {
  it("rejects a parent-directory segment smuggled past URL normalisation", async () => {
    // A bare `../` is collapsed by the WHATWG URL parser before the handler
    // ever sees it. Encoding only the slash (`..%2f`) leaves a literal `..`
    // segment in nextUrl.pathname — this is the input the guard actually
    // exists for.
    const res = await GET(makeReq("GET", "api/v1/records/..%2fadmin"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ message: "Invalid path" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let a normalised `../` climb into an unlisted prefix", async () => {
    // `%2e%2e` is decoded and resolved by the URL parser, so the handler sees
    // `api/v1/admin` — which is NOT allow-listed (the entry is `api/v1/admin/`,
    // and this candidate has no trailing segment). The allowlist, not the
    // traversal guard, is what stops it.
    const res = await GET(makeReq("GET", "api/v1/records/%2e%2e/admin"));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      message: "Proxy path not allowed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("collapses an empty path segment rather than relaying a doubled slash", async () => {
    // `//` would re-anchor the request at the backend origin on some servers.
    // extractPathSegments drops empty segments, so the target URL is clean.
    await GET(makeReq("GET", "api/v1/records//abc"));

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/api/v1/records/abc");
    expect(url).not.toContain("records//abc");
  });
});

// ---------------------------------------------------------------------------
// Request-body relay
// ---------------------------------------------------------------------------

describe("proxy request-body relay", () => {
  it("relays a JSON body verbatim and normalises the content-type", async () => {
    const payload = { note: "vitals recorded", value: 37.2 };

    await POST(
      makeReq("POST", UNGATED, {
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      }),
    );

    const init = forwardedInit();
    expect(JSON.parse(String(init.body))).toEqual(payload);
    // Exactly one content-type, lowercased and unparameterised.
    const headers = forwardedHeaders();
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("omits the body entirely for an empty JSON POST", async () => {
    await POST(
      makeReq("POST", UNGATED, {
        headers: { "content-type": "application/json" },
      }),
    );

    // Sending a zero-length body with a JSON content-type makes strict backends
    // 400 on a parse error rather than treating the call as body-less.
    expect(forwardedInit().body).toBeUndefined();
  });

  it("relays a form-encoded body as FormData", async () => {
    await PUT(
      makeReq("PUT", UNGATED, {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "field=value&other=2",
      }),
    );

    // Compared by constructor name, not instanceof: the route receives undici's
    // FormData while the jsdom test global is a different class object.
    const body = forwardedInit().body as FormData;
    expect(body?.constructor?.name).toBe("FormData");
    expect(body.get("field")).toBe("value");
    expect(body.get("other")).toBe("2");
  });

  it("relays an opaque binary body as raw bytes", async () => {
    await POST(
      makeReq("POST", UNGATED, {
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
    );

    const body = forwardedInit().body as ArrayBuffer;
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(body))).toEqual([1, 2, 3, 4]);
  });

  it("omits the body for a zero-length binary POST", async () => {
    await POST(
      makeReq("POST", UNGATED, {
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([]),
      }),
    );

    expect(forwardedInit().body).toBeUndefined();
  });

  it("never attaches a body to a GET", async () => {
    await GET(makeReq("GET"));

    expect(forwardedInit().body).toBeUndefined();
  });

  it("forwards the query string to the backend", async () => {
    await GET(
      new NextRequest(`${ORIGIN}/api/proxy/${UNGATED}?page=2&limit=50`, {
        method: "GET",
        headers: { origin: ORIGIN, cookie: "auth_token=valid-token" },
      }),
    );

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("?page=2&limit=50");
  });
});

// ---------------------------------------------------------------------------
// Header discipline
// ---------------------------------------------------------------------------

describe("proxy header discipline", () => {
  it("strips hop-by-hop and host headers from the forwarded request", async () => {
    await GET(
      makeReq("GET", UNGATED, {
        headers: {
          connection: "keep-alive",
          te: "trailers",
          "proxy-authorization": "Basic abc",
          "content-length": "99",
        },
      }),
    );

    const headers = forwardedHeaders();
    for (const banned of [
      "connection",
      "te",
      "proxy-authorization",
      "content-length",
      "host",
    ]) {
      expect(Object.keys(headers).some((k) => k.toLowerCase() === banned)).toBe(
        false,
      );
    }
    // x-forwarded-proto is asserted because the backend's HTTPS-redirect
    // middleware rejects the call without it.
    expect(headers["x-forwarded-proto"]).toBe("https");
  });

  it("forces Cache-Control: no-store and drops upstream encoding headers", async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers({
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "1234",
        "cache-control": "public, max-age=3600",
        connection: "keep-alive",
      }),
      arrayBuffer: async () => new TextEncoder().encode('{"ok":true}').buffer,
    } as unknown as Response);

    const res = await GET(makeReq("GET"));

    // PHI-bearing responses must never be stored by the browser or an
    // intermediary, whatever the backend said.
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The runtime fetch layer already decoded the body; leaving these on would
    // make the browser try to decode it a second time.
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("connection")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("relays a non-2xx upstream status instead of masking it", async () => {
    fetchMock.mockResolvedValue({
      status: 409,
      headers: new Headers({ "content-type": "application/json" }),
      arrayBuffer: async () =>
        new TextEncoder().encode('{"message":"conflict"}').buffer,
    } as unknown as Response);

    const res = await PUT(makeReq("PUT"));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ message: "conflict" });
  });
});

// ---------------------------------------------------------------------------
// acting_tenant cookie parsing
// ---------------------------------------------------------------------------

describe("proxy acting_tenant parsing", () => {
  it("ignores a malformed acting_tenant cookie instead of failing the request", async () => {
    getVerifiedTokenRole.mockResolvedValue("SUPER_ADMIN");

    const res = await GET(
      makeReq("GET", UNGATED, {
        cookie: "auth_token=valid-token; acting_tenant=not-json",
      }),
    );

    // Fail-open on the *override*, fail-closed on the request: the call still
    // goes through, but scoped to the caller's own tenant.
    expect(res.status).toBe(200);
    const headers = forwardedHeaders();
    expect(headers["x-tenant-id"]).toBeUndefined();
    expect(headers["x-tenant-override-reason"]).toBeUndefined();
  });

  it("ignores an acting_tenant whose id is not a UUID", async () => {
    getVerifiedTokenRole.mockResolvedValue("SUPER_ADMIN");
    const acting = encodeURIComponent(
      JSON.stringify({ id: "../../etc/passwd", reason: "platform support op" }),
    );

    await GET(
      makeReq("GET", UNGATED, {
        cookie: `auth_token=valid-token; acting_tenant=${acting}`,
      }),
    );

    expect(forwardedHeaders()["x-tenant-id"]).toBeUndefined();
  });

  it("ignores an acting_tenant whose reason is not a string", async () => {
    getVerifiedTokenRole.mockResolvedValue("SUPER_ADMIN");
    const acting = encodeURIComponent(
      JSON.stringify({ id: TENANT, reason: 12345678 }),
    );

    await GET(
      makeReq("GET", UNGATED, {
        cookie: `auth_token=valid-token; acting_tenant=${acting}`,
      }),
    );

    // The audited override reason has to be a real operator-typed string; a
    // number that happens to be long enough must not satisfy the length gate.
    expect(forwardedHeaders()["x-tenant-id"]).toBeUndefined();
  });

  it("does not consult the token role at all when no acting_tenant cookie is present", async () => {
    await GET(makeReq("GET"));

    expect(getVerifiedTokenRole).not.toHaveBeenCalled();
    expect(forwardedHeaders()["x-tenant-id"]).toBeUndefined();
  });
});
