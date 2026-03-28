/**
 * Tests for src/lib/api-client.ts
 *
 * Covers the localStorage-based auth helpers:
 *   - getAuthToken
 *   - getAdminUser
 *   - isAuthenticated
 *   - clearAuthData
 */

import {
  getAuthToken,
  getAdminUser,
  isAuthenticated,
  clearAuthData,
} from "@/lib/api-client";

// ---------------------------------------------------------------------------
// getAuthToken
// ---------------------------------------------------------------------------
describe("getAuthToken", () => {
  it("returns null when no token is stored", () => {
    expect(getAuthToken()).toBeNull();
  });

  it("returns the stored token", () => {
    localStorage.setItem("adminToken", "jwt-abc-123");
    expect(getAuthToken()).toBe("jwt-abc-123");
  });
});

// ---------------------------------------------------------------------------
// isAuthenticated
// ---------------------------------------------------------------------------
describe("isAuthenticated", () => {
  it("returns false when no token exists", () => {
    expect(isAuthenticated()).toBe(false);
  });

  it("returns true when a token is present", () => {
    localStorage.setItem("adminToken", "some-token");
    expect(isAuthenticated()).toBe(true);
  });

  it("returns false after token is removed", () => {
    localStorage.setItem("adminToken", "some-token");
    localStorage.removeItem("adminToken");
    expect(isAuthenticated()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clearAuthData
// ---------------------------------------------------------------------------
describe("clearAuthData", () => {
  it("removes adminToken from localStorage", () => {
    localStorage.setItem("adminToken", "tok");
    clearAuthData();
    expect(localStorage.getItem("adminToken")).toBeNull();
  });

  it("removes adminUser from localStorage", () => {
    localStorage.setItem("adminUser", '{"id":1}');
    clearAuthData();
    expect(localStorage.getItem("adminUser")).toBeNull();
  });

  it("removes both keys in a single call", () => {
    localStorage.setItem("adminToken", "tok");
    localStorage.setItem("adminUser", '{"id":1}');
    clearAuthData();
    expect(localStorage.getItem("adminToken")).toBeNull();
    expect(localStorage.getItem("adminUser")).toBeNull();
  });

  it("does not throw when storage is already empty", () => {
    expect(() => clearAuthData()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getAdminUser
// ---------------------------------------------------------------------------
describe("getAdminUser", () => {
  const validUser = {
    id: 1,
    name: "Dr Admin",
    email: "admin@vhhealth.app",
    phone: "1234567890",
    is_active: true,
    created_at: "2025-01-01T00:00:00Z",
    role: "ADMIN" as const,
    permissions: ["dashboard.view", "users.manage"],
  };

  it("returns null when no user is stored", () => {
    expect(getAdminUser()).toBeNull();
  });

  it("parses and returns a valid stored admin user", () => {
    localStorage.setItem("adminUser", JSON.stringify(validUser));
    const user = getAdminUser();
    expect(user).not.toBeNull();
    expect(user!.id).toBe(1);
    expect(user!.role).toBe("ADMIN");
    expect(user!.permissions).toEqual(["dashboard.view", "users.manage"]);
  });

  it("returns null for invalid JSON", () => {
    localStorage.setItem("adminUser", "not-valid-json{{{");
    expect(getAdminUser()).toBeNull();
  });

  it("returns null and clears storage when data fails schema validation", () => {
    // Missing required 'role' field
    localStorage.setItem("adminUser", JSON.stringify({ id: 1 }));
    expect(getAdminUser()).toBeNull();
    // The implementation removes the invalid entry
    expect(localStorage.getItem("adminUser")).toBeNull();
  });

  it("handles a user with string id (backend sometimes returns string)", () => {
    const userWithStringId = { ...validUser, id: "42" };
    localStorage.setItem("adminUser", JSON.stringify(userWithStringId));
    const user = getAdminUser();
    expect(user).not.toBeNull();
    expect(user!.id).toBe("42");
  });

  it("defaults permissions to empty array when missing", () => {
    const userNoPerms = { id: 1, role: "STAFF" as const, name: "Staff User" };
    localStorage.setItem("adminUser", JSON.stringify(userNoPerms));
    const user = getAdminUser();
    expect(user).not.toBeNull();
    expect(user!.permissions).toEqual([]);
  });
});
