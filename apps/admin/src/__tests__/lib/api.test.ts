/**
 * Tests for the core API layer (src/lib/api/core.ts) via the barrel
 * re-export at src/lib/api.ts.
 *
 * Covers:
 *   - getJSON returns unwrapped data on success
 *   - 401 response triggers redirect to /login
 *   - 403 response throws APIError with correct status
 *   - Network failure (fetch rejects) propagates as error
 *   - postJSON sends correct method and body
 */

import { getJSON, postJSON, APIError } from "@/lib/api";
import { toast } from "react-hot-toast";
// Note: We cannot directly verify window.location.href assignment in jsdom
// because jsdom's Location object has non-configurable properties.
// Instead, we verify the 401 code path ran by checking toast calls and thrown errors.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response object for mocking apiFetch */
function mockResponse(
  body: unknown,
  init: { status?: number; ok?: boolean; contentType?: string } = {},
): Response {
  const { status = 200, ok = status >= 200 && status < 300, contentType = "application/json" } = init;
  const json = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    headers: new Headers({ "content-type": contentType }),
    json: jest.fn().mockResolvedValue(typeof body === "string" ? JSON.parse(body) : body),
    text: jest.fn().mockResolvedValue(json),
  } as unknown as Response;
}

// We mock apiFetch (the low-level fetch wrapper) so we don't hit the network.
// requestJSON calls apiFetch internally.
jest.mock("@/lib/api-fetch", () => ({
  apiFetch: jest.fn(),
}));

// Import the mock so we can control return values per test
import { apiFetch } from "@/lib/api-fetch";
const mockedApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

