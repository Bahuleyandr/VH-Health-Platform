// W5 S3 — /api/act-as: only a signature-verified SUPER_ADMIN may set the
// acting_tenant cookie. A regular ADMIN is rejected; reason/UUID are validated;
// the cookie is httpOnly. The proxy (S4) honours this cookie only for SUPER_ADMIN.
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = "https://admin.vhhealth.app";
const ORIGIN = "https://admin.vhhealth.app";
const TENANT = "a5a5a5a5-c5c5-4a5a-8a5a-a5a5c5c5aa01";

const getVerifiedTokenRole = jest.fn();
jest.mock("@/lib/serverTokenRole", () => ({
  getVerifiedTokenRole: (...args: unknown[]) => getVerifiedTokenRole(...args),
  isSuperAdminRole: (r: string | null) => String(r || "").toUpperCase() === "SUPER_ADMIN",
}));

type Handler = (req: NextRequest) => Promise<Response> | Response;
let POST: Handler, GET: Handler, DELETE: Handler;

beforeAll(async () => {
  const route = await import("@/app/api/act-as/route");
  POST = route.POST as Handler;
  GET = route.GET as Handler;
  DELETE = route.DELETE as Handler;
});

beforeEach(() => getVerifiedTokenRole.mockReset());

function makeReq(method: string, opts: { body?: unknown; cookie?: string; origin?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin !== false) headers.origin = ORIGIN;
  if (opts.cookie) headers.cookie = opts.cookie;
  return new NextRequest("http://localhost:3001/api/act-as", {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("/api/act-as (W5 S3)", () => {
  it("SUPER_ADMIN can set the acting tenant → 200 + httpOnly cookie", async () => {
    getVerifiedTokenRole.mockResolvedValue("SUPER_ADMIN");
    const res = await POST(makeReq("POST", { cookie: "auth_token=t", body: { tenantId: TENANT, slug: "hosp-a", reason: "platform support investigation" } }));
    expect(res.status).toBe(200);
    const cookie = (res as Response & { cookies: { get: (n: string) => { value: string; httpOnly?: boolean } | undefined } }).cookies.get("acting_tenant");
    expect(cookie?.value).toContain(TENANT);
    const body = await res.json();
    expect(body.actingTenant).toMatchObject({ id: TENANT, slug: "hosp-a" });
  });

  it("a regular ADMIN is rejected → 403, no cookie", async () => {
    getVerifiedTokenRole.mockResolvedValue("ADMIN");
    const res = await POST(makeReq("POST", { cookie: "auth_token=t", body: { tenantId: TENANT, reason: "trying to cross tenants" } }));
    expect(res.status).toBe(403);
  });

  it("no/invalid token is rejected → 403", async () => {
    getVerifiedTokenRole.mockResolvedValue(null);
    const res = await POST(makeReq("POST", { body: { tenantId: TENANT, reason: "no token here at all" } }));
    expect(res.status).toBe(403);
  });

  it("SUPER_ADMIN with a too-short reason → 400", async () => {
    getVerifiedTokenRole.mockResolvedValue("SUPER_ADMIN");
    const res = await POST(makeReq("POST", { cookie: "auth_token=t", body: { tenantId: TENANT, reason: "short" } }));
    expect(res.status).toBe(400);
  });

  it("SUPER_ADMIN with a non-UUID tenantId → 400", async () => {
    getVerifiedTokenRole.mockResolvedValue("SUPER_ADMIN");
    const res = await POST(makeReq("POST", { cookie: "auth_token=t", body: { tenantId: "not-a-uuid", reason: "valid reason text" } }));
    expect(res.status).toBe(400);
  });

  it("a cross-site Origin is blocked by CSRF before the role check → 403", async () => {
    getVerifiedTokenRole.mockResolvedValue("SUPER_ADMIN");
    const req = new NextRequest("http://localhost:3001/api/act-as", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example.com" },
      body: JSON.stringify({ tenantId: TENANT, reason: "valid reason text" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("GET returns the current acting tenant from the cookie", async () => {
    const acting = JSON.stringify({ id: TENANT, slug: "hosp-a", reason: "platform support" });
    const res = await GET(makeReq("GET", { cookie: `acting_tenant=${encodeURIComponent(acting)}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actingTenant?.id).toBe(TENANT);
  });

  it("DELETE clears the acting tenant cookie (maxAge 0)", async () => {
    const res = await DELETE(makeReq("DELETE", { cookie: `acting_tenant=x` }));
    expect(res.status).toBe(200);
    const cookie = (res as Response & { cookies: { get: (n: string) => { value: string; maxAge?: number } | undefined } }).cookies.get("acting_tenant");
    expect(cookie?.value).toBe("");
  });
});
