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
import { isFacilityAssetsEnvEnabled } from '../facility/facilityAssetService.js';
import { isBirthNotificationEnvEnabled } from '../clinical/birthNotificationService.js';
import { isPublicHealthRegistersEnvEnabled } from '../publicHealth/publicHealthService.js';
import { isGstEInvoiceEnvEnabled } from '../billing/gstEInvoiceService.js';
import { isSiemExportSchedulerEnvEnabled } from '../security/siemExportSchedulerService.js';
import { livekitEnabled } from '../telemedicine/teleconsultProvisioningService.js';
import { listTenants } from '../tenant/tenantService.js';
import {
  getAbdmEnrolmentSettings,
  getAbdmHiuSettings,
  getAmbulanceGpsTrackingSettings,
  getAnalyticsBiSettings,
  getFacilityAssetsSettings,
  getBirthNotificationSettings,
  getPublicHealthRegistersSettings,
  getGstEInvoiceSettings,
  getPaymentGatewaySettings,
  getSmsSettings,
  getUhiSettings,
} from '../tenant/tenantSettingsService.js';
// Namespace view of the same module for OPTIONAL accessors added by sibling
// work packages (getLabLoincMappingSettings / getDrugKbSettings). Accessed
// via property lookup so this file loads — and the gates fail closed — both
// before and after those packages merge.
import * as tenantSettingsAccessors from '../tenant/tenantSettingsService.js';
import { isWhoIcdConfigured } from '../terminology/whoIcdClient.js';
import { lisListenerConfigSummaryFromEnv } from './lisListenerConfig.js';

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
    facility_assets_enabled: isFacilityAssetsEnvEnabled(),
    // Reaudit 2026-08-25 forward slate (G1/G2/G3/G4) — env kill switches,
    // presence booleans only. Each ANDs a per-tenant settings flag below.
    birth_notification_enabled: isBirthNotificationEnvEnabled(),
    public_health_registers_enabled: isPublicHealthRegistersEnvEnabled(),
    gst_einvoice_enabled: isGstEInvoiceEnvEnabled(),
    siem_export_scheduler_enabled: isSiemExportSchedulerEnvEnabled(),
    // Read-only env facts (operator/hardware-blocked dark stack).
    livekit_enabled: livekitEnabled(),
    file_scan_policy: resolveFileScanPolicy(),
    clinical_continuity_c_d14_approved: CLINICAL_CONTINUITY_C_D14_APPROVED === true,
    // ── Terminology & knowledge env facts (slate C1; self-contained block) ──
    // Presence booleans / enum names only, never credential values.
    who_icd_configured: isWhoIcdConfigured(),
    terminology_coding_enforcement: normalizeCodingEnforcementEnv(),
    drug_kb_deterministic_matching: knowledgeEnvFlagEnabled('DRUG_KB_DETERMINISTIC_MATCHING'),
    lab_loinc_mapping_enabled: knowledgeEnvFlagEnabled('LAB_LOINC_MAPPING_ENABLED'),
    // Validated non-secret profiles from the same ConfigMap key the gateway
    // consumes. Only the count leaves this service.
    lis_listeners_configured: lisListenerConfigSummaryFromEnv().count,

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

async function facilityAssetsGate(tenantId) {
  const envEnabled = isFacilityAssetsEnvEnabled();
  const settings = await getFacilityAssetsSettings(tenantId);
  const effective = envEnabled && settings.enabled === true;
  return {
    effective,
    blocking_layer: effective ? null : (envEnabled ? 'tenant_setting' : 'env'),
    layers: { env: envEnabled, tenant_setting: settings.enabled === true },
  };
}

// ── Reaudit 2026-08-25 forward slate gates (G1/G2/G3/G4) ────────────────────
// Same two-layer contract as facility_assets: env kill switch AND per-tenant
// settings flag, ANDed, fail-closed. Truth reused from each service's own env
// predicate + the tenantSettingsService accessor it consults.

async function birthNotificationGate(tenantId) {
  const envEnabled = isBirthNotificationEnvEnabled();
  const settings = await getBirthNotificationSettings(tenantId);
  const effective = envEnabled && settings.enabled === true;
  return {
    effective,
    blocking_layer: effective ? null : (envEnabled ? 'tenant_setting' : 'env'),
    layers: { env: envEnabled, tenant_setting: settings.enabled === true },
  };
}

