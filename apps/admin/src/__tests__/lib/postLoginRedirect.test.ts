/**
 * Tests for src/lib/postLoginRedirect.ts
 *
 * The middleware writes `?redirect=<pathname>` on unauthenticated dashboard
 * hits; the login success paths consume it through this sanitizer. It must
 * accept ONLY same-origin relative paths inside /dashboard and fall back to
 * /dashboard for anything that could become an open redirect.
 */

import {
  DEFAULT_POST_LOGIN_PATH,
  resolvePostLoginRedirect,
  sanitizePostLoginRedirect,
} from "@/lib/postLoginRedirect";

describe("sanitizePostLoginRedirect — accepted values", () => {
  it("round-trips the dashboard home", () => {
    expect(sanitizePostLoginRedirect("/dashboard")).toBe("/dashboard");
  });

  it("round-trips a deep dashboard path", () => {
    expect(sanitizePostLoginRedirect("/dashboard/appointments")).toBe(
      "/dashboard/appointments",
    );
  });

  it("round-trips a nested deep path with query and hash", () => {
    expect(
      sanitizePostLoginRedirect("/dashboard/doctors/42?tab=schedule#slots"),
    ).toBe("/dashboard/doctors/42?tab=schedule#slots");
  });
});

describe("sanitizePostLoginRedirect — hostile values fall back to /dashboard", () => {
  it.each([
    ["protocol-relative URL", "//evil.com"],
    ["absolute https URL", "https://evil.com"],
    ["absolute http URL", "http://evil.com/dashboard"],
    ["backslash protocol-relative trick", "/\\evil.com"],
    ["double-backslash trick", "\\\\evil.com"],
    ["still-encoded double slash", "%2F%2Fevil.com"],
    ["encoded slash after real slash", "/%2Fevil.com"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,x"],
    ["non-dashboard path", "/login"],
    ["prefix-lookalike path", "/dashboardevil"],
    ["dot-segment escape out of /dashboard", "/dashboard/../login"],
    ["credentials smuggling", "/dashboard@evil.com"],
    ["embedded whitespace", "/dash board"],
    ["tab characters (URL parsers strip them)", "/\t/evil.com"],
    ["newline characters", "/dashboard\n.evil.com"],
  ])("%s: %s", (_label, value) => {
    expect(sanitizePostLoginRedirect(value)).toBe(DEFAULT_POST_LOGIN_PATH);
  });

  it("falls back for empty, null and undefined", () => {
    expect(sanitizePostLoginRedirect("")).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(sanitizePostLoginRedirect(null)).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(sanitizePostLoginRedirect(undefined)).toBe(DEFAULT_POST_LOGIN_PATH);
  });

  it("never returns a value that escapes the dashboard tree", () => {
    // Property-style sweep over the hostile corpus: whatever comes back must
    // be a relative /dashboard path.
    const corpus = [
      "//evil.com",
      "https://evil.com",
      "/\\evil.com",
      "%2F%2Fevil.com",
      "/login",
      "/dashboard/../../etc/passwd",
      "/dashboard/..%2f..%2flogin",
    ];
    for (const value of corpus) {
      const out = sanitizePostLoginRedirect(value);
      expect(out.startsWith("/dashboard")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
    }
  });
});

describe("resolvePostLoginRedirect — reads ?redirect= from the location", () => {
  const setSearch = (search: string) => {
    window.history.replaceState(null, "", `/login${search}`);
  };

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("returns the sanitized deep link when ?redirect= is a dashboard path", () => {
    setSearch("?redirect=%2Fdashboard%2Fappointments");
    expect(resolvePostLoginRedirect()).toBe("/dashboard/appointments");
  });

  it("falls back to /dashboard when ?redirect= is hostile", () => {
    setSearch("?redirect=%2F%2Fevil.com");
    expect(resolvePostLoginRedirect()).toBe(DEFAULT_POST_LOGIN_PATH);
  });

  it("falls back to /dashboard when ?redirect= is absent", () => {
    setSearch("");
    expect(resolvePostLoginRedirect()).toBe(DEFAULT_POST_LOGIN_PATH);
  });
});
