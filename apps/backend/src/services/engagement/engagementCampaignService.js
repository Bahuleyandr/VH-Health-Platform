import crypto from 'node:crypto';
import prisma, { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';

export const CAMPAIGN_TYPES = Object.freeze([
  'appointment_recall',
  'no_show_recall',
  'feedback_nps_request',
  'generic_follow_up_reminder',
  'rpm_enrollment_reminder',
]);

export const ENGAGEMENT_CHANNELS = Object.freeze(['push', 'sms', 'whatsapp', 'email', 'inapp']);

export const ENGAGEMENT_CONSENT_TYPES = Object.freeze([
  'marketing_whatsapp',
  'care_reminder_whatsapp',
  'rpm_monitoring',
  'nps_survey',
  'teleconsult_followup',
]);

export const TEMPLATE_ALLOWED_VARIABLES = Object.freeze([
  'first_name',
  'salutation',
  'appointment_window',
  'department_name',
  'clinic_name',
  'call_to_action_url',
  'support_phone',
  'campaign_token',
  'feedback_link',
  'tenant_name',
]);

const DEFAULT_CONSENT_MAP = Object.freeze({
  appointment_recall: 'care_reminder_whatsapp',
  no_show_recall: 'care_reminder_whatsapp',
  feedback_nps_request: 'nps_survey',
  generic_follow_up_reminder: 'teleconsult_followup',
  rpm_enrollment_reminder: 'rpm_monitoring',
});

const BROAD_APPROVAL_ROLES = new Set([
  'SUPER_ADMIN',
  'ADMIN',
  'QUALITY_OFFICER',
  'CMO',
  'CNO',
  'MEDICAL_SUPERINTENDENT',
]);

const CARE_TEAM_APPROVAL_ROLES = new Set([
  ...BROAD_APPROVAL_ROLES,
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT',
  'NURSING_INCHARGE',
  'OP_INCHARGE',
  'IP_INCHARGE',
]);

const BLOCKED_VARIABLE_RE = /(diagnosis|medication|medicine|drug|lab|result|hba1c|note|transcript|ward|bed|location|ai|compliance|clinician|doctor_note|nps_comment)/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonReady(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => jsonReady(entry));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonReady(entry)]));
  }
  return value;
}

function requireTenantId(tenantId) {
  const value = String(tenantId || '').trim();
  if (!UUID_RE.test(value)) {
    throw AppError.badRequest('Tenant context is required', 'ENGAGEMENT_TENANT_REQUIRED');
  }
  return value;
}

function uuidOrNull(value) {
  const text = String(value || '').trim();
  return UUID_RE.test(text) ? text : null;
}

function nonEmptyText(value, field, max = 2000) {
  const text = String(value || '').trim();
  if (!text) throw AppError.badRequest(`${field} is required`, 'ENGAGEMENT_FIELD_REQUIRED', { field });
  return text.slice(0, max);
}

function optionalText(value, max = 2000) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}

function normalizeCampaignType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!CAMPAIGN_TYPES.includes(type)) {
    throw AppError.badRequest('Unsupported engagement campaign type', 'ENGAGEMENT_BAD_CAMPAIGN_TYPE', {
      allowed: CAMPAIGN_TYPES,
    });
  }
  return type;
}

function normalizeChannel(value) {
  const channel = String(value || '').trim().toLowerCase();
  if (!ENGAGEMENT_CHANNELS.includes(channel)) {
    throw AppError.badRequest('Unsupported engagement channel', 'ENGAGEMENT_BAD_CHANNEL', {
      allowed: ENGAGEMENT_CHANNELS,
    });
  }
  return channel;
}

function normalizeChannels(value, fallback = []) {
  const raw = Array.isArray(value) ? value : fallback;
  const channels = [];
  const seen = new Set();
  for (const entry of raw) {
    const channel = normalizeChannel(entry);
    if (!seen.has(channel)) {
      seen.add(channel);
      channels.push(channel);
    }
  }
  if (!channels.length) {
    throw AppError.badRequest('At least one engagement channel is required', 'ENGAGEMENT_CHANNEL_REQUIRED');
  }
  return channels;
}

function integerOrDefault(value, fallback, { min = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.trunc(parsed));
}

function objectOrDefault(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map((entry) => stableJson(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJson(value[key])]),
  );
}

function hashCohortSource(source) {
  return crypto.createHash('sha256').update(JSON.stringify(stableJson(source || {}))).digest('hex');
}

