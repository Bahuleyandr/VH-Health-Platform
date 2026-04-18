/**
 * Tests for src/lib/api-config.ts
 *
 * Covers:
 *   - API_BASE_URL defaults correctly (client vs server)
 *   - Endpoint constants are properly structured
 *   - Endpoint paths start with /api/v1/
 *   - Key endpoint groups exist (auth, users, doctors, departments, etc.)
 *   - getHeaders builds correct header objects
 *   - buildUrl constructs URLs with param replacement
 *   - requiresAuth matches protected routes
 *   - buildWsUrl constructs WebSocket URLs
 */

import {
  API_BASE_URL,
  WS_BASE_URL,
  WS_ENDPOINT,
  WS_ENDPOINTS,
  API_ENDPOINTS,
  PROTECTED_ROUTES,
  getHeaders,
  buildUrl,
  ensureApiV1Path,
  buildProxyUrl,
  requiresAuth,
  buildWsUrl,
} from "@/lib/api-config";

// ---------------------------------------------------------------------------
// API_BASE_URL defaults
// ---------------------------------------------------------------------------
describe("API_BASE_URL", () => {
  it("resolves to /api/proxy on the client (jsdom)", () => {
    // jsdom provides a window object, so typeof window !== "undefined" is true
    expect(API_BASE_URL).toBe("/api/proxy");
  });

  it("is a string", () => {
    expect(typeof API_BASE_URL).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// WS_BASE_URL / WS_ENDPOINT
// ---------------------------------------------------------------------------
describe("WebSocket configuration", () => {
  it("WS_BASE_URL is a string", () => {
    expect(typeof WS_BASE_URL).toBe("string");
  });

  it("WS_ENDPOINT is /ws", () => {
    expect(WS_ENDPOINT).toBe("/ws");
  });

  it("WS_ENDPOINTS maps all keys to /ws", () => {
    expect(WS_ENDPOINTS.admin).toBe("/ws");
    expect(WS_ENDPOINTS.notifications).toBe("/ws");
    expect(WS_ENDPOINTS.sos).toBe("/ws");
    expect(WS_ENDPOINTS.activity).toBe("/ws");
  });
});

// ---------------------------------------------------------------------------
// API_ENDPOINTS — key groups exist
// ---------------------------------------------------------------------------
describe("API_ENDPOINTS — top-level groups", () => {
  it("has auth group", () => {
    expect(API_ENDPOINTS.auth).toBeDefined();
  });

  it("has users group", () => {
    expect(API_ENDPOINTS.users).toBeDefined();
  });

  it("has doctors group", () => {
    expect(API_ENDPOINTS.doctors).toBeDefined();
  });

  it("has departments group", () => {
    expect(API_ENDPOINTS.departments).toBeDefined();
  });

  it("has appointments group", () => {
    expect(API_ENDPOINTS.appointments).toBeDefined();
  });

  it("has pharmacy group", () => {
    expect(API_ENDPOINTS.pharmacy).toBeDefined();
  });

  it("has notifications group", () => {
    expect(API_ENDPOINTS.notifications).toBeDefined();
  });

  it("has admin group", () => {
    expect(API_ENDPOINTS.admin).toBeDefined();
  });

  it("has health group", () => {
    expect(API_ENDPOINTS.health).toBeDefined();
  });

  it("has staff group", () => {
    expect(API_ENDPOINTS.staff).toBeDefined();
  });

  it("has investigations group", () => {
    expect(API_ENDPOINTS.investigations).toBeDefined();
  });

  it("has analytics group", () => {
    expect(API_ENDPOINTS.analytics).toBeDefined();
  });

  it("has billing group", () => {
    expect(API_ENDPOINTS.billing).toBeDefined();
  });

  it("has emr group", () => {
    expect(API_ENDPOINTS.emr).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// API_ENDPOINTS — auth structure
// ---------------------------------------------------------------------------
describe("API_ENDPOINTS.auth", () => {
  it("has admin.login endpoint", () => {
    expect(API_ENDPOINTS.auth.admin.login).toBe("/api/v1/auth/admin/login");
  });

  it("has admin.profile endpoint", () => {
    expect(API_ENDPOINTS.auth.admin.profile).toBe("/api/v1/auth/admin/profile");
  });

  it("has admin.logout endpoint", () => {
    expect(API_ENDPOINTS.auth.admin.logout).toBe("/api/v1/auth/admin/logout");
  });

  it("has staff.login endpoint", () => {
    expect(API_ENDPOINTS.auth.staff.login).toBe("/api/v1/auth/staff/login");
  });

  it("has staff.profile endpoint", () => {
    expect(API_ENDPOINTS.auth.staff.profile).toBe("/api/v1/auth/staff/profile");
  });

  it("has staff.logout endpoint", () => {
    expect(API_ENDPOINTS.auth.staff.logout).toBe("/api/v1/auth/staff/logout");
  });

  it("has refreshToken endpoint", () => {
    expect(API_ENDPOINTS.auth.refreshToken).toBe("/api/v1/auth/refresh-token");
  });
});

// ---------------------------------------------------------------------------
// API_ENDPOINTS — string endpoints start with /api/v1/
// ---------------------------------------------------------------------------
describe("API_ENDPOINTS — endpoint paths start with /api/v1/", () => {
  /**
   * Recursively collect all string values from a nested object,
   * skipping functions (dynamic endpoints like billing.invoiceDetail).
   */
  function collectStringEndpoints(obj: unknown, prefix = ""): string[] {
    const results: string[] = [];
    if (typeof obj === "string") {
      results.push(obj);
    } else if (typeof obj === "object" && obj !== null) {
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof value === "string") {
          results.push(value);
        } else if (typeof value === "object" && value !== null) {
          results.push(...collectStringEndpoints(value, `${prefix}${key}.`));
        }
        // Skip functions — dynamic endpoints are tested separately
      }
    }
    return results;
  }

  it("all static string endpoints start with /api/v1/ or /api-docs", () => {
    const endpoints = collectStringEndpoints(API_ENDPOINTS);
    for (const ep of endpoints) {
      const valid = ep.startsWith("/api/v1/") || ep.startsWith("/api-docs");
      expect(valid).toBe(true);
    }
  });

  it("collects a reasonable number of endpoints (sanity check)", () => {
    const endpoints = collectStringEndpoints(API_ENDPOINTS);
    // The config has well over 50 static endpoints
    expect(endpoints.length).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// API_ENDPOINTS — dynamic (function) endpoints
// ---------------------------------------------------------------------------
describe("API_ENDPOINTS — dynamic endpoints", () => {
  it("billing.invoiceDetail returns correct path", () => {
    expect(API_ENDPOINTS.billing.invoiceDetail(42)).toBe(
      "/api/v1/billing/invoice/42",
    );
  });

  it("billing.patientInvoices returns correct path", () => {
    expect(API_ENDPOINTS.billing.patientInvoices("UID123")).toBe(
      "/api/v1/billing/invoices/patient/UID123",
    );
  });

  it("billing.recordPayment returns correct path", () => {
    expect(API_ENDPOINTS.billing.recordPayment(7)).toBe(
      "/api/v1/billing/invoice/7/payment",
    );
  });

  it("billing.insurance.updateClaim returns correct path", () => {
    expect(API_ENDPOINTS.billing.insurance.updateClaim(99)).toBe(
      "/api/v1/billing/insurance/claim/99",
    );
  });

  it("emr.admissionDetail returns correct path", () => {
    expect(API_ENDPOINTS.emr.admissionDetail(5)).toBe(
      "/api/v1/emr/admission/5",
    );
  });

  it("emr.timeline returns correct path", () => {
    expect(API_ENDPOINTS.emr.timeline("P001")).toBe(
      "/api/v1/emr/timeline/P001",
    );
  });
});

// ---------------------------------------------------------------------------
// PROTECTED_ROUTES
// ---------------------------------------------------------------------------
describe("PROTECTED_ROUTES", () => {
  it("is a non-empty array of strings", () => {
    expect(Array.isArray(PROTECTED_ROUTES)).toBe(true);
    expect(PROTECTED_ROUTES.length).toBeGreaterThan(0);
    for (const route of PROTECTED_ROUTES) {
      expect(typeof route).toBe("string");
    }
  });

  it("includes admin wildcard routes", () => {
    expect(PROTECTED_ROUTES).toContain("/api/v1/admin/*");
  });

  it("includes staff admin routes", () => {
    expect(PROTECTED_ROUTES).toContain("/api/v1/staff/admin/*");
  });
});

// ---------------------------------------------------------------------------
// getHeaders
// ---------------------------------------------------------------------------
describe("getHeaders", () => {
  it("returns Content-Type and Origin headers without token", () => {
    const headers = getHeaders();
    expect(headers).toHaveProperty("Content-Type", "application/json");
    expect(headers).toHaveProperty("Origin");
  });

  it("includes Authorization when token is provided", () => {
    const headers = getHeaders("my-jwt") as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-jwt");
  });

  it("omits Authorization when token is undefined", () => {
    const headers = getHeaders() as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildUrl
// ---------------------------------------------------------------------------
describe("buildUrl", () => {
  it("prepends API_BASE_URL to the endpoint", () => {
    const url = buildUrl("/api/v1/users");
    expect(url).toBe(`${API_BASE_URL}/api/v1/users`);
  });

  it("replaces :param placeholders with provided values", () => {
    const url = buildUrl("/api/v1/users/:identifier", {
      identifier: "abc-123",
    });
    expect(url).toContain("abc-123");
    expect(url).not.toContain(":identifier");
  });

  it("encodes param values", () => {
    const url = buildUrl("/api/v1/users/:identifier", {
      identifier: "hello world",
    });
    expect(url).toContain("hello%20world");
  });
});

// ---------------------------------------------------------------------------
// ensureApiV1Path / buildProxyUrl
// ---------------------------------------------------------------------------
describe("proxy URL helpers", () => {
  it("preserves a full /api/v1 path", () => {
    expect(ensureApiV1Path("/api/v1/admin/dashboard")).toBe(
      "/api/v1/admin/dashboard",
    );
  });

  it("adds /api/v1 to short API paths", () => {
    expect(ensureApiV1Path("/admin/alerts")).toBe("/api/v1/admin/alerts");
    expect(ensureApiV1Path("records/export/pdf")).toBe("/api/v1/records/export/pdf");
  });

  it("builds a proxied URL without stripping the API version", () => {
    expect(buildProxyUrl("/api/v1/records/export/pdf")).toBe(
      `${API_BASE_URL}/api/v1/records/export/pdf`,
    );
  });

  it("preserves query strings when building proxy URLs", () => {
    expect(
      buildProxyUrl("/api/v1/appointments/admin/export?format=csv&date_from=2026-04-01"),
    ).toBe(
      `${API_BASE_URL}/api/v1/appointments/admin/export?format=csv&date_from=2026-04-01`,
    );
  });
});

// ---------------------------------------------------------------------------
// requiresAuth
// ---------------------------------------------------------------------------
describe("requiresAuth", () => {
  it("returns true for admin wildcard routes", () => {
    expect(requiresAuth("/api/v1/admin/dashboard")).toBe(true);
  });

  it("returns true for exact protected routes", () => {
    expect(requiresAuth("/api/v1/investigations/routes")).toBe(true);
  });

  it("returns false for public health-check endpoint", () => {
    expect(requiresAuth("/api/v1/health/health-check")).toBe(false);
  });

  it("returns false for auth login endpoint", () => {
    expect(requiresAuth("/api/v1/auth/admin/login")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildWsUrl
// ---------------------------------------------------------------------------
describe("buildWsUrl", () => {
  it("returns WS URL without token query param when no token given", () => {
    const url = buildWsUrl();
    expect(url).toBe(`${WS_BASE_URL}/ws`);
    expect(url).not.toContain("?token=");
  });

  it("appends token as query param when token is provided", () => {
    const url = buildWsUrl("my-ws-token");
    expect(url).toContain("?token=my-ws-token");
  });

  it("encodes special characters in the token", () => {
    const url = buildWsUrl("token with spaces");
    expect(url).toContain("?token=token%20with%20spaces");
  });
});
