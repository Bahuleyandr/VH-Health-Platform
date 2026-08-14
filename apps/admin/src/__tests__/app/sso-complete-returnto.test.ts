/**
 * Regression tests: the SSO completion routes redirect to `payload.returnTo`
 * after minting the auth cookies. That value round-trips through the backend
 * from a client-controlled query parameter, so it must pass the same strict
 * open-redirect validation as the password login paths — only same-origin
 * /dashboard paths survive; everything else falls back to /dashboard.
 */

jest.mock("@/lib/api-config", () => ({
  getServerBackendUrl: () => "https://backend.test",
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

type Handler = (request: Request) => Promise<Response>;
let oidcComplete: Handler;
let samlComplete: Handler;

beforeAll(async () => {
  oidcComplete = (await import("@/app/api/login/sso/oidc/complete/route"))
    .GET as Handler;
  samlComplete = (await import("@/app/api/login/sso/saml/complete/route"))
    .GET as Handler;
});

beforeEach(() => fetchMock.mockReset());

function upstreamSuccess(returnTo: unknown) {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        data: {
          token: "access-token",
          refreshToken: "refresh-token",
          returnTo,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

function completeRequest() {
  return new Request("https://admin.vhhealth.app/api/login/sso/oidc/complete", {
    headers: { cookie: "vh_admin_sso_handoff=handoff", host: "admin.vhhealth.app" },
  });
}

describe.each([
  ["oidc", () => oidcComplete],
  ["saml", () => samlComplete],
])("%s complete route — returnTo validation", (_protocol, handler) => {
  it("redirects to a valid dashboard deep link", async () => {
    upstreamSuccess("/dashboard/appointments");
    const response = await handler()(completeRequest());
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://admin.vhhealth.app");
    expect(location.pathname).toBe("/dashboard/appointments");
  });

  it.each([
    ["//evil.com"],
    ["https://evil.com"],
    ["/\\evil.com"],
    ["%2F%2Fevil.com"],
    ["/login"],
  ])("falls back to /dashboard for hostile returnTo %s", async (returnTo) => {
    upstreamSuccess(returnTo);
    const response = await handler()(completeRequest());
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://admin.vhhealth.app");
    expect(location.pathname).toBe("/dashboard");
  });

  it("falls back to /dashboard when returnTo is missing", async () => {
    upstreamSuccess(undefined);
    const response = await handler()(completeRequest());
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/dashboard");
  });
});
