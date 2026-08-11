import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = "https://admin.vhhealth.app";

type Handler = (req: NextRequest) => Promise<Response>;
let GET: Handler;
let fetchMock: jest.SpyInstance;

beforeAll(async () => {
  const route = await import("@/app/api/proxy/[...path]/route");
  GET = route.GET as Handler;
});

beforeEach(() => {
  fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response);
});

afterEach(() => fetchMock.mockRestore());

function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3001/api/proxy/api/v1/${path}`, {
    method: "GET",
    headers: { cookie: "auth_token=test-token", ...headers },
  });
}

describe("proxy path allowlist", () => {
  it.each([
    "diagnostic-results/release/17/hold",
    "patients/search?q=9876543210&limit=10",
  ])("forwards the admin client contract path %s", async (path) => {
    const response = await GET(request(path));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/api/v1/${path}`);
  });

  it("forwards the STEMI pathway family", async () => {
    const response = await GET(
      request("stemi-pathway/activations?active_only=true&limit=50"),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/v1/stemi-pathway/activations?active_only=true&limit=50",
    );
  });

  it("keeps segment-boundary lookalikes blocked", async () => {
    const response = await GET(request("stemi-pathway-internal/activations"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      message: "Proxy path not allowed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards only the exact reconciliation family and its signed facility context", async () => {
    const response = await GET(
      request("downtime/reconciliation/workbench", {
        "x-vh-continuity-facility-id": "17",
        "x-vh-continuity-facility-context": "signed-envelope",
      }),
    );

    expect(response.status).toBe(200);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("x-vh-continuity-facility-id")).toBe("17");
    expect(headers.get("x-vh-continuity-facility-context")).toBe(
      "signed-envelope",
    );

    fetchMock.mockClear();
    const lookalike = await GET(
      request("downtime/reconciliation-internal/workbench"),
    );
    expect(lookalike.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
