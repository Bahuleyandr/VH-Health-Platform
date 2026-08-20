// src/services/integrations/integrationGateService.js
//
// Read-only "Integrations & Gates" console backing (slate B1): per tenant,
// the effective state of every dark-shipped feature gate, plus the
// deployment-wide env facts.
//
// Design rules:
//   * Truth is REUSED, never re-derived: each feature's own resolver decides
//     "effective" — paymentGatewayService.resolveGatewayContext, the SMS
//     registry's resolveSmsProviderContext, and the tenantSettingsService
//     accessors the ABDM/UHI/ambulance services consult. This module only
//     assembles their answers.
//   * NEVER returns secret values. Config rows are surfaced through the
//     services' own write-only admin views (has_* booleans); env credentials
//     are reduced to presence booleans; resolver `config` rows (which carry
//     ciphertext columns) are never included in the output.
//   * Read-only: no mutation lives here. Flips go through the existing
//     mutation endpoints (PUT /billing/gateway/config, PUT
//     /admin/notifications/sms/config + template registration, and the
//     tenant-settings PATCH).

import logger from '../../logging/logger.js';
import { ABDM_CONFIG } from '../../config/abdmConfig.js';
import { UHI_CONFIG } from '../../config/uhiConfig.js';
import { CLINICAL_CONTINUITY_C_D14_APPROVED } from '../../config/downtimeConfig.js';
import { resolveFileScanPolicy } from '../../config/fileScanPolicy.js';
import {
  isGatewayEnvEnabled,
  listGatewayConfigs,
  resolveGatewayContext,
} from '../billing/paymentGatewayService.js';
import {
  listSmsProviderConfigs,
  listSmsTemplateRegistrations,
} from '../notification/smsProviderConfigService.js';
import { resolveSmsProviderContext } from '../../utils/notifications/smsProviders/index.js';
import { livekitEnabled } from '../telemedicine/teleconsultProvisioningService.js';
import { listTenants } from '../tenant/tenantService.js';
import {
  getAbdmEnrolmentSettings,
  getAbdmHiuSettings,
  getAmbulanceGpsTrackingSettings,
  getAnalyticsBiSettings,
  getPaymentGatewaySettings,
  getSmsSettings,
  getUhiSettings,
} from '../tenant/tenantSettingsService.js';

// Map each resolver's blocking reason onto the gate layer it names, so the
// console can say WHICH layer holds a dark feature dark.
const GATEWAY_REASON_LAYER = {
  env_disabled: 'env',
  settings_unavailable: 'tenant_setting',
  tenant_disabled: 'tenant_setting',
  config_unavailable: 'provider_config',
  no_enabled_config: 'provider_config',
  credentials_incomplete: 'provider_config',
};

const SMS_REASON_LAYER = {
  env_kill_switch: 'env',
  tenant_unresolved: 'tenant_setting',
  settings_unavailable: 'tenant_setting',
  tenant_disabled: 'tenant_setting',
  config_unavailable: 'provider_config',
  tenant_config_dry_run: 'provider_config',
  env_credentials_incomplete: 'provider_config',
  not_configured: 'provider_config',
};

function blockingLayer(map, reason) {
  if (!reason) return null;
  return map[reason] || 'unknown';
}

// Env layer of the analytics-BI (embedded Metabase) gate. Mirrors
// metabaseService.isMetabaseEnvConfigured — read here directly from
// process.env (the sms_provider idiom) so this console module does not
// import the dashboards service graph.
function metabaseEnvConfigured() {
  return Boolean(process.env.METABASE_URL && process.env.METABASE_EMBED_SECRET);
}