function timeToMinutes(value, fallback) {
  const text = String(value || fallback || '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  return Math.min(23, Number(match[1])) * 60 + Math.min(59, Number(match[2]));
}

function isInsideQuietHours(at, settings) {
  const date = at instanceof Date ? at : new Date(at || Date.now());
  const current = date.getHours() * 60 + date.getMinutes();
  const start = timeToMinutes(settings.quiet_hours_start, '21:00');
  const end = timeToMinutes(settings.quiet_hours_end, '08:00');
  if (start === end) return false;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

function defaultSettings(tenantId) {
  return {
    tenant_id: tenantId,
    enabled: false,
    emergency_stop: false,
    quiet_hours_start: '21:00',
    quiet_hours_end: '08:00',
    tenant_daily_cap: 250,
    per_patient_cooldown_hours: 48,
    consent_max_age_days: 365,
    channel_caps: { sms: 100, whatsapp: 100, push: 250, email: 100, inapp: 250 },
    default_consent_map: { ...DEFAULT_CONSENT_MAP },
    acceptance_snapshot: null,
  };
}

function normalizeSettings(row, tenantId) {
  if (!row) return defaultSettings(tenantId);
  return {
    ...defaultSettings(tenantId),
    ...jsonReady(row),
    tenant_daily_cap: integerOrDefault(row.tenant_daily_cap, 250),
    per_patient_cooldown_hours: integerOrDefault(row.per_patient_cooldown_hours, 48),
    consent_max_age_days: integerOrDefault(row.consent_max_age_days, 365, { min: 1 }),
    channel_caps: objectOrDefault(row.channel_caps, {}),
    default_consent_map: {
      ...DEFAULT_CONSENT_MAP,
      ...objectOrDefault(row.default_consent_map, {}),
    },
  };
}

export function normalizeAllowedVariables(value) {
  const input = Array.isArray(value) ? value : [];
  const allowed = [];
  const seen = new Set();
  for (const raw of input) {
    const key = String(raw || '').trim();
    if (!key) continue;
    if (!TEMPLATE_ALLOWED_VARIABLES.includes(key) || BLOCKED_VARIABLE_RE.test(key)) {
      throw AppError.badRequest('Template variable is not allowed for engagement outreach', 'ENGAGEMENT_TEMPLATE_VARIABLE_BLOCKED', {
        variable: key,
      });
    }
    if (!seen.has(key)) {
      seen.add(key);
      allowed.push(key);
    }
  }
  return allowed;
}

export function sanitizeTemplateVariables(variables = {}, allowedVariables = TEMPLATE_ALLOWED_VARIABLES) {
  const source = objectOrDefault(variables, {});
  const allowedSet = new Set(allowedVariables);
  const cleaned = {};

  for (const [key, value] of Object.entries(source)) {
    if (!allowedSet.has(key) || BLOCKED_VARIABLE_RE.test(key)) {
      throw AppError.badRequest('Template variable is not allowed for engagement outreach', 'ENGAGEMENT_TEMPLATE_VARIABLE_BLOCKED', {
        variable: key,
      });
    }
    const text = String(value ?? '').trim();
    if (BLOCKED_VARIABLE_RE.test(text)) {
      throw AppError.badRequest('Template variable value contains disallowed clinical content', 'ENGAGEMENT_TEMPLATE_VALUE_BLOCKED', {
        variable: key,
      });
    }
    cleaned[key] = text.slice(0, 500);
  }

  return cleaned;
}

export function renderTemplateString(template, variables = {}) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => (
    Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : ''
  ));
}

async function loadEngagementSettings(tx, tenantId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT tenant_id, enabled, enabled_at, enabled_by, acceptance_snapshot,
            emergency_stop, quiet_hours_start::text, quiet_hours_end::text,
            tenant_daily_cap, per_patient_cooldown_hours, consent_max_age_days,
            channel_caps, default_consent_map, created_at, updated_at
       FROM engagement_settings
      WHERE tenant_id = $1::uuid`,
    tenantId,
  );
  return normalizeSettings(rows[0], tenantId);
}

function requiredConsentType(campaign, settings) {
  const map = objectOrDefault(campaign.rate_policy?.consent_map, settings.default_consent_map);
  const consentType = String(map[campaign.campaign_type] || DEFAULT_CONSENT_MAP[campaign.campaign_type] || '').trim();
  if (!ENGAGEMENT_CONSENT_TYPES.includes(consentType)) {
    throw AppError.badRequest('Campaign required consent type is not an NL9 engagement consent type', 'ENGAGEMENT_BAD_CONSENT_TYPE');
  }
  return consentType;
}

async function auditCampaignTransition({ tenantId, actorUid, actorRole, campaignId, previousStatus, nextStatus, reason }) {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO audit_logs
         (uid, role, action, resource, resource_id, metadata, created_at)
       VALUES ($1::uuid, $2, 'ENGAGEMENT_CAMPAIGN_STATUS_CHANGED', 'engagement_campaign',
               $3, $4::jsonb, NOW())`,
      uuidOrNull(actorUid),
      actorRole || null,
      String(campaignId),
      JSON.stringify({ tenant_id: tenantId, previous_status: previousStatus, next_status: nextStatus, reason: reason || null }),
    );
  } catch (err) {
    logger.warn('Engagement campaign audit write failed', { campaignId, error: err?.message });
  }
}

export async function getEngagementSettings(tenantId) {
  const tid = requireTenantId(tenantId);
  return setTenant(tid, (tx) => loadEngagementSettings(tx, tid), { readOnly: true });
}

