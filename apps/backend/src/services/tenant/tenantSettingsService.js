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
  const tenant = await getTenantById(tenantId).catch(() => null);
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
