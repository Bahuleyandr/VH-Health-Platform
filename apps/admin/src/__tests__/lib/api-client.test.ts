/**
 * Tests for src/lib/api-client.ts
 *
 * Covers the localStorage-based auth helpers:
 *   - getAdminUser
 *   - isAuthenticated
 *   - clearAuthData
 *
 * NOTE: getAuthToken has been removed — auth tokens are now stored in
 * httpOnly cookies (not localStorage) to prevent XSS token theft.
 * Authentication state is determined by the presence of a cached user profile.
 */

import {
  getAdminUser,
  isAuthenticated,
  clearAuthData,
  staffLogin,
  adminLogout,
} from "@/lib/api-client";

// ---------------------------------------------------------------------------
// isAuthenticated
// ---------------------------------------------------------------------------
describe("isAuthenticated", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns false when no user profile is cached", () => {
    expect(isAuthenticated()).toBe(false);
  });

  it("returns true when a valid user profile is cached", () => {
    localStorage.setItem(
      "adminUser",
      JSON.stringify({ id: 1, name: "Admin", email: "admin@test.com", phone: "0000000000", is_active: true, created_at: "2024-01-01", role: "ADMIN" as const, permissions: [] }),
    );
    expect(isAuthenticated()).toBe(true);
  });

  it("returns false after user data is cleared", () => {
    localStorage.setItem(
      "adminUser",
      JSON.stringify({ id: 1, name: "Admin", email: "admin@test.com", phone: "0000000000", is_active: true, created_at: "2024-01-01", role: "ADMIN" as const, permissions: [] }),
    );
    clearAuthData();
    expect(isAuthenticated()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAdminUser
// ---------------------------------------------------------------------------
describe("getAdminUser", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when nothing is stored", () => {
    expect(getAdminUser()).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    localStorage.setItem("adminUser", "not-json");
    expect(getAdminUser()).toBeNull();
    expect(localStorage.getItem("adminUser")).toBeNull();
  });

  it("returns the stored user when valid", () => {
    const user = { id: 1, name: "Admin", email: "admin@test.com", phone: "0000000000", is_active: true, created_at: "2024-01-01", role: "ADMIN" as const, permissions: [] };
    localStorage.setItem("adminUser", JSON.stringify(user));
    const result = getAdminUser();
    expect(result?.name).toBe("Admin");
  });

  it("keeps real HR staff sessions cached", () => {
    const user = { id: 1005, name: "Test HR", role: "HR_STAFF" as const, permissions: [], employee_id: "EMP-1005" };
    localStorage.setItem("adminUser", JSON.stringify(user));
    const result = getAdminUser();
    expect(result?.role).toBe("HR_STAFF");
  });

  it("clears and rejects cached profiles with unknown roles", () => {
    localStorage.setItem(
      "adminUser",
      JSON.stringify({ id: 7, name: "Mystery", role: "UNKNOWN_ROLE", permissions: [] }),
    );

    expect(getAdminUser()).toBeNull();
    expect(localStorage.getItem("adminUser")).toBeNull();
  });

  it("clears and rejects a cache entry with a malformed timestamp", () => {
    localStorage.setItem(
      "adminUser",
      JSON.stringify({ role: "ADMIN", permissions: [], _cachedAt: "recent" }),
    );

    expect(getAdminUser()).toBeNull();
    expect(localStorage.getItem("adminUser")).toBeNull();
  });
});

describe("profile caching from authentication responses", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it("rejects an unsupported role before it can enter the profile cache", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        success: true,
        data: {
          staff: { role: "PATIENT", permissions: ["*"] },
        },
      }),
    } as unknown as Response);

    await expect(staffLogin("EMP-1", "password")).rejects.toMatchObject({
      status: 403,
    });
    expect(localStorage.getItem("adminUser")).toBeNull();
  });
});

describe("adminLogout", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it("protects the backend revocation request with an idempotency key", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: jest.fn().mockResolvedValue({ success: true, data: {} }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    await expect(adminLogout()).resolves.toEqual({ serverSignOutOk: true });

    const revocationHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(revocationHeaders.get("Idempotency-Key")).toMatch(/^admin-logout:/);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/logout");
  });
});

// ---------------------------------------------------------------------------
// clearAuthData
// ---------------------------------------------------------------------------
describe("clearAuthData", () => {
  it("removes user data from localStorage", () => {
    localStorage.setItem(
      "adminUser",
      JSON.stringify({ id: 1, name: "A", email: "a@b.com", phone: "0000000000", is_active: true, created_at: "2024-01-01", role: "ADMIN" as const, permissions: [] }),
    );
    clearAuthData();
    expect(localStorage.getItem("adminUser")).toBeNull();
  });
});
