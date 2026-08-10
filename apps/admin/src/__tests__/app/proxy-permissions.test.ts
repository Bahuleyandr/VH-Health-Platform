// ADM-1 (review 2026-08-10): per-admin permission flags must be enforced at
// the proxy, not only in the nav. A scoped-down ADMIN must be blocked from
// permission-gated backend prefixes; SUPER_ADMIN and lower-rank roles pass.
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = "https://admin.vhhealth.app";

type Handler = (req: NextRequest) => Promise<Response>;
let GET: Handler;
let resetCache: () => void;
let fetchMock: jest.SpyInstance;

// Unsigned structural JWTs — serverTokenRole falls back to a structural
// decode when JWT_SECRET is unset outside production (NODE_ENV=test here).
function tokenWithRole(role: string): string {
  const b64 = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ role })}.sig`;
}

function profileResponse(permissions: string[]): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({
      success: true,
      data: { admin: { uid: "a-1", permissions } },
    }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

function upstreamResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => ({}),
  } as unknown as Response;
}

beforeAll(async () => {
  const route = await import("@/app/api/proxy/[...path]/route");
  GET = route.GET as Handler;
  const perms = await import("@/lib/proxyPermissions");
  resetCache = perms.__resetPermissionCacheForTests;
});

function mockBackend(permissions: string[]) {
  fetchMock = jest
    .spyOn(global, "fetch")
    .mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/v1/auth/admin/profile")) {
        return profileResponse(permissions);
      }
      return upstreamResponse();
    });
}

afterEach(() => {
  fetchMock?.mockRestore();
  resetCache();
});

function request(path: string, token: string) {
  return new NextRequest(`http://localhost:3001/api/proxy/api/v1/${path}`, {
    method: "GET",
    headers: { cookie: `auth_token=${token}` },
  });
}

function proxiedCalls(): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => !u.includes("/api/v1/auth/admin/profile"));
}

describe("proxy per-admin permission enforcement", () => {
  it("blocks a scoped-down ADMIN from a gated prefix", async () => {
    mockBackend(["appointmentManagement"]);
    const res = await GET(request("users?limit=10", tokenWithRole("ADMIN")));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      message: "Forbidden: missing userManagement permission",
    });
    expect(proxiedCalls()).toHaveLength(0);
  });

  it("forwards an ADMIN holding the required flag", async () => {
    mockBackend(["userManagement"]);
    const res = await GET(request("users?limit=10", tokenWithRole("ADMIN")));

    expect(res.status).toBe(200);
    expect(proxiedCalls()).toHaveLength(1);
    expect(proxiedCalls()[0]).toContain("/api/v1/users?limit=10");
  });

  it("lets a wildcard permission through", async () => {
    mockBackend(["*"]);
    const res = await GET(request("doctors", tokenWithRole("ADMIN")));
    expect(res.status).toBe(200);
    expect(proxiedCalls()).toHaveLength(1);
  });

  it("never consults the profile for SUPER_ADMIN", async () => {
    mockBackend([]);
    const res = await GET(request("users", tokenWithRole("SUPER_ADMIN")));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1); // upstream only
    expect(proxiedCalls()).toHaveLength(1);
  });

  it("does not apply the flags model to lower-rank roles", async () => {
    mockBackend([]);
    const res = await GET(
      request("appointments/list", tokenWithRole("RECEPTIONIST")),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1); // upstream only, no profile
  });

  it("skips enforcement for ungated prefixes", async () => {
    mockBackend([]);
    const res = await GET(
      request("stemi-pathway/activations", tokenWithRole("ADMIN")),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1); // upstream only
  });

  it("exempts staff self-service My Work appointment endpoints", async () => {
    mockBackend([]);
    for (const path of [
      "appointments/queue/today",
      "appointments/pending",
      "appointments/17/confirm",
    ]) {
      const res = await GET(request(path, tokenWithRole("ADMIN")));
      expect(res.status).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3); // upstream only, no profile
  });

  it("fails closed when the profile lookup fails for an ADMIN", async () => {
    fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/v1/auth/admin/profile")) {
          return { ok: false, status: 500 } as unknown as Response;
        }
        return upstreamResponse();
      });

    const res = await GET(request("users", tokenWithRole("ADMIN")));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      message: "Forbidden: permissions unavailable",
    });
  });

  it("caches the profile lookup per token", async () => {
    mockBackend(["userManagement"]);
    const token = tokenWithRole("ADMIN");
    await GET(request("users", token));
    await GET(request("users", token));

    const profileCalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/api/v1/auth/admin/profile"));
    expect(profileCalls).toHaveLength(1);
    expect(proxiedCalls()).toHaveLength(2);
  });
});
