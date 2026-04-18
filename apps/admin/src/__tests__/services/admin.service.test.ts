import { adminService } from "@/services/admin.service";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("adminService proxy routing", () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      writable: true,
      configurable: true,
    });
  });

  it("keeps the /api/v1 prefix when proxying admin endpoints", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

    await adminService.getSystemAlerts();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/proxy/api/v1/admin/alerts",
      expect.objectContaining({
        credentials: "include",
      }),
    );
  });

  it("preserves query strings when proxying admin analytics endpoints", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

    await adminService.getAttendanceAnalytics({ group_by: "day", department: "ICU" });

    const url = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");

    expect(url.pathname).toBe("/api/proxy/api/v1/admin/staff/attendance/analytics");
    expect(url.searchParams.get("department")).toBe("ICU");
    expect(url.searchParams.get("group_by")).toBe("day");
  });

  it("calls HIPAA audit as a GET with query params", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

    await adminService.getHipaaAuditReport({
      limit: 20,
      offset: 5,
      start_date: "2026-04-01",
      end_date: "2026-04-19",
    });

    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url), "http://localhost");

    expect(parsed.pathname).toBe("/api/proxy/api/v1/admin/upload/hipaa/audit");
    expect(parsed.searchParams.get("limit")).toBe("20");
    expect(parsed.searchParams.get("offset")).toBe("5");
    expect(parsed.searchParams.get("start_date")).toBe("2026-04-01");
    expect(parsed.searchParams.get("end_date")).toBe("2026-04-19");
    expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("uses the route-parameter rescan endpoint instead of posting the file id in the body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: {} }));

    await adminService.rescanFile("file-123");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/proxy/api/v1/admin/upload/rescan/file-123",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
  });

  it("posts quarantine purge to the backend route the admin router exposes", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: {} }));

    await adminService.purgeQuarantinedFiles(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/proxy/api/v1/admin/upload/quarantine/purge",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
  });

  it("posts HIPAA bulk-protect updates to the backend route the admin router exposes", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: {} }));

    await adminService.bulkUpdateHipaaProtection({
      ids: ["file-1", "file-2"],
      protect: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/proxy/api/v1/admin/upload/hipaa/bulk-protect",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
  });
});
