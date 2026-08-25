// Integrations & Gates console (SUPER_ADMIN-only, slate B1).
//
// The read comes from GET /api/v1/admin/integration-gates (new backend
// surface). Every mutation goes to a PRE-EXISTING endpoint:
//   * payment gateway config   → PUT /api/v1/billing/gateway/config
//   * SMS provider config      → PUT /api/v1/admin/notifications/sms/config
//   * DLT template registration→ POST /api/v1/admin/notifications/sms/templates
//   * tenant gate flags        → PATCH /api/v1/admin/tenants/:id (settings)
//
// Secrets are WRITE-ONLY: reads only ever expose has_* booleans, and this
// module never stores or echoes a submitted secret.

import { fetchAdminAPI } from "./core";
import { listTenants, updateTenant, type Tenant } from "./tenants";

export type GateLayerName =
  "env" | "tenant_setting" | "provider_config" | "unknown";

export interface PaymentGatewayConfigView {
  id: number;
  provider: string;
  environment: string;
  enabled: boolean;
  display_name: string | null;
  key_id: string | null;
  accepted_methods: string[];
  has_key_secret: boolean;
  has_webhook_secret: boolean;
  webhook_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface SmsProviderConfigView {
  id: number;
  provider: string;
  enabled: boolean;
  sender_id: string | null;
  dlt_entity_id: string | null;
  account_sid: string | null;
  has_auth_key: boolean;
  has_callback_token: boolean;
  created_at: string;
  updated_at: string;
}

export interface IntegrationGateState {
  effective: boolean;
  blocking_layer?: GateLayerName | null;
  reason?: string | null;
  rides?: string;
  provider?: string;
  source?: string;
  environment?: string;
  retention_days?: number;
  min_seconds_between_fixes?: number;
  layers?: {
    env?: boolean;
    env_provider?: string | null;
    env_kill_switch?: boolean;
    tenant_setting?: boolean;
    provider_configs?: Array<PaymentGatewayConfigView | SmsProviderConfigView>;
    /** Terminology & knowledge gates: "provider config" ≙ imported content. */
    provider_config?: boolean;
  };
  dlt_templates?: { total: number; active: number };
  // ── Terminology & knowledge gate details (slate C1; appended block) ──
  env_level?: string;
  enforcement?: Record<string, string>;
  concept_count?: number;
  mapping_rows?: number;
  licensed_active_sources?: number;
  counter_sale_advisory?: boolean;
}

export type GateKey =
  | "payment_gateway"
  | "sms"
  | "abdm_enrolment"
  | "abdm_scan_share"
  | "abdm_hiu"
  | "uhi"
  | "ambulance_gps"
  | "facility_assets"
  // Terminology & knowledge gates (slate C1; appended block).
  | "terminology_coding"
  | "lab_loinc_mapping"
  | "drug_kb"
  // Device-gateway LIS analyzer transport (#891 deferral).
  | "lis_listeners"
  | "analytics_bi";

export interface IntegrationGateTenantEntry {
  tenant: { id: string; slug: string; name: string | null; status: string };
  // Partial: a backend that predates a newly-added gate key simply omits it,
  // and the console renders the rows it receives.
  gates: Partial<Record<GateKey, IntegrationGateState>>;
}

export interface IntegrationGateEnvFacts {
  payment_gateway_enabled: boolean;
  sms_provider: string | null;
  sms_kill_switch: boolean;
  abdm_enabled: boolean;
  abdm_environment: "sandbox" | "production";
  abdm_has_client_credentials: boolean;
  uhi_enabled: boolean;
  uhi_environment: "sandbox" | "production";
  uhi_has_subscriber_identity: boolean;
  facility_assets_enabled: boolean;
  livekit_enabled: boolean;
  file_scan_policy: "required" | "disabled_accepted_risk";
  clinical_continuity_c_d14_approved: boolean;
  // ── Terminology & knowledge env facts (slate C1; appended block) ──
  // Optional so the console tolerates a backend that predates them.
  who_icd_configured?: boolean;
  terminology_coding_enforcement?: "off" | "warn" | "block";
  drug_kb_deterministic_matching?: boolean;
  lab_loinc_mapping_enabled?: boolean;
  /**
   * Count of listener profiles in the backend mirror of
   * DEVICE_GATEWAY_LIS_LISTENERS (the gateway deployment holds the
   * authoritative copy).
   */
  lis_listeners_configured?: number;
  /** Embedded BI (wt/bi-app): METABASE_URL + METABASE_EMBED_SECRET present. */
  metabase_configured: boolean;
  /** Count of METABASE_DASH_* env vars carrying a positive dashboard id. */
  metabase_dashboards_configured: number;
}

export interface IntegrationGateReport {
  generated_at: string;
  env: IntegrationGateEnvFacts;
  tenants: IntegrationGateTenantEntry[];
}

export function getIntegrationGates(tenantId?: string) {
  const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
  return fetchAdminAPI<IntegrationGateReport>(
    `/admin/integration-gates${query}`,
  );
}

// ── Tenant gate-flag flips (tenant-settings PATCH) ──────────────────────────
//
// PATCH /admin/tenants/:id REPLACES the generic settings JSONB (only the
// server-reserved governed keys survive), so a flag flip must send the FULL
// current settings with just the gate key changed — and must strip the
// reserved keys the backend refuses in a generic write.

const RESERVED_TENANT_SETTINGS_KEYS = [
  "care_pathways",
  "care_team_enforcement_mode",
];

export type TenantGateSettingKey =
  | "paymentGateway"
  | "sms"
  | "abdmEnrolment"
  | "abdmHiu"
  | "uhi"
  | "ambulanceGpsTracking"
  | "facilityAssets"
  | "analyticsBi";

export async function setTenantGateFlag(
  tenantId: string,
  settingKey: TenantGateSettingKey,
  enabled: boolean,
): Promise<Tenant> {
  // Fresh read of the tenant's settings right before the merge, so we never
  // clobber a concurrent settings change with a stale snapshot.
  const { tenants } = await listTenants();
  const tenant = tenants.find((t) => t.id === tenantId);
  if (!tenant) throw new Error("Tenant not found");

  const settings: Record<string, unknown> = {
    ...(tenant.settings ?? {}),
  };
  for (const key of RESERVED_TENANT_SETTINGS_KEYS) delete settings[key];

  const existing = settings[settingKey];
  settings[settingKey] = {
    ...(existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {}),
    enabled,
  };

  return updateTenant(tenantId, { settings });
}

// ── Payment gateway config (write-only secrets) ─────────────────────────────

export interface PaymentGatewayConfigUpsert {
  provider: string;
  environment?: "sandbox" | "production";
  enabled: boolean;
  display_name?: string;
  key_id?: string;
  /** Write-only; omit to keep the stored secret. */
  key_secret?: string;
  /** Write-only; omit to keep the stored secret. */
  webhook_secret?: string;
  accepted_methods?: string[];
}

export function upsertPaymentGatewayConfig(
  payload: PaymentGatewayConfigUpsert,
) {
  return fetchAdminAPI<PaymentGatewayConfigView>("/billing/gateway/config", {
    method: "PUT",
    body: payload,
  });
}

// ── SMS provider config + DLT template registration ─────────────────────────

export interface SmsConfigUpsert {
  provider: "msg91" | "twilio" | "dry_run";
  enabled: boolean;
  sender_id?: string;
  dlt_entity_id?: string;
  /** Write-only; omit to keep the stored key. */
  auth_key?: string;
  account_sid?: string;
  rotate_callback_token?: boolean;
}

export interface SmsConfigUpsertResult extends SmsProviderConfigView {
  /** Returned EXACTLY ONCE when a DLR callback token is minted/rotated. */
  callback_token?: string;
  dlr_path?: string;
}

export function upsertSmsConfig(payload: SmsConfigUpsert) {
  return fetchAdminAPI<SmsConfigUpsertResult>(
    "/admin/notifications/sms/config",
    { method: "PUT", body: payload },
  );
}

export interface SmsTemplateRegistrationCreate {
  /** Optional — the backend resolves the tenant's config row when omitted. */
  provider_config_id?: number;
  template_key: string;
  dlt_template_id: string;
  provider_template_id?: string;
  active?: boolean;
}

export interface SmsTemplateRegistration {
  id: number;
  provider_config_id: number;
  template_key: string;
  dlt_template_id: string;
  provider_template_id: string | null;
  active: boolean;
}

export function registerSmsTemplate(payload: SmsTemplateRegistrationCreate) {
  return fetchAdminAPI<SmsTemplateRegistration>(
    "/admin/notifications/sms/templates",
    { method: "POST", body: payload },
  );
}

export function listSmsTemplates() {
  return fetchAdminAPI<{ templates: SmsTemplateRegistration[] }>(
    "/admin/notifications/sms/templates",
  );
}
