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

export async function listTenants(params: { status?: string; region?: string } = {}) {
  const query: Record<string, string | number> = {};
  if (params.status) query.status = params.status;
  if (params.region) query.region = params.region;
  return getJSON<{ tenants: Tenant[]; count: number }>('/admin/tenants', query);
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
