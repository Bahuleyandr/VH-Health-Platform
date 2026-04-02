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
  });

  it("returns the stored user when valid", () => {
    const user = { id: 1, name: "Admin", email: "admin@test.com", phone: "0000000000", is_active: true, created_at: "2024-01-01", role: "ADMIN" as const, permissions: [] };
    localStorage.setItem("adminUser", JSON.stringify(user));
    const result = getAdminUser();
    expect(result?.name).toBe("Admin");
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