/** Deployment-wide env facts — booleans / enum names only, never values. */
export function integrationGateEnvFacts() {
  const smsProvider = String(process.env.SMS_PROVIDER || '').trim().toLowerCase();
  return {
    payment_gateway_enabled: isGatewayEnvEnabled(),
    sms_provider: smsProvider || null,
    sms_kill_switch: smsProvider === 'logger',
    abdm_enabled: ABDM_CONFIG.enabled === true,
    abdm_environment: ABDM_CONFIG.environment,
    abdm_has_client_credentials: Boolean(ABDM_CONFIG.clientId && ABDM_CONFIG.clientSecret),
    uhi_enabled: UHI_CONFIG.enabled === true,
    uhi_environment: UHI_CONFIG.environment,
    uhi_has_subscriber_identity: Boolean(
      UHI_CONFIG.subscriberId && UHI_CONFIG.signingPrivateKey && UHI_CONFIG.signingKeyId,
    ),
    // Read-only env facts (operator/hardware-blocked dark stack).
    livekit_enabled: livekitEnabled(),
    file_scan_policy: resolveFileScanPolicy(),
    clinical_continuity_c_d14_approved: CLINICAL_CONTINUITY_C_D14_APPROVED === true,
    // Embedded BI (slate C2): presence booleans/counts only, never URLs or
    // secrets. metabase_dashboards_configured counts METABASE_DASH_* env
    // vars carrying a positive dashboard id (the per-dashboard config layer).
    metabase_configured: metabaseEnvConfigured(),
    metabase_dashboards_configured: Object.entries(process.env)
      .filter(([name]) => name.startsWith('METABASE_DASH_'))
      .filter(([, value]) => Number.parseInt(value, 10) > 0)
      .length,
  };
}

async function paymentGatewayGate(tenantId) {
  // resolveGatewayContext is the single effective-state truth (env AND
  // tenant setting AND enabled config row, incl. dry_run vs live creds).
  const context = await resolveGatewayContext(tenantId);
  // listGatewayConfigs is the write-only admin view (secrets → booleans).
  const view = await listGatewayConfigs(tenantId);
  return {
    effective: context.enabled === true,
    reason: context.reason,
    blocking_layer: blockingLayer(GATEWAY_REASON_LAYER, context.reason),
    layers: {
      env: view.env_enabled === true,
      tenant_setting: view.tenant_enabled === true,
      provider_configs: view.configs,
    },
  };
}

async function smsGate(tenantId) {
  const context = await resolveSmsProviderContext(tenantId);
  const view = await listSmsProviderConfigs(tenantId);
  let templates = [];
  try {
    templates = await listSmsTemplateRegistrations(tenantId);
  } catch (err) {
    logger.warn('integration gates: sms template listing failed', { error: err?.message });
  }
  const effective = context.provider !== 'dry_run';
  return {
    effective,
    provider: context.provider,
    source: context.source,
    reason: context.reason,
    blocking_layer: effective ? null : blockingLayer(SMS_REASON_LAYER, context.reason),
    layers: {
      env_provider: view.env_provider,
      env_kill_switch: view.env_kill_switch === true,
      tenant_setting: view.tenant_enabled === true,
      provider_configs: view.configs,
    },
    dlt_templates: {
      total: templates.length,
      active: templates.filter((t) => t?.active === true).length,
    },
  };
}

async function abdmGates(tenantId) {
  const envEnabled = ABDM_CONFIG.enabled === true;
  const enrolment = await getAbdmEnrolmentSettings(tenantId);
  const hiu = await getAbdmHiuSettings(tenantId);
  const enrolmentEffective = envEnabled && enrolment.enabled === true;
  const enrolmentBlocking = enrolmentEffective
    ? null
    : (envEnabled ? 'tenant_setting' : 'env');
  return {
    abdm_enrolment: {
      effective: enrolmentEffective,
      blocking_layer: enrolmentBlocking,
      layers: { env: envEnabled, tenant_setting: enrolment.enabled === true },
      environment: ABDM_CONFIG.environment,
    },
    // Scan & Share intake rides the enrolment/HIP gating — no flag of its own.
    abdm_scan_share: {
      effective: enrolmentEffective,
      blocking_layer: enrolmentBlocking,
      rides: 'abdm_enrolment',
    },
    abdm_hiu: {
      effective: envEnabled && hiu.enabled === true,
      blocking_layer: envEnabled && hiu.enabled === true
        ? null
        : (envEnabled ? 'tenant_setting' : 'env'),
      layers: { env: envEnabled, tenant_setting: hiu.enabled === true },
    },
  };
}

