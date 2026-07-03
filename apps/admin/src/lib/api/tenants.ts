import { fetchAdminAPI, getJSON, postJSON } from './core';

export type TenantRegion = 'IN' | 'EU' | 'US' | 'AP' | 'OTHER';
export type TenantComplianceProfile = 'DPDP' | 'HIPAA' | 'GDPR' | 'NONE';
export type TenantStatus = 'active' | 'suspended' | 'offboarding';

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
  kind: 'abdm_callback' | 'hl7_inbound';
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
  status: 'queued' | 'running' | 'succeeded' | 'failed';
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

export async function listTenants(params: { status?: string; region?: string } = {}) {
  const query: Record<string, string | number> = {};
  if (params.status) query.status = params.status;
  if (params.region) query.region = params.region;
  return getJSON<{ tenants: Tenant[]; count: number }>('/admin/tenants', query);
}

export async function listTenantInteropSecrets(tenantId: string) {
  return getJSON<{ secrets: TenantInteropSecret[]; count: number }>(
    `/admin/tenants/${tenantId}/interop-secrets`,
  );
}

export async function upsertTenantInteropSecret(tenantId: string, payload: {
  kind: TenantInteropSecret['kind'];
  senderIdentifier: string;
  secret: string;
}) {
  return postJSON<TenantInteropSecret>(`/admin/tenants/${tenantId}/interop-secrets`, payload);
}

export async function startTenantKekRewrapJob(tenantId: string) {
  return postJSON<TenantKekRewrapJob>(`/admin/tenants/${tenantId}/kek-rotation-jobs`, {});
}

export async function getTenantKekRewrapJob(tenantId: string, jobId: string) {
  return getJSON<TenantKekRewrapJob>(`/admin/tenants/${tenantId}/kek-rotation-jobs/${jobId}`);
}

export async function createTenant(payload: {
  slug: string;
  name: string;
  region?: TenantRegion;
  compliance_profile?: TenantComplianceProfile;
  settings?: Record<string, unknown>;
}) {
  return postJSON<Tenant>('/admin/tenants', payload);
}

export async function updateTenant(tenantId: string, patch: Partial<{
  name: string;
  region: TenantRegion;
  compliance_profile: TenantComplianceProfile;
  status: TenantStatus;
  settings: Record<string, unknown>;
}>) {
  return fetchAdminAPI<Tenant>(`/admin/tenants/${tenantId}`, {
    method: 'PATCH',
    body: patch,
  });
}
