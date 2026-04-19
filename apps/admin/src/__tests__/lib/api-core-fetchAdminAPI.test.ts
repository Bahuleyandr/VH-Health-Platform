import { fetchAdminAPI, APIError } from "@/lib/api/core";
import { apiFetch } from "@/lib/api-fetch";

jest.mock("@/lib/api-fetch", () => ({
  apiFetch: jest.fn(),
}));

const mockedApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

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

describe("fetchAdminAPI response/error behavior", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("unwraps success envelopes with data", async () => {
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { ok: true } }));

    const result = await fetchAdminAPI<{ ok: boolean }>("/admin/appointments");

    expect(result).toEqual({ ok: true });
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/appointments/list",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("keeps already-prefixed endpoints and returns raw payload when no data envelope exists", async () => {
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ ok: true, source: "raw" }));

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
      expect((err as APIError).message).toContain("HTTP 502 calling POST /users");
      expect((err as APIError).status).toBe(502);
    }
  });
});
