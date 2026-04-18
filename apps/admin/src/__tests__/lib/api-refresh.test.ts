import { getJSON, APIError } from "@/lib/api";
import { apiFetch } from "@/lib/api-fetch";
import { toast } from "react-hot-toast";

jest.mock("@/lib/api-fetch", () => ({
  apiFetch: jest.fn(),
}));

const mockedApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe("requestJSON refresh flow", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("retries once after a 401 when refresh succeeds", async () => {
    mockedApiFetch
      .mockResolvedValueOnce(mockJsonResponse({ message: "Unauthorized" }, 401))
      .mockResolvedValueOnce(mockJsonResponse({ data: { ok: true } }, 200));

    const refreshFetch = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true } as Response);

    const result = await getJSON<{ ok: boolean }>("/api/v1/admin/dashboard");

    expect(result).toEqual({ ok: true });
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(refreshFetch).toHaveBeenCalledWith("/api/refresh", {
      method: "POST",
      credentials: "include",
    });

    refreshFetch.mockRestore();
  });

  it("fails with APIError and session-expired toast when refresh fails", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      mockJsonResponse({ message: "Unauthorized" }, 401),
    );

    const refreshFetch = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: false } as Response);

    await expect(getJSON("/api/v1/admin/dashboard")).rejects.toThrow(APIError);

    expect(toast.error).toHaveBeenCalledWith(
      "Session expired. Please log in again.",
    );
    expect(refreshFetch).toHaveBeenCalledTimes(1);

    refreshFetch.mockRestore();
  });

  it("does not attempt refresh when useAuth=false", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      mockJsonResponse({ message: "Unauthorized" }, 401),
    );

    const refreshFetch = jest.spyOn(globalThis, "fetch");

    await expect(getJSON("/api/v1/health/health-check", undefined, false)).rejects.toThrow(
      "Unauthorized",
    );

    expect(refreshFetch).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Session expired. Please log in again.",
    );

    refreshFetch.mockRestore();
  });

  it("uses single-flight refresh for concurrent 401 responses", async () => {
    const endpointCalls: Record<string, number> = {};

    mockedApiFetch.mockImplementation(async (endpoint) => {
      const key = String(endpoint);
      endpointCalls[key] = (endpointCalls[key] ?? 0) + 1;

      // First call per endpoint returns 401, second (retry after refresh) succeeds.
      if (endpointCalls[key] === 1) {
        return mockJsonResponse({ message: "Unauthorized" }, 401);
      }
      return mockJsonResponse({ data: { endpoint: key } }, 200);
    });

    const refreshFetch = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ ok: true } as Response), 20),
          ),
      );

    const [a, b] = await Promise.all([
      getJSON<{ endpoint: string }>("/api/v1/admin/a"),
      getJSON<{ endpoint: string }>("/api/v1/admin/b"),
    ]);

    expect(a).toEqual({ endpoint: "/api/v1/admin/a" });
    expect(b).toEqual({ endpoint: "/api/v1/admin/b" });

    // The key assertion: both 401s share one refresh call.
    expect(refreshFetch).toHaveBeenCalledTimes(1);
    expect(refreshFetch).toHaveBeenCalledWith("/api/refresh", {
      method: "POST",
      credentials: "include",
    });

    refreshFetch.mockRestore();
  });

  it("does not recurse refresh logic for /auth/refresh-token endpoint", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      mockJsonResponse({ message: "Unauthorized" }, 401),
    );

    const refreshFetch = jest.spyOn(globalThis, "fetch");

    await expect(getJSON("/api/v1/auth/refresh-token")).rejects.toThrow(
      "Unauthorized",
    );

    // Critical behavior: never call /api/refresh while already on refresh path.
    expect(refreshFetch).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Session expired. Please log in again.",
    );

    refreshFetch.mockRestore();
  });

  it("refreshes at most once and fails on second 401 (no infinite loop)", async () => {
    // First call -> 401, retried call -> still 401
    mockedApiFetch
      .mockResolvedValueOnce(mockJsonResponse({ message: "Unauthorized" }, 401))
      .mockResolvedValueOnce(mockJsonResponse({ message: "Unauthorized" }, 401));

    const refreshFetch = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true } as Response);

    await expect(getJSON("/api/v1/admin/dashboard")).rejects.toThrow(
      "Unauthorized",
    );

    expect(refreshFetch).toHaveBeenCalledTimes(1);
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenCalledWith(
      "Session expired. Please log in again.",
    );

    refreshFetch.mockRestore();
  });
});
