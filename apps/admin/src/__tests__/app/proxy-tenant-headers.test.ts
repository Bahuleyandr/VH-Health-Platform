// W5 S4 — the proxy never forwards a client-supplied tenant override. It
// re-attaches x-tenant-id / x-tenant-override-reason ONLY from the server-set
// acting_tenant cookie of a signature-verified SUPER_ADMIN.
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = "https://admin.vhhealth.app";

const getVerifiedTokenRole = jest.fn();
jest.mock("@/lib/serverTokenRole", () => ({
  getVerifiedTokenRole: (...a: unknown[]) => getVerifiedTokenRole(...a),
  isSuperAdminRole: (r: string | null) => String(r || "").toUpperCase() === "SUPER_ADMIN",
}));

const TENANT = "a5a5a5a5-c5c5-4a5a-8a5a-a5a5c5c5aa01";

type Handler = (req: NextRequest) => Promise<Response>;
let GET: Handler;
let fetchMock: jest.SpyInstance;

beforeAll(async () => {
  const route = await import("@/app/api/proxy/[...path]/route");
  GET = route.GET as Handler;
});

beforeEach(() => {
  getVerifiedTokenRole.mockReset();
  fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response);
});
afterEach(() => fetchMock.mockRestore());

function capturedHeaders(): Record<string, string> {
  const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit;
  return (init.headers ?? {}) as Record<string, string>;
}

function makeReq(cookie: string, extraHeaders: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3001/api/proxy/api/v1/users", {
    method: "GET",
    headers: { cookie, ...extraHeaders },
  });
}

describe("proxy tenant-header discipline (W5 S4)", () => {
  it("SUPER_ADMIN + acting_tenant cookie → x-tenant-id + reason attached upstream", async () => {
    getVerifiedTokenRole.mockResolvedValue("SUPER_ADMIN");
    const acting = encodeURIComponent(JSON.stringify({ id: TENANT, slug: "a", reason: "platform support op" }));
    await GET(makeReq(`auth_token=t; acting_tenant=${acting}`));
    const h = capturedHeaders();
    expect(h["x-tenant-id"]).toBe(TENANT);
    expect(h["x-tenant-override-reason"]).toBe("platform support op");
  });

  it("non-super + acting_tenant cookie → NO tenant header (role gate)", async () => {
    getVerifiedTokenRole.mockResolvedValue("ADMIN");
    const acting = encodeURIComponent(JSON.stringify({ id: TENANT, reason: "platform support op" }));
    await GET(makeReq(`auth_token=t; acting_tenant=${acting}`));
    expect(capturedHeaders()["x-tenant-id"]).toBeUndefined();
  });

  it("strips a client-injected x-tenant-id when there is no acting context", async () => {
    getVerifiedTokenRole.mockResolvedValue("ADMIN");
    await GET(makeReq("auth_token=t", { "x-tenant-id": TENANT }));
    expect(capturedHeaders()["x-tenant-id"]).toBeUndefined();
  });

  it("a client x-tenant-id cannot override the acting tenant for a super-admin", async () => {
    getVerifiedTokenRole.mockResolvedValue("SUPER_ADMIN");
    const acting = encodeURIComponent(JSON.stringify({ id: TENANT, reason: "platform support op" }));
    const CLIENT_INJECT = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await GET(makeReq(`auth_token=t; acting_tenant=${acting}`, { "x-tenant-id": CLIENT_INJECT }));
    // The client header was stripped; the server-set cookie value is what goes upstream.
    expect(capturedHeaders()["x-tenant-id"]).toBe(TENANT);
  });

  it("SUPER_ADMIN with a too-short acting reason → no override attached", async () => {
    getVerifiedTokenRole.mockResolvedValue("SUPER_ADMIN");
    const acting = encodeURIComponent(JSON.stringify({ id: TENANT, reason: "short" }));
    await GET(makeReq(`auth_token=t; acting_tenant=${acting}`));
    expect(capturedHeaders()["x-tenant-id"]).toBeUndefined();
  });
});
