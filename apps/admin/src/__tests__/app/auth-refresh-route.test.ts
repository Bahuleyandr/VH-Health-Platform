import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = "https://admin.vhhealth.app";

jest.mock("@/lib/api-config", () => ({
  getServerBackendUrl: () => "https://backend.test",
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

type Handler = (request: NextRequest) => Promise<Response>;
let refresh: Handler;
let login: Handler;
let logout: Handler;

beforeAll(async () => {
  refresh = (await import("@/app/api/refresh/route")).POST as Handler;
  login = (await import("@/app/api/login/route")).POST as Handler;
  logout = (await import("@/app/api/logout/route")).POST as Handler;
});

beforeEach(() => fetchMock.mockReset());

function request(path: string, body?: unknown, cookie?: string) {
  return new NextRequest(`https://admin.vhhealth.app${path}`, {
    method: "POST",
    headers: {
      origin: "https://admin.vhhealth.app",
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("admin BFF refresh credential contract", () => {
  it("stores both credentials at login and never returns them in JSON", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      data: {
        token: "access-one",
        refreshToken: "refresh-one",
        admin: { uid: "admin-1", role: "ADMIN" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const response = await login(request("/api/login", { username: "root", password: "secret" }));
    const cookies = (response as Response & { cookies: { get: (name: string) => { value: string } | undefined } }).cookies;

    expect(cookies.get("auth_token")?.value).toBe("access-one");
    expect(cookies.get("refresh_token")?.value).toBe("refresh-one");
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("access-one");
    expect(body).not.toContain("refresh-one");
  });

  it("submits only the refresh cookie and rotates both cookies", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      data: { token: "access-two", refreshToken: "refresh-two", admin: { uid: "admin-1" } },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const response = await refresh(request(
      "/api/refresh",
      undefined,
      "auth_token=access-one; refresh_token=refresh-one",
    ));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://backend.test/api/v1/auth/refresh-token",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer refresh-one" }),
      }),
    );
    const cookies = (response as Response & { cookies: { get: (name: string) => { value: string } | undefined } }).cookies;
    expect(cookies.get("auth_token")?.value).toBe("access-two");
    expect(cookies.get("refresh_token")?.value).toBe("refresh-two");
  });

  it("clears both cookies on logout", async () => {
    const response = await logout(request("/api/logout"));
    const cookies = (response as Response & { cookies: { get: (name: string) => { value: string } | undefined } }).cookies;
    expect(cookies.get("auth_token")?.value).toBe("");
    expect(cookies.get("refresh_token")?.value).toBe("");
  });
});
