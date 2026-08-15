import { fetchAdminAPI } from "./core";

export type EntitlementDecision = {
  featureKey: string;
  allowed: boolean;
  entitled: boolean;
  hardBlock: boolean;
  decision: "allow" | "deny" | "grace" | "status_only" | "audit_only";
  status: string;
  enforcementMode: string;
  packageKey: string | null;
  packageDisplayName: string | null;
  urgentClinical: boolean;
  reason: string;
};

export type ProductFeature = {
  featureKey: string;
  displayName: string;
  description?: string | null;
  category: string;
  enforcementMode: string;
  urgentClinical: boolean;
  routePatterns: string[];
  navSurfaces: string[];
  mobileSurfaceKeys: string[];
  metadata: Record<string, unknown>;
  decision?: EntitlementDecision;
};

export type ProductPackage = {
  packageKey: string;
  displayName: string;
  description?: string | null;
  packageTier: string;
  status: string;
  gracePeriodDays: number;
  metadata: Record<string, unknown>;
  features: Array<{
    packageKey: string;
    featureKey: string;
    included: boolean;
    limits: Record<string, unknown>;
    feature?: ProductFeature | null;
  }>;
};

export type TenantEntitlement = {
  id: number;
  tenantId: string;
  packageKey: string;
  packageDisplayName?: string | null;
  status: string;
  startsAt: string;
  expiresAt?: string | null;
  graceEndsAt?: string | null;
  source: string;
  assignedBy?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type TenantEntitlementSummary = {
  tenantId: string;
  generatedAt: string;
  packages: TenantEntitlement[];
  catalog: {
    packages: ProductPackage[];
    features: ProductFeature[];
  };
  features: ProductFeature[];
  nav: Array<{
    surface: string;
    featureKey: string;
    visible: boolean;
    status: string;
  }>;
  mobile: Array<{
    surface: string;
    featureKey: string;
    visible: boolean;
    status: string;
  }>;
  invariants: {
    hardBlockCategories: string[];
    urgentClinicalPolicy: string;
  };
};

export type EntitlementAuditEvent = {
  id: number;
  tenantId: string;
  featureKey?: string | null;
  packageKey?: string | null;
  action: string;
  decision: string;
  enforcementMode?: string | null;
  surface?: string | null;
  routePath?: string | null;
  actorUid?: string | null;
  actorRole?: string | null;
  requestId?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type TenantEntitlementUpdate = {
  packageKey: string;
  status: string;
  expiresAt?: string | null;
  graceEndsAt?: string | null;
  source?: string;
  metadata?: Record<string, unknown>;
};

export function getCurrentEntitlementSummary() {
  return fetchAdminAPI<TenantEntitlementSummary>("/admin/entitlements/current");
}

export function getTenantEntitlementSummary(tenantId: string) {
  return fetchAdminAPI<TenantEntitlementSummary>(
    `/admin/entitlements/tenants/${encodeURIComponent(tenantId)}`,
  );
}

export function updateTenantEntitlement(
  tenantId: string,
  payload: TenantEntitlementUpdate,
) {
  return fetchAdminAPI<TenantEntitlement>(
    `/admin/entitlements/tenants/${encodeURIComponent(tenantId)}`,
    {
      method: "PUT",
      body: payload,
    },
  );
}

export function getTenantEntitlementAudit(tenantId: string, limit = 50) {
  return fetchAdminAPI<EntitlementAuditEvent[]>(
    `/admin/entitlements/tenants/${encodeURIComponent(tenantId)}/audit?limit=${limit}`,
  );
}
