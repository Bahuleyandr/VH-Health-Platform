import { fetchAdminAPI, getJSON, postJSON, putJSON } from "./core";

export type DeveloperPortalEnvironment = "sandbox" | "production";
export type DeveloperPortalClientStatus = "active" | "paused" | "revoked" | "archived";
export type DeveloperPortalKeyStatus = "active" | "revoked" | "expired";

export interface DeveloperPortalApiKey {
  id: number;
  tenant_id: string;
  api_client_id: number;
  key_prefix: string;
  display_name: string | null;
  status: DeveloperPortalKeyStatus;
  expires_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeveloperPortalApiClient {
  id: number;
  tenant_id: string;
  client_code: string;
  display_name: string;
  description: string | null;
  client_kind: string;
  status: DeveloperPortalClientStatus;
  environment: DeveloperPortalEnvironment;
  scopes: string[];
  allowed_ips: string[];
  rate_limit_profile: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  keys: DeveloperPortalApiKey[];
  key_count: number;
  active_key_count: number;
}

export interface DeveloperPortalAuditEvent {
  id: number | string;
  api_client_id: number | null;
  api_key_id: number | null;
  event_type: string;
  outcome: string;
  actor_uid: string | null;
  actor_role: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface DeveloperPortalScope {
  key: string;
  label: string;
  category: string;
  risk: "low" | "medium" | "high" | string;
  description: string;
}

export interface DeveloperPortalSummary {
  clients: DeveloperPortalApiClient[];
  count: number;
  counts: {
    total_clients: number;
    active_clients: number;
    sandbox_clients: number;
    production_clients: number;
    total_keys: number;
    active_keys: number;
  };
  scope_dictionary: DeveloperPortalScope[];
  integration_guide: {
    title: string;
    base_url_hint: string;
    authentication: string[];
    lifecycle: string[];
    security_notes: string[];
  };
  sandbox_key_policy: {
    environment: DeveloperPortalEnvironment;
    recommended_status: string;
    recommended_scopes: string[];
    recommended_expiry_days: number;
    production_promotion: string;
  };
  openapi_download: {
    endpoint: string;
    filename: string;
    media_type: string;
  };
  audit_events: DeveloperPortalAuditEvent[];
}

export interface DeveloperPortalClientPayload {
  id?: number;
  client_code: string;
  display_name: string;
  description?: string | null;
  client_kind: string;
  status: DeveloperPortalClientStatus;
  environment: DeveloperPortalEnvironment;
  scopes: string[];
  allowed_ips: string[];
  rate_limit_profile?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DeveloperPortalKeyPayload {
  display_name?: string | null;
  expires_at?: string | null;
  revoked_reason?: string | null;
}

export interface DeveloperPortalKeyIssue {
  plaintext: string;
  key: DeveloperPortalApiKey;
  revoked_key?: DeveloperPortalApiKey;
}

export function getDeveloperPortalSummary(params?: {
  status?: string;
  client_kind?: string;
  environment?: string;
}) {
  return getJSON<DeveloperPortalSummary>("/admin/developer-portal", params);
}

export function saveDeveloperPortalClient(payload: DeveloperPortalClientPayload) {
  return putJSON<DeveloperPortalApiClient>("/admin/developer-portal/api-clients", payload);
}

export function issueDeveloperPortalKey(clientId: number, payload: DeveloperPortalKeyPayload) {
  return postJSON<DeveloperPortalKeyIssue>(`/admin/developer-portal/api-clients/${clientId}/keys`, payload);
}

export function rotateDeveloperPortalKey(clientId: number, keyId: number, payload: DeveloperPortalKeyPayload) {
  return postJSON<DeveloperPortalKeyIssue>(
    `/admin/developer-portal/api-clients/${clientId}/keys/${keyId}/rotate`,
    payload,
  );
}

export function revokeDeveloperPortalKey(keyId: number, payload: DeveloperPortalKeyPayload) {
  return fetchAdminAPI<DeveloperPortalApiKey>(`/admin/developer-portal/api-keys/${keyId}/revoke`, {
    method: "PATCH",
    body: payload,
  });
}

export function getDeveloperPortalOpenApi() {
  return getJSON<{ document: unknown }>("/admin/developer-portal/openapi");
}
