// src/lib/proxyPermissions.ts
//
// ADM-1 (review 2026-08-10): per-admin permission flags (admins.permissions,
// edited via /dashboard/admin-management/edit-permissions) were UI-only — the
// nav hid gated pages but the /api/proxy allowlist forwarded every request at
// full role rank, so a scoped-down ADMIN kept full API access. This module is
// the server-side enforcement point: it maps permission-gated backend path
// prefixes to the flag they require and resolves the caller's flags from the
// backend profile endpoint (short-TTL cache keyed by bearer token).
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

interface PermissionGate {
  permission: string;
  /** Proxy path prefixes in candidate form ("api/v1/..."), segment-bounded. */
  prefixes: string[];
}

// Keep in sync with the nav requiredPermissions in dashboard/layout.tsx and
// PERMISSION_CATEGORIES in admin-management/components/permissionsConfig.ts.
const PERMISSION_GATES: PermissionGate[] = [
  { permission: "userManagement", prefixes: ["api/v1/users"] },
  { permission: "doctorManagement", prefixes: ["api/v1/doctors"] },
  { permission: "departmentManagement", prefixes: ["api/v1/departments"] },
  { permission: "appointmentManagement", prefixes: ["api/v1/appointments"] },
  {
    permission: "pharmacyAdminRoutes",
    prefixes: ["api/v1/pharmacy", "api/v1/pharmacy-orders"],
  },
  {
    permission: "notificationManagement",
    prefixes: ["api/v1/notifications/admin"],
  },
  { permission: "viewAuditLogs", prefixes: ["api/v1/logs"] },
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

function matchesPrefix(candidate: string, prefix: string): boolean {
  // Segment-boundary match, same rule as the proxy path allowlist.
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

/**
 * The permission flag a proxied path requires, or null when ungated.
 * `candidate` is the normalized proxy path ("api/v1/...", no leading slash).
 */
export function requiredProxyPermission(candidate: string): string | null {
  if (SELF_SERVICE_EXEMPT.some((re) => re.test(candidate))) return null;
  for (const gate of PERMISSION_GATES) {
    if (gate.prefixes.some((prefix) => matchesPrefix(candidate, prefix))) {
      return gate.permission;
    }
  }
  return null;
}

// ── Permission resolution (backend profile, short-TTL per-token cache) ──────

const PERMISSION_CACHE_TTL_MS = 60_000;
const PERMISSION_CACHE_MAX = 500;

const permissionCache = new Map<
  string,
  { permissions: string[]; expires: number }
>();

export function __resetPermissionCacheForTests(): void {
  permissionCache.clear();
}

async function fetchAdminPermissions(token: string): Promise<string[] | null> {
  const cached = permissionCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.permissions;

  const base = API_BASE_URL.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "x-forwarded-proto": "https",
  };
  const serverApiKey = process.env.BACKEND_API_KEY || process.env.API_KEY || "";
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
    if (permissionCache.size >= PERMISSION_CACHE_MAX) {
      const oldest = permissionCache.keys().next().value;
      if (oldest !== undefined) permissionCache.delete(oldest);
    }
    permissionCache.set(token, {
      permissions,
      expires: Date.now() + PERMISSION_CACHE_TTL_MS,
    });
    return permissions;
  } catch {
    return null;
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
  const normalized = String(role ?? "").trim().toUpperCase();

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
