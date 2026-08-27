// Re-audit finding G (authz, 2026-08-23) — SUPER_ADMIN rank was enforced on
// page navigation only.
//
// routePolicy.ts marks ten consoles SUPER_ADMIN-only and navConfig hides
// them, but middleware.ts checks rank exclusively in its /dashboard branch
// (the /api/proxy branch verifies the token signature and the portal role and
// stops there). Six of those consoles — encryption-keys, smart-fhir,
// gdpr-erasure, migration-toolkit, feature-flags (console since retired),
// continuity-facility-context
// — had no proxy gate at all and, at the time, an ADMIN-tier backend mount, so
// a plain ADMIN could call `/api/proxy/api/v1/admin/encryption-keys` (etc.)
// straight through and get a 200. All six of those mounts have since gained a
// SUPER_ADMIN check of their own; this suite pins the proxy half, which is
// what stops the request before it is forwarded.
//
// THE DURABLE GATE (part 1 + part 2 below): every SUPER_ADMIN-only entry in
// ROUTE_POLICY must be listed in SUPER_ADMIN_CONSOLE_API_PREFIXES with the
// backend prefixes that console owns, and every one of those prefixes must
// resolve to a proxy gate that no ADMIN account can satisfy. Shipping a
// twelfth SUPER_ADMIN console with a nav entry and no proxy gate fails here.
//
// "SUPER_ADMIN-only" is decided by BEHAVIOUR, not by one field. RoutePolicy
// has two declaration forms — `minRank: SUPER_ADMIN_ONLY`, and a `roles`
// allowlist that REPLACES the rank check — and a console declared
// `roles: ["SUPER_ADMIN"]` is exactly as SUPER_ADMIN-only as one declared by
// rank, while carrying no minRank for a minRank filter to see. So the
// selector below asks roleSatisfiesPolicy() (the resolver middleware.ts uses)
// whether any portal role other than SUPER_ADMIN passes, and a separate
// assertion pins the set of declaration forms against the RoutePolicy type,
// so a third form fails this suite instead of quietly escaping it.
//
// Part 3 covers the one SUPER_ADMIN group defined on the backend rather than
// by a console page: the `adminManagement` RBAC group in adminAuthRoutes.js,
// read out of the backend source so a route added to that group cannot be
// gated at the proxy by half.
//
// Deriving the prefixes from the page automatically is too brittle (each
// console reaches the API through a different lib/api module, some inline the
// path, some go through API_ENDPOINTS), so the map is explicit — with a
// staleness check that the mapped prefix still appears in the console's own
// sources, and a both-directions assertion so a new console forces an edit
// here rather than silently inheriting nothing.

import fs from "fs";
import path from "path";
import {
  GRANTABLE_PERMISSIONS,
  PLATFORM_SUPER_ADMIN,
  __resetPermissionCacheForTests,
  checkProxyPermission,
  requiredProxyPermission,
} from "@/lib/proxyPermissions";
import {
  ADMIN_ONLY,
  ROUTE_POLICY,
  SUPER_ADMIN_ONLY,
  roleSatisfiesPolicy,
  type RoutePolicy,
} from "@/lib/routePolicy";
import { PORTAL_ROLE_VALUES } from "@/lib/roles";

const SRC_DIR = path.join(__dirname, "..", "..");
const DASHBOARD_DIR = path.join(SRC_DIR, "app", "(with-auth)", "dashboard");
const API_CONFIG = path.join(SRC_DIR, "lib", "api-config.ts");
const ROUTE_POLICY_SOURCE = path.join(SRC_DIR, "lib", "routePolicy.ts");
const BACKEND_SRC = path.join(SRC_DIR, "..", "..", "backend", "src");
const ADMIN_AUTH_ROUTES = path.join(
  BACKEND_SRC,
  "routes",
  "auth",
  "adminAuthRoutes.js",
);
const RBAC_CONFIG = path.join(BACKEND_SRC, "config", "rbacConfig.js");

