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

function request(path: string) {
  return new NextRequest(`http://localhost:3001/api/proxy/api/v1/${path}`, {
    method: "GET",
    headers: { cookie: "auth_token=test-token" },
  });
}

describe("proxy path allowlist", () => {
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
});
