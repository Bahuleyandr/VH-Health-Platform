import { fetchAdminAPI, APIError } from "@/lib/api/core";
import { apiFetch } from "@/lib/api-fetch";
import { navigateToLogin } from "@/lib/browserNavigation";

jest.mock("@/lib/api-fetch", () => ({
  apiFetch: jest.fn(),
}));
jest.mock("@/lib/browserNavigation", () => ({
  navigateToLogin: jest.fn(),
}));

const mockedApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;
const mockedNavigateToLogin = navigateToLogin as jest.MockedFunction<typeof navigateToLogin>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe("fetchAdminAPI endpoint normalization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rewrites /admin/doctors list to /api/v1/doctors", async () => {
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: 1 }] }));

    await fetchAdminAPI("/admin/doctors");

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/doctors",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rewrites /feedback to /feedback/recent with default paging", async () => {
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await fetchAdminAPI("/feedback");

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/feedback/recent?page=1&limit=100",
      expect.any(Object),
    );
  });

  it("rewrites /notifications to admin/manage with default paging", async () => {
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await fetchAdminAPI("/notifications");

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/notifications/admin/manage?page=1&limit=50",
      expect.any(Object),
    );
  });
});

describe("fetchAdminAPI body serialization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("JSON-stringifies a raw object body (canonical pattern)", async () => {
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 1 } }));

    await fetchAdminAPI("/users", { method: "POST", body: { name: "x" } });

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/users",
      expect.objectContaining({
        method: "POST",
        body: '{"name":"x"}',
        headers: expect.any(Headers),
      }),
    );
  });

  it("passes a pre-stringified body through unchanged (no double-stringify)", async () => {
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 1 } }));

    // Several existing call sites (PaymentLinksTab, ClaimsTab, etc.) pre-stringify.
    // The helper must NOT wrap that string in another JSON.stringify pass —
    // doing so produces `"\"{\\\"name\\\":\\\"x\\\"}\""` which the backend rejects.
    await fetchAdminAPI("/users", {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
    });

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/users",
      expect.objectContaining({
        method: "POST",
        body: '{"name":"x"}',
        headers: expect.any(Headers),
      }),
    );
  });

  it("omits body + Content-Type when body is undefined", async () => {
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await fetchAdminAPI("/admin/test", { method: "GET" });

    const call = mockedApiFetch.mock.calls[0][1] as RequestInit;
    expect(call.body).toBeUndefined();
    expect(call.headers).toBeUndefined();
  });

  it("omits body when caller passes null (same shape as undefined)", async () => {
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await fetchAdminAPI("/admin/test", { method: "POST", body: null });

    const call = mockedApiFetch.mock.calls[0][1] as RequestInit;
    expect(call.body).toBeUndefined();
    expect(call.headers).toBeUndefined();
  });

  it("forwards a server-issued continuity context with JSON requests", async () => {
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

    await fetchAdminAPI("/downtime/reconciliation/workbench", {
      headers: {
        "X-VH-Continuity-Facility-Id": "17",
        "X-VH-Continuity-Facility-Context": "signed-envelope",
      },
    });

    const call = mockedApiFetch.mock.calls[0][1] as RequestInit;
    const headers = new Headers(call.headers);
    expect(headers.get("X-VH-Continuity-Facility-Id")).toBe("17");
    expect(headers.get("X-VH-Continuity-Facility-Context")).toBe(
      "signed-envelope",
    );
  });
});

describe("fetchAdminAPI response/error behavior", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("unwraps success envelopes with data", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { ok: true } }),
    );

    const result = await fetchAdminAPI<{ ok: boolean }>("/admin/appointments");

    expect(result).toEqual({ ok: true });
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/appointments/list",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("keeps already-prefixed endpoints and returns raw payload when no data envelope exists", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, source: "raw" }),
    );

    const result = await fetchAdminAPI<{ ok: boolean; source: string }>(
      "/api/v1/admin/test",
    );

    expect(result).toEqual({ ok: true, source: "raw" });
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/admin/test",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("throws APIError with fallback message when error JSON is unreadable", async () => {
    mockedApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      headers: new Headers({ "content-type": "application/json" }),
      json: jest.fn().mockRejectedValue(new Error("bad json")),
      text: jest.fn().mockResolvedValue("bad gateway"),
    } as unknown as Response);

    try {
      await fetchAdminAPI("/users", { method: "POST", body: { name: "x" } });
      throw new Error("Expected fetchAdminAPI to throw APIError");
    } catch (err) {
      expect((err as APIError).message).toContain(
        "HTTP 502 calling POST /users",
      );
      expect((err as APIError).status).toBe(502);
    }
  });
});