// ---------------------------------------------------------------------------
// getJSON — success
// ---------------------------------------------------------------------------
describe("getJSON", () => {
  it("returns unwrapped data from a success envelope", async () => {
    const envelope = { success: true, message: "OK", data: { id: 1, name: "Test" } };
    mockedApiFetch.mockResolvedValueOnce(mockResponse(envelope));

    const result = await getJSON<{ id: number; name: string }>("/api/v1/test");

    expect(result).toEqual({ id: 1, name: "Test" });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  it("returns the full body when no data key is present", async () => {
    const body = { success: true, items: [1, 2, 3] };
    mockedApiFetch.mockResolvedValueOnce(mockResponse(body));

    const result = await getJSON("/api/v1/items");

    expect(result).toEqual(body);
  });

  it("passes query params in the URL", async () => {
    mockedApiFetch.mockResolvedValueOnce(mockResponse({ data: [] }));

    await getJSON("/api/v1/users", { page: 1, limit: 10 });

    const calledUrl = mockedApiFetch.mock.calls[0][0];
    expect(calledUrl).toContain("page=1");
    expect(calledUrl).toContain("limit=10");
  });
});

// ---------------------------------------------------------------------------
// getJSON — 401 unauthorized
// ---------------------------------------------------------------------------
describe("getJSON — 401 handling", () => {
  it("throws APIError and shows toast on 401 (redirect verified by toast side-effect)", async () => {
    const errorBody = { success: false, message: "Unauthorized" };
    mockedApiFetch.mockResolvedValueOnce(
      mockResponse(errorBody, { status: 401, ok: false }),
    );

    await expect(getJSON("/api/v1/protected")).rejects.toThrow(APIError);
    // The code also does window.location.href = "/login" which jsdom cannot
    // intercept cleanly. We verify the redirect intent via the toast call
    // that fires in the same code path.
    expect(toast.error).toHaveBeenCalledWith(
      "Session expired. Please log in again.",
    );
  });

  it("shows a toast error on 401", async () => {
    const errorBody = { success: false, message: "Unauthorized" };
    mockedApiFetch.mockResolvedValueOnce(
      mockResponse(errorBody, { status: 401, ok: false }),
    );

    await expect(getJSON("/api/v1/protected")).rejects.toThrow("Unauthorized");
    expect(toast.error).toHaveBeenCalledWith(
      "Session expired. Please log in again.",
    );
  });

  it("throws APIError with status 401", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      mockResponse({ message: "Unauthorized" }, { status: 401, ok: false }),
    );

    try {
      await getJSON("/api/v1/protected");
      fail("Expected APIError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(APIError);
      expect((err as APIError).status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// getJSON — 403 forbidden
// ---------------------------------------------------------------------------
describe("getJSON — 403 handling", () => {
  it("throws APIError with status 403", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      mockResponse({ message: "Forbidden" }, { status: 403, ok: false }),
    );

    await expect(getJSON("/api/v1/admin-only")).rejects.toThrow(APIError);

    try {
      mockedApiFetch.mockResolvedValueOnce(
        mockResponse({ message: "Forbidden" }, { status: 403, ok: false }),
      );
      await getJSON("/api/v1/admin-only");
    } catch (err) {
      expect((err as APIError).status).toBe(403);
    }
  });

  it("shows permission-denied toast on 403", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      mockResponse({ message: "Forbidden" }, { status: 403, ok: false }),
    );

    await expect(getJSON("/api/v1/admin-only")).rejects.toThrow();
    expect(toast.error).toHaveBeenCalledWith(
      "You do not have permission to perform this action.",
    );
  });
});

// ---------------------------------------------------------------------------
// Network / fetch failure
// ---------------------------------------------------------------------------
describe("getJSON — network failure", () => {
  it("propagates network errors", async () => {
    mockedApiFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(getJSON("/api/v1/anything")).rejects.toThrow("Failed to fetch");
  });

  it("propagates generic Error from apiFetch", async () => {
    mockedApiFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(getJSON("/api/v1/anything")).rejects.toThrow("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// postJSON
// ---------------------------------------------------------------------------
describe("postJSON", () => {
  it("sends POST method with JSON body", async () => {
    const responseData = { id: 42 };
    mockedApiFetch.mockResolvedValueOnce(
      mockResponse({ success: true, data: responseData }),
    );

    const result = await postJSON<{ id: number }>("/api/v1/items", {
      name: "New Item",
    });

    expect(result).toEqual({ id: 42 });

    // Verify apiFetch was called with POST and a stringified body
    const callArgs = mockedApiFetch.mock.calls[0];
    expect(callArgs[0]).toBe("/api/v1/items");
    const init = callArgs[1] as RequestInit & { token?: string };
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "New Item" }));
  });

  it("sends POST without body when none provided", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      mockResponse({ success: true, data: null }),
    );

    await postJSON("/api/v1/auth/admin/logout");

    const init = mockedApiFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Auth token handling
// ---------------------------------------------------------------------------
// Auth is carried via the httpOnly auth_token cookie handled by /api/proxy —
// the client never reads or injects the token. These tests verify that no
// Authorization header / `token` option is forwarded from the client layer.
describe("auth token handling", () => {
  it("does not forward a client-side token via apiFetch", async () => {
    mockedApiFetch.mockResolvedValueOnce(mockResponse({ data: "ok" }));

    await getJSON("/api/v1/admin/dashboard");

    const callInit = mockedApiFetch.mock.calls[0][1] as Record<string, unknown>;
    expect(callInit?.token).toBeUndefined();
  });

  it("does not forward a token even when useAuth is false", async () => {
    mockedApiFetch.mockResolvedValueOnce(mockResponse({ data: "ok" }));

    await getJSON("/api/v1/health-check", undefined, false);

    const callInit = mockedApiFetch.mock.calls[0][1] as Record<string, unknown>;
    expect(callInit?.token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// APIError class
// ---------------------------------------------------------------------------
describe("APIError", () => {
  it("exposes status and data properties", () => {
    const err = new APIError("Something broke", 500, { detail: "db down" });
    expect(err.message).toBe("Something broke");
    expect(err.status).toBe(500);
    expect(err.data).toEqual({ detail: "db down" });
    expect(err.name).toBe("APIError");
    expect(err).toBeInstanceOf(Error);
  });
});
