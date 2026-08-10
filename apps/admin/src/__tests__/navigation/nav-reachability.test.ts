// Regression tests for audit finding R10 (2026-08-10) — link-orphaned
// dashboard pages.
//
// The portal shipped with two nav definitions (a rendered inline array in
// dashboard/layout.tsx and a maintained-but-unimported AdminNav.tsx); 64 of
// 114 dashboard pages ended up reachable only by typing the URL. The merged
// single source of truth is src/lib/navConfig.ts. This suite keeps it honest:
//
//   1. Every non-parameterised page.tsx under (with-auth)/dashboard is either
//      an EXACT nav href or listed in NAV_EXCLUDED_PAGES with a reason. A new
//      page without a nav entry fails CI until it is linked or deliberately
//      excluded — the exact regression class that produced R10.
//   2. Every nav href points at an existing page (no dead links) and is unique.
//   3. The exclusion list cannot go stale: an entry whose page no longer
//      exists, that is also in the nav, or that lacks a reason, fails.
//   4. Nav gating is never LOOSER than the middleware ROUTE_POLICY for the
//      same path, so the sidebar never advertises a page the default-deny
//      middleware will bounce.

import fs from "fs";
import path from "path";
import { NAV_ITEMS, NAV_EXCLUDED_PAGES, type NavItem } from "@/lib/navConfig";
import {
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
      const m = rel.match(/(?:^|\/)dashboard(\/.*)?\/page\.tsx?$/);
      if (m) {
        const sub = (m[1] ?? "").replace(/\/page\.tsx?$/, "");
        pages.push(`/dashboard${sub}`);
      }
    }
  }
  return pages;
}

/** Parameterised routes ([id] etc.) are deep links, never sidebar targets. */
const isParameterised = (page: string) => /\[[^\]]+\]/.test(page);

const allPages = collectDashboardPages(APP_DIR);
const linkablePages = allPages.filter((p) => !isParameterised(p));
const navHrefs = NAV_ITEMS.map((i) => i.href);
const navHrefSet = new Set(navHrefs);
const pageSet = new Set(allPages);

describe("R10 — every dashboard page is reachable from the nav", () => {
  test("found a sane number of dashboard pages", () => {
    expect(linkablePages.length).toBeGreaterThan(90);
  });

  test.each(linkablePages)(
    "%s is a nav href or deliberately excluded",
    (page) => {
      const inNav = navHrefSet.has(page);
      const excluded = page in NAV_EXCLUDED_PAGES;
      if (!inNav && !excluded) {
        throw new Error(
          `${page} is link-orphaned: no NAV_SECTIONS entry and no ` +
            `NAV_EXCLUDED_PAGES reason in src/lib/navConfig.ts. Add a nav ` +
            `item (gated at least as strictly as ROUTE_POLICY) or an ` +
            `exclusion with a reason.`,
        );
      }
      expect(inNav || excluded).toBe(true);
    },
  );

  test("nav hrefs are unique", () => {
    const seen = new Set<string>();
    const dupes = navHrefs.filter((h) => (seen.has(h) ? true : (seen.add(h), false)));
    expect(dupes).toEqual([]);
  });

  test.each(navHrefs)("nav href %s points at an existing page", (href) => {
    expect(pageSet.has(href)).toBe(true);
  });

  describe("exclusion list stays honest", () => {
    const exclusions = Object.entries(NAV_EXCLUDED_PAGES);

    test("every exclusion carries a non-trivial reason", () => {
      for (const [page, reason] of exclusions) {
        expect(typeof reason).toBe("string");
        expect(reason.trim().length).toBeGreaterThan(10);
        expect(page.startsWith("/dashboard")).toBe(true);
      }
    });

    test.each(exclusions.map(([p]) => p))(
      "excluded page %s still exists and is not also in the nav",
      (page) => {
        expect(pageSet.has(page)).toBe(true);
        expect(navHrefSet.has(page)).toBe(false);
      },
    );
  });
});

describe("R10 — nav gating is at least as strict as ROUTE_POLICY", () => {
  // Portal-tier probes: usePermissions normalizes every staff-tier role to
  // one of these before the nav filter runs, plus the IT roles which pass
  // through unchanged (relevant only to allowedRoles entries).
  const PROBE_ROLES = ["STAFF", "DOCTOR", "HR", "ADMIN", "IT_ADMIN"] as const;

  function navShows(item: NavItem, role: string): boolean {
    // Mirror of the visibility filter in dashboard/layout.tsx (SUPER_ADMIN
    // short-circuit omitted — SUPER_ADMIN passes every route policy anyway).
    if (item.allowedRoles) return item.allowedRoles.includes(role);
    const roleOk = !item.requiredRole || role === item.requiredRole;
    const minRoleOk =
      !item.minRole || (ROLE_RANK[role] ?? -1) >= ROLE_RANK[item.minRole];
    // Permission flags are per-account, not per-role; a permission-gated item
    // can be visible to any tier that holds the flag, so treat it as visible
    // for the strictness comparison (the route policy must still allow it for
    // the tiers the flags model targets — ADMIN).
    const perms = item.requiredPermissions ?? [];
    const permsVisible = perms.length === 0 || role === "ADMIN";
    return roleOk && minRoleOk && permsVisible;
  }

  test.each(NAV_ITEMS.map((i) => [i.href, i] as const))(
    "%s never shows to a role the middleware would bounce",
    (_href, item) => {
      const policy = policyForPath(item.href);
      // Default-deny: a nav entry for an unmapped route is a guaranteed
      // bounce for everyone.
      expect(policy).not.toBeNull();
      for (const role of PROBE_ROLES) {
        if (navShows(item, role)) {
          expect(roleSatisfiesPolicy(role, policy!)).toBe(true);
        }
      }
    },
  );
});
