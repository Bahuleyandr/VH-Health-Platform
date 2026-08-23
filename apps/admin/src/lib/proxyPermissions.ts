// src/lib/proxyPermissions.ts
//
// ADM-1 (review 2026-08-10): per-admin permission flags (admins.permissions,
// edited via /dashboard/admin-management/edit-permissions) were UI-only — the
// nav hid gated pages but the /api/proxy allowlist forwarded every request at
// full role rank, so a scoped-down ADMIN kept full API access. This module is
// the server-side enforcement point: it maps permission-gated backend path
// prefixes to the flag they require and resolves the caller's flags from the
// backend profile endpoint. Concurrent requests are coalesced by a token hash,
// but completed decisions are not cached so revocation applies immediately.
//
// Semantics (mirrors the nav in dashboard/layout.tsx + usePermissions):
//   - SUPER_ADMIN always passes.
//   - A gate whose permission sits outside the grantable vocabulary (see
//     GRANTABLE_PERMISSIONS below) is a RANK gate, not a flag gate: only
//     SUPER_ADMIN crosses it. Every other caller is denied before any flag is
//     consulted — an ADMIN holding '*', a lower portal tier (DOCTOR,
//     IT_ADMIN, NURSING_STAFF…), and a bearer whose role claim cannot be read.
//   - A '*' permission passes every GRANTABLE gate.
//   - Flags scope ADMIN accounts at grantable gates. Lower portal tiers pass
//     those gates and are governed by the backend's per-endpoint role RBAC —
//     they never had ADMIN-rank access for the flags to scope down.
//   - An ADMIN without the required flag is denied (403), exactly like the
//     nav already hides the page.
//   - Both proxy layers — the route handler's ALLOWED_PATH_PREFIXES allowlist
//     and the gate map here — match on canonicalProxyPath() output, so no
//     spelling of a path can satisfy one layer while missing the other.
//
// Server-only: imported by the /api/proxy route handler (node runtime).

import { API_BASE_URL } from "@/lib/api-config";
import { createHash } from "node:crypto";

// Sentinel "permission" that no per-admin flag grants and the Permissions
// Matrix never offers. A gate requiring it is SUPER_ADMIN-only: SUPER_ADMIN
// short-circuits the check before flags are consulted, and the backend
// rejects the sentinel by name when writing admins.permissions
// (adminPermissionsCatalog.js → ADMIN_PERMISSIONS_SENTINEL_REJECTED).
export const PLATFORM_SUPER_ADMIN = "platformSuperAdmin";

// The per-admin flags the Permissions Matrix can actually grant — mirror of
// GRANTABLE_ADMIN_PERMISSIONS in
// apps/backend/src/config/adminPermissionsCatalog.js, which validates every
// write to admins.permissions against it fail-closed.
//
// A gate whose permission is NOT in this set cannot be satisfied by an ADMIN
// account at all: not by the flag string itself (a pre-#883 row may still
// literally carry the retired `adminManagement` value) and not by the '*'
// wildcard most ADMIN accounts hold. That is what makes PLATFORM_SUPER_ADMIN
// a real rank gate rather than a UI convention.
//
// Exported so the mirror is pinned against the backend catalog by test rather
// than by comment: proxy-gate-bypass-regressions.test.ts (under
// src/__tests__/security) reads adminPermissionsCatalog.js and compares.
export const GRANTABLE_PERMISSIONS: ReadonlySet<string> = new Set([
  "userManagement",
  "doctorManagement",
  "departmentManagement",
  "appointmentManagement",
  "pharmacyAdminRoutes",
  "notificationManagement",
  "viewAuditLogs",
]);

interface PermissionGate {
  permission: string;
  /**
   * Proxy path prefixes in canonical candidate form ("api/v1/..."),
   * segment-bounded. They are compared against canonicalProxyPath() output,
   * so a prefix MUST be written lowercase and percent-decoded — an uppercase
   * letter here would make the gate unmatchable rather than case-tolerant.
   */
  prefixes: string[];
  /** Restrict a gate to specific HTTP methods. Omitted means every method. */
  methods?: string[];
}

