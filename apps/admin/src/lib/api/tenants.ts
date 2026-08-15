import { fetchAdminAPI, getJSON, postJSON } from "./core";
import type { BrandKitAsset } from "./tenantContext";

export type TenantRegion = "IN" | "EU" | "US" | "AP" | "OTHER";
export type TenantComplianceProfile = "DPDP" | "HIPAA" | "GDPR" | "NONE";
export type TenantStatus = "active" | "suspended" | "offboarding";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  region: TenantRegion;
  compliance_profile: TenantComplianceProfile;
  status: TenantStatus;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TenantInteropSecret {
  id: number;
  tenant_id: string;
  kind: "abdm_callback" | "hl7_inbound";
  sender_identifier: string;
  status: string;
  has_secret: boolean;
  secret_masked: string | null;
  created_at: string;
  updated_at: string;
}

export interface TenantKekRewrapJob {
  job_id: string;
  tenant_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  requested_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  summary: null | {
    tenant_id: string;
    key_id: string;
    dry_run: boolean;
    scanned: number;
    rewrapped: number;
    tables: Array<{
      table: string;
      scanned: number;
      rewrapped: number;
      skipped: boolean;
    }>;
  };
  error: null | {
    code: string;
    message: string;
  };
}

export interface TenantBrandKit {
  schemaVersion: number;
  name: string | null;
  primaryColor: string | null;
  logoUrl: string | null;
  supportEmail: string | null;
  legalName: string | null;
  legalFooter: string | null;
  helpCenterUrl: string | null;
  document: {
    legalName: string | null;
    footerText: string | null;
    letterheadUrl: string | null;
  };
  email: {
    fromName: string | null;
    replyTo: string | null;
  };
  assets: {
    logo: BrandKitAsset | null;
    documentLetterhead: BrandKitAsset | null;
  };
  mobile: {
    identityMode: "stamped_build";
    tokenColorSource: "VH_TENANT_PRIMARY";
  };
  fallbacks?: {
    name: boolean;
    logo: boolean;
    supportEmail: boolean;
    legalName: boolean;
    helpCenter: boolean;
  };
}

export type TenantBrandKitPatch = Partial<{
  name: string | null;
  primaryColor: string | null;
  logoUrl: string | null;
  supportEmail: string | null;
  legalName: string | null;
  legalFooter: string | null;
  helpCenterUrl: string | null;
  document: Partial<{
    footerText: string | null;
  }>;
  email: Partial<{
    fromName: string | null;
    replyTo: string | null;
  }>;
  assets: Partial<{
    logo: { storageKey: string } | null;
    documentLetterhead: { storageKey: string } | null;
  }>;
}>;

export async function listTenants(
  params: { status?: string; region?: string } = {},
) {
  const query: Record<string, string | number> = {};
  if (params.status) query.status = params.status;
  if (params.region) query.region = params.region;
  return getJSON<{ tenants: Tenant[]; count: number }>("/admin/tenants", query);
}

export async function listTenantInteropSecrets(tenantId: string) {
  return getJSON<{ secrets: TenantInteropSecret[]; count: number }>(
    `/admin/tenants/${tenantId}/interop-secrets`,
  );
}

export async function updateTenantBrandKit(
  tenantId: string,
  payload: TenantBrandKitPatch,
) {
  return fetchAdminAPI<{ brandKit: TenantBrandKit }>(
    `/admin/tenants/${tenantId}/brand-kit`,
    {
      method: "PATCH",
      body: payload,
    },
  );
}

export async function upsertTenantInteropSecret(
  tenantId: string,
  payload: {
    kind: TenantInteropSecret["kind"];
    senderIdentifier: string;
    secret: string;
  },
) {
  return postJSON<TenantInteropSecret>(
    `/admin/tenants/${tenantId}/interop-secrets`,
    payload,
  );
}

export async function startTenantKekRewrapJob(tenantId: string) {
  return postJSON<TenantKekRewrapJob>(
    `/admin/tenants/${tenantId}/kek-rotation-jobs`,
    {},
  );
}

export async function getTenantKekRewrapJob(tenantId: string, jobId: string) {
  return getJSON<TenantKekRewrapJob>(
    `/admin/tenants/${tenantId}/kek-rotation-jobs/${jobId}`,
  );
}

export async function createTenant(payload: {
  slug: string;
  name: string;
  region?: TenantRegion;
  compliance_profile?: TenantComplianceProfile;
  settings?: Record<string, unknown>;
}) {
  return postJSON<Tenant>("/admin/tenants", payload);
}

export async function updateTenant(
  tenantId: string,
  patch: Partial<{
    name: string;
    region: TenantRegion;
    compliance_profile: TenantComplianceProfile;
    status: TenantStatus;
    settings: Record<string, unknown>;
  }>,
) {
  return fetchAdminAPI<Tenant>(`/admin/tenants/${tenantId}`, {
    method: "PATCH",
    body: patch,
  });
}
