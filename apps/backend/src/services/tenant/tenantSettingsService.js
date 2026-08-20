// Typed read path for per-tenant configuration stored in `tenants.settings`
// (jsonb). Reuses the 60s in-memory tenant cache in tenantService — callers do
// NOT hit the DB on every read. All accessors are defensive: a missing tenant,
// null settings, or a DB error yields the empty default, never a throw, so a
// per-tenant override is always a pure enhancement over the hardcoded baseline.
//
// `tenants.settings` shape (every key optional):
//   {
//     rateLimits?: { <profile>: { windowMs?: number, max?: number } },
//     branding?:   { name?, logoUrl?, primaryColor?, supportEmail?, legalName?,
//                    legalFooter?, helpCenterUrl?, document?, email?, assets? },
//     cache?:      { enabledRoutes?: string[] },
//     notificationChannels?: {
//       appointment_reminder?: ('push'|'sms'|'whatsapp'|'voice'|'email'|'inapp'|'print')[],
//       results_ready?:        ('push'|'sms'|'whatsapp'|'voice'|'email'|'inapp'|'print')[],
//     },
//     teleconsultPayments?: {
//       enabled?: boolean,
//       channels?: ('sms'|'whatsapp'|'email')[],
//       expiresInHours?: number,
//     },
//     biometricCapture?: {
//       frontDeskRegistration?: {
//         enabled?: boolean,
//         modes?: ('face'|'fingerprint'|'iris')[],
//         provider?: string,
//       },
//     },
//     ambulanceGpsTracking?: {
//       enabled?: boolean,                // default false — no GPS devices yet
//       retentionDays?: number,           // position-event retention (1-90, default 7)
//       minSecondsBetweenFixes?: number,  // per-reporter ingest floor (1-300, default 3)
//     },
//     paymentGateway?: {
//       enabled?: boolean,                // default false — online gateway (UPI/cards).
//                                         // Effective only with PAYMENT_GATEWAY_ENABLED=true
//                                         // AND an enabled payment_gateway_provider_configs row.
//     },
//     sms?: {
//       enabled?: boolean,                // default false — real SMS gateway sends.
//                                         // Effective only when SMS_PROVIDER is not the
//                                         // 'logger' kill switch AND an enabled
//                                         // sms_provider_configs row (or complete env
//                                         // credentials) exists; otherwise dry-run.
//     },
//     abdmEnrolment?: {
//       enabled?: boolean,                // default false — ABHA enrolment flows
//                                         // (Aadhaar-OTP/mobile-OTP). Effective only
//                                         // with ABDM_ENABLED=true; sandbox unless
//                                         // ABDM_ENVIRONMENT=production.
//     },
//     abdmHiu?: {
//       enabled?: boolean,                // default false — thin HIU consent/fetch
//                                         // legs. Effective only with ABDM_ENABLED=true.
//     },
//     uhi?: {
//       enabled?: boolean,                // default false — UHI (DHP/beckn) network
//                                         // adapter webhook legs. Effective only with
//                                         // UHI_ENABLED=true; sandbox unless
//                                         // environment: 'production'.
//       environment?: 'sandbox'|'production',
//     },
//     nhcx?: {
//       enabled?: boolean,
//       environment?: 'sandbox'|'production',
//       participantCode?: string,
//       counterpartyParticipantCode?: string,
//       gatewayBaseUrls?: { sandbox?: string, production?: string },
//     },
//     cathQuickWins?: {                     // NL-13 P1e owner-decision inert slots
//       consent?: { consentType?: string }, // patient_consents.consent_type that counts as cath consent
//       orderSets?: {                       // clinical_order_sets.family_key per workbench slot
//         preCathFamilyKey?: string,
//         postCathFamilyKey?: string,
//       },
//       followUp?: {                        // procedure-type -> loop-template mappings
//         templates?: Array<{
//           templateKey: string,            // stable identifier, <= 80 chars
//           title: string,                  // owner-authored staff task title
//           description?: string,           // owner-authored staff task body
//           procedureTypes: string[],       // exact cath_procedure_logs.procedure_type matches
//           offsetDays?: number,            // due offset from completion (0-365, default 0)
//           staffTaskRole?: string,         // tasks.assigned_to_role fallback (default DOCTOR)
//           enabled?: boolean,              // default true; false disables the mapping
//         }>,
//       },
//     },
//   }
import { getTenantById } from './tenantService.js';
import { normalizeBrandKit } from './brandKitSchema.js';

export async function getTenantSettings(tenantId) {
  if (!tenantId) return {};
  const tenant = await getTenantById(tenantId);
  const settings = tenant?.settings;
  return settings && typeof settings === 'object' ? settings : {};
}