export async function upsertEngagementSettings(tenantId, patch = {}, actorUid = null) {
  const tid = requireTenantId(tenantId);
  const enabled = patch.enabled === true;
  if (enabled && !patch.acceptance_snapshot && !patch.acceptanceSnapshot) {
    throw AppError.badRequest('acceptance_snapshot is required when enabling engagement', 'ENGAGEMENT_ACCEPTANCE_REQUIRED');
  }

  const snapshot = patch.acceptance_snapshot ?? patch.acceptanceSnapshot ?? null;
  const rows = await setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
    `INSERT INTO engagement_settings
       (tenant_id, enabled, enabled_at, enabled_by, acceptance_snapshot,
        emergency_stop, quiet_hours_start, quiet_hours_end, tenant_daily_cap,
        per_patient_cooldown_hours, consent_max_age_days, channel_caps,
        default_consent_map, updated_at)
     VALUES (
       $1::uuid,
       $2,
       CASE WHEN $2 THEN NOW() ELSE NULL END,
       CASE WHEN $2 THEN $3::uuid ELSE NULL END,
       CASE WHEN $2 THEN $4::jsonb ELSE NULL END,
       $5,
       $6::time,
       $7::time,
       $8::int,
       $9::int,
       $10::int,
       $11::jsonb,
       $12::jsonb,
       NOW()
     )
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = $2,
       enabled_at = CASE WHEN $2 THEN NOW() ELSE engagement_settings.enabled_at END,
       enabled_by = CASE WHEN $2 THEN $3::uuid ELSE engagement_settings.enabled_by END,
       acceptance_snapshot = CASE WHEN $2 THEN $4::jsonb ELSE engagement_settings.acceptance_snapshot END,
       emergency_stop = $5,
       quiet_hours_start = $6::time,
       quiet_hours_end = $7::time,
       tenant_daily_cap = $8::int,
       per_patient_cooldown_hours = $9::int,
       consent_max_age_days = $10::int,
       channel_caps = $11::jsonb,
       default_consent_map = $12::jsonb,
       updated_at = NOW()
     RETURNING tenant_id, enabled, enabled_at, enabled_by, acceptance_snapshot,
               emergency_stop, quiet_hours_start::text, quiet_hours_end::text,
               tenant_daily_cap, per_patient_cooldown_hours, consent_max_age_days,
               channel_caps, default_consent_map, created_at, updated_at`,
    tid,
    enabled,
    uuidOrNull(actorUid),
    snapshot == null ? null : JSON.stringify(snapshot),
    patch.emergency_stop === true || patch.emergencyStop === true,
    optionalText(patch.quiet_hours_start ?? patch.quietHoursStart, 5) || '21:00',
    optionalText(patch.quiet_hours_end ?? patch.quietHoursEnd, 5) || '08:00',
    integerOrDefault(patch.tenant_daily_cap ?? patch.tenantDailyCap, 250),
    integerOrDefault(patch.per_patient_cooldown_hours ?? patch.perPatientCooldownHours, 48),
    integerOrDefault(patch.consent_max_age_days ?? patch.consentMaxAgeDays, 365, { min: 1 }),
    JSON.stringify(objectOrDefault(patch.channel_caps ?? patch.channelCaps, defaultSettings(tid).channel_caps)),
    JSON.stringify({
      ...DEFAULT_CONSENT_MAP,
      ...objectOrDefault(patch.default_consent_map ?? patch.defaultConsentMap, {}),
    }),
  ));

  return normalizeSettings(rows[0], tid);
}

export async function createEngagementTemplate(tenantId, input = {}, actorUid = null) {
  const tid = requireTenantId(tenantId);
  const templateKind = normalizeCampaignType(input.template_kind ?? input.templateKind);
  const channel = normalizeChannel(input.channel);
  const notificationTemplateId = integerOrDefault(input.notification_template_id ?? input.notificationTemplateId, 0, { min: 0 });
  if (!notificationTemplateId) {
    throw AppError.badRequest('notification_template_id is required', 'ENGAGEMENT_NOTIFICATION_TEMPLATE_REQUIRED');
  }

  const schema = objectOrDefault(input.variables_schema ?? input.variablesSchema, {});
  const allowedVariables = normalizeAllowedVariables(input.allowed_variables ?? input.allowedVariables ?? schema.allowed ?? []);
  const phiClassification = String(input.phi_classification ?? input.phiClassification ?? 'minimal').trim().toLowerCase();
  if (phiClassification === 'phi_prohibited') {
    throw AppError.badRequest('Engagement templates cannot be marked phi_prohibited', 'ENGAGEMENT_TEMPLATE_PHI_PROHIBITED');
  }

  const rows = await setTenantTx(tid, async (tx) => {
    const copyRows = await tx.$queryRawUnsafe(
      `SELECT id FROM notification_templates WHERE id = $1::int LIMIT 1`,
      notificationTemplateId,
    );
    if (!copyRows.length) {
      throw AppError.notFound('Notification template not found', 'ENGAGEMENT_NOTIFICATION_TEMPLATE_NOT_FOUND');
    }

    return tx.$queryRawUnsafe(
      `INSERT INTO engagement_templates
         (tenant_id, notification_template_id, template_kind, channel,
          variables_schema, allowed_variables, phi_classification, locale,
          approved_by, approved_at, created_by, updated_at)
       VALUES (
         $1::uuid, $2::int, $3, $4, $5::jsonb, $6::text[], $7, $8,
         $9::uuid, CASE WHEN $10 THEN NOW() ELSE NULL END, $9::uuid, NOW()
       )
       RETURNING id, tenant_id, notification_template_id, template_kind, channel,
                 variables_schema, allowed_variables, phi_classification, locale,
                 approved_by, approved_at, retired_at, created_by, created_at, updated_at`,
      tid,
      notificationTemplateId,
      templateKind,
      channel,
      JSON.stringify({ ...schema, allowed: allowedVariables }),
      allowedVariables,
      phiClassification,
      optionalText(input.locale, 20) || 'en-IN',
      uuidOrNull(actorUid),
      input.approved !== false,
    );
  });

  return jsonReady(rows[0]);
}