// Keep in sync with the nav requiredPermissions in dashboard/layout.tsx and
// PERMISSION_CATEGORIES in admin-management/components/permissionsConfig.ts.
const PERMISSION_GATES: PermissionGate[] = [
  {
    permission: "userManagement",
    prefixes: [
      "api/v1/users",
      "api/v1/admin/users",
      "api/v1/admin/staff/attendance",
      "api/v1/staff/admin/attendance",
      "api/v1/attendance/admin",
      "api/v1/consent",
      "api/v1/feedback",
      "api/v1/quality/nps",
      "api/v1/rbac/admin/toggle-user-status",
    ],
  },
  {
    permission: "doctorManagement",
    prefixes: ["api/v1/doctors", "api/v1/admin/doctors"],
  },
  {
    permission: "departmentManagement",
    prefixes: [
      "api/v1/departments",
      "api/v1/admin/departments",
      "api/v1/beds",
      "api/v1/wards",
      // Facility assets are physical-infrastructure inventory, same class as
      // beds/wards; scope a flag-limited ADMIN out of them too.
      "api/v1/facility/assets",
    ],
  },
  {
    permission: "appointmentManagement",
    prefixes: [
      "api/v1/appointments",
      "api/v1/admin/appointments",
      "api/v1/patients/search",
      "api/v1/prescriptions/all",
    ],
  },
  {
    permission: "pharmacyAdminRoutes",
    prefixes: [
      "api/v1/pharmacy",
      "api/v1/pharmacy-orders",
      "api/v1/admin/pharmacy",
    ],
  },
  {
    permission: "notificationManagement",
    prefixes: [
      "api/v1/notifications/admin",
      "api/v1/notifications/stats",
      "api/v1/notifications/scheduled",
      "api/v1/notifications/emergency",
      "api/v1/admin/notifications",
    ],
  },
  {
    permission: "notificationManagement",
    prefixes: ["api/v1/notifications/announcement-banner"],
    methods: ["PUT"],
  },
  {
    permission: "viewAuditLogs",
    prefixes: [
      "api/v1/logs",
      "api/v1/admin/analytics",
      "api/v1/investigations/admin",
    ],
  },
  {
    // EVERY member of the backend's `adminManagement` RBAC group — the
    // admin-account lifecycle. adminAuthRoutes.js hands seven routes to
    // wrapAutoRBAC(router, 'adminManagement', …) under /api/v1/auth/admin:
    // create-admin, deactivate, reactivate, revoke-all-sessions/:userId,
    // list, activity-logs/:adminId, update-permissions. rbacConfig.js sets
    // that group to [SUPER_ADMIN], so gating all seven denies an ADMIN
    // nothing the backend would have served it.
    //
    // Two of them (revoke-all-sessions, activity-logs) have no caller in this
    // app at all, so nothing in the portal loses a working screen either.
    // Until they were listed here no gate matched them, and since the proxy
    // allowlist admits the whole "api/v1/auth/" family the portal forwarded
    // an ADMIN's call at full role rank — the backend's own check was the
    // only refusal.
    //
    // login / profile / logout / change-password / MFA are mounted ABOVE that
    // wrapAutoRBAC call and are not in the group — every session needs them,
    // so they stay ungated.
    //
    // api/v1/rbac/admin/audit-log is NOT a group member (rbacRoutes.js wraps
    // it at [ADMIN], one tier lower); it is gated here because it is a read
    // belonging to the SUPER_ADMIN-only admin-management console, whose
    // PermissionsMatrix is its only caller in this app — so the denial costs
    // no ADMIN-reachable screen.
    permission: "adminManagement",
    prefixes: [
      "api/v1/auth/admin/create-admin",
      "api/v1/auth/admin/deactivate",
      "api/v1/auth/admin/reactivate",
      "api/v1/auth/admin/revoke-all-sessions",
      "api/v1/auth/admin/list",
      "api/v1/auth/admin/activity-logs",
      "api/v1/auth/admin/update-permissions",
      "api/v1/rbac/admin/audit-log",
    ],
  },
  {
    // Tenant entitlement/license administration is SUPER_ADMIN-only (route
    // policy + backend gate). PLATFORM_SUPER_ADMIN is intentionally NOT a
    // grantable per-admin flag, so no scoped ADMIN can hold it — only a
    // SUPER_ADMIN (who bypasses this check) crosses the gate.
    permission: PLATFORM_SUPER_ADMIN,
    prefixes: ["api/v1/admin/entitlements"],
  },
  {
    // Dark-gate console (Integrations & Gates) is SUPER_ADMIN-only, same
    // sentinel pattern as entitlements: no per-admin flag can satisfy it.
    permission: PLATFORM_SUPER_ADMIN,
    prefixes: ["api/v1/admin/integration-gates"],
  },

  // ── Remaining SUPER_ADMIN-only consoles (re-audit finding G, 2026-08-23) ──
  // routePolicy.ts marks these SUPER_ADMIN-only and navConfig hides them, but
  // middleware.ts enforces rank ONLY in its /dashboard branch — the
  // /api/proxy branch checks token validity + portal role and nothing else.
  // Without a sentinel here a plain ADMIN's call was forwarded at full role
  // rank and only the backend decided what happened next.
  //
  // Enforcement is layered now, and the backend half is the authority. Each
  // of the mounts gated below carries its own SUPER_ADMIN check:
  //   - router.use(requireRole('SUPER_ADMIN')) at the top of
  //     encryptionKeyRoutes, smartFhirRoutes, migrationToolkitRoutes and
  //     featureFlagRoutes;
  //   - per-route requireRole('SUPER_ADMIN') on both gdprRoutes routes and on
  //     the four continuity operations in admin/deviceRegistryRoutes;
  //   - an equivalent inline role check in admin/databaseRoutes;
  //   - a mount-level requireRole('SUPER_ADMIN') in app.js for
  //     api/v1/admin/tenants.
  // Each of those is a SUPER_ADMIN check written on the mount itself, rather
  // than the ADMIN-tier rank a /api/v1/admin-prefixed path would otherwise
  // pick up (ADMIN_ROUTE_ROLES resolves to ['SUPER_ADMIN', 'ADMIN']).
  //
  // This gate is the portal half, and it is not redundant. It refuses the
  // request before it is forwarded and before any profile round-trip, it
  // keeps the portal's answer identical to the backend's rather than sending
  // an ADMIN a request that could only 403, and it still refuses a console
  // whose route file later loses its check. Equally, it is not sufficient on
  // its own: a caller that skips the portal never reaches this code, which is
  // why the backend checks above are the load-bearing ones.
  // src/__tests__/security/super-admin-console-proxy-gate.test.ts pins every
  // SUPER_ADMIN-only console to the prefixes below, in both directions.
  {
    // PHI key registry: register/rotate/retire/compromise the keys live
    // decryption paths depend on (encryptionKeyRoutes).
    permission: PLATFORM_SUPER_ADMIN,
    prefixes: ["api/v1/admin/encryption-keys"],
  },
  {
    // SMART-on-FHIR app registry + token revocation over the LIVE public
    // OAuth surface (smartFhirRoutes).
    permission: PLATFORM_SUPER_ADMIN,
    prefixes: ["api/v1/admin/smart-fhir"],
  },
  {
    // Two-phase hospital-data import, rehearsal → commit (migrationToolkit
    // Routes) — an operator ceremony, not a tenant-admin task.
    permission: PLATFORM_SUPER_ADMIN,
    prefixes: ["api/v1/admin/migration-toolkit"],
  },
  {
    // Data-subject erasure execution: destructive and audit-bound. Mounted
    // at /api/v1/gdpr (app.js), NOT under /api/v1/admin.
    permission: PLATFORM_SUPER_ADMIN,
    prefixes: ["api/v1/gdpr"],
  },
  {
    // Live DB browser (databaseRoutes).
    permission: PLATFORM_SUPER_ADMIN,
    prefixes: ["api/v1/admin/database"],
  },
  {
    // Tenant CRUD, interop secrets and KEK rotation (tenantRoutes). Distinct
    // from api/v1/admin/tenant-context, the ADMIN-level read of the caller's
    // OWN tenant chrome — segment-bounded matching keeps them apart.
    permission: PLATFORM_SUPER_ADMIN,
    prefixes: ["api/v1/admin/tenants"],
  },
  {
    // Platform feature flags (featureFlagRoutes).
    permission: PLATFORM_SUPER_ADMIN,
    prefixes: ["api/v1/admin/feature-flags"],
  },
  {
    // Continuity facility-context grants/enrol/revoke + device-loss
    // declaration. Deliberately narrower than api/v1/admin/devices: the
    // device registry console itself is STAFF-rank and must stay reachable.
    permission: PLATFORM_SUPER_ADMIN,
    prefixes: [
      "api/v1/admin/devices/continuity-facility-context",
      "api/v1/admin/devices/continuity-device-loss",
    ],
  },
];