export async function getRateLimitOverride(tenantId, profile) {
  const settings = await getTenantSettings(tenantId);
  const override = settings.rateLimits?.[profile];
  return override && typeof override === 'object' ? override : null;
}

export async function getBranding(tenantId) {
  const settings = await getTenantSettings(tenantId);
  return normalizeBrandKit(settings.branding);
}

const CATH_QUICK_WIN_SLOTS = ['pre_cath', 'post_cath'];

function cleanSettingText(value, max = 160) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

// NL-13 P1e owner-decision inert slots. Defensive like every accessor here:
// missing/malformed config yields the disabled default (null slots, empty
// template list) so cath quick-wins stay inert until the owner publishes
// valid mappings. Never throws.
export async function getCathQuickWinSettings(tenantId) {
  const settings = await getTenantSettings(tenantId);
  const raw = settings.cathQuickWins;
  const empty = {
    consentType: null,
    orderSetFamilies: { pre_cath: null, post_cath: null },
    followUpTemplates: [],
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;

  const consentType = cleanSettingText(raw.consent?.consentType, 100);

  const orderSetFamilies = { pre_cath: null, post_cath: null };
  const rawSets = raw.orderSets;
  if (rawSets && typeof rawSets === 'object' && !Array.isArray(rawSets)) {
    orderSetFamilies.pre_cath = cleanSettingText(rawSets.preCathFamilyKey, 80);
    orderSetFamilies.post_cath = cleanSettingText(rawSets.postCathFamilyKey, 80);
  }

  const followUpTemplates = [];
  const rawTemplates = raw.followUp?.templates;
  if (Array.isArray(rawTemplates)) {
    for (const entry of rawTemplates) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      if (entry.enabled === false) continue;
      const templateKey = cleanSettingText(entry.templateKey, 80);
      const title = cleanSettingText(entry.title, 200);
      const procedureTypes = Array.isArray(entry.procedureTypes)
        ? entry.procedureTypes
          .map((type) => cleanSettingText(type, 120))
          .filter((type) => type !== null)
          .map((type) => type.toLowerCase())
        : [];
      // A mapping without a key, owner-authored title, or explicit procedure
      // list cannot trigger anything — drop it rather than guessing.
      if (!templateKey || !title || !procedureTypes.length) continue;
      if (followUpTemplates.some((tpl) => tpl.templateKey === templateKey)) continue;
      const offsetParsed = Number.parseInt(entry.offsetDays, 10);
      followUpTemplates.push({
        templateKey,
        title,
        description: cleanSettingText(entry.description, 2000),
        procedureTypes,
        offsetDays: Number.isFinite(offsetParsed) && offsetParsed >= 0 && offsetParsed <= 365
          ? offsetParsed
          : 0,
        staffTaskRole: cleanSettingText(entry.staffTaskRole, 80) || 'DOCTOR',
      });
    }
  }

  return { consentType, orderSetFamilies, followUpTemplates };
}

export { CATH_QUICK_WIN_SLOTS };

