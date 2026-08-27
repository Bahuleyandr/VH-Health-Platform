// Regression tests for audit finding H6/M8 (2026-06-10) — broken
// function-level authorization in the admin portal.
//
// Part 1 (THE coverage gate): every page.tsx under src/app/**/dashboard/**
// must resolve to an entry in ROUTE_POLICY. This test FAILS when someone
// adds a dashboard page without a policy entry — the exact regression class
// that produced H6 (allowlist drift). Default-deny in middleware handles
// runtime; this test keeps the map complete at CI time.
//
// Part 2: policy semantics — low-privilege roles are denied on sensitive
// segments, correct roles pass, unmapped segments deny.

import fs from "fs";
import path from "path";
import {
  ROUTE_POLICY,
  ROLE_RANK,
  policyForPath,
  roleSatisfiesPolicy,
} from "@/lib/routePolicy";

const APP_DIR = path.join(__dirname, "..", "..", "app");

function collectDashboardPages(dir: string, pages: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectDashboardPages(full, pages);
    } else if (entry.name === "page.tsx" || entry.name === "page.ts") {
      const rel = path.relative(APP_DIR, full).replace(/\\/g, "/");
      // Only dashboard pages are gated by the middleware matcher.
      const m = rel.match(/(?:^|\/)dashboard(\/.*)?\/page\.tsx?$/);
      if (m) {
        const sub = (m[1] ?? "").replace(/\/page\.tsx?$/, "");
        pages.push(`/dashboard${sub}`);
      }
    }
  }
  return pages;
}

describe("H6/M8 — admin route policy", () => {
  describe("coverage gate (fails when a dashboard page has no policy entry)", () => {
    const pages = collectDashboardPages(APP_DIR);

    test("found a sane number of dashboard pages", () => {
      expect(pages.length).toBeGreaterThan(50);
    });

    test.each(pages)("policy entry exists for %s", (pagePath) => {
      // Dynamic segments ([id] etc.) resolve through their parent segment.
      const policy = policyForPath(pagePath);
      if (policy === null) {
        throw new Error(
          `No ROUTE_POLICY entry covers ${pagePath}. ` +
            `Add the first path segment to src/lib/routePolicy.ts — ` +
            `unmapped routes are DENIED at runtime (default-deny).`,
        );
      }
      expect(policy).toBeTruthy();
    });
  });

  describe("default-deny semantics", () => {
    test("unmapped segment resolves to null (deny)", () => {
      expect(policyForPath("/dashboard/some-brand-new-page")).toBeNull();
      expect(policyForPath("/dashboard/some-brand-new-page/sub")).toBeNull();
    });

    test("dashboard home is reachable only by recognized portal roles", () => {
      const policy = policyForPath("/dashboard");
      expect(policy).toBeTruthy();
      expect(roleSatisfiesPolicy("RECEPTIONIST", policy!)).toBe(true);
      expect(roleSatisfiesPolicy("UNKNOWN_ROLE", policy!)).toBe(false);
      expect(roleSatisfiesPolicy(null, policy!)).toBe(false);
    });
  });

  describe("sensitive surfaces deny low-privilege roles", () => {
    const SENSITIVE_ADMIN_PATHS = [
      "/dashboard/patients",
      "/dashboard/patients/dedupe",
      "/dashboard/users",
      "/dashboard/audit-explorer",
      "/dashboard/system-logs",
      "/dashboard/integrations",
      "/dashboard/settings",
      "/dashboard/payroll",
      "/dashboard/continuity-reconciliation",
    ];

    test.each(SENSITIVE_ADMIN_PATHS)(
      "%s denies rank-0/clinical roles, allows ADMIN",
      (p) => {
        const policy = policyForPath(p);
        expect(policy).toBeTruthy();
        for (const role of [
          "RECEPTIONIST",
          "NURSING_STAFF",
          "DRIVER",
          "DOCTOR",
          "HR_STAFF",
        ]) {
          expect(roleSatisfiesPolicy(role, policy!)).toBe(false);
        }
        expect(roleSatisfiesPolicy("ADMIN", policy!)).toBe(true);
        expect(roleSatisfiesPolicy("SUPER_ADMIN", policy!)).toBe(true);
      },
    );

    test("platform control planes are SUPER_ADMIN only", () => {
      for (const p of [
        "/dashboard/tenants",
        "/dashboard/database",
        "/dashboard/continuity-facility-context",
        // Tenant entitlement editing and admin-account lifecycle are
        // SUPER_ADMIN-only (a tenant ADMIN must not self-upgrade / self-grant).
        "/dashboard/entitlements",
        "/dashboard/admin-management",
      ]) {
        const policy = policyForPath(p);
        expect(policy).toBeTruthy();
        expect(roleSatisfiesPolicy("ADMIN", policy!)).toBe(false);
        expect(roleSatisfiesPolicy("SUPER_ADMIN", policy!)).toBe(true);
      }
    });

    test("clinical-ai control plane uses the explicit role allowlist", () => {
      const policy = policyForPath("/dashboard/clinical-ai/scoreboard");
      expect(policy).toBeTruthy();
      expect(roleSatisfiesPolicy("DOCTOR", policy!)).toBe(false);
      expect(roleSatisfiesPolicy("IT_ADMIN", policy!)).toBe(true);
      expect(roleSatisfiesPolicy("SUPER_ADMIN", policy!)).toBe(true);
    });

    test("unknown roles are denied on STAFF-rank pages", () => {
      const policy = policyForPath("/dashboard/mar");
      expect(policy).toBeTruthy();
      expect(roleSatisfiesPolicy("TOTALLY_MADE_UP", policy!)).toBe(false);
      expect(roleSatisfiesPolicy(null, policy!)).toBe(false);
      expect(roleSatisfiesPolicy("NURSING_STAFF", policy!)).toBe(true);
    });
  });

  describe("legitimate paths still work", () => {
    test("clinical staff keep their boards", () => {
      for (const [p, role] of [
        ["/dashboard/mar", "NURSING_STAFF"],
        ["/dashboard/icu", "ICU_NURSE"],
        ["/dashboard/blood-bank", "LAB_STAFF"],
        ["/dashboard/my-payslips", "DRIVER"],
        ["/dashboard/leave-approvals", "HR_STAFF"],
        ["/dashboard/executive", "CMO"],
        ["/dashboard/death-certification", "DOCTOR"],
      ] as const) {
        const policy = policyForPath(p);
        expect(policy).toBeTruthy();
        expect(roleSatisfiesPolicy(role, policy!)).toBe(true);
      }
    });

    test("every role in ROLE_RANK is upper-cased and ranked sanely", () => {
      for (const [role, rank] of Object.entries(ROLE_RANK)) {
        expect(role).toBe(role.toUpperCase());
        expect(rank).toBeGreaterThanOrEqual(0);
        expect(rank).toBeLessThanOrEqual(4);
      }
    });

    test("every ROUTE_POLICY entry is well-formed", () => {
      for (const [key, policy] of Object.entries(ROUTE_POLICY)) {
        expect(typeof key).toBe("string");
        expect(policy.roles !== undefined || policy.minRank !== undefined).toBe(
          true,
        );
      }
    });
  });
});
