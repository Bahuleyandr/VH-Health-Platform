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
//   - SUPER_ADMIN (or a '*' permission) always passes.
//   - Flags scope ADMIN accounts. Lower-rank portal roles (staff/HR/doctor
//     tiers) are governed by the backend's per-endpoint role RBAC — they never
//     had ADMIN-rank access for the flags to scope down, so they pass here.
//   - An ADMIN without the required flag is denied (403), exactly like the
//     nav already hides the page.
//
// Server-only: imported by the /api/proxy route handler (node runtime).

import { API_BASE_URL } from "@/lib/api-config";
import { createHash } from "node:crypto";

// Sentinel "permission" that no per-admin flag grants and the Permissions
// Matrix never offers. A gate requiring it is effectively SUPER_ADMIN-only:
// ADMIN accounts can never satisfy it, and SUPER_ADMIN (plus the '*' wildcard)
// short-circuits the check before flags are consulted.
const PLATFORM_SUPER_ADMIN = "platformSuperAdmin";

interface PermissionGate {
  permission: string;
  /** Proxy path prefixes in candidate form ("api/v1/..."), segment-bounded. */
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
    // The admin-account lifecycle endpoints under api/v1/auth/admin/.
    // (login/profile/logout/MFA stay ungated — every session needs those.)
    permission: "adminManagement",
    prefixes: [
      "api/v1/auth/admin/list",
      "api/v1/auth/admin/create-admin",
      "api/v1/auth/admin/deactivate",
      "api/v1/auth/admin/reactivate",
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

function matchesPrefix(candidate: string, prefix: string): boolean {
  // Segment-boundary match, same rule as the proxy path allowlist.
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

/**
 * The permission flag a proxied path requires, or null when ungated.
 * `candidate` is the normalized proxy path ("api/v1/...", no leading slash).
 */
export function requiredProxyPermission(
  candidate: string,
  method = "GET",
): string | null {
  if (SELF_SERVICE_EXEMPT.some((re) => re.test(candidate))) return null;
  const normalizedMethod = method.toUpperCase();
  for (const gate of PERMISSION_GATES) {
    if (gate.methods && !gate.methods.includes(normalizedMethod)) continue;
    if (gate.prefixes.some((prefix) => matchesPrefix(candidate, prefix))) {
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
 * `permission`. Fails closed for an ADMIN whose flags cannot be resolved.
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

  if (!normalized) {
    // Middleware already signature-verified the cookie; a missing role claim
    // in production is a misconfigured/foreign token — fail closed there,
    // stay permissive in dev/test where JWT_SECRET may be unset.
    if (process.env.NODE_ENV === "production") {
      return { allowed: false, message: "Forbidden: role unverifiable" };
    }
    return { allowed: true };
  }

  // The flags model scopes ADMIN accounts; other tiers are governed by the
  // backend's per-endpoint role RBAC.
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