// Ambulance live GPS tracking (migration 683). Disabled by default — the
// hospital has no GPS devices yet; the feature turns on per tenant via a
// settings write the day devices arrive. Defensive like every accessor here:
// malformed config yields the disabled default, never a throw.
export async function getAmbulanceGpsTrackingSettings(tenantId) {
  const settings = await getTenantSettings(tenantId);
  const raw = settings.ambulanceGpsTracking;
  const defaults = { enabled: false, retentionDays: 7, minSecondsBetweenFixes: 3 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  const retentionParsed = Number.parseInt(raw.retentionDays, 10);
  const intervalParsed = Number.parseInt(raw.minSecondsBetweenFixes, 10);
  return {
    enabled: raw.enabled === true,
    retentionDays: Number.isFinite(retentionParsed) && retentionParsed >= 1 && retentionParsed <= 90
      ? retentionParsed
      : defaults.retentionDays,
    minSecondsBetweenFixes: Number.isFinite(intervalParsed) && intervalParsed >= 1 && intervalParsed <= 300
      ? intervalParsed
      : defaults.minSecondsBetweenFixes,
  };
}

// Online payment gateway (migrations 693-697). Disabled by default — turning
// the feature on is a settings write + provider config row, never a
// migration. Effective enablement additionally requires the
// PAYMENT_GATEWAY_ENABLED env kill switch and an enabled provider config
// (paymentGatewayService.resolveGatewayContext ANDs all three). Defensive
// like every accessor here: malformed config yields the disabled default,
// never a throw.
export async function getPaymentGatewaySettings(tenantId) {
  const settings = await getTenantSettings(tenantId);
  const raw = settings.paymentGateway;
  const defaults = { enabled: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  return { enabled: raw.enabled === true };
}

// SMS gateway (migrations 699/700). Disabled by default — the outbox drain
// resolves every tenant to the dry-run logger until this settings write AND a
// provider config row (or complete env credentials) exist; SMS_PROVIDER=logger
// remains the deployment-wide kill switch
// (smsProviders/index.js:resolveSmsProviderContext ANDs all of it). Defensive
// like every accessor here: malformed config yields the disabled default,
// never a throw.
export async function getSmsSettings(tenantId) {
  const settings = await getTenantSettings(tenantId);
  const raw = settings.sms;
  const defaults = { enabled: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  return { enabled: raw.enabled === true };
}

// ABHA enrolment (migration 701). Disabled by default — enrolment reaches the
// national ABDM sandbox/production gateway, so it turns on per tenant via a
// settings write only after the deployment sets ABDM_ENABLED and the operator
// decides. Defensive like every accessor here: malformed config yields the
// disabled default, never a throw.
export async function getAbdmEnrolmentSettings(tenantId) {
  const settings = await getTenantSettings(tenantId);
  const raw = settings.abdmEnrolment;
  const defaults = { enabled: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  return { enabled: raw.enabled === true };
}

// Thin HIU legs (migration 703 + the 124 abdmFull consent layer). Disabled by
// default — same posture as abdmEnrolment. Defensive: malformed config yields
// the disabled default, never a throw.
export async function getAbdmHiuSettings(tenantId) {
  const settings = await getTenantSettings(tenantId);
  const raw = settings.abdmHiu;
  const defaults = { enabled: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  return { enabled: raw.enabled === true };
}

// UHI (Unified Health Interface / DHP-beckn) adapter (migration 705).
// Disabled by default — the webhook legs answer the national UHI network, so
// a tenant opts in via a settings write only after the deployment sets
// UHI_ENABLED (env is the kill switch, this is the per-hospital enable).
// Defensive like every accessor here: malformed config yields the disabled
// defaults, never a throw.
export async function getUhiSettings(tenantId) {
  const settings = await getTenantSettings(tenantId);
  const raw = settings.uhi;
  const defaults = { enabled: false, environment: 'sandbox' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  return {
    enabled: raw.enabled === true,
    environment: raw.environment === 'production' ? 'production' : 'sandbox',
  };
}

// Drug-KB adapter flags (migration 722, terminology slate C1/WP4). Both
// disabled by default and BOTH additionally require the deployment-wide
// DRUG_KB_DETERMINISTIC_MATCHING env kill switch (drugKbLinkService ANDs it):
//   deterministicMatching — resolve prescription meds to KB drug keys via
//     drug_kb_catalog_links / ATC bindings / composition ingredients instead
//     of name-substring only. Off ⇒ the substring path is byte-identical.
//   counterSaleAdvisory — fail-OPEN advisory DDI screen on OTC counter sales
//     (warnings in the response, never blocks or fails a sale).
// Defensive like every accessor here: malformed config yields the disabled
// defaults, never a throw.
export async function getDrugKbSettings(tenantId) {
  const settings = await getTenantSettings(tenantId);
  const raw = settings.drugKb;
  const defaults = { deterministicMatching: false, counterSaleAdvisory: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  return {
    deterministicMatching: raw.deterministicMatching === true,
    counterSaleAdvisory: raw.counterSaleAdvisory === true,
  };
}

export async function getFrontDeskBiometricCaptureSettings(tenantId) {
  const settings = await getTenantSettings(tenantId);
  const raw = settings.biometricCapture?.frontDeskRegistration;
  if (!raw || typeof raw !== 'object') {
    return { enabled: false, modes: [], provider: null };
  }
  const modes = Array.isArray(raw.modes)
    ? raw.modes
      .map((mode) => String(mode || '').trim().toLowerCase())
      .filter((mode) => ['face', 'fingerprint', 'iris'].includes(mode))
    : [];
  return {
    enabled: raw.enabled === true,
    modes,
    provider: raw.provider ? String(raw.provider).trim() || null : null,
  };
}

// Lab analyzer-code → LOINC mapping enrichment (migration 721). Disabled by
// default — a tenant opts in via a settings write once its analyzer code
// mappings are curated. Effective enablement additionally requires the
// LAB_LOINC_MAPPING_ENABLED env kill switch AND curated active mapping rows
// (labCodeMappingService.resolveLabLoincMappingGate ANDs env + tenant; no
// rows means the resolver simply never matches). Defensive like every
// accessor here: malformed config yields the disabled default, never a
// throw.
export async function getLabLoincMappingSettings(tenantId) {
  const settings = await getTenantSettings(tenantId);
  const raw = settings.labLoincMapping;
  const defaults = { enabled: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  return { enabled: raw.enabled === true };
}