async function loadCampaignContext(tx, tenantId, campaignId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT c.id, c.tenant_id, c.campaign_type, c.objective, c.status,
            c.template_id, c.channels, c.schedule_policy, c.rate_policy,
            c.audience_kind, c.approval_required_role, c.created_by,
            c.submitted_at, c.approved_by, c.approved_at, c.scheduled_at,
            c.frozen_audience_hash, c.current_audience_snapshot_id,
            et.channel AS template_channel, et.allowed_variables,
            et.phi_classification, et.approved_at AS template_approved_at,
            nt.title_template, nt.message_template, nt.type AS notification_type
       FROM engagement_campaigns c
       JOIN engagement_templates et
         ON et.id = c.template_id
        AND et.tenant_id = c.tenant_id
       JOIN notification_templates nt
         ON nt.id = et.notification_template_id
      WHERE c.tenant_id = $1::uuid
        AND c.id = $2::bigint
      LIMIT 1`,
    tenantId,
    campaignId,
  );
  if (!rows.length) throw AppError.notFound('Engagement campaign not found', 'ENGAGEMENT_CAMPAIGN_NOT_FOUND');
  const campaign = jsonReady(rows[0]);
  campaign.rate_policy = objectOrDefault(campaign.rate_policy, {});
  campaign.schedule_policy = objectOrDefault(campaign.schedule_policy, {});
  return campaign;
}

export async function createEngagementCampaign(tenantId, input = {}, actorUid = null) {
  const tid = requireTenantId(tenantId);
  const campaignType = normalizeCampaignType(input.campaign_type ?? input.campaignType);
  const templateId = integerOrDefault(input.template_id ?? input.templateId, 0, { min: 0 });
  if (!templateId) throw AppError.badRequest('template_id is required', 'ENGAGEMENT_TEMPLATE_REQUIRED');

  const rows = await setTenantTx(tid, async (tx) => {
    const templates = await tx.$queryRawUnsafe(
      `SELECT id, template_kind, channel, approved_at, retired_at
         FROM engagement_templates
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
        LIMIT 1`,
      tid,
      templateId,
    );
    const template = templates[0];
    if (!template || template.retired_at) {
      throw AppError.notFound('Engagement template not found', 'ENGAGEMENT_TEMPLATE_NOT_FOUND');
    }
    if (!template.approved_at) {
      throw AppError.badRequest('Engagement template must be approved before campaign use', 'ENGAGEMENT_TEMPLATE_NOT_APPROVED');
    }
    if (String(template.template_kind) !== campaignType) {
      throw AppError.badRequest('Template kind does not match campaign type', 'ENGAGEMENT_TEMPLATE_KIND_MISMATCH');
    }

    const channels = normalizeChannels(input.channels, [template.channel]);
    const audienceKind = String(input.audience_kind ?? input.audienceKind ?? 'cohort').trim().toLowerCase();
    const approvalRequiredRole = audienceKind === 'broad' ? 'admin_quality' : 'care_team';

    return tx.$queryRawUnsafe(
      `INSERT INTO engagement_campaigns
         (tenant_id, campaign_type, objective, template_id, channels,
          schedule_policy, rate_policy, audience_kind, approval_required_role,
          created_by, scheduled_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::bigint, $5::text[], $6::jsonb, $7::jsonb,
               $8, $9, $10::uuid, $11::timestamptz, NOW())
       RETURNING id, tenant_id, campaign_type, objective, status, template_id,
                 channels, schedule_policy, rate_policy, audience_kind,
                 approval_required_role, created_by, scheduled_at, created_at, updated_at`,
      tid,
      campaignType,
      nonEmptyText(input.objective, 'objective', 1000),
      templateId,
      channels,
      JSON.stringify(objectOrDefault(input.schedule_policy ?? input.schedulePolicy, {})),
      JSON.stringify(objectOrDefault(input.rate_policy ?? input.ratePolicy, {})),
      audienceKind === 'broad' ? 'broad' : 'cohort',
      approvalRequiredRole,
      uuidOrNull(actorUid),
      input.scheduled_at ?? input.scheduledAt ?? null,
    );
  });

  return jsonReady(rows[0]);
}

async function insertAudienceSnapshot(tx, { tenantId, campaignId, kind, source, counts, actorUid }) {
  const sourceBody = objectOrDefault(source, {});
  const cohortHash = hashCohortSource(sourceBody);
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO engagement_audience_snapshots
       (tenant_id, campaign_id, snapshot_kind, cohort_source, cohort_hash,
        materialized_count, eligible_count, suppressed_count, source_tables,
        minimum_cohort_size, created_by)
     VALUES ($1::uuid, $2::bigint, $3, $4::jsonb, $5, $6::int, $7::int,
             $8::int, $9::text[], $10::int, $11::uuid)
     RETURNING id, tenant_id, campaign_id, snapshot_kind, cohort_source,
               cohort_hash, materialized_count, eligible_count,
               suppressed_count, source_tables, minimum_cohort_size,
               created_by, created_at`,
    tenantId,
    campaignId,
    kind,
    JSON.stringify(sourceBody),
    cohortHash,
    counts.materialized,
    counts.eligible,
    counts.suppressed,
    Array.isArray(sourceBody.source_tables) ? sourceBody.source_tables.map(String) : [],
    integerOrDefault(sourceBody.minimum_cohort_size, 1, { min: 1 }),
    uuidOrNull(actorUid),
  );
  return jsonReady(rows[0]);
}

async function findPatient(tx, tenantId, patientUid) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, uid, phone, email, name, role, is_active, preferred_channel, tenant_id
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantId,
    patientUid,
  );
  return rows[0] || null;
}