async function publicHealthRegistersGate(tenantId) {
  const envEnabled = isPublicHealthRegistersEnvEnabled();
  const settings = await getPublicHealthRegistersSettings(tenantId);
  const effective = envEnabled && settings.enabled === true;
  return {
    effective,
    blocking_layer: effective ? null : (envEnabled ? 'tenant_setting' : 'env'),
    layers: { env: envEnabled, tenant_setting: settings.enabled === true },
  };
}

async function gstEInvoiceGate(tenantId) {
  const envEnabled = isGstEInvoiceEnvEnabled();
  const settings = await getGstEInvoiceSettings(tenantId);
  const effective = envEnabled && settings.enabled === true;
  return {
    effective,
    blocking_layer: effective ? null : (envEnabled ? 'tenant_setting' : 'env'),
    layers: { env: envEnabled, tenant_setting: settings.enabled === true },
  };
}

// SIEM export delivery (BES-1). The engine and its migrations (448/449/622)
// exist; this gate covers the scheduler wiring added in the forward slate:
// env SIEM_EXPORT_SCHEDULER_ENABLED AND a per-tenant active siem_export_targets
// row (the register IS the per-tenant enable — the console shows no flip
// button, like lis_listeners). The live SIEM endpoint/creds are owner-side.
async function siemExportGate(tenantId) {
  const envEnabled = isSiemExportSchedulerEnvEnabled();
  const activeTargets = await knowledgeContentCount(
    `SELECT COUNT(*)::int AS count
       FROM siem_export_targets
      WHERE tenant_id = $1::uuid AND status = 'active'`,
    tenantId,
  );
  const contentOn = activeTargets > 0;
  const effective = envEnabled && contentOn;
  let blockingLayer = null;
  if (!effective) blockingLayer = !envEnabled ? 'env' : 'provider_config';
  return {
    effective,
    blocking_layer: blockingLayer,
    layers: { env: envEnabled, provider_config: contentOn },
    active_targets: activeTargets,
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

// ── Terminology & knowledge gates (slate C1) ────────────────────────────────
//
// One self-contained block per the shared-file merge rule, so sibling gate
// additions merge cleanly around it. Same three-layer contract as the gates
// above, with one reinterpretation: the "provider_config" layer here means
// IMPORTED CONTENT (concepts / licensed KB source / mapping rows) — a
// terminology feature with no content behaves exactly like a payment gateway
// with no credentials: dark, fail-closed.
//
// Content counts and the WP2/3/4 tenant-settings accessors are resolved
// lazily and defensively. Before those work packages merge (or when the DB
// is unreachable) every check degrades to "absent" and the gate stays dark —
// this console read never throws because a knowledge table is missing.

const TERMINOLOGY_ENFORCEMENT_LEVELS = ['off', 'warn', 'block'];
const TERMINOLOGY_CODING_SURFACES = [
  'death_certificate',
  'insurance_claim',
  'discharge_summary',
];

function normalizeCodingEnforcementEnv() {
  const value = String(process.env.TERMINOLOGY_CODING_ENFORCEMENT || '')
    .trim()
    .toLowerCase();
  return TERMINOLOGY_ENFORCEMENT_LEVELS.includes(value) ? value : 'off';
}

function knowledgeEnvFlagEnabled(name) {
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

/**
 * COUNT(*) helper for the content layer. Prisma is imported lazily so this
 * module's static dependency set is unchanged (existing unit-test mock
 * factories stay valid) and any failure — table not migrated yet, DB down —
 * reads as "no content", never as an error.
 */
async function knowledgeContentCount(sql, ...params) {
  try {
    const mod = await import('../../lib/prisma.js');
    const client = mod.prisma || mod.default;
    const rows = await client.$queryRawUnsafe(sql, ...params);
    return Number(rows?.[0]?.count ?? 0);
  } catch (err) {
    logger.warn('integration gates: knowledge content check failed', { error: err?.message });
    return 0;
  }
}

/** Assemble the standard {effective, reason, blocking_layer, layers} shape. */
function knowledgeGateShape({ env, tenantSetting, contentPresent, reasons, extra = {} }) {
  const effective = env === true && tenantSetting === true && contentPresent === true;
  let reason = null;
  let blockingLayerName = null;
  if (!effective) {
    if (env !== true) {
      reason = reasons.env;
      blockingLayerName = 'env';
    } else if (tenantSetting !== true) {
      reason = reasons.tenant;
      blockingLayerName = 'tenant_setting';
    } else {
      reason = reasons.content;
      blockingLayerName = 'provider_config';
    }
  }
  return {
    effective,
    reason,
    blocking_layer: blockingLayerName,
    layers: {
      env: env === true,
      tenant_setting: tenantSetting === true,
      provider_config: contentPresent === true,
    },
    ...extra,
  };
}

async function terminologyCodingGate(tenant) {
  const envLevel = normalizeCodingEnforcementEnv();
  // Tenant layer lives in tenant_terminology_settings.coding_enforcement
  // (WP2 JSONB, per-surface off|warn|block) — absent pre-merge ⇒ all off.
  let enforcementRaw = {};
  try {
    const mod = await import('../terminology/terminologySettingsService.js');
    const settings = await mod.getTenantTerminologySettings(tenant.id);
    if (settings?.coding_enforcement && typeof settings.coding_enforcement === 'object'
        && !Array.isArray(settings.coding_enforcement)) {
      enforcementRaw = settings.coding_enforcement;
    }
  } catch (err) {
    logger.warn('integration gates: terminology settings read failed', { error: err?.message });
  }
  const enforcement = {};
  for (const surface of TERMINOLOGY_CODING_SURFACES) {
    const level = String(enforcementRaw[surface] || 'off').trim().toLowerCase();
    enforcement[surface] = TERMINOLOGY_ENFORCEMENT_LEVELS.includes(level) ? level : 'off';
  }
  const tenantSetting = Object.values(enforcement).some((level) => level !== 'off');
  // Content layer: ICD-10 is federated into terminology_concepts on day one
  // (migration 275), so a healthy deployment always has active concepts.
  const conceptCount = await knowledgeContentCount(
    `SELECT COUNT(*)::int AS count
       FROM terminology_concepts
      WHERE system_key = 'ICD10' AND status = 'active'`,
  );
  return knowledgeGateShape({
    env: envLevel !== 'off',
    tenantSetting,
    contentPresent: conceptCount > 0,
    reasons: {
      env: 'env_enforcement_off',
      tenant: 'all_surfaces_off',
      content: 'no_concepts_imported',
    },
    extra: { env_level: envLevel, enforcement, concept_count: conceptCount },
  });
}

async function labLoincMappingGate(tenant) {
  const env = knowledgeEnvFlagEnabled('LAB_LOINC_MAPPING_ENABLED');
  // Prefer the WP3 accessor once it exists; fall back to the raw settings
  // JSONB on the tenant row (same disabled-by-default semantics) before then.
  let tenantSetting = tenant?.settings?.labLoincMapping?.enabled === true;
  try {
    if (typeof tenantSettingsAccessors.getLabLoincMappingSettings === 'function') {
      const settings = await tenantSettingsAccessors.getLabLoincMappingSettings(tenant.id);
      tenantSetting = settings?.enabled === true;
    }
  } catch (err) {
    logger.warn('integration gates: lab LOINC mapping settings read failed', { error: err?.message });
  }
  const mappingRows = await knowledgeContentCount(
    `SELECT COUNT(*)::int AS count
       FROM lab_analyzer_code_mappings
      WHERE tenant_id = $1::uuid AND active = true`,
    tenant.id,
  );
  return knowledgeGateShape({
    env,
    tenantSetting,
    contentPresent: mappingRows > 0,
    reasons: {
      env: 'env_disabled',
      tenant: 'tenant_disabled',
      content: 'no_mapping_rows',
    },
    extra: { mapping_rows: mappingRows },
  });
}

async function drugKbGate(tenant) {
  const env = knowledgeEnvFlagEnabled('DRUG_KB_DETERMINISTIC_MATCHING');
  let tenantSetting = tenant?.settings?.drugKb?.deterministicMatching === true;
  let counterSaleAdvisory = tenant?.settings?.drugKb?.counterSaleAdvisory === true;
  try {
    if (typeof tenantSettingsAccessors.getDrugKbSettings === 'function') {
      const settings = await tenantSettingsAccessors.getDrugKbSettings(tenant.id);
      tenantSetting = settings?.deterministicMatching === true;
      counterSaleAdvisory = settings?.counterSaleAdvisory === true;
    }
  } catch (err) {
    logger.warn('integration gates: drug KB settings read failed', { error: err?.message });
  }
  // Content layer: a licensed (non-starter) source must be active. The
  // homegrown starter set alone keeps deterministic matching dark.
  const licensedSources = await knowledgeContentCount(
    `SELECT COUNT(*)::int AS count
       FROM drug_kb_sources
      WHERE is_active = true AND is_starter = false`,
  );
  return knowledgeGateShape({
    env,
    tenantSetting,
    contentPresent: licensedSources > 0,
    reasons: {
      env: 'env_disabled',
      tenant: 'tenant_disabled',
      content: 'no_licensed_source',
    },
    extra: {
      licensed_active_sources: licensedSources,
      counter_sale_advisory: counterSaleAdvisory,
    },
  });
}


// ── lis_listeners (device-gateway LIS analyzer transport; #891 deferral) ────
// Surfaces the dark LIS ingress in the console. Two AND-ed layers mirroring
// the path's real gates:
//   env             — at least one structurally valid listener profile from
//                     the gateway's authoritative ConfigMap is correlated to
//                     this exact tenant slug.
//   provider_config — an active tenant analyzer matches a configured profile's
//                     exact analyzer_code, as required by the ingest path.
// There is no tenants.settings boolean for LIS — per-tenant enablement IS
// the analyzer registry, so the console shows no flip button for this row.
async function lisListenersGate(tenant) {
  const listeners = lisListenerConfigSummaryFromEnv();
  const tenantSlug = String(tenant.slug || '').trim().toLowerCase();
  const tenantProfiles = listeners.profiles.filter(
    profile => profile.tenant_slug === tenantSlug,
  );
  const analyzerCodes = [...new Set(tenantProfiles.map(profile => profile.analyzer_code))];
  const analyzerCount = analyzerCodes.length === 0
    ? 0
    : await knowledgeContentCount(
      `SELECT COUNT(*)::int AS count
         FROM lab_analyzers
        WHERE tenant_id = $1::uuid
          AND status = 'active'
          AND interface_kind IN ('astm', 'hl7')
          AND analyzer_code = ANY($2::text[])`,
      tenant.id,
      analyzerCodes,
    );
  const envOn = tenantProfiles.length > 0;
  const contentOn = analyzerCount > 0;
  const effective = envOn && contentOn;
  let reason = null;
  let blockingLayer = null;
  if (!effective) {
    if (!envOn) {
      if (listeners.invalid) reason = 'listeners_env_invalid';
      else if (listeners.count === 0) reason = 'no_listeners_configured';
      else reason = 'no_tenant_listener_profiles';
      blockingLayer = 'env';
    } else {
      reason = 'no_matching_active_interface_analyzers';
      blockingLayer = 'provider_config';
    }
  }
  return {
    effective,
    reason,
    blocking_layer: blockingLayer,
    layers: { env: envOn, provider_config: contentOn },
    listeners_configured: tenantProfiles.length,
    active_interface_analyzers: analyzerCount,
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
  const [
    paymentGateway, sms, abdm, uhi, ambulanceGps, facilityAssets,
    paymentSetting, smsSetting, analyticsBi,
  ] =
    await Promise.all([
      paymentGatewayGate(tenantId),
      smsGate(tenantId),
      abdmGates(tenantId),
      uhiGate(tenantId),
      ambulanceGpsGate(tenantId),
      facilityAssetsGate(tenantId),
      getPaymentGatewaySettings(tenantId),
      getSmsSettings(tenantId),
      analyticsBiGate(tenantId),
    ]);
  // Terminology & knowledge gates (slate C1) — separate await so the block
  // above keeps its positional destructure untouched for sibling merges.
  const [terminologyCoding, labLoincMapping, drugKb, lisListeners] = await Promise.all([
    terminologyCodingGate(tenant),
    labLoincMappingGate(tenant),
    drugKbGate(tenant),
    lisListenersGate(tenant),
  ]);
  // Reaudit 2026-08-25 forward slate (G1/G2/G3/G4) — separate await so the
  // blocks above keep their positional destructure untouched for sibling merges.
  const [birthNotification, publicHealthRegisters, gstEInvoice, siemExport] = await Promise.all([
    birthNotificationGate(tenantId),
    publicHealthRegistersGate(tenantId),
    gstEInvoiceGate(tenantId),
    siemExportGate(tenantId),
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
      facility_assets: facilityAssets,
      // Terminology & knowledge gates (slate C1; appended block).
      terminology_coding: terminologyCoding,
      lab_loinc_mapping: labLoincMapping,
      drug_kb: drugKb,
      // Device-gateway LIS analyzer transport (#891 deferral).
      lis_listeners: lisListeners,

      analytics_bi: analyticsBi,
      // Reaudit 2026-08-25 forward slate (G1/G2/G3/G4).
      birth_notification: birthNotification,
      public_health_registers: publicHealthRegisters,
      gst_einvoice: gstEInvoice,
      siem_export: siemExport,
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
