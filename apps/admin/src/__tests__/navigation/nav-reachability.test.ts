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
//   4. Nav gating exactly mirrors the middleware ROUTE_POLICY for the same
//      path. The sidebar neither advertises a page the middleware will bounce
//      nor hides a page from a role the middleware admits.

import {
  isNavItemVisible,
  NAV_ITEMS,
  NAV_EXCLUDED_PAGES,
  visibleNavSections,
  type NavItem,
} from "@/lib/navConfig";
import { policyForPath, roleSatisfiesPolicy } from "@/lib/routePolicy";
import fs from "fs";
import path from "path";

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
    const dupes = navHrefs.filter((h) =>
      seen.has(h) ? true : (seen.add(h), false),
    );
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

describe("R10 — nav gating exactly mirrors ROUTE_POLICY", () => {
  // Portal-tier probes exercise rank-based visibility. Explicit allowlists
  // are checked separately with the canonical raw role identity.
  const PROBE_ROLES = ["STAFF", "DOCTOR", "HR", "ADMIN", "IT_ADMIN"] as const;

  function navShows(item: NavItem, role: string): boolean {
    return isNavItemVisible(item, {
      rawRole: role,
      role,
      isSuperAdmin: false,
      // Permission flags are per-account, not per-role. Model an ADMIN probe
      // as holding them so route-policy strictness is still compared.
      hasAllPermissions: () => role === "ADMIN",
    });
  }

  test("explicit allowlists use the canonical role, not the normalized tier", () => {
    const item = NAV_ITEMS.find(
      (candidate) => candidate.href === "/dashboard/order-set-studio",
    );
    expect(item).toBeDefined();

    for (const rawRole of ["QUALITY_OFFICER", "PHARMACY_INCHARGE"]) {
      expect(
        isNavItemVisible(item!, {
          rawRole,
          role: "STAFF",
          isSuperAdmin: false,
          hasAllPermissions: () => false,
        }),
      ).toBe(true);
    }
    expect(
      isNavItemVisible(item!, {
        rawRole: "STAFF",
        role: "STAFF",
        isSuperAdmin: false,
        hasAllPermissions: () => false,
      }),
    ).toBe(false);
  });

  test("the shared section filter returns the same visible item set", () => {
    for (const role of PROBE_ROLES) {
      const context = {
        rawRole: role,
        role,
        isSuperAdmin: false,
        hasAllPermissions: () => role === "ADMIN",
      };
      const helperHrefs = visibleNavSections(context)
        .flatMap((section) => section.items)
        .map((item) => item.href);
      const directlyFilteredHrefs = NAV_ITEMS.filter((item) =>
        isNavItemVisible(item, context),
      ).map((item) => item.href);
      expect(helperHrefs).toEqual(directlyFilteredHrefs);
    }
  });

  test("the command palette consumes the shared role-filtered nav", () => {
    const paletteSource = fs.readFileSync(
      path.join(APP_DIR, "..", "components", "CommandPalette.tsx"),
      "utf8",
    );
    expect(paletteSource).toContain("visibleNavSections({");
    expect(paletteSource).not.toMatch(/router\.push\(["']\/dashboard/);
  });

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

  test.each(NAV_ITEMS.map((i) => [i.href, i] as const))(
    "%s shows to every role the middleware admits",
    (_href, item) => {
      const policy = policyForPath(item.href);
      expect(policy).not.toBeNull();
      for (const role of PROBE_ROLES) {
        if (roleSatisfiesPolicy(role, policy!)) {
          expect(navShows(item, role)).toBe(true);
        }
      }
    },
  );
});