async function checkConsent(tx, { tenantId, patientUid, consentType, maxAgeDays }) {
  const activeRows = await tx.$queryRawUnsafe(
    `SELECT id, granted_at, expires_at, status
       FROM patient_consents
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND consent_type = $3
        AND granted = TRUE
        AND revoked_at IS NULL
        AND COALESCE(status, 'active') IN ('active', 'granted', 'signed')
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY granted_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    tenantId,
    patientUid,
    consentType,
  );

  const active = activeRows[0];
  if (active?.granted_at) {
    const grantedAt = new Date(active.granted_at);
    const ageMs = Date.now() - grantedAt.getTime();
    if (ageMs > maxAgeDays * 24 * 60 * 60 * 1000) {
      return { ok: false, reason: 'stale_consent', consentId: active.id };
    }
  }
  if (active) return { ok: true, consentId: active.id };

  const latestRows = await tx.$queryRawUnsafe(
    `SELECT granted, status, revoked_at, expires_at
       FROM patient_consents
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND consent_type = $3
      ORDER BY created_at DESC
      LIMIT 1`,
    tenantId,
    patientUid,
    consentType,
  );
  const latest = latestRows[0];
  if (!latest) return { ok: false, reason: 'missing_consent' };
  if (latest.revoked_at || String(latest.status || '').toLowerCase() === 'revoked' || latest.granted !== true) {
    return { ok: false, reason: 'revoked_consent' };
  }
  if (latest.expires_at && new Date(latest.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired_consent' };
  }
  return { ok: false, reason: 'missing_consent' };
}

async function hasActiveSuppression(tx, { tenantId, campaignId, patientUid, channel }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT event_type, reason_code
       FROM engagement_suppression_events
      WHERE tenant_id = $1::uuid
        AND active = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (campaign_id IS NULL OR campaign_id = $2::bigint)
        AND (patient_uid IS NULL OR patient_uid = $3::uuid)
        AND (channel IS NULL OR channel = $4)
      ORDER BY created_at DESC
      LIMIT 1`,
    tenantId,
    campaignId,
    patientUid,
    channel,
  );
  return rows[0] ? String(rows[0].reason_code || rows[0].event_type) : null;
}