describe("fetchAdminAPI shared refresh and mutation replay", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.setItem("adminUser", JSON.stringify({ role: "ADMIN" }));
    window.history.replaceState({}, "", "/dashboard");
  });

  it("uses the same single-flight refresh for concurrent 401s", async () => {
    const calls: Record<string, number> = {};
    mockedApiFetch.mockImplementation(async (endpoint) => {
      const key = String(endpoint);
      calls[key] = (calls[key] ?? 0) + 1;
      return calls[key] === 1
        ? jsonResponse({ message: "Unauthorized" }, 401)
        : jsonResponse({ data: { endpoint: key } });
    });
    const refreshFetch = jest.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true } as Response), 10)),
    );

    const [first, second] = await Promise.all([
      fetchAdminAPI<{ endpoint: string }>("/admin/a"),
      fetchAdminAPI<{ endpoint: string }>("/admin/b"),
    ]);

    expect(first.endpoint).toBe("/api/v1/admin/a");
    expect(second.endpoint).toBe("/api/v1/admin/b");
    expect(refreshFetch).toHaveBeenCalledTimes(1);
    expect(mockedApiFetch).toHaveBeenCalledTimes(4);
    refreshFetch.mockRestore();
  });

  it("retries GET once with the original request", async () => {
    mockedApiFetch
      .mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    const refreshFetch = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);

    await expect(fetchAdminAPI("/users", { headers: { "X-Test": "same" } })).resolves.toEqual({ ok: true });

    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    const first = mockedApiFetch.mock.calls[0][1] as RequestInit;
    const second = mockedApiFetch.mock.calls[1][1] as RequestInit;
    expect(new Headers(first.headers).get("X-Test")).toBe("same");
    expect(new Headers(second.headers).get("X-Test")).toBe("same");
    refreshFetch.mockRestore();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "does not replay an unsafe %s mutation without an Idempotency-Key",
    async (method) => {
      mockedApiFetch.mockResolvedValueOnce(
        jsonResponse({ message: "Unauthorized" }, 401),
      );
      const refreshFetch = jest
        .spyOn(globalThis, "fetch")
        .mockResolvedValue({ ok: true } as Response);

      await expect(
        fetchAdminAPI("/users", { method, body: { name: "once" } }),
      ).rejects.toThrow(/not replayed.*Idempotency-Key/i);

      expect(mockedApiFetch).toHaveBeenCalledTimes(1);
      expect(refreshFetch).toHaveBeenCalledTimes(1);
      refreshFetch.mockRestore();
    },
  );

  it("replays an idempotency-protected mutation once and preserves its body", async () => {
    mockedApiFetch
      .mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 8 } }));
    const refreshFetch = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);

    await expect(
      fetchAdminAPI("/users", {
        method: "POST",
        body: { name: "once" },
        headers: { "Idempotency-Key": "request-8" },
      }),
    ).resolves.toEqual({ id: 8 });

    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    for (const call of mockedApiFetch.mock.calls) {
      expect((call[1] as RequestInit).body).toBe('{"name":"once"}');
      expect(new Headers((call[1] as RequestInit).headers).get("Idempotency-Key")).toBe("request-8");
    }
    refreshFetch.mockRestore();
  });

  it("clears the profile and redirects to login when refresh fails", async () => {
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));
    const refreshFetch = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false } as Response);
    await expect(fetchAdminAPI("/users")).rejects.toThrow(APIError);

    expect(localStorage.getItem("adminUser")).toBeNull();
    expect(mockedNavigateToLogin).toHaveBeenCalledWith("/login?reason=session_expired");
    refreshFetch.mockRestore();
  });
});