/**
 * ROUTE_POLICY key → the proxy path prefixes ("api/v1/...", the normalized
 * candidate form the proxy matches on) that the console OWNS.
 *
 * Only surfaces that exist to serve the console belong here. Shared ADMIN-tier
 * endpoints a console happens to reuse (integration-gates writing SMS config
 * through api/v1/admin/notifications, say) stay out — gating those would lock
 * ADMINs out of their own screens, and the backend owns that decision.
 *
 * The entries are also checked against the console's own sources below, so a
 * gated backend surface with NO caller in this app cannot be listed here.
 * api/v1/auth/admin/revoke-all-sessions and .../activity-logs are exactly
 * that: members of the backend adminManagement group that no page calls. Part
 * 3 pins them against the backend source instead.
 */
const SUPER_ADMIN_CONSOLE_API_PREFIXES: Record<string, string[]> = {
  "admin-management": [
    "api/v1/auth/admin/list",
    "api/v1/auth/admin/create-admin",
    "api/v1/auth/admin/deactivate",
    "api/v1/auth/admin/reactivate",
    "api/v1/auth/admin/update-permissions",
    "api/v1/rbac/admin/audit-log",
  ],
  "continuity-facility-context": [
    "api/v1/admin/devices/continuity-facility-context",
    "api/v1/admin/devices/continuity-device-loss",
  ],
  database: ["api/v1/admin/database"],
  "encryption-keys": ["api/v1/admin/encryption-keys"],
  entitlements: ["api/v1/admin/entitlements"],
  "gdpr-erasure": ["api/v1/gdpr"],
  "integration-gates": ["api/v1/admin/integration-gates"],
  "migration-toolkit": ["api/v1/admin/migration-toolkit"],
  "smart-fhir": ["api/v1/admin/smart-fhir"],
  tenants: ["api/v1/admin/tenants"],
};

// The most an ADMIN account can ever hold. Read from the enforcing module
// rather than re-typed here — a third copy of this vocabulary could drift out
// from under the assertions below and weaken them silently. The admin copy is
// pinned to the backend catalog (GRANTABLE_ADMIN_PERMISSIONS in
// apps/backend/src/config/adminPermissionsCatalog.js) by the sibling suite
// proxy-gate-bypass-regressions.test.ts.
const EVERY_GRANTABLE_PERMISSION = [...GRANTABLE_PERMISSIONS];

/**
 * Every declaration form RoutePolicy has, as a TOTAL map over its keys.
 *
 * TypeScript rejects this file if RoutePolicy gains or loses a field, and the
 * "understands every declaration form" case below re-checks the same thing at
 * runtime against routePolicy.ts's own source — jest strips types here, so the
 * compile-time half alone would only be caught by `npm run type-check`.
 */
const UNDERSTOOD_POLICY_FORMS: Record<keyof RoutePolicy, true> = {
  minRank: true,
  roles: true,
};

/**
 * True when no portal role except SUPER_ADMIN satisfies `policy`.
 *
 * Asked of roleSatisfiesPolicy() — the resolver middleware.ts actually uses —
 * rather than of `policy.minRank`, because `roles` REPLACES the rank check
 * (routePolicy.ts): a console declared `roles: ["SUPER_ADMIN"]` carries no
 * minRank at all, so a `minRank === SUPER_ADMIN_ONLY` filter would drop it out
 * of this whole suite and it would ship with no proxy gate.
 */
function isSuperAdminOnly(policy: RoutePolicy): boolean {
  return PORTAL_ROLE_VALUES.every(
    (role) => role === "SUPER_ADMIN" || !roleSatisfiesPolicy(role, policy),
  );
}

function superAdminOnlyKeys(policies: Record<string, RoutePolicy>): string[] {
  return Object.entries(policies)
    .filter(([, policy]) => isSuperAdminOnly(policy))
    .map(([key]) => key)
    .sort();
}

const superAdminOnlyRoutes = superAdminOnlyKeys(ROUTE_POLICY);

const POLICY_FORM_CASES: [string, RoutePolicy, boolean][] = [
  ["rank form", { minRank: SUPER_ADMIN_ONLY }, true],
  ["roles form", { roles: ["SUPER_ADMIN"] }, true],
  // roleSatisfiesPolicy passes SUPER_ADMIN before consulting `roles`, so an
  // empty allowlist is SUPER_ADMIN-only too.
  ["empty roles form", { roles: [] }, true],
  ["rank form one tier down", { minRank: ADMIN_ONLY }, false],
  ["roles form admitting ADMIN", { roles: ["SUPER_ADMIN", "ADMIN"] }, false],
  // Neither field set: roleSatisfiesPolicy defaults to ADMIN_ONLY.
  ["empty policy", {}, false],
];