async function dailyQueuedCount(tx, tenantId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM engagement_campaign_recipients
      WHERE tenant_id = $1::uuid
        AND status IN ('queued', 'sent')
        AND queued_at >= date_trunc('day', NOW())`,
    tenantId,
  );
  return Number(rows[0]?.count || 0);
}

async function hasRecentPatientTouch(tx, { tenantId, patientUid, cooldownHours, excludeRecipientId = null }) {
  if (!cooldownHours) return false;
  const rows = await tx.$queryRawUnsafe(
    `SELECT id
       FROM engagement_campaign_recipients
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND status IN ('queued', 'sent')
        AND queued_at >= NOW() - ($3::int * INTERVAL '1 hour')
        AND ($4::bigint IS NULL OR id <> $4::bigint)
      LIMIT 1`,
    tenantId,
    patientUid,
    cooldownHours,
    excludeRecipientId,
  );
  return rows.length > 0;
}

async function evaluateCandidate(tx, {
  campaign,
  settings,
  tenantId,
  candidate,
  usedDailySlots,
  dryRun,
  excludeRecipientId = null,
}) {
  const patientUid = String(candidate.patient_uid ?? candidate.patientUid ?? '').trim();
  if (!UUID_RE.test(patientUid)) {
    return { eligible: false, reason: 'invalid_patient_uid', patient_uid: patientUid || null };
  }

  const channel = normalizeChannel(candidate.channel || campaign.channels?.[0] || campaign.template_channel);
  const requiredConsent = requiredConsentType(campaign, settings);
  const variables = sanitizeTemplateVariables(candidate.variables || {}, campaign.allowed_variables || TEMPLATE_ALLOWED_VARIABLES);
  const dueAt = candidate.due_at || candidate.dueAt || campaign.scheduled_at || new Date().toISOString();
  const idempotencyKey = `${campaign.id}:${patientUid}:${channel}`;

  if (!dryRun && !settings.enabled) {
    return { eligible: false, reason: 'tenant_engagement_disabled', patient_uid: patientUid, channel, required_consent_type: requiredConsent, variables, due_at: dueAt, idempotency_key: idempotencyKey };
  }
  if (settings.emergency_stop) {
    return { eligible: false, reason: 'tenant_emergency_stop', patient_uid: patientUid, channel, required_consent_type: requiredConsent, variables, due_at: dueAt, idempotency_key: idempotencyKey };
  }

  const patient = await findPatient(tx, tenantId, patientUid);
  if (!patient || patient.is_active === false) {
    return { eligible: false, reason: 'patient_not_contactable', patient_uid: patientUid, channel, required_consent_type: requiredConsent, variables, due_at: dueAt, idempotency_key: idempotencyKey };
  }

  const preferred = String(patient.preferred_channel || '').trim().toLowerCase();
  if (preferred === 'none') {
    return { eligible: false, reason: 'preferred_channel_none', patient_uid: patientUid, channel, required_consent_type: requiredConsent, variables, due_at: dueAt, idempotency_key: idempotencyKey };
  }
  if ((channel === 'sms' || channel === 'whatsapp') && preferred === 'app') {
    return { eligible: false, reason: 'app_only_contact', patient_uid: patientUid, channel, required_consent_type: requiredConsent, variables, due_at: dueAt, idempotency_key: idempotencyKey };
  }

  const contactRoute = channel === 'email' ? patient.email : patient.phone;
  if ((channel === 'sms' || channel === 'whatsapp') && !contactRoute) {
    return { eligible: false, reason: 'missing_phone', patient_uid: patientUid, channel, required_consent_type: requiredConsent, variables, due_at: dueAt, idempotency_key: idempotencyKey };
  }
  if (channel === 'email' && !contactRoute) {
    return { eligible: false, reason: 'missing_email', patient_uid: patientUid, channel, required_consent_type: requiredConsent, variables, due_at: dueAt, idempotency_key: idempotencyKey };
  }

  const consent = await checkConsent(tx, {
    tenantId,
    patientUid,
    consentType: requiredConsent,
    maxAgeDays: settings.consent_max_age_days,
  });
  if (!consent.ok) {
    return { eligible: false, reason: consent.reason, consent_id: consent.consentId || null, patient_uid: patientUid, channel, required_consent_type: requiredConsent, contact_route: contactRoute || null, variables, due_at: dueAt, idempotency_key: idempotencyKey };
  }

  const suppressionReason = await hasActiveSuppression(tx, { tenantId, campaignId: campaign.id, patientUid, channel });
  if (suppressionReason) {
    return { eligible: false, reason: suppressionReason, consent_id: consent.consentId, patient_uid: patientUid, channel, required_consent_type: requiredConsent, contact_route: contactRoute || null, variables, due_at: dueAt, idempotency_key: idempotencyKey };
  }

  if (isInsideQuietHours(dueAt, settings)) {
    return { eligible: false, reason: 'quiet_hours', consent_id: consent.consentId, patient_uid: patientUid, channel, required_consent_type: requiredConsent, contact_route: contactRoute || null, variables, due_at: dueAt, idempotency_key: idempotencyKey };
  }

  const tenantDailyCap = integerOrDefault(campaign.rate_policy?.tenant_daily_cap, settings.tenant_daily_cap);
  if (tenantDailyCap > 0 && (await dailyQueuedCount(tx, tenantId)) + usedDailySlots >= tenantDailyCap) {
    return { eligible: false, reason: 'daily_tenant_cap', consent_id: consent.consentId, patient_uid: patientUid, channel, required_consent_type: requiredConsent, contact_route: contactRoute || null, variables, due_at: dueAt, idempotency_key: idempotencyKey };
  }

  const cooldownHours = integerOrDefault(campaign.rate_policy?.per_patient_cooldown_hours, settings.per_patient_cooldown_hours);
  if (await hasRecentPatientTouch(tx, { tenantId, patientUid, cooldownHours, excludeRecipientId })) {
    return { eligible: false, reason: 'patient_cooldown', consent_id: consent.consentId, patient_uid: patientUid, channel, required_consent_type: requiredConsent, contact_route: contactRoute || null, variables, due_at: dueAt, idempotency_key: idempotencyKey };
  }

  return {
    eligible: true,
    reason: null,
    user_id: patient.id,
    patient_uid: patientUid,
    consent_id: consent.consentId,
    required_consent_type: requiredConsent,
    channel,
    contact_route: contactRoute || null,
    variables,
    due_at: dueAt,
    idempotency_key: idempotencyKey,
  };
}

async function evaluateCandidates(tx, { tenantId, campaign, settings, candidates, dryRun }) {
  const results = [];
  let usedDailySlots = 0;
  for (const candidate of candidates) {
    const result = await evaluateCandidate(tx, {
      campaign,
      settings,
      tenantId,
      candidate,
      usedDailySlots,
      dryRun,
    });
    if (result.eligible) usedDailySlots += 1;
    results.push(result);
  }
  return results;
}

function countsFor(results) {
  const eligible = results.filter((row) => row.eligible).length;
  return {
    materialized: results.length,
    eligible,
    suppressed: results.length - eligible,
  };
}

function candidateList(input) {
  const candidates = input?.patients || input?.recipients || input?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw AppError.badRequest('At least one campaign candidate is required', 'ENGAGEMENT_CANDIDATES_REQUIRED');
  }
  return candidates.slice(0, 500);
}

export async function dryRunCampaign({ tenantId, campaignId, input = {}, actorUid = null }) {
  const tid = requireTenantId(tenantId);
  const candidates = candidateList(input);

  return setTenantTx(tid, async (tx) => {
    const campaign = await loadCampaignContext(tx, tid, campaignId);
    const settings = await loadEngagementSettings(tx, tid);
    const results = await evaluateCandidates(tx, { tenantId: tid, campaign, settings, candidates, dryRun: true });
    const counts = countsFor(results);
    const snapshot = await insertAudienceSnapshot(tx, {
      tenantId: tid,
      campaignId: campaign.id,
      kind: 'dry_run',
      source: { ...(input.cohort_source || input.cohortSource || {}), candidate_count: candidates.length },
      counts,
      actorUid,
    });

    await tx.$executeRawUnsafe(
      `UPDATE engagement_campaigns
          SET status = CASE WHEN status = 'draft' THEN 'dry_run' ELSE status END,
              current_audience_snapshot_id = $3::bigint,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tid,
      campaign.id,
      snapshot.id,
    );

    return jsonReady({ snapshot, counts, recipients: results });
  });
}

