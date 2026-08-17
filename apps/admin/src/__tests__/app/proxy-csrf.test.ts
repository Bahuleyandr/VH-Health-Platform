// SEC-8: CSRF hardening on the admin reverse proxy.
//
// The proxy must REQUIRE a valid Origin (or Referer) on unsafe methods —
// a missing or mismatched Origin can no longer ride the auth cookie. These
// assertions exercise the exported route handlers directly; the CSRF check
// runs before auth/upstream-fetch, so a rejection short-circuits there.

import { NextRequest } from "next/server";

// Pin the allowlist BEFORE the route module is loaded (in beforeAll, below) —
// ALLOWED_ORIGINS is resolved at module load per SEC-8's production guard.
process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = "https://admin.vhhealth.app";

type ProxyHandler = (req: NextRequest) => Promise<Response>;
let POST: ProxyHandler;
let GET: ProxyHandler;
let PUT: ProxyHandler;

beforeAll(async () => {
  const route = await import("@/app/api/proxy/[...path]/route");
  POST = route.POST as ProxyHandler;
  GET = route.GET as ProxyHandler;
  PUT = route.PUT as ProxyHandler;
});

function makeReq(
  method: string,
  headers: Record<string, string> = {},
  path = "users",
): NextRequest {
  return new NextRequest(`http://localhost:3001/api/proxy/api/v1/${path}`, {
    method,
    headers,
  });
}

describe("proxy CSRF mutation-origin validation (SEC-8)", () => {
  it("rejects POST with NO Origin and NO Referer (fail-closed)", async () => {
    const res = await POST(makeReq("POST"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toMatch(/cross-origin/i);
  });

  it("keeps facility asset mutations behind the same-origin CSRF gate", async () => {
    const res = await POST(makeReq("POST", {}, "facility/assets"));

    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/cross-origin/i);
  });

  it("rejects PUT with a mismatched Origin", async () => {
    const res = await PUT(
      makeReq("PUT", { origin: "https://evil.example.com" }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects POST whose Origin is absent but Referer is cross-site", async () => {
    const res = await POST(
      makeReq("POST", { referer: "https://evil.example.com/attack" }),
    );
    expect(res.status).toBe(403);
  });

  it("allows a matching Origin past the CSRF gate (then fails auth, not CSRF)", async () => {
    // Matching origin → CSRF passes → next gate is the auth cookie (401),
    // proving the request was NOT blocked at the CSRF layer.
    const res = await POST(
      makeReq("POST", { origin: "https://admin.vhhealth.app" }),
    );
    expect(res.status).toBe(401);
  });

  it("accepts a same-origin Referer when Origin is omitted", async () => {
    // No Origin, but a Referer on the allowed origin → CSRF passes → 401 auth.
    const res = await POST(
      makeReq("POST", { referer: "https://admin.vhhealth.app/dashboard" }),
    );
    expect(res.status).toBe(401);
  });

  it("does not gate safe GET requests on Origin (auth still required)", async () => {
    // GET is exempt from CSRF origin checks; it should reach the auth gate.
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(401);
  });
});