const mappedEntries = Object.entries(SUPER_ADMIN_CONSOLE_API_PREFIXES);
const mappedPrefixes: [string, string][] = mappedEntries.flatMap(
  ([routeKey, prefixes]) =>
    prefixes.map((prefix): [string, string] => [routeKey, prefix]),
);

function readIfPresent(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, files);
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

/**
 * Everything the console can reach a path literal through: its own page tree,
 * the typed `@/lib/api/*` modules it imports, and the shared endpoint registry
 * when it goes through API_ENDPOINTS.
 */
function consoleSourceText(routeKey: string): string {
  const files = collectSourceFiles(path.join(DASHBOARD_DIR, routeKey));
  let text = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  for (const mod of new Set(text.match(/@\/lib\/api\/[A-Za-z0-9]+/g) ?? [])) {
    text += `\n${readIfPresent(path.join(SRC_DIR, `${mod.slice(2)}.ts`))}`;
  }
  if (text.includes("API_ENDPOINTS")) text += `\n${readIfPresent(API_CONFIG)}`;
  return text;
}

/** The path fragment a source file spells, short form or /api/v1 form. */
function pathFragment(prefix: string): RegExp {
  const rest = prefix
    .replace(/^api\/v1\//, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Segment boundary so "/gdpr" does not match the "/gdprErasure" module name.
  return new RegExp(`/${rest}(?![A-Za-z0-9-])`);
}

function tokenFor(role: string): string {
  const b64 = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ role })}.sig`;
}

/**
 * The route paths adminAuthRoutes.js hands to
 * wrapAutoRBAC(router, 'adminManagement', …), read out of the backend source
 * so a route added to that group turns up here without anyone remembering to
 * copy it across the stack boundary.
 *
 * Every entry in a wrapAutoRBAC route map is `[path, ...handlers]` with the
 * path first, which is what the literal regex keys on; the region searched
 * ends at the next column-0 `router.`/wrapper call/`export default`, so routes
 * mounted after the group cannot leak in. Throws rather than returning [] — an
 * empty list would make part 3 vacuous. A reshaped source therefore fails this
 * suite (here, or on the >= 7 assertion) instead of silently narrowing it.
 */
function adminManagementRoutePaths(): string[] {
  const source = fs.readFileSync(ADMIN_AUTH_ROUTES, "utf8");
  const start = /wrapAutoRBAC\(\s*router,\s*'adminManagement',/.exec(source);
  if (!start) {
    throw new Error(
      `no wrapAutoRBAC(router, 'adminManagement', …) call found in ${ADMIN_AUTH_ROUTES}`,
    );
  }
  const after = source.slice(start.index + start[0].length);
  const end = /\n(?:export default|wrapAutoRBAC\(|wrapRoutes|router\.)/.exec(
    after,
  );
  const block = end ? after.slice(0, end.index) : after;
  const paths = [...block.matchAll(/\[\s*'(\/[^']*)'/g)].map((m) => m[1]);
  if (paths.length === 0) {
    throw new Error(
      `parsed the adminManagement group out of ${ADMIN_AUTH_ROUTES} but found no route paths`,
    );
  }
  return paths;
}

const ADMIN_MANAGEMENT_ROUTES = adminManagementRoutePaths();

/** `/revoke-all-sessions/:userId` → `api/v1/auth/admin/revoke-all-sessions/1` */
function adminManagementProxyPath(routePath: string): string {
  return `api/v1/auth/admin${routePath.replace(/\/:[A-Za-z0-9_]+/g, "/1")}`;
}

function mockProfile(permissions: string[]): jest.SpyInstance {
  return jest.spyOn(global, "fetch").mockImplementation(
    async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          success: true,
          data: { admin: { uid: "a-1", permissions } },
        }),
      }) as unknown as Response,
  );
}

afterEach(() => {
  jest.restoreAllMocks();
  __resetPermissionCacheForTests();
});

describe("finding G — SUPER_ADMIN consoles are gated at /api/proxy, not just at /dashboard", () => {
  describe("part 1: the console → proxy-prefix map is complete", () => {
    it("found every SUPER_ADMIN-only console", () => {
      // Ten since the feature-flags console retired (2026-08-27).
      expect(superAdminOnlyRoutes.length).toBeGreaterThanOrEqual(10);
    });

    it("understands every declaration form the RoutePolicy type has", () => {
      // The selector reasons about exactly the fields listed in
      // UNDERSTOOD_POLICY_FORMS. A third field added to RoutePolicy is a third
      // way to declare a console, and it must not reach production without
      // someone re-reading isSuperAdminOnly() — so this fails then.
      const block = /export interface RoutePolicy \{([\s\S]*?)\n\}/.exec(
        fs.readFileSync(ROUTE_POLICY_SOURCE, "utf8"),
      );
      expect(block).not.toBeNull();
      const declared = [...block![1].matchAll(/^ {2}(\w+)\??:/gm)]
        .map((m) => m[1])
        .sort();
      // A regex that matched nothing would make the comparison vacuous.
      expect(declared.length).toBeGreaterThan(0);
      expect(declared).toEqual(Object.keys(UNDERSTOOD_POLICY_FORMS).sort());
    });

    it.each(POLICY_FORM_CASES)(
      "classifies the %s the way roleSatisfiesPolicy resolves it",
      (_label, policy, expected) => {
        expect(isSuperAdminOnly(policy)).toBe(expected);
      },
    );

    it("selects a console declared with roles, not just one declared by rank", () => {
      // The hole this closes: a twelfth SUPER_ADMIN console written as
      // `roles: ["SUPER_ADMIN"]` carries no minRank, so the old
      // `minRank === SUPER_ADMIN_ONLY` filter never saw it and it inherited
      // no proxy gate and no assertion in this suite.
      const selected = superAdminOnlyKeys({
        ...ROUTE_POLICY,
        "twelfth-console": { roles: ["SUPER_ADMIN"] },
      });

      expect(selected).toContain("twelfth-console");
      // And it lands in the completeness check below as the one unmapped
      // console — i.e. it forces the map edit rather than passing silently.
      expect(
        selected.filter((key) => !(key in SUPER_ADMIN_CONSOLE_API_PREFIXES)),
      ).toEqual(["twelfth-console"]);
    });

    it("maps every SUPER_ADMIN-only route, and maps nothing stale", () => {
      const missing = superAdminOnlyRoutes.filter(
        (key) => !(key in SUPER_ADMIN_CONSOLE_API_PREFIXES),
      );
      const stale = Object.keys(SUPER_ADMIN_CONSOLE_API_PREFIXES).filter(
        (key) => !superAdminOnlyRoutes.includes(key),
      );
      // A new SUPER_ADMIN console must be added here WITH its backend
      // prefixes — middleware.ts enforces rank on /dashboard navigation only,
      // so the proxy gate is the part that actually stops an ADMIN's request.
      expect({ missing, stale }).toEqual({ missing: [], stale: [] });
    });

    it.each(mappedEntries)(
      "the %s console still calls the prefixes mapped for it",
      (routeKey, prefixes) => {
        const source = consoleSourceText(routeKey);
        expect(source).not.toBe("");
        for (const prefix of prefixes) {
          expect(source).toMatch(pathFragment(prefix));
        }
      },
    );
  });

  describe("part 2: every mapped prefix carries a gate no ADMIN can hold", () => {
    // The gate must require a permission OUTSIDE the grantable vocabulary —
    // the PLATFORM_SUPER_ADMIN sentinel for every console except
    // admin-management, which is gated by `adminManagement`, retired from the
    // grantable matrix post-#883 and therefore equally unholdable. Gating a
    // SUPER_ADMIN console with a grantable flag (viewAuditLogs, say) is the
    // near-miss this assertion exists to catch.
    it.each(mappedPrefixes)(
      "%s: %s requires an ungrantable permission on reads and writes",
      (_routeKey, prefix) => {
        for (const [candidate, method] of [
          [prefix, "GET"],
          [`${prefix}/some/sub/path`, "POST"],
          [`${prefix}/1`, "DELETE"],
        ]) {
          const permission = requiredProxyPermission(candidate, method);
          expect(permission).not.toBeNull();
          expect(EVERY_GRANTABLE_PERMISSION).not.toContain(permission);
        }
      },
    );

    it.each(mappedPrefixes)(
      "%s: %s denies the most privileged ADMIN there can be",
      async (_routeKey, prefix) => {
        mockProfile(["*", ...EVERY_GRANTABLE_PERMISSION]);
        const permission = requiredProxyPermission(prefix, "GET");
        expect(permission).not.toBeNull();

        const verdict = await checkProxyPermission(
          tokenFor("ADMIN"),
          "ADMIN",
          permission!,
        );
        expect(verdict.allowed).toBe(false);
      },
    );

    it.each(mappedPrefixes)(
      "%s: %s still lets SUPER_ADMIN through",
      async (_routeKey, prefix) => {
        const permission = requiredProxyPermission(prefix, "GET");
        const verdict = await checkProxyPermission(
          tokenFor("SUPER_ADMIN"),
          "SUPER_ADMIN",
          permission!,
        );
        expect(verdict.allowed).toBe(true);
      },
    );
  });

  describe("part 3: the backend adminManagement group is gated member-by-member", () => {
    // The group is declared on the backend, not by a console page: five of its
    // seven routes were gated here and revoke-all-sessions/:userId and
    // activity-logs/:adminId were not. Nothing in this app calls those two, so
    // no screen broke — but "api/v1/auth/" is an allowlisted proxy prefix, so
    // the proxy forwarded them at full role rank and the backend's own check
    // was the only refusal. Enumerating the group from its source is what
    // stops the list going stale again.
    it("read the whole group out of the backend source", () => {
      expect(fs.existsSync(ADMIN_AUTH_ROUTES)).toBe(true);
      expect(ADMIN_MANAGEMENT_ROUTES.length).toBeGreaterThanOrEqual(7);
      // The member the round-2 list missed. If the backend renames it, the
      // prefix in proxyPermissions.ts is stale and must be re-derived.
      expect(ADMIN_MANAGEMENT_ROUTES).toContain("/revoke-all-sessions/:userId");
      expect(ADMIN_MANAGEMENT_ROUTES).toContain("/activity-logs/:adminId");
    });

    it("is a SUPER_ADMIN group on the backend, so gating it here locks nobody out", () => {
      // wrapAutoRBAC takes the group's roles from rbacConfig (the `roles`
      // option passed at the call site is not what applyWrappers reads), so
      // this entry is the backend's actual answer for all seven routes. An
      // ADMIN cannot reach them there either — which is what makes denying an
      // ADMIN at the proxy a no-op for legitimate traffic rather than a
      // lockout.
      const entry = /adminManagement:\s*\[([^\]]*)\]/.exec(
        fs.readFileSync(RBAC_CONFIG, "utf8"),
      );
      expect(entry).not.toBeNull();
      const roles = entry![1]
        .split(",")
        .map((role) => role.trim())
        .filter(Boolean);
      expect(roles).toEqual(["SUPER_ADMIN"]);
    });

    it.each(ADMIN_MANAGEMENT_ROUTES)(
      "api/v1/auth/admin%s requires an ungrantable permission",
      (routePath) => {
        const candidate = adminManagementProxyPath(routePath);
        for (const method of ["GET", "POST", "PUT", "DELETE"]) {
          const permission = requiredProxyPermission(candidate, method);
          expect(permission).not.toBeNull();
          expect(EVERY_GRANTABLE_PERMISSION).not.toContain(permission);
        }
      },
    );

    it.each(ADMIN_MANAGEMENT_ROUTES)(
      "api/v1/auth/admin%s denies the most privileged ADMIN there can be",
      async (routePath) => {
        mockProfile(["*", ...EVERY_GRANTABLE_PERMISSION]);
        const permission = requiredProxyPermission(
          adminManagementProxyPath(routePath),
          "POST",
        );
        expect(permission).not.toBeNull();

        const verdict = await checkProxyPermission(
          tokenFor("ADMIN"),
          "ADMIN",
          permission!,
        );
        expect(verdict.allowed).toBe(false);
      },
    );

    it("leaves the session endpoints outside the group ungated", () => {
      // login / profile / logout / change-password / MFA are mounted above the
      // wrapAutoRBAC call and are not group members. Gating any of them would
      // break every admin session, including the proxy's own permission lookup
      // against /api/v1/auth/admin/profile.
      for (const candidate of [
        "api/v1/auth/admin/login",
        "api/v1/auth/admin/profile",
        "api/v1/auth/admin/logout",
        "api/v1/auth/admin/change-password",
        "api/v1/auth/admin/mfa/enroll",
      ]) {
        expect(requiredProxyPermission(candidate, "POST")).toBeNull();
      }
    });
  });

  describe("regression: the four consoles the proxy forwarded verbatim", () => {
    // Before the fix requiredProxyPermission() returned null for all four, so
    // the proxy never consulted checkProxyPermission and forwarded a plain
    // ADMIN's request at full role rank.
    it.each([
      ["api/v1/admin/encryption-keys", "GET"],
      ["api/v1/admin/encryption-keys/rotate", "POST"],
      ["api/v1/admin/smart-fhir/apps", "GET"],
      ["api/v1/admin/smart-fhir/tokens/tok-1/revoke", "POST"],
      ["api/v1/admin/migration-toolkit/jobs", "GET"],
      ["api/v1/admin/migration-toolkit/jobs/7/commits", "POST"],
      ["api/v1/gdpr/erasure-log", "GET"],
      ["api/v1/gdpr/erase", "POST"],
    ])("%s (%s) is sentinel-gated", (candidate, method) => {
      expect(requiredProxyPermission(candidate, method)).toBe(
        PLATFORM_SUPER_ADMIN,
      );
    });

    it("leaves the ADMIN-tier neighbours of those prefixes open", async () => {
      // Segment-bounded matching: the STAFF-rank device registry and the
      // ADMIN-level own-tenant chrome read must not be caught by the
      // continuity/tenants gates.
      expect(requiredProxyPermission("api/v1/admin/devices", "GET")).toBeNull();
      expect(
        requiredProxyPermission("api/v1/admin/tenant-context", "GET"),
      ).toBeNull();
      expect(requiredProxyPermission("api/v1/gdpr-exports", "GET")).toBeNull();
    });
  });

  describe("the sentinel is ungrantable, not just unlisted", () => {
    it("does not let the '*' wildcard cross a sentinel gate", async () => {
      mockProfile(["*"]);
      const verdict = await checkProxyPermission(
        tokenFor("ADMIN"),
        "ADMIN",
        PLATFORM_SUPER_ADMIN,
      );
      expect(verdict.allowed).toBe(false);
      expect(verdict.message).toContain(PLATFORM_SUPER_ADMIN);
    });

    it("does not let the sentinel itself be held as a flag", async () => {
      // The backend rejects the string on write (ADMIN_PERMISSIONS_SENTINEL_
      // REJECTED); the proxy must not depend on that being the only guard.
      mockProfile([PLATFORM_SUPER_ADMIN]);
      const verdict = await checkProxyPermission(
        tokenFor("ADMIN"),
        "ADMIN",
        PLATFORM_SUPER_ADMIN,
      );
      expect(verdict.allowed).toBe(false);
    });

    it("does not let a retired flag left in an old row open its gate", async () => {
      // `adminManagement` was removed from the grantable vocabulary post-#883
      // but pre-existing admins.permissions rows still carry the string until
      // they are next saved.
      mockProfile(["adminManagement"]);
      const permission = requiredProxyPermission("api/v1/auth/admin/list");
      expect(permission).toBe("adminManagement");

      const verdict = await checkProxyPermission(
        tokenFor("ADMIN"),
        "ADMIN",
        permission!,
      );
      expect(verdict.allowed).toBe(false);
    });

    it("still honours a grantable flag and its wildcard", async () => {
      mockProfile(["userManagement"]);
      await expect(
        checkProxyPermission(tokenFor("ADMIN"), "ADMIN", "userManagement"),
      ).resolves.toEqual({ allowed: true });

      __resetPermissionCacheForTests();
      jest.restoreAllMocks();
      mockProfile(["*"]);
      await expect(
        checkProxyPermission(tokenFor("ADMIN"), "ADMIN", "doctorManagement"),
      ).resolves.toEqual({ allowed: true });
    });
  });
});