export async function materializeCampaignRecipients({ tenantId, campaignId, input = {}, actorUid = null }) {
  const tid = requireTenantId(tenantId);
  const candidates = candidateList(input);

  return setTenantTx(tid, async (tx) => {
    const campaign = await loadCampaignContext(tx, tid, campaignId);
    if (!['dry_run', 'pending_approval', 'scheduled', 'running'].includes(campaign.status)) {
      throw AppError.badRequest('Campaign must be dry-run or approved before recipient materialization', 'ENGAGEMENT_BAD_MATERIALIZE_STATE');
    }
    const settings = await loadEngagementSettings(tx, tid);
    const results = await evaluateCandidates(tx, { tenantId: tid, campaign, settings, candidates, dryRun: false });
    const counts = countsFor(results);
    const snapshot = await insertAudienceSnapshot(tx, {
      tenantId: tid,
      campaignId: campaign.id,
      kind: 'materialized',
      source: { ...(input.cohort_source || input.cohortSource || {}), candidate_count: candidates.length },
      counts,
      actorUid,
    });

    const inserted = [];
    for (const result of results) {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO engagement_campaign_recipients
           (tenant_id, campaign_id, audience_snapshot_id, patient_uid, consent_id,
            required_consent_type, channel, contact_route, due_at, status,
            suppression_reason, idempotency_key, variables, last_consent_checked_at,
            updated_at)
         VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, $5::int, $6, $7,
                 $8, $9::timestamptz, $10, $11, $12, $13::jsonb, NOW(), NOW())
         ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET
           audience_snapshot_id = EXCLUDED.audience_snapshot_id,
           consent_id = EXCLUDED.consent_id,
           required_consent_type = EXCLUDED.required_consent_type,
           contact_route = EXCLUDED.contact_route,
           due_at = EXCLUDED.due_at,
           status = EXCLUDED.status,
           suppression_reason = EXCLUDED.suppression_reason,
           variables = EXCLUDED.variables,
           last_consent_checked_at = NOW(),
           updated_at = NOW()
         RETURNING id, tenant_id, campaign_id, audience_snapshot_id, patient_uid,
                   consent_id, required_consent_type, channel, contact_route,
                   due_at, status, suppression_reason, outbox_id, idempotency_key,
                   variables, materialized_at, queued_at, created_at, updated_at`,
        tid,
        campaign.id,
        snapshot.id,
        result.patient_uid,
        result.consent_id || null,
        result.required_consent_type,
        result.channel,
        result.contact_route || null,
        result.due_at,
        result.eligible ? 'eligible' : 'suppressed',
        result.eligible ? null : result.reason,
        result.idempotency_key,
        JSON.stringify(result.variables || {}),
      );
      inserted.push(jsonReady(rows[0]));
    }

    await tx.$executeRawUnsafe(
      `UPDATE engagement_campaigns
          SET current_audience_snapshot_id = $3::bigint,
              frozen_audience_hash = $4,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tid,
      campaign.id,
      snapshot.id,
      snapshot.cohort_hash,
    );

    return { snapshot, counts, recipients: inserted };
  });
}

async function updateCampaignStatus({ tenantId, campaignId, fromStatuses, nextStatus, actorUid, actorRole, reason }) {
  const tid = requireTenantId(tenantId);
  const rows = await setTenantTx(tid, async (tx) => {
    const campaign = await loadCampaignContext(tx, tid, campaignId);
    if (!fromStatuses.includes(campaign.status)) {
      throw AppError.invalidTransition(campaign.status, nextStatus, fromStatuses);
    }
    return tx.$queryRawUnsafe(
      `UPDATE engagement_campaigns
          SET status = $4::varchar,
              submitted_by = CASE WHEN $4::varchar = 'pending_approval' THEN $5::uuid ELSE submitted_by END,
              submitted_at = CASE WHEN $4::varchar = 'pending_approval' THEN NOW() ELSE submitted_at END,
              approved_by = CASE WHEN $4::varchar = 'scheduled' THEN $5::uuid ELSE approved_by END,
              approved_at = CASE WHEN $4::varchar = 'scheduled' THEN NOW() ELSE approved_at END,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status = $3::varchar
      RETURNING id, tenant_id, campaign_type, objective, status, template_id,
                channels, schedule_policy, rate_policy, audience_kind,
                approval_required_role, submitted_by, submitted_at,
                approved_by, approved_at, scheduled_at, frozen_audience_hash,
                current_audience_snapshot_id, created_at, updated_at`,
      tid,
      campaign.id,
      campaign.status,
      nextStatus,
      uuidOrNull(actorUid),
    );
  });
  const row = jsonReady(rows[0]);
  await auditCampaignTransition({
    tenantId: tid,
    actorUid,
    actorRole,
    campaignId,
    previousStatus: fromStatuses.length === 1 ? fromStatuses[0] : null,
    nextStatus,
    reason,
  });
  return row;
}

export async function submitCampaignForApproval({ tenantId, campaignId, actorUid = null, actorRole = null, reason = null }) {
  return updateCampaignStatus({
    tenantId,
    campaignId,
    fromStatuses: ['dry_run'],
    nextStatus: 'pending_approval',
    actorUid,
    actorRole,
    reason,
  });
}

export async function approveCampaign({ tenantId, campaignId, actorUid = null, actorRole = null, reason = null }) {
  const tid = requireTenantId(tenantId);
  const role = String(actorRole || '').toUpperCase();
  const campaign = await setTenant(tid, (tx) => loadCampaignContext(tx, tid, campaignId), { readOnly: true });
  const allowed = campaign.approval_required_role === 'admin_quality'
    ? BROAD_APPROVAL_ROLES
    : CARE_TEAM_APPROVAL_ROLES;
  if (!allowed.has(role)) {
    throw AppError.forbidden('This role cannot approve the requested engagement campaign', 'ENGAGEMENT_APPROVAL_FORBIDDEN');
  }
  return updateCampaignStatus({
    tenantId: tid,
    campaignId,
    fromStatuses: ['pending_approval'],
    nextStatus: 'scheduled',
    actorUid,
    actorRole,
    reason,
  });
}