// Staff self-service ("My Work") endpoints that every portal tier — including
// an ADMIN scoped away from appointmentManagement — may use for their own
// queue. Checked before the gates above.
const SELF_SERVICE_EXEMPT: RegExp[] = [
  /^api\/v1\/appointments\/queue\/today$/,
  /^api\/v1\/appointments\/pending$/,
  /^api\/v1\/appointments\/completed\/recent$/,
  /^api\/v1\/appointments\/[^/]+\/(confirm|complete|no-show)$/,
];

/**
 * Fold a proxy path into the ONE form both proxy layers match on.
 *
 * Re-audit finding G round 2: the gate map below is spelled in lowercase and
 * was compared case-sensitively, while the route handler's allowlist admits a
 * gated path on a coarse ancestor prefix ("api/v1/admin/") whose casing the
 * attacker leaves alone. `api/v1/admin/Entitlements` therefore passed the
 * allowlist and missed every gate — and Express routes case-insensitively by
 * default (no `case sensitive routing` is set in apps/backend/src/app.js), so
 * the backend served the request. Both layers now call this function on the
 * same raw path, which is what makes the two decisions provably identical.
 *
 * Case folding uses toLowerCase(), which is locale-independent in ECMAScript,
 * so the gate cannot be shifted by the caller's locale.
 *
 * Percent escapes are decoded per segment as well. Express matches static
 * route segments against the still-encoded pathname, so an encoded spelling
 * reaches no route today; decoding is a fail-closed superset that keeps the
 * gate correct if anything on the path to the backend normalizes escapes.
 * A decoded separator would change the path's SHAPE, so a segment that
 * decodes to something containing "/" or "\" is left encoded — the canonical
 * path always has exactly the segments the raw one had.
 *
 * @returns the canonical candidate, or null when a segment carries a
 *   malformed escape (undecodable — the caller must reject the request).
 */
