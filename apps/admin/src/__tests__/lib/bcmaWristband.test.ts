// The "Print band" control's URL, checked against the two layers it has to
// clear: the proxy path allowlist and (in src/__tests__/middleware.test.ts)
// the middleware's CSP exemption. All three are pinned to the same builder so
// a change to one cannot silently strand the others.

import { printableWristbandUrl } from "@/lib/bcmaWristband";
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = "https://admin.vhhealth.app";

const UID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("printableWristbandUrl", () => {
  it("targets the wristband producer through the portal proxy, as an HTML document", () => {
    expect(printableWristbandUrl(UID)).toBe(
      `/api/proxy/api/v1/bcma/wristband/${UID}?format=html&autoprint=1`,
    );
  });

  it("is a relative same-origin path — never the backend origin", () => {
    // The backend mount authenticates on headers only; a direct link would
    // need the API key in the URL, which must never happen.
    expect(printableWristbandUrl(UID)!.startsWith("/api/proxy/")).toBe(true);
  });

  it("returns null for anything that is not a patient UUID", () => {
    for (const value of [
      "",
      "   ",
      "not-a-uuid",
      "3fa85f64-5717-4562-b3fc",
      // Wrong version/variant nibbles — the backend's own guard rejects these.
      "3fa85f64-5717-6562-b3fc-2c963f66afa6",
      "3fa85f64-5717-4562-f3fc-2c963f66afa6",
      // No path traversal can be smuggled through the patient segment.
      `${UID}/../../admin/users`,
    ]) {
      expect(printableWristbandUrl(value)).toBeNull();
    }
  });

  it("tolerates surrounding whitespace", () => {
    expect(printableWristbandUrl(`  ${UID}  `)).toBe(
      printableWristbandUrl(UID),
    );
  });
});

describe("the proxy forwards the URL the Print band control emits", () => {
  let GET: (req: NextRequest) => Promise<Response>;
  let fetchMock: jest.SpyInstance;

  beforeAll(async () => {
    const route = await import("@/app/api/proxy/[...path]/route");
    GET = route.GET as (req: NextRequest) => Promise<Response>;
  });

  beforeEach(() => {
    fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response);
  });

  afterEach(() => fetchMock.mockRestore());

  it("reaches the backend wristband route rather than 403ing on the allowlist", async () => {
    const href = printableWristbandUrl(UID)!;
    const response = await GET(
      new NextRequest(`http://localhost:3001${href}`, {
        method: "GET",
        headers: { cookie: "auth_token=test-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `/api/v1/bcma/wristband/${UID}?format=html&autoprint=1`,
    );
  });

  it("passes the backend's Content-Security-Policy through untouched", async () => {
    // The proxy copies upstream response headers; the band's own policy is
    // what makes its hashed autoprint script runnable.
    const bandCsp = "default-src 'none'; script-src 'sha256-abc123'";
    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers({
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": bandCsp,
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response);

    const response = await GET(
      new NextRequest(`http://localhost:3001${printableWristbandUrl(UID)!}`, {
        method: "GET",
        headers: { cookie: "auth_token=test-token" },
      }),
    );

    expect(response.headers.get("content-security-policy")).toBe(bandCsp);
  });
});