async function uhiGate(tenantId) {
  const envEnabled = UHI_CONFIG.enabled === true;
  const settings = await getUhiSettings(tenantId);
  const effective = envEnabled && settings.enabled === true;
  return {
    effective,
    blocking_layer: effective ? null : (envEnabled ? 'tenant_setting' : 'env'),
    layers: { env: envEnabled, tenant_setting: settings.enabled === true },
    environment: settings.environment,
  };
}

async function ambulanceGpsGate(tenantId) {
  const settings = await getAmbulanceGpsTrackingSettings(tenantId);
  return {
    effective: settings.enabled === true,
    blocking_layer: settings.enabled === true ? null : 'tenant_setting',
    layers: { tenant_setting: settings.enabled === true },
    retention_days: settings.retentionDays,
    min_seconds_between_fixes: settings.minSecondsBetweenFixes,
  };
}

// ── analytics_bi (embedded Metabase BI, slate C2) ───────────────────────────
// Self-contained append-style block (wt/bi-app). Two AND-ed layers:
//   env           — METABASE_URL + METABASE_EMBED_SECRET both set
//   tenant_setting— settings.analyticsBi.enabled === true
// Truth reused, not re-derived: the tenant layer is the same
// tenantSettingsService accessor metabaseService.buildEmbedUrl consults; the
// env predicate mirrors its isMetabaseEnvConfigured fail-closed check.
// Per-dashboard METABASE_DASH_* ids are a per-resource config layer surfaced
// as a count in integrationGateEnvFacts (metabase_dashboards_configured),
// not a blocking layer here.
async function analyticsBiGate(tenantId) {
  const envConfigured = metabaseEnvConfigured();
  const settings = await getAnalyticsBiSettings(tenantId);
  const effective = envConfigured && settings.enabled === true;
  return {
    effective,
    blocking_layer: effective ? null : (envConfigured ? 'tenant_setting' : 'env'),
    layers: { env: envConfigured, tenant_setting: settings.enabled === true },
  };
}

async function tenantGates(tenant) {
  const tenantId = tenant.id;
  const [paymentGateway, sms, abdm, uhi, ambulanceGps, paymentSetting, smsSetting, analyticsBi] =
    await Promise.all([
      paymentGatewayGate(tenantId),
      smsGate(tenantId),
      abdmGates(tenantId),
      uhiGate(tenantId),
      ambulanceGpsGate(tenantId),
      getPaymentGatewaySettings(tenantId),
      getSmsSettings(tenantId),
      analyticsBiGate(tenantId),
    ]);
  // Consistency belt: the standalone accessors and the resolver views should
  // agree; the resolver wins, but log if they ever diverge (cache skew).
  if (paymentGateway.layers.tenant_setting !== paymentSetting.enabled
      || sms.layers.tenant_setting !== smsSetting.enabled) {
    logger.warn('integration gates: tenant-setting view divergence', { tenantId });
  }
  return {
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
    },
    gates: {
      payment_gateway: paymentGateway,
      sms,
      ...abdm,
      uhi,
      ambulance_gps: ambulanceGps,
      analytics_bi: analyticsBi,
    },
  };
}

/**
 * Full console read: env facts + per-tenant gate states.
 *
 * @param {{tenantId?: string|null, limit?: number}} [options]
 */
export async function listIntegrationGates({ tenantId = null, limit = 100 } = {}) {
  const { tenants } = await listTenants({ limit });
  const selected = tenantId
    ? tenants.filter((t) => String(t.id) === String(tenantId))
    : tenants;
  const rows = [];
  for (const tenant of selected) {
    rows.push(await tenantGates(tenant));
  }
  return {
    generated_at: new Date().toISOString(),
    env: integrationGateEnvFacts(),
    tenants: rows,
  };
}

export default { listIntegrationGates, integrationGateEnvFacts };