export function canonicalProxyPath(candidate: string): string | null {
  const canonical: string[] = [];
  for (const segment of candidate.split("/")) {
    let decoded = segment;
    if (segment.includes("%")) {
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return null;
      }
      if (decoded.includes("/") || decoded.includes("\\")) decoded = segment;
    }
    canonical.push(decoded);
  }
  return canonical.join("/").toLowerCase();
}

function matchesPrefix(candidate: string, prefix: string): boolean {
  // Segment-boundary match on the canonical path, same rule and same input
  // as the proxy path allowlist.
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

/**
 * The permission flag a proxied path requires, or null when ungated.
 *
 * `candidate` is the proxy path ("api/v1/...", no leading slash) AS RECEIVED —
 * canonicalization happens here rather than at the call site, so a caller
 * cannot reintroduce the layer asymmetry by forgetting it.
 */
export function requiredProxyPermission(
  candidate: string,
  method = "GET",
): string | null {
  const canonical = canonicalProxyPath(candidate);
  // An undecodable path is never "ungated": return the sentinel so only
  // SUPER_ADMIN could ever cross. The proxy route rejects such paths with a
  // 400 before reaching this, so this is the floor for any other caller.
  if (canonical === null) return PLATFORM_SUPER_ADMIN;

  if (SELF_SERVICE_EXEMPT.some((re) => re.test(canonical))) return null;
  const normalizedMethod = method.toUpperCase();
  for (const gate of PERMISSION_GATES) {
    if (gate.methods && !gate.methods.includes(normalizedMethod)) continue;
    if (gate.prefixes.some((prefix) => matchesPrefix(canonical, prefix))) {
      return gate.permission;
    }
  }
  return null;
}

// ── Permission resolution (live backend profile, concurrent coalescing) ─────

// Do not retain completed authorization decisions: permission revocation must
// take effect on the next request. The map only coalesces simultaneous calls
// from one page render and is cleared as soon as that lookup settles.
const permissionRequests = new Map<string, Promise<string[] | null>>();

export function __resetPermissionCacheForTests(): void {
  permissionRequests.clear();
}

async function fetchAdminPermissions(token: string): Promise<string[] | null> {
  const cacheKey = createHash("sha256").update(token).digest("hex");
  const pending = permissionRequests.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    const base = API_BASE_URL.replace(/\/+$/, "");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "x-forwarded-proto": "https",
    };
    const serverApiKey =
      process.env.BACKEND_API_KEY || process.env.API_KEY || "";
    if (serverApiKey) headers["x-api-key"] = serverApiKey;

    try {
      const res = await fetch(`${base}/api/v1/auth/admin/profile`, { headers });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        data?: { admin?: { permissions?: unknown } };
      };
      const raw = body?.data?.admin?.permissions;
      const permissions = Array.isArray(raw)
        ? raw.filter((p): p is string => typeof p === "string")
        : [];
      return permissions;
    } catch {
      return null;
    }
  })();

  permissionRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    permissionRequests.delete(cacheKey);
  }
}