export async function queueDueCampaignRecipients({ tenantId, campaignId, limit = 50 }) {
  const tid = requireTenantId(tenantId);
  const boundedLimit = integerOrDefault(limit, 50, { min: 1 });

  const recipients = await setTenant(tid, async (tx) => {
    const campaign = await loadCampaignContext(tx, tid, campaignId);
    if (!['scheduled', 'running'].includes(campaign.status)) {
      throw AppError.badRequest('Campaign must be approved before queueing recipients', 'ENGAGEMENT_NOT_APPROVED');
    }
    return tx.$queryRawUnsafe(
      `SELECT id, tenant_id, campaign_id, audience_snapshot_id, patient_uid,
              consent_id, required_consent_type, channel, contact_route, due_at,
              status, variables, idempotency_key
         FROM engagement_campaign_recipients
        WHERE tenant_id = $1::uuid
          AND campaign_id = $2::bigint
          AND status = 'eligible'
          AND due_at <= NOW()
        ORDER BY due_at ASC, id ASC
        LIMIT $3::int`,
      tid,
      campaign.id,
      boundedLimit,
    );
  }, { readOnly: true });

  let queued = 0;
  let suppressed = 0;
  let failed = 0;

  for (const recipientRow of recipients) {
    const row = jsonReady(recipientRow);
    try {
      const { campaign, verdict } = await setTenant(tid, async (tx) => {
        const loadedCampaign = await loadCampaignContext(tx, tid, campaignId);
        const settings = await loadEngagementSettings(tx, tid);
        const loadedVerdict = await evaluateCandidate(tx, {
          campaign: loadedCampaign,
          settings,
          tenantId: tid,
          candidate: {
            patient_uid: row.patient_uid,
            channel: row.channel,
            variables: row.variables,
            due_at: row.due_at,
          },
          usedDailySlots: queued,
          dryRun: false,
          excludeRecipientId: row.id,
        });
        return { campaign: loadedCampaign, verdict: loadedVerdict };
      }, { readOnly: true });

      if (!verdict.eligible) {
        await setTenantTx(tid, (tx) => tx.$executeRawUnsafe(
          `UPDATE engagement_campaign_recipients
              SET status = 'suppressed',
                  suppression_reason = $4,
                  last_consent_checked_at = NOW(),
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND campaign_id = $2::bigint
              AND id = $3::bigint`,
          tid,
          campaignId,
          row.id,
          verdict.reason,
        ));
        suppressed += 1;
        continue;
      }

      const variables = sanitizeTemplateVariables(row.variables || {}, campaign.allowed_variables || TEMPLATE_ALLOWED_VARIABLES);
      const title = renderTemplateString(campaign.title_template, variables).slice(0, 500);
      const body = renderTemplateString(campaign.message_template, variables).slice(0, 4000);
      const queuedOutbox = await notificationOutbox.queue({
        type: 'engagement_campaign',
        recipientId: verdict.user_id,
        recipientPhone: verdict.contact_route,
        title,
        body,
        data: {
          tenant_id: tid,
          channels: [row.channel],
          campaign_id: row.campaign_id,
          campaign_recipient_id: row.id,
          patient_uid: row.patient_uid,
          consent_id: verdict.consent_id,
          template_kind: campaign.campaign_type,
        },
      });

      if (!queuedOutbox?.id) {
        throw new Error('notification_outbox queue returned no id');
      }

      await setTenantTx(tid, (tx) => tx.$executeRawUnsafe(
        `UPDATE engagement_campaign_recipients
            SET status = 'queued',
                outbox_id = $4::int,
                consent_id = $5::int,
                last_consent_checked_at = NOW(),
                queued_at = NOW(),
                delivery_metadata = jsonb_build_object(
                  'outbox_type', 'engagement_campaign',
                  'channel', $6::text
                ),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND campaign_id = $2::bigint
            AND id = $3::bigint`,
        tid,
        campaignId,
        row.id,
        queuedOutbox.id,
        verdict.consent_id,
        row.channel,
      ));
      queued += 1;
    } catch (err) {
      failed += 1;
      logger.warn('Failed to queue engagement campaign recipient', {
        campaignId,
        recipientId: row.id,
        error: err?.message,
      });
      await setTenantTx(tid, (tx) => tx.$executeRawUnsafe(
        `UPDATE engagement_campaign_recipients
            SET status = 'failed',
                failed_at = NOW(),
                delivery_metadata = delivery_metadata || jsonb_build_object('failure', $4::text),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND campaign_id = $2::bigint
            AND id = $3::bigint`,
        tid,
        campaignId,
        row.id,
        String(err?.message || err).slice(0, 500),
      )).catch(() => {});
    }
  }

  if (queued > 0) {
    await setTenantTx(tid, (tx) => tx.$executeRawUnsafe(
      `UPDATE engagement_campaigns
          SET status = CASE WHEN status = 'scheduled' THEN 'running' ELSE status END,
              started_at = COALESCE(started_at, NOW()),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tid,
      campaignId,
    ));
  }

  return { claimed: recipients.length, queued, suppressed, failed };
}

export default {
  getEngagementSettings,
  upsertEngagementSettings,
  createEngagementTemplate,
  createEngagementCampaign,
  dryRunCampaign,
  materializeCampaignRecipients,
  submitCampaignForApproval,
  approveCampaign,
  queueDueCampaignRecipients,
};