export interface ProxyPermissionVerdict {
  allowed: boolean;
  message?: string;
}

/**
 * Decide whether the verified `role` / bearer may cross a gate requiring
 * `permission`. Fails closed for an ADMIN whose flags cannot be resolved, and
 * for every non-SUPER_ADMIN caller at a gate whose permission is outside
 * GRANTABLE_PERMISSIONS.
 */
export async function checkProxyPermission(
  token: string,
  role: string | null,
  permission: string,
): Promise<ProxyPermissionVerdict> {
  const normalized = String(role ?? "")
    .trim()
    .toUpperCase();

  if (normalized === "SUPER_ADMIN") return { allowed: true };

  // ── RANK GATE ────────────────────────────────────────────────────────────
  // A permission outside the grantable vocabulary (the PLATFORM_SUPER_ADMIN
  // sentinel, or a retired flag such as `adminManagement` still sitting in an
  // old admins.permissions row) is not a flag anyone can hold. SUPER_ADMIN
  // returned above; everyone else is denied HERE, which matters twice:
  //
  //   - middleware.ts enforces rank only in its /dashboard branch, and its
  //     /api/proxy branch admits every role in PORTAL_ROLE_VALUES. Without
  //     this check the "other tiers are backend-governed" passthrough below
  //     let a DOCTOR / IT_ADMIN / NURSING_STAFF token cross a sentinel gate
  //     as freely as it crosses a flag gate.
  //   - it is a pure, local decision, so a denied request costs no backend
  //     round-trip (the profile fetch below is only for flag gates).
  //
  // No lockout: every prefix behind an ungrantable permission is declared
  // SUPER_ADMIN_ONLY in routePolicy.ts, and the backend already refuses the
  // lower tiers there — those endpoints sit behind ADMIN-or-above RBAC (the
  // /api/v1/admin barrel's ADMIN_ROUTE_ROLES = ['SUPER_ADMIN','ADMIN'], the
  // rbacConfig `adminManagement: [SUPER_ADMIN]` group, wrapRoutes([ADMIN]),
  // or a route-level requireRole('SUPER_ADMIN')). This denial takes away only
  // access the backend was refusing anyway.
  if (!GRANTABLE_PERMISSIONS.has(permission)) {
    return {
      allowed: false,
      message: `Forbidden: missing ${permission} permission`,
    };
  }

  if (!normalized) {
    // Middleware already signature-verified the cookie; a missing role claim
    // in production is a misconfigured/foreign token — fail closed there,
    // stay permissive in dev/test where JWT_SECRET may be unset. Rank gates
    // are already denied above, in every environment.
    if (process.env.NODE_ENV === "production") {
      return { allowed: false, message: "Forbidden: role unverifiable" };
    }
    return { allowed: true };
  }

  // The flags model scopes ADMIN accounts at grantable gates; other tiers are
  // governed by the backend's per-endpoint role RBAC.
  if (normalized !== "ADMIN") return { allowed: true };

  const permissions = await fetchAdminPermissions(token);
  if (permissions === null) {
    return { allowed: false, message: "Forbidden: permissions unavailable" };
  }
  if (permissions.includes("*") || permissions.includes(permission)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    message: `Forbidden: missing ${permission} permission`,
  };
}
