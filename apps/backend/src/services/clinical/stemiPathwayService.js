import { randomUUID } from 'crypto';

import { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { emitCodeStemi } from '../../utils/websocket/realtimeEmitter.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';

const SETTINGS_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_TIMEZONE = process.env.APP_TIMEZONE || process.env.TZ || 'Asia/Kolkata';

const settingsCache = new Map();

export const ACTIVATION_SOURCES = Object.freeze([
  'ed_triage',
  'ecg_auto_flag',
  'clinician',
  'prehospital_handover',
]);

export const ACTIVATION_STATUSES = Object.freeze([
  'activated',
  'lab_notified',
  'in_lab',
  'device_deployed',
  'completed',
  'stood_down',
]);

export const NONTERMINAL_STATUSES = Object.freeze([
  'activated',
  'lab_notified',
  'in_lab',
  'device_deployed',
]);

export const ACTIVATION_TRANSITIONS = Object.freeze({
  activated: ['lab_notified', 'stood_down'],
  lab_notified: ['in_lab', 'stood_down'],
  in_lab: ['device_deployed', 'stood_down'],
  device_deployed: ['completed', 'stood_down'],
  completed: [],
  stood_down: [],
});

export const PATHWAY_EVENT_TYPES = Object.freeze([
  'ecg_acquired',
  'ecg_read',
  'activation',
  'lab_ready',
  'patient_in_lab',
  'access',
  'wire_crossing',
  'device_deployed',
  'reperfusion_assessment',
  'transfer',
  'disposition',
]);

export const CATH_NOTIFICATION_ROLE_CODES = Object.freeze([
  'CATH_LAB_INCHARGE',
  'CATH_LAB_STAFF',
]);

const STATUS_FROM_EVENT = Object.freeze({
  lab_ready: 'lab_notified',
  patient_in_lab: 'in_lab',
  device_deployed: 'device_deployed',
  disposition: 'completed',
});

const SLA_RULE_FROM_EVENT = Object.freeze({
  ecg_acquired: 'stemi_door_to_ecg',
  patient_in_lab: 'stemi_door_to_lab',
  device_deployed: 'stemi_door_to_balloon',
});

const CATH_READINESS_TYPES = Object.freeze([
  'consent',
  'labs',
  'allergy_renal_risk',
  'anticoagulation',
  'blood_bank',
  'equipment',
  'implants_device_rep',
  'timeout',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACTIVATION_COLUMN_NAMES = Object.freeze([
  'id', 'tenant_id', 'activation_uid', 'patient_uid', 'encounter_id',
  'emergency_visit_id', 'prehospital_handover_id', 'cath_case_id',
  'activation_source', 'symptom_onset_at', 'last_known_well_at',
  'first_medical_contact_at', 'door_time_at', 'ecg_at', 'activated_at',
  'lab_notified_at', 'in_lab_at', 'device_deployed_at', 'completed_at',
  'stood_down_at', 'team', 'status', 'stand_down_reason', 'activation_criteria',
  'owner_target_minutes', 'clock_metadata', 'canonical_timeline_event_id',
  'canonical_audit_event_id', 'metadata', 'created_by', 'updated_by',
  'created_at', 'updated_at',
]);
const ACTIVATION_COLUMNS = ACTIVATION_COLUMN_NAMES.join(', ');
const ACTIVATION_COLUMNS_A = ACTIVATION_COLUMN_NAMES.map((column) => `a.${column}`).join(', ');

const SLA_COLUMNS = [
  'id', 'tenant_id', 'rule_id', 'rule_code', 'patient_uid', 'encounter_id',
  'source_table', 'source_id', 'source_uid', 'status', 'priority', 'started_at',
  'due_at', 'completed_at', 'breached_at', 'escalated_at', 'assigned_role_codes',
  'assigned_user_uid', 'metadata', 'created_at', 'updated_at',
].join(', ');

const PATHWAY_EVENT_COLUMNS = [
  'id', 'tenant_id', 'activation_id', 'patient_uid', 'encounter_id',
  'sequence_number', 'event_type', 'occurred_at', 'workflow_sla_instance_id',
  'event_payload', 'recorded_by', 'canonical_timeline_event_id',
  'canonical_audit_event_id', 'metadata', 'created_at',
].join(', ');

const CATH_CASE_COLUMNS = [
  'id', 'tenant_id', 'patient_uid', 'encounter_id', 'appointment_id',
  'requested_procedure', 'indication', 'urgency', 'lab_room', 'status',
  'planned_start_at', 'planned_end_at', 'actual_start_at', 'actual_end_at',
  'team', 'timeline_event_id', 'audit_event_id', 'sla_rule_code',
  'sla_instance_id', 'created_by', 'updated_by', 'created_at', 'updated_at',
  'metadata',
].join(', ');

const CATH_READINESS_COLUMNS = [
  'id', 'tenant_id', 'case_id', 'check_type', 'status', 'required',
  'completed_by', 'completed_at', 'evidence_owner', 'source_name',
  'source_version', 'attachment_ref', 'notes', 'created_at', 'updated_at',
  'metadata',
].join(', ');

const CATH_PROCEDURE_LOG_COLUMNS = [
  'id', 'tenant_id', 'case_id', 'patient_uid', 'encounter_id', 'procedure_type',
  'access_site', 'operators', 'sedation_anesthesia_ref', 'devices',
  'findings_summary', 'complications', 'status', 'started_at', 'ended_at',
  'logged_by', 'timeline_event_id', 'audit_event_id', 'created_at', 'updated_at',
  'metadata',
].join(', ');

const TEAM_NOTIFICATION_COLUMNS = [
  'id', 'tenant_id', 'activation_id', 'staff_id', 'staff_uid', 'role_code',
  'assignment_source', 'notification_status', 'notification_outbox_id',
  'notified_at', 'acknowledged_by_uid', 'acknowledged_at',
  'acknowledgement_note', 'canonical_timeline_event_id',
  'canonical_audit_event_id', 'created_at', 'updated_at',
].join(', ');

function tenantOr(value) {
  return requireTenantId(String(value || '').trim());
}

function cleanText(value, max = 8000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function maybeUuid(value, label, { required = false } = {}) {
  const text = cleanText(value, 80);
  if (!text) {
    if (required) throw AppError.badRequest(`${label} is required`, 'STEMI_UUID_REQUIRED');
    return null;
  }
  if (!UUID_RE.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'STEMI_BAD_UUID');
  }
  return text;
}

function positiveId(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'STEMI_BAD_ID');
  }
  return parsed;
}

function boundedLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

function parseBoolean(value) {
  return value === true || String(value || '').toLowerCase() === 'true';
}

function isUniqueViolation(err) {
  const code = err?.meta?.code || err?.cause?.code || err?.code;
  return String(code) === '23505'
    || /23505|duplicate key value/i.test(String(err?.message || ''));
}

function asIso(value, label, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`, 'STEMI_TIMESTAMP_REQUIRED');
    return null;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest(`${label} must be a valid timestamp`, 'STEMI_BAD_TIMESTAMP');
  }
  return date.toISOString();
}

function dbTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  return value instanceof Date ? value : new Date(value);
}

function jsonObject(value, label = 'value') {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be an object`, 'STEMI_BAD_JSON');
  }
  return value;
}

function json(value, fallback = {}) {
  return JSON.stringify(value === undefined || value === null ? fallback : value);
}

export function buildPathwayCanonicalPayload(eventPayload, {
  activationId,
  sequenceNumber,
  eventType,
  workflowSlaInstanceId,
}) {
  return {
    ...eventPayload,
    activation_id: wireId(activationId),
    sequence_number: sequenceNumber,
    event_type: eventType,
    workflow_sla_instance_id: workflowSlaInstanceId || null,
  };
}

function normalizeValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)]),
    );
  }
  return value;
}

function wireId(value) {
  return normalizeValue(value);
}

function pick(input, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) return input[key];
  }
  return undefined;
}

function optionalPositiveMinutes(value, label) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be positive whole minutes`, 'STEMI_BAD_SLA_TARGET');
  }
  return parsed;
}

function normalizeRoleCodes(value, fallback = []) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) {
    throw AppError.badRequest('notification_role_codes must be an array', 'STEMI_BAD_NOTIFICATION_ROLES');
  }
  const roles = [...new Set(value.map((role) => cleanText(role, 80)).filter(Boolean))];
  if (roles.length === 0) {
    throw AppError.badRequest('notification_role_codes cannot be empty', 'STEMI_BAD_NOTIFICATION_ROLES');
  }
  return roles;
}

function normalizeCathNotificationRoleCodes(value, fallback = []) {
  const roles = normalizeRoleCodes(value, fallback);
  if (roles.some((role) => !CATH_NOTIFICATION_ROLE_CODES.includes(role))) {
    throw AppError.badRequest(
      'notification_role_codes may contain only cath-lab roles',
      'STEMI_BAD_NOTIFICATION_ROLES',
      { allowed: CATH_NOTIFICATION_ROLE_CODES },
    );
  }
  return roles;
}

function normalizeTeam(value) {
  if (value === undefined || value === null) return { members: [] };
  if (Array.isArray(value)) return { members: value };
  const team = jsonObject(value, 'team');
  if (team.members !== undefined && !Array.isArray(team.members)) {
    throw AppError.badRequest('team.members must be an array', 'STEMI_BAD_TEAM');
  }
  return { ...team, members: team.members || [] };
}

export function validateActivationClock(input = {}) {
  const activationSource = cleanText(
    pick(input, 'activation_source', 'activationSource'),
    40,
  )?.toLowerCase();
  const prehospitalClock = activationSource === 'prehospital_handover';
  const activatedAt = asIso(
    pick(input, 'activated_at', 'activatedAt') || new Date(),
    'activated_at',
    { required: true },
  );
  const doorTimeAt = asIso(
    pick(input, 'door_time_at', 'doorTimeAt'),
    'door_time_at',
    { required: !prehospitalClock },
  );
  const symptomOnsetAt = asIso(pick(input, 'symptom_onset_at', 'symptomOnsetAt'), 'symptom_onset_at');
  const lastKnownWellAt = asIso(pick(input, 'last_known_well_at', 'lastKnownWellAt'), 'last_known_well_at');
  const firstMedicalContactAt = asIso(
    pick(input, 'first_medical_contact_at', 'firstMedicalContactAt'),
    'first_medical_contact_at',
  );
  const ecgAt = asIso(pick(input, 'ecg_at', 'ecgAt'), 'ecg_at');
  const activated = new Date(activatedAt);

  for (const [label, value] of [
    ['symptom_onset_at', symptomOnsetAt],
    ['last_known_well_at', lastKnownWellAt],
    ['first_medical_contact_at', firstMedicalContactAt],
  ]) {
    if (value && new Date(value) > activated) {
      throw AppError.badRequest(`${label} cannot be after activated_at`, 'STEMI_CLOCK_ORDER');
    }
  }
  if (!prehospitalClock
    && new Date(doorTimeAt).getTime() > activated.getTime() + 5 * 60 * 1000) {
    throw AppError.badRequest(
      'door_time_at cannot be more than five minutes after activated_at',
      'STEMI_CLOCK_DOOR_AFTER_ACTIVATION',
    );
  }
  return {
    symptomOnsetAt,
    lastKnownWellAt,
    firstMedicalContactAt,
    doorTimeAt,
    ecgAt,
    activatedAt,
  };
}

export function resolveActivationClock(input = {}, context = {}) {
  const suppliedDoorTime = asIso(
    pick(input, 'door_time_at', 'doorTimeAt'),
    'door_time_at',
  );
  const edArrivalAt = asIso(context.edArrivalAt, 'emergency_visit.arrival_at');
  if (suppliedDoorTime && edArrivalAt
    && new Date(suppliedDoorTime).getTime() !== new Date(edArrivalAt).getTime()) {
    throw AppError.conflict(
      'door_time_at does not match the linked ED visit arrival time',
      'STEMI_DOOR_TIME_ED_VISIT_MISMATCH',
    );
  }
  return validateActivationClock({
    ...input,
    activation_source: context.activationSource,
    door_time_at: suppliedDoorTime || edArrivalAt,
  });
}

export function assertActivationTransition(currentStatus, nextStatus, standDownReason = null) {
  const current = cleanText(currentStatus, 32)?.toLowerCase();
  const next = cleanText(nextStatus, 32)?.toLowerCase();
  if (!ACTIVATION_STATUSES.includes(next)) {
    throw AppError.badRequest('Invalid STEMI activation status', 'STEMI_BAD_STATUS', {
      allowed: ACTIVATION_STATUSES,
    });
  }
  if (!current) return next;
  const allowed = ACTIVATION_TRANSITIONS[current] || [];
  if (!allowed.includes(next)) throw AppError.invalidTransition(current, next, allowed);
  if (next === 'stood_down' && !cleanText(standDownReason)) {
    throw AppError.badRequest('stand_down_reason is required', 'STEMI_STAND_DOWN_REASON_REQUIRED');
  }
  return next;
}

function settingsCacheGet(tenantId) {
  const hit = settingsCache.get(String(tenantId));
  if (!hit || Date.now() - hit.fetchedAt > SETTINGS_CACHE_TTL_MS) return null;
  return hit.value;
}

function settingsCacheSet(tenantId, value) {
  settingsCache.set(String(tenantId), { value, fetchedAt: Date.now() });
}

function settingsCacheDelete(tenantId) {
  settingsCache.delete(String(tenantId));
}

async function getSettingsTx(tx, tenantId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT tenant_id, enabled, enabled_at, enabled_by,
            clock_definition_source, clock_definition_version,
            clock_definition_attachment_refs, activation_criteria_source,
            activation_criteria_version, activation_criteria,
            door_to_ecg_target_minutes, door_to_lab_target_minutes,
            door_to_balloon_target_minutes, notification_role_codes,
            acceptance_snapshot, metadata, created_at, updated_at
       FROM stemi_pathway_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    tenantId,
  );
  return rows[0] || null;
}

export async function getStemiPathwaySettings(tenantId) {
  const tid = tenantOr(tenantId);
  const cached = settingsCacheGet(tid);
  if (cached) return cached;
  try {
    const value = await setTenant(tid, (tx) => getSettingsTx(tx, tid));
    const settings = value || { tenant_id: tid, enabled: false, reason: 'settings_missing' };
    settingsCacheSet(tid, settings);
    return normalizeValue(settings);
  } catch (err) {
    logger.warn('getStemiPathwaySettings failed', { tenantId: tid, message: err.message });
    return { tenant_id: tid, enabled: false, reason: 'settings_unavailable' };
  }
}

function assertPathwayEnabled(settings) {
  if (!settings?.enabled) {
    throw AppError.forbidden(
      'Code-STEMI pathway is not enabled for this tenant',
      'STEMI_PATHWAY_DISABLED',
    );
  }
}

export async function setStemiPathwaySettings(input = {}) {
  const tenantId = tenantOr(pick(input, 'tenantId', 'tenant_id'));
  const actorUid = maybeUuid(pick(input, 'actorUid', 'actor_uid'), 'actor_uid');
  const result = await setTenantTx(tenantId, async (tx) => {
    const current = await getSettingsTx(tx, tenantId);
    const enabledInput = pick(input, 'enabled');
    const enabled = enabledInput === undefined ? current?.enabled === true : enabledInput === true;
    const clockDefinitionSource = cleanText(
      pick(input, 'clock_definition_source', 'clockDefinitionSource')
        ?? current?.clock_definition_source,
    );
    const clockDefinitionVersion = cleanText(
      pick(input, 'clock_definition_version', 'clockDefinitionVersion')
        ?? current?.clock_definition_version,
    );
    const activationCriteriaSource = cleanText(
      pick(input, 'activation_criteria_source', 'activationCriteriaSource')
        ?? current?.activation_criteria_source,
    );
    const activationCriteriaVersion = cleanText(
      pick(input, 'activation_criteria_version', 'activationCriteriaVersion')
        ?? current?.activation_criteria_version,
    );
    if (enabled && (!actorUid || !clockDefinitionSource || !clockDefinitionVersion
      || !activationCriteriaSource || !activationCriteriaVersion)) {
      throw AppError.badRequest(
        'Enabling Code-STEMI requires actor, clock source/version, and activation-criteria source/version',
        'STEMI_ENABLE_OWNER_METADATA_REQUIRED',
      );
    }

    const ecgTarget = optionalPositiveMinutes(
      pick(input, 'door_to_ecg_target_minutes', 'doorToEcgTargetMinutes'),
      'door_to_ecg_target_minutes',
    );
    const labTarget = optionalPositiveMinutes(
      pick(input, 'door_to_lab_target_minutes', 'doorToLabTargetMinutes'),
      'door_to_lab_target_minutes',
    );
    const balloonTarget = optionalPositiveMinutes(
      pick(input, 'door_to_balloon_target_minutes', 'doorToBalloonTargetMinutes'),
      'door_to_balloon_target_minutes',
    );
    const settings = {
      enabled,
      clock_definition_source: clockDefinitionSource,
      clock_definition_version: clockDefinitionVersion,
      clock_definition_attachment_refs: pick(
        input,
        'clock_definition_attachment_refs',
        'clockDefinitionAttachmentRefs',
      ) ?? current?.clock_definition_attachment_refs ?? [],
      activation_criteria_source: activationCriteriaSource,
      activation_criteria_version: activationCriteriaVersion,
      activation_criteria: jsonObject(
        pick(input, 'activation_criteria', 'activationCriteria')
          ?? current?.activation_criteria
          ?? {},
        'activation_criteria',
      ),
      door_to_ecg_target_minutes: ecgTarget === undefined
        ? current?.door_to_ecg_target_minutes ?? null
        : ecgTarget,
      door_to_lab_target_minutes: labTarget === undefined
        ? current?.door_to_lab_target_minutes ?? null
        : labTarget,
      door_to_balloon_target_minutes: balloonTarget === undefined
        ? current?.door_to_balloon_target_minutes ?? null
        : balloonTarget,
      notification_role_codes: normalizeCathNotificationRoleCodes(
        pick(input, 'notification_role_codes', 'notificationRoleCodes'),
        current?.notification_role_codes || ['CATH_LAB_INCHARGE', 'CATH_LAB_STAFF'],
      ),
      acceptance_snapshot: pick(input, 'acceptance_snapshot', 'acceptanceSnapshot')
        ?? current?.acceptance_snapshot
        ?? null,
      metadata: jsonObject(pick(input, 'metadata') ?? current?.metadata ?? {}, 'metadata'),
    };
    if (!Array.isArray(settings.clock_definition_attachment_refs)) {
      throw AppError.badRequest(
        'clock_definition_attachment_refs must be an array',
        'STEMI_BAD_ATTACHMENTS',
      );
    }

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO stemi_pathway_settings
         (tenant_id, enabled, enabled_at, enabled_by,
          clock_definition_source, clock_definition_version,
          clock_definition_attachment_refs, activation_criteria_source,
          activation_criteria_version, activation_criteria,
          door_to_ecg_target_minutes, door_to_lab_target_minutes,
          door_to_balloon_target_minutes, notification_role_codes,
          acceptance_snapshot, metadata, updated_at)
       VALUES ($1::uuid, $2,
               CASE WHEN $2 THEN NOW() ELSE NULL END,
               CASE WHEN $2 THEN $3::uuid ELSE NULL END,
               $4::text, $5::text, $6::jsonb, $7::text, $8::text, $9::jsonb,
               $10::int, $11::int, $12::int, $13::text[], $14::jsonb, $15::jsonb, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         enabled_at = CASE WHEN EXCLUDED.enabled THEN NOW() ELSE stemi_pathway_settings.enabled_at END,
         enabled_by = CASE WHEN EXCLUDED.enabled THEN EXCLUDED.enabled_by ELSE stemi_pathway_settings.enabled_by END,
         clock_definition_source = EXCLUDED.clock_definition_source,
         clock_definition_version = EXCLUDED.clock_definition_version,
         clock_definition_attachment_refs = EXCLUDED.clock_definition_attachment_refs,
         activation_criteria_source = EXCLUDED.activation_criteria_source,
         activation_criteria_version = EXCLUDED.activation_criteria_version,
         activation_criteria = EXCLUDED.activation_criteria,
         door_to_ecg_target_minutes = EXCLUDED.door_to_ecg_target_minutes,
         door_to_lab_target_minutes = EXCLUDED.door_to_lab_target_minutes,
         door_to_balloon_target_minutes = EXCLUDED.door_to_balloon_target_minutes,
         notification_role_codes = EXCLUDED.notification_role_codes,
         acceptance_snapshot = EXCLUDED.acceptance_snapshot,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      tenantId,
      settings.enabled,
      actorUid,
      settings.clock_definition_source,
      settings.clock_definition_version,
      json(settings.clock_definition_attachment_refs, []),
      settings.activation_criteria_source,
      settings.activation_criteria_version,
      json(settings.activation_criteria),
      settings.door_to_ecg_target_minutes,
      settings.door_to_lab_target_minutes,
      settings.door_to_balloon_target_minutes,
      settings.notification_role_codes,
      settings.acceptance_snapshot == null ? null : json(settings.acceptance_snapshot),
      json(settings.metadata),
    );
    return rows[0];
  });
  settingsCacheSet(tenantId, result);
  return normalizeValue(result);
}

async function recordCanonicalPairOrThrow(tx, input) {
  const occurredAt = input.occurredAt ?? input.occurred_at;
  const pair = await recordCanonicalClinicalEvent({
    ...input,
    ...(occurredAt == null ? {} : { occurredAt: dbTimestamp(occurredAt) }),
  }, { db: tx });
  if (!pair?.timeline?.id || !pair?.audit?.id) {
    throw AppError.internal(
      'Canonical STEMI timeline/audit write failed',
      'STEMI_CANONICAL_WRITE_FAILED',
    );
  }
  return pair;
}

async function resolveClinicalContext(tx, tenantId, input) {
  const source = cleanText(pick(input, 'activation_source', 'activationSource'), 40)?.toLowerCase();
  if (!ACTIVATION_SOURCES.includes(source)) {
    throw AppError.badRequest('Invalid activation_source', 'STEMI_BAD_ACTIVATION_SOURCE', {
      allowed: ACTIVATION_SOURCES,
    });
  }
  let emergencyVisitId = pick(input, 'emergency_visit_id', 'emergencyVisitId');
  let handoverId = pick(input, 'prehospital_handover_id', 'prehospitalHandoverId');
  emergencyVisitId = emergencyVisitId == null ? null : positiveId(emergencyVisitId, 'emergency_visit_id');
  handoverId = handoverId == null ? null : positiveId(handoverId, 'prehospital_handover_id');
  if (source === 'prehospital_handover' && !handoverId) {
    throw AppError.badRequest(
      'prehospital_handover_id is required for a prehospital activation',
      'STEMI_PREHOSPITAL_HANDOVER_REQUIRED',
    );
  }

  let handover = null;
  if (handoverId) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, patient_uid, emergency_visit_id, status
         FROM prehospital_handovers
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        LIMIT 1`,
      tenantId,
      handoverId,
    );
    handover = rows[0] || null;
    if (!handover) throw AppError.notFound('Pre-hospital handover not found', 'STEMI_HANDOVER_NOT_FOUND');
    if (emergencyVisitId && handover.emergency_visit_id
      && Number(handover.emergency_visit_id) !== emergencyVisitId) {
      throw AppError.conflict(
        'Pre-hospital handover belongs to a different ED visit',
        'STEMI_HANDOVER_VISIT_MISMATCH',
      );
    }
    emergencyVisitId ||= handover.emergency_visit_id == null
      ? null
      : Number(handover.emergency_visit_id);
  }

  let visit = null;
  if (emergencyVisitId) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, patient_uid, encounter_id, arrival_at
         FROM emergency_visits
        WHERE tenant_id = $1::uuid AND id = $2::int
        LIMIT 1`,
      tenantId,
      emergencyVisitId,
    );
    visit = rows[0] || null;
    if (!visit) throw AppError.notFound('Emergency visit not found', 'STEMI_ED_VISIT_NOT_FOUND');
  }

  const suppliedPatientUid = maybeUuid(pick(input, 'patient_uid', 'patientUid'), 'patient_uid');
  const suppliedEncounterId = maybeUuid(pick(input, 'encounter_id', 'encounterId'), 'encounter_id');
  const patientCandidates = [suppliedPatientUid, visit?.patient_uid, handover?.patient_uid]
    .filter(Boolean)
    .map(String);
  const uniquePatients = [...new Set(patientCandidates)];
  if (uniquePatients.length > 1) {
    throw AppError.conflict(
      'Patient does not match the linked ED visit or pre-hospital handover',
      'STEMI_PATIENT_CONTEXT_MISMATCH',
    );
  }
  const patientUid = uniquePatients[0];
  if (!patientUid) throw AppError.badRequest('patient_uid is required', 'STEMI_PATIENT_REQUIRED');
  if (suppliedEncounterId && visit?.encounter_id
    && String(suppliedEncounterId) !== String(visit.encounter_id)) {
    throw AppError.conflict(
      'Encounter does not match the linked ED visit',
      'STEMI_ENCOUNTER_CONTEXT_MISMATCH',
    );
  }
  const encounterId = suppliedEncounterId || visit?.encounter_id || null;
  const patients = await tx.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id = $1::uuid AND uid = $2::uuid AND role = 'PATIENT' AND is_active = TRUE
      LIMIT 1`,
    tenantId,
    patientUid,
  );
  if (!patients[0]) throw AppError.notFound('Patient not found', 'STEMI_PATIENT_NOT_FOUND');
  if (encounterId) {
    const encounters = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid
         FROM patient_encounters
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
        LIMIT 1`,
      tenantId,
      encounterId,
    );
    if (!encounters[0]) {
      throw AppError.notFound('Encounter not found in this tenant', 'STEMI_ENCOUNTER_NOT_FOUND');
    }
    if (String(encounters[0].patient_uid) !== String(patientUid)) {
      throw AppError.conflict(
        'Encounter belongs to a different patient',
        'STEMI_ENCOUNTER_CONTEXT_MISMATCH',
      );
    }
  }

  return {
    activationSource: source,
    patientUid,
    encounterId,
    emergencyVisitId,
    prehospitalHandoverId: handoverId,
    edArrivalAt: visit?.arrival_at || null,
  };
}

async function resolveTeamMembers(tx, tenantId, settings, inputTeam, occurredAt) {
  const team = normalizeTeam(inputTeam);
  const roles = normalizeCathNotificationRoleCodes(settings.notification_role_codes, []);
  const rosterRows = await tx.$queryRawUnsafe(
    `WITH ctx AS (
       SELECT $2::timestamptz AS ts,
              ($2::timestamptz AT TIME ZONE $3)::date AS local_date,
              ($2::timestamptz AT TIME ZONE $3)::time AS local_time
     )
     SELECT DISTINCT ON (u.uid)
            u.id AS staff_id, u.uid AS staff_uid, u.name AS staff_name,
            COALESCE(a.staff_role, u.role) AS role_code,
            a.id AS roster_assignment_id, b.id AS roster_board_id,
            a.is_lead
       FROM ctx
       JOIN staff_shift_roster_boards b
         ON b.tenant_id = $1::uuid
        AND b.department = 'cath_lab'
        AND b.status = 'published'
        AND b.roster_date IN (ctx.local_date, ctx.local_date - 1)
       JOIN staff_shift_roster_assignments a
         ON a.tenant_id = $1::uuid
        AND a.roster_id = b.id
        AND a.status = 'published'
       JOIN users u
         ON u.tenant_id = $1::uuid
        AND u.id = a.staff_id
        AND u.is_active = TRUE
        AND u.role = ANY($4::text[])
      WHERE (
        (b.shift_end > b.shift_start
          AND b.roster_date = ctx.local_date
          AND ctx.local_time >= b.shift_start
          AND ctx.local_time < b.shift_end)
        OR
        (b.shift_end <= b.shift_start AND (
          (b.roster_date = ctx.local_date AND ctx.local_time >= b.shift_start)
          OR (b.roster_date = ctx.local_date - 1 AND ctx.local_time < b.shift_end)
        ))
      )
      ORDER BY u.uid, a.is_lead DESC, b.roster_date DESC, b.shift_start DESC`,
    tenantId,
    dbTimestamp(occurredAt),
    DEFAULT_TIMEZONE,
    roles,
  );

  const explicitMembers = team.members || [];
  const explicitUids = [...new Set(explicitMembers.map((member) =>
    maybeUuid(member?.staff_uid || member?.staffUid || member?.uid, 'team member staff_uid', { required: true }))
  )];
  let explicitRows = [];
  if (explicitUids.length > 0) {
    explicitRows = await tx.$queryRawUnsafe(
      `SELECT id AS staff_id, uid AS staff_uid, name AS staff_name, role AS role_code
         FROM users
        WHERE tenant_id = $1::uuid
          AND uid = ANY($2::uuid[])
          AND role = ANY($3::text[])
          AND is_active = TRUE`,
      tenantId,
      explicitUids,
      roles,
    );
    if (explicitRows.length !== explicitUids.length) {
      throw AppError.badRequest(
        'Every explicit STEMI team member must be active staff with an approved notification role',
        'STEMI_TEAM_MEMBER_NOT_FOUND',
      );
    }
  }

  const byUid = new Map();
  for (const row of rosterRows) {
    byUid.set(String(row.staff_uid), {
      ...normalizeValue(row),
      assignment_source: 'on_call_role',
    });
  }
  for (const row of explicitRows) {
    const requested = explicitMembers.find((member) =>
      String(member?.staff_uid || member?.staffUid || member?.uid) === String(row.staff_uid));
    byUid.set(String(row.staff_uid), {
      ...normalizeValue(row),
      role_code: row.role_code,
      assignment_source: 'explicit',
      roster_assignment_id: null,
      roster_board_id: null,
      is_lead: requested?.is_lead === true || requested?.isLead === true,
    });
  }
  return {
    ...team,
    members: [...byUid.values()],
    resolved_at: occurredAt,
    timezone: DEFAULT_TIMEZONE,
  };
}

async function validateExistingCathCase(tx, tenantId, caseId, context) {
  if (!caseId) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT cath_case.id, cath_case.tenant_id, cath_case.patient_uid,
            cath_case.encounter_id, cath_case.urgency, cath_case.status,
            cath_case.facility_id, cath_case.requested_procedure, cath_case.team,
            cath_case.timeline_event_id, cath_case.audit_event_id,
            CASE
              WHEN encounter.metadata->>'facility_id' ~ '^[1-9][0-9]*$'
              THEN (encounter.metadata->>'facility_id')::int
              ELSE NULL
            END AS encounter_facility_id
       FROM cath_lab_cases cath_case
       LEFT JOIN patient_encounters encounter
         ON encounter.tenant_id=cath_case.tenant_id
        AND encounter.id=cath_case.encounter_id
        AND encounter.patient_uid=cath_case.patient_uid
      WHERE cath_case.tenant_id = $1::uuid AND cath_case.id = $2::bigint
      FOR UPDATE OF cath_case`,
    tenantId,
    positiveId(caseId, 'cath_case_id'),
  );
  const cathCase = rows[0] || null;
  if (!cathCase) throw AppError.notFound('Cath-lab case not found', 'STEMI_CATH_CASE_NOT_FOUND');
  if (String(cathCase.patient_uid) !== String(context.patientUid)) {
    throw AppError.conflict('Cath-lab case belongs to a different patient', 'STEMI_CATH_PATIENT_MISMATCH');
  }
  if (context.encounterId
    && String(cathCase.encounter_id || '') !== String(context.encounterId)) {
    throw AppError.conflict('Cath-lab case belongs to a different encounter', 'STEMI_CATH_ENCOUNTER_MISMATCH');
  }
  if (cathCase.facility_id == null) {
    throw AppError.conflict(
      'A linked Code-STEMI Cath case requires exact facility authority recovery',
      'STEMI_CATH_CASE_FACILITY_REQUIRED',
    );
  }
  if (cathCase.encounter_facility_id == null) {
    throw AppError.conflict(
      'Linked Code-STEMI Cath case encounter has no exact facility authority',
      'STEMI_CATH_CASE_FACILITY_REQUIRED',
    );
  }
  if (Number(cathCase.encounter_facility_id) !== Number(cathCase.facility_id)) {
    throw AppError.conflict(
      'Linked Code-STEMI Cath case facility does not match its encounter authority',
      'STEMI_CATH_CASE_FACILITY_MISMATCH',
    );
  }
  if (cathCase.urgency !== 'emergency') {
    throw AppError.conflict(
      'A linked Code-STEMI cath-lab case must have emergency urgency',
      'STEMI_CATH_CASE_NOT_EMERGENCY',
    );
  }
  if (['completed', 'cancelled'].includes(cathCase.status)) {
    throw AppError.conflict(
      'A terminal cath-lab case cannot be linked to a new Code-STEMI activation',
      'STEMI_CATH_CASE_TERMINAL',
    );
  }
  return cathCase;
}

async function spawnCathCase(tx, tenantId, activation, team, actorUid, actorRole) {
  const encounterRows = await tx.$queryRawUnsafe(
    `SELECT CASE
              WHEN encounter.metadata->>'facility_id' ~ '^[1-9][0-9]*$'
              THEN (encounter.metadata->>'facility_id')::int
              ELSE NULL
            END AS facility_id
       FROM patient_encounters encounter
       JOIN facilities facility
         ON facility.tenant_id=encounter.tenant_id
        AND encounter.metadata->>'facility_id' ~ '^[1-9][0-9]*$'
        AND facility.id=(encounter.metadata->>'facility_id')::int
        AND facility.status='active'
      WHERE encounter.tenant_id=$1::uuid AND encounter.id=$2::uuid
        AND encounter.patient_uid=$3::uuid
      FOR KEY SHARE OF encounter, facility`,
    tenantId,
    activation.encounter_id,
    activation.patient_uid,
  );
  if (encounterRows.length !== 1 || encounterRows[0].facility_id == null) {
    throw AppError.conflict(
      'Code-STEMI Cath case requires the encounter exact active facility authority',
      'STEMI_CATH_CASE_FACILITY_REQUIRED',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO cath_lab_cases
       (tenant_id, patient_uid, encounter_id, facility_id, requested_procedure, indication,
        urgency, status, team, created_by, updated_by, metadata)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, 'Primary PCI',
             'Code-STEMI activation', 'emergency', 'readiness_pending',
             $5::jsonb, $6::uuid, $6::uuid, $7::jsonb)
     RETURNING *`,
    tenantId,
    activation.patient_uid,
    activation.encounter_id,
    Number(encounterRows[0].facility_id),
    json(team),
    actorUid,
    json({
      stemi_activation_id: String(activation.id),
      facility_id: Number(encounterRows[0].facility_id),
      source: 'nl13_p1c_stemi',
    }),
  );
  const cathCase = rows[0];
  await tx.$queryRawUnsafe(
    `INSERT INTO cath_lab_readiness_checks
       (tenant_id, case_id, check_type, status, required)
     SELECT $1::uuid, $2::bigint, check_type, 'pending', TRUE
       FROM unnest($3::text[]) AS check_type
     ON CONFLICT (tenant_id, case_id, check_type) DO NOTHING`,
    tenantId,
    cathCase.id,
    CATH_READINESS_TYPES,
  );
  const pair = await recordCanonicalPairOrThrow(tx, {
    tenantId,
    patientUid: cathCase.patient_uid,
    encounterId: cathCase.encounter_id,
    eventType: 'cath_lab.case_created',
    eventStatus: cathCase.status,
    sourceTable: 'cath_lab_cases',
    sourceId: cathCase.id,
    resourceType: 'cath_lab_case',
    actorUid,
    actorRole,
    summary: 'Emergency primary-PCI cath-lab case created from Code-STEMI',
    payload: {
      stemi_activation_id: wireId(activation.id),
      facility_id: Number(cathCase.facility_id),
      requested_procedure: cathCase.requested_procedure,
      urgency: cathCase.urgency,
    },
    tags: ['cath_lab', 'stemi', 'primary_pci'],
    afterState: normalizeValue(cathCase),
  });
  const updated = await tx.$queryRawUnsafe(
    `UPDATE cath_lab_cases
        SET timeline_event_id = $3::uuid,
            audit_event_id = $4::uuid,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      RETURNING *`,
    tenantId,
    cathCase.id,
    pair.timeline.id,
    pair.audit.id,
  );
  return updated[0] || cathCase;
}

async function createSlaRows(tx, tenantId, activation, settings) {
  const rows = await tx.$queryRawUnsafe(
    `WITH targets(rule_code, target_minutes) AS (
       VALUES
         ('stemi_door_to_ecg'::text, $10::int),
         ('stemi_door_to_lab'::text, $11::int),
         ('stemi_door_to_balloon'::text, $12::int)
     )
     INSERT INTO workflow_sla_instances
       (tenant_id, rule_id, rule_code, patient_uid, encounter_id,
        source_table, source_id, source_uid, status, priority,
        started_at, due_at, assigned_role_codes, metadata)
     SELECT $1::uuid, NULL::uuid, targets.rule_code, $2::uuid, $3::uuid,
            'stemi_activations', $4::text, $5::uuid, 'active', 'critical',
            $6::timestamptz,
            CASE WHEN targets.target_minutes IS NULL THEN NULL
                 ELSE $6::timestamptz + (targets.target_minutes * INTERVAL '1 minute') END,
            $7::text[],
             jsonb_build_object(
               'source', 'nl13_p1c_stemi_pathway',
               'targets_pending', targets.target_minutes IS NULL,
               'owner_target_pending', targets.target_minutes IS NULL,
               'clock_start_pending', $6::timestamptz IS NULL,
               'door_time_pending', $6::timestamptz IS NULL,
               'target_minutes', targets.target_minutes,
              'owner_clock_source', $8::text,
              'owner_clock_version', $9::text
            )
       FROM targets
     ON CONFLICT (tenant_id, rule_code, source_table, source_id)
     WHERE source_table IS NOT NULL AND source_id IS NOT NULL
     DO UPDATE SET
       status = CASE
         WHEN workflow_sla_instances.status IN ('completed', 'cancelled')
           THEN workflow_sla_instances.status
         ELSE 'active'
       END,
       due_at = CASE
         WHEN workflow_sla_instances.status IN ('completed', 'cancelled')
           THEN workflow_sla_instances.due_at
         ELSE EXCLUDED.due_at
       END,
       started_at = CASE
         WHEN workflow_sla_instances.status IN ('completed', 'cancelled', 'breached')
           THEN workflow_sla_instances.started_at
         ELSE EXCLUDED.started_at
       END,
       assigned_role_codes = EXCLUDED.assigned_role_codes,
       metadata = workflow_sla_instances.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    tenantId,
    activation.patient_uid,
    activation.encounter_id,
    String(activation.id),
    activation.activation_uid,
    dbTimestamp(activation.door_time_at),
    settings.notification_role_codes,
    settings.clock_definition_source,
    settings.clock_definition_version,
    settings.door_to_ecg_target_minutes == null
      ? null
      : Number(settings.door_to_ecg_target_minutes),
    settings.door_to_lab_target_minutes == null
      ? null
      : Number(settings.door_to_lab_target_minutes),
    settings.door_to_balloon_target_minutes == null
      ? null
      : Number(settings.door_to_balloon_target_minutes),
  );
  return rows;
}

async function fanOutTeamNotifications(tx, tenantId, activation, team, actorUid, actorRole) {
  const created = [];
  for (const member of team.members) {
    const payload = {
      kind: 'code-stemi',
      tenant_id: tenantId,
      activation_id: wireId(activation.id),
      patient_uid: activation.patient_uid,
      emergency_visit_id: activation.emergency_visit_id,
      cath_case_id: wireId(activation.cath_case_id),
      status: activation.status,
      activated_at: normalizeValue(activation.activated_at),
    };
    const notificationRows = await tx.$queryRawUnsafe(
      `INSERT INTO stemi_team_notifications
         (tenant_id, activation_id, staff_id, staff_uid, role_code,
          assignment_source, notification_status, notification_payload)
       VALUES ($1::uuid, $2::bigint, $3::int, $4::uuid, $5::text,
               $6::text, 'pending', $7::jsonb)
       RETURNING *`,
      tenantId,
      activation.id,
      member.staff_id,
      member.staff_uid,
      member.role_code,
      member.assignment_source,
      json(payload),
    );
    const notification = notificationRows[0];
    const outboxRows = await tx.$queryRawUnsafe(
      `INSERT INTO notification_outbox
         (tenant_id, type, recipient_id, recipient_phone, title, body,
           payload, status, created_at)
       VALUES ($1::uuid, 'push', $2::text, NULL, 'CODE STEMI',
               'Emergency cath-lab activation requires acknowledgement',
               $3::jsonb, 'PENDING', NOW())
       RETURNING id, status`,
      tenantId,
      String(member.staff_uid),
      json(payload),
    );
    const pair = await recordCanonicalPairOrThrow(tx, {
      tenantId,
      patientUid: activation.patient_uid,
      encounterId: activation.encounter_id,
      eventType: 'stemi.team.notified',
      eventStatus: 'notified',
      sourceTable: 'stemi_team_notifications',
      sourceId: notification.id,
      resourceType: 'stemi_team_notification',
      actorUid,
      actorRole,
      summary: 'Code-STEMI cath-team member notified',
      payload: {
        activation_id: wireId(activation.id),
        staff_uid: member.staff_uid,
        role_code: member.role_code,
        assignment_source: member.assignment_source,
      },
      tags: ['stemi', 'cath_team', 'notification'],
      afterState: { notification_status: 'notified' },
    });
    const updated = await tx.$queryRawUnsafe(
      `UPDATE stemi_team_notifications
          SET notification_status = 'notified',
              notification_outbox_id = $3::int,
              notified_at = NOW(),
              canonical_timeline_event_id = $4::uuid,
              canonical_audit_event_id = $5::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        RETURNING *`,
      tenantId,
      notification.id,
      outboxRows[0].id,
      pair.timeline.id,
      pair.audit.id,
    );
    created.push(updated[0]);
  }
  return created;
}

async function completeSlaForEvent(tx, tenantId, activation, ruleCode, eventId, eventType, occurredAt) {
  const rows = await tx.$queryRawUnsafe(
    `WITH updated AS (
       UPDATE workflow_sla_instances
          SET status = CASE
                WHEN due_at IS NOT NULL AND $4::timestamptz > due_at THEN 'breached'
                ELSE 'completed'
              END,
              completed_at = $4::timestamptz,
              breached_at = CASE
                WHEN due_at IS NOT NULL AND $4::timestamptz > due_at
                  THEN COALESCE(breached_at, $4::timestamptz)
                ELSE breached_at
              END,
              metadata = metadata || jsonb_build_object(
                'completed_by_event_id', $5::text,
                'completed_by_event_type', $6::text
              ),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND rule_code = $2::text
          AND source_table = 'stemi_activations'
          AND source_id = $3::text
          AND status = 'active'
        RETURNING *
     )
     SELECT ${SLA_COLUMNS} FROM updated
     UNION ALL
     SELECT ${SLA_COLUMNS} FROM workflow_sla_instances
      WHERE tenant_id = $1::uuid
        AND rule_code = $2::text
        AND source_table = 'stemi_activations'
        AND source_id = $3::text
        AND NOT EXISTS (SELECT 1 FROM updated)
     LIMIT 1`,
    tenantId,
    ruleCode,
    String(activation.id),
    dbTimestamp(occurredAt),
    eventId,
    eventType,
  );
  return rows[0] || null;
}

async function loadActivation(tx, tenantId, activationId, { lock = false } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${ACTIVATION_COLUMNS} FROM stemi_activations
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      ${lock ? 'FOR UPDATE' : ''}
      LIMIT 1`,
    tenantId,
    positiveId(activationId, 'activation_id'),
  );
  if (!rows[0]) throw AppError.notFound('STEMI activation not found', 'STEMI_ACTIVATION_NOT_FOUND');
  return rows[0];
}

async function updateActivationFromEvent(tx, tenantId, activation, eventType, occurredAt, actorUid) {
  if (['completed', 'stood_down'].includes(activation.status)) {
    throw AppError.conflict(
      'Cannot append pathway milestones to a terminal STEMI activation',
      'STEMI_ACTIVATION_TERMINAL',
    );
  }
  const mappedStatus = STATUS_FROM_EVENT[eventType] || activation.status;
  let nextStatus = activation.status;
  if (mappedStatus !== activation.status) {
    const currentIndex = ACTIVATION_STATUSES.indexOf(activation.status);
    const mappedIndex = ACTIVATION_STATUSES.indexOf(mappedStatus);
    if (mappedIndex > currentIndex) {
      nextStatus = assertActivationTransition(activation.status, mappedStatus);
    }
  }
  const rows = await tx.$queryRawUnsafe(
    `UPDATE stemi_activations
        SET status = $3::text,
            ecg_at = CASE WHEN $4::text = 'ecg_acquired'
                          THEN COALESCE(ecg_at, $5::timestamptz) ELSE ecg_at END,
            lab_notified_at = CASE WHEN $3::text = 'lab_notified'
                                   THEN COALESCE(lab_notified_at, $5::timestamptz)
                                   ELSE lab_notified_at END,
            in_lab_at = CASE WHEN $3::text = 'in_lab'
                             THEN COALESCE(in_lab_at, $5::timestamptz) ELSE in_lab_at END,
            device_deployed_at = CASE WHEN $3::text = 'device_deployed'
                                      THEN COALESCE(device_deployed_at, $5::timestamptz)
                                      ELSE device_deployed_at END,
            completed_at = CASE WHEN $3::text = 'completed'
                                THEN COALESCE(completed_at, $5::timestamptz) ELSE completed_at END,
            updated_by = COALESCE($6::uuid, updated_by),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint AND status = $7::text
      RETURNING *`,
    tenantId,
    activation.id,
    nextStatus,
    eventType,
    dbTimestamp(occurredAt),
    actorUid,
    activation.status,
  );
  if (!rows[0]) throw AppError.conflict('STEMI activation changed concurrently', 'STEMI_STATUS_CONFLICT');
  return rows[0];
}

async function insertPathwayEventTx(tx, {
  tenantId,
  activation,
  eventType,
  occurredAt,
  eventPayload = {},
  metadata = {},
  actorUid = null,
  actorRole = null,
  updateHeader = true,
}) {
  const eventId = randomUUID();
  const seqRows = await tx.$queryRawUnsafe(
    `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_sequence
       FROM stemi_pathway_events
      WHERE tenant_id = $1::uuid AND activation_id = $2::bigint`,
    tenantId,
    activation.id,
  );
  const sequenceNumber = Number(seqRows[0]?.next_sequence || 1);
  const updatedActivation = updateHeader
    ? await updateActivationFromEvent(tx, tenantId, activation, eventType, occurredAt, actorUid)
    : activation;
  const ruleCode = SLA_RULE_FROM_EVENT[eventType] || null;
  const sla = ruleCode
    ? await completeSlaForEvent(
      tx,
      tenantId,
      updatedActivation,
      ruleCode,
      eventId,
      eventType,
      occurredAt,
    )
    : null;
  const pair = await recordCanonicalPairOrThrow(tx, {
    tenantId,
    patientUid: updatedActivation.patient_uid,
    encounterId: updatedActivation.encounter_id,
    eventType: `stemi.pathway.${eventType}`,
    eventStatus: eventType,
    sourceTable: 'stemi_pathway_events',
    sourceId: eventId,
    resourceType: 'stemi_pathway_event',
    actorUid,
    actorRole,
    occurredAt: dbTimestamp(occurredAt),
    summary: `Code-STEMI pathway milestone recorded: ${eventType}`,
    payload: buildPathwayCanonicalPayload(eventPayload, {
      activationId: updatedActivation.id,
      sequenceNumber,
      eventType,
      workflowSlaInstanceId: sla?.id,
    }),
    tags: ['stemi', 'pathway', eventType],
    afterState: { event_type: eventType, sequence_number: sequenceNumber },
    timelineIdempotencyKey: `stemi_pathway_events:${eventId}:timeline`,
    auditIdempotencyKey: `stemi_pathway_events:${eventId}:audit`,
  });
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO stemi_pathway_events
       (id, tenant_id, activation_id, patient_uid, encounter_id,
        sequence_number, event_type, occurred_at, workflow_sla_instance_id,
        event_payload, recorded_by, canonical_timeline_event_id,
        canonical_audit_event_id, metadata)
     VALUES ($1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::uuid,
             $6::int, $7::text, $8::timestamptz, $9::uuid,
             $10::jsonb, $11::uuid, $12::uuid, $13::uuid, $14::jsonb)
     RETURNING *`,
    eventId,
    tenantId,
    updatedActivation.id,
    updatedActivation.patient_uid,
    updatedActivation.encounter_id,
    sequenceNumber,
    eventType,
    occurredAt,
    sla?.id || null,
    json(eventPayload),
    actorUid,
    pair.timeline.id,
    pair.audit.id,
    json(metadata),
  );
  return { event: rows[0], activation: updatedActivation, sla };
}

// The STEMI activation detail is served to STEMI_ROUTE_ROLES — a far wider
// audience than the serology one: RECEPTIONIST, TECHNICIAN, LAB_STAFF and
// RADIOLOGIST all reach GET /activations/:id. The `labs` readiness row's
// metadata carries the lab rail's own snapshot — `live_evidence` (one entry
// per required item, each with a `value_text` that for hiv/hbsag/hcv reads
// `Reactive`/`Non-reactive`, plus its criticality) and `critical_items`. Those
// belong to the cath readiness surface, which gates them by role; the PCI
// evidence bundle only needs to show THAT the check stands and why, so strip
// exactly those two keys and keep the rest of metadata (`critical_warning`,
// `auto_managed`, `auto_pending_reason`, `live_evidence_refreshed_at`). No
// client reads either key from here — the staff app takes `critical_items`
// from the cath readiness endpoint — so this is contract-safe, and the route's
// 200 is the generic Success schema.
const READINESS_LAB_EVIDENCE_KEYS = ['live_evidence', 'critical_items'];

function readinessWithoutLabEvidence(rows = []) {
  return rows.map((row) => {
    const metadata = row?.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return row;
    if (!READINESS_LAB_EVIDENCE_KEYS.some((key) => key in metadata)) return row;
    const next = { ...metadata };
    for (const key of READINESS_LAB_EVIDENCE_KEYS) delete next[key];
    return { ...row, metadata: next };
  });
}

async function getActivationTx(tx, tenantId, activationId) {
  const activation = await loadActivation(tx, tenantId, activationId);
  const [events, slas, acknowledgements, settings] = await Promise.all([
    tx.$queryRawUnsafe(
      `SELECT ${PATHWAY_EVENT_COLUMNS} FROM stemi_pathway_events
        WHERE tenant_id = $1::uuid AND activation_id = $2::bigint
        ORDER BY sequence_number ASC`,
      tenantId,
      activation.id,
    ),
    tx.$queryRawUnsafe(
      `SELECT ${SLA_COLUMNS} FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'stemi_activations'
          AND source_id = $2::text
        ORDER BY rule_code`,
      tenantId,
      String(activation.id),
    ),
    tx.$queryRawUnsafe(
      `SELECT n.id, n.activation_id, n.staff_id, n.staff_uid, n.role_code,
              n.assignment_source, n.notification_status, n.notification_outbox_id,
              n.notified_at, n.acknowledged_by_uid, n.acknowledged_at,
              n.acknowledgement_note, u.name AS staff_name, n.created_at, n.updated_at
         FROM stemi_team_notifications n
         LEFT JOIN users u
           ON u.tenant_id = n.tenant_id AND u.uid = n.staff_uid
        WHERE n.tenant_id = $1::uuid AND n.activation_id = $2::bigint
        ORDER BY n.created_at, n.id`,
      tenantId,
      activation.id,
    ),
    getSettingsTx(tx, tenantId),
  ]);
  let primaryPciEvidence = null;
  if (activation.cath_case_id) {
    const [caseRows, readiness, procedureLogs] = await Promise.all([
      tx.$queryRawUnsafe(
        `SELECT ${CATH_CASE_COLUMNS} FROM cath_lab_cases
          WHERE tenant_id = $1::uuid AND id = $2::bigint
          LIMIT 1`,
        tenantId,
        activation.cath_case_id,
      ),
      tx.$queryRawUnsafe(
        `SELECT ${CATH_READINESS_COLUMNS} FROM cath_lab_readiness_checks
          WHERE tenant_id = $1::uuid AND case_id = $2::bigint
          ORDER BY id`,
        tenantId,
        activation.cath_case_id,
      ),
      tx.$queryRawUnsafe(
        `SELECT ${CATH_PROCEDURE_LOG_COLUMNS} FROM cath_procedure_logs
          WHERE tenant_id = $1::uuid AND case_id = $2::bigint
          ORDER BY created_at DESC`,
        tenantId,
        activation.cath_case_id,
      ),
    ]);
    primaryPciEvidence = {
      cath_case: caseRows[0] || null,
      readiness_checks: readinessWithoutLabEvidence(readiness),
      cath_procedure_logs: procedureLogs,
      sla_instances: slas,
    };
  }
  return normalizeValue({
    activation,
    pathway_events: events,
    sla_instances: slas,
    team_acknowledgements: acknowledgements,
    primary_pci_evidence: primaryPciEvidence,
    settings: settings || { tenant_id: tenantId, enabled: false },
  });
}

export async function createActivation(input = {}) {
  const tenantId = tenantOr(pick(input, 'tenantId', 'tenant_id'));
  const settings = await getStemiPathwaySettings(tenantId);
  assertPathwayEnabled(settings);
  const actorUid = maybeUuid(pick(input, 'actorUid', 'actor_uid', 'created_by'), 'actor_uid');
  const actorRole = cleanText(pick(input, 'actorRole', 'actor_role'), 80);
  const initialStatus = assertActivationTransition(null, 'activated');
  const result = await setTenantTx(tenantId, async (tx) => {
    const context = await resolveClinicalContext(tx, tenantId, input);
    const clock = resolveActivationClock(input, context);
    const team = await resolveTeamMembers(
      tx,
      tenantId,
      settings,
      pick(input, 'team'),
      clock.activatedAt,
    );
    const existingCathCase = await validateExistingCathCase(
      tx,
      tenantId,
      pick(input, 'cath_case_id', 'cathCaseId'),
      context,
    );
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO stemi_activations
         (tenant_id, patient_uid, encounter_id, emergency_visit_id,
          prehospital_handover_id, cath_case_id, activation_source,
          symptom_onset_at, last_known_well_at, first_medical_contact_at,
          door_time_at, ecg_at, activated_at, team, status,
          activation_criteria, owner_target_minutes, clock_metadata,
          metadata, created_by, updated_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int,
               $5::bigint, $6::bigint, $7::text,
               $8::timestamptz, $9::timestamptz, $10::timestamptz,
               $11::timestamptz, $12::timestamptz, $13::timestamptz,
               $14::jsonb, $15::text, $16::jsonb, $17::jsonb,
               $18::jsonb, $19::jsonb, $20::uuid, $20::uuid)
       RETURNING *`,
      tenantId,
      context.patientUid,
      context.encounterId,
      context.emergencyVisitId,
      context.prehospitalHandoverId,
      existingCathCase?.id || null,
      context.activationSource,
      dbTimestamp(clock.symptomOnsetAt),
      dbTimestamp(clock.lastKnownWellAt),
      dbTimestamp(clock.firstMedicalContactAt),
      dbTimestamp(clock.doorTimeAt),
      dbTimestamp(clock.ecgAt),
      dbTimestamp(clock.activatedAt),
      json(team),
      initialStatus,
      json(settings.activation_criteria || {}),
      json({
        door_to_ecg: settings.door_to_ecg_target_minutes ?? null,
        door_to_lab: settings.door_to_lab_target_minutes ?? null,
        door_to_balloon: settings.door_to_balloon_target_minutes ?? null,
      }),
      json({
        source: settings.clock_definition_source,
        version: settings.clock_definition_version,
        attachment_refs: settings.clock_definition_attachment_refs || [],
      }),
      json(jsonObject(pick(input, 'metadata'), 'metadata')),
      actorUid,
    );
    let activation = rows[0];
    let cathCase = existingCathCase;
    if (!cathCase && pick(input, 'spawn_cath_case', 'spawnCathCase') !== false) {
      cathCase = await spawnCathCase(tx, tenantId, activation, team, actorUid, actorRole);
      const linked = await tx.$queryRawUnsafe(
        `UPDATE stemi_activations
            SET cath_case_id = $3::bigint, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::bigint
          RETURNING *`,
        tenantId,
        activation.id,
        cathCase.id,
      );
      activation = linked[0];
    }
    await createSlaRows(tx, tenantId, activation, settings);
    const notifications = await fanOutTeamNotifications(
      tx,
      tenantId,
      activation,
      team,
      actorUid,
      actorRole,
    );
    if (notifications.length > 0) {
      const notified = await tx.$queryRawUnsafe(
        `UPDATE stemi_activations
            SET status = 'lab_notified', lab_notified_at = NOW(), updated_by = $3::uuid, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::bigint AND status = 'activated'
          RETURNING *`,
        tenantId,
        activation.id,
        actorUid,
      );
      activation = notified[0] || activation;
    }
    const pair = await recordCanonicalPairOrThrow(tx, {
      tenantId,
      patientUid: activation.patient_uid,
      encounterId: activation.encounter_id,
      eventType: 'stemi.activation.created',
      eventStatus: activation.status,
      sourceTable: 'stemi_activations',
      sourceId: activation.id,
      sourceUid: activation.activation_uid,
      resourceType: 'stemi_activation',
      actorUid,
      actorRole,
      occurredAt: activation.activated_at,
      summary: 'Code-STEMI pathway activation recorded',
      payload: {
        activation_source: activation.activation_source,
        emergency_visit_id: activation.emergency_visit_id,
        prehospital_handover_id: wireId(activation.prehospital_handover_id),
        cath_case_id: wireId(activation.cath_case_id),
        notified_team_members: notifications.length,
      },
      tags: ['stemi', 'code_stemi', 'primary_pci'],
      afterState: { status: activation.status },
    });
    const linkedCanonical = await tx.$queryRawUnsafe(
      `UPDATE stemi_activations
          SET canonical_timeline_event_id = $3::uuid,
              canonical_audit_event_id = $4::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        RETURNING *`,
      tenantId,
      activation.id,
      pair.timeline.id,
      pair.audit.id,
    );
    activation = linkedCanonical[0] || activation;
    const activationEvent = await insertPathwayEventTx(tx, {
      tenantId,
      activation,
      eventType: 'activation',
      occurredAt: clock.activatedAt,
      eventPayload: { activation_source: activation.activation_source },
      actorUid,
      actorRole,
      updateHeader: false,
    });
    activation = activationEvent.activation;
    if (clock.ecgAt) {
      const ecgEvent = await insertPathwayEventTx(tx, {
        tenantId,
        activation,
        eventType: 'ecg_acquired',
        occurredAt: clock.ecgAt,
        eventPayload: { source: 'activation_payload' },
        actorUid,
        actorRole,
      });
      activation = ecgEvent.activation;
    }
    return getActivationTx(tx, tenantId, activation.id);
  }).catch((err) => {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(
        'An active Code-STEMI activation already exists for this patient',
        'STEMI_ACTIVE_ACTIVATION_EXISTS',
      );
    }
    throw err;
  });
  emitCodeStemi({
    kind: 'activation-created',
    tenantId,
    activation: result.activation,
  });
  return result;
}

export async function recordActivationDoorTime({
  tenantId,
  id,
  doorTimeAt,
  actorUid,
  actorRole = null,
} = {}) {
  const tid = tenantOr(tenantId);
  const actor = maybeUuid(actorUid, 'actor_uid', { required: true });
  const doorTime = asIso(doorTimeAt, 'door_time_at', { required: true });
  const result = await setTenantTx(tid, async (tx) => {
    const current = await loadActivation(tx, tid, id, { lock: true });
    if (current.activation_source !== 'prehospital_handover') {
      throw AppError.conflict(
        'A deferred door clock is only valid for a pre-hospital activation',
        'STEMI_DEFERRED_DOOR_CLOCK_NOT_ALLOWED',
      );
    }
    const doorTimestamp = new Date(doorTime).getTime();
    if (doorTimestamp < new Date(current.activated_at).getTime()) {
      throw AppError.conflict(
        'A pre-hospital door time cannot precede the activation time',
        'STEMI_DOOR_TIME_BEFORE_ACTIVATION',
      );
    }
    if (doorTimestamp > Date.now() + 5 * 60 * 1000) {
      throw AppError.badRequest(
        'door_time_at cannot be in the future',
        'STEMI_DOOR_TIME_FUTURE',
      );
    }
    if (current.emergency_visit_id) {
      const visits = await tx.$queryRawUnsafe(
        `SELECT id, patient_uid, arrival_at
           FROM emergency_visits
          WHERE tenant_id = $1::uuid AND id = $2::int
          LIMIT 1`,
        tid,
        current.emergency_visit_id,
      );
      const visit = visits[0] || null;
      if (!visit || String(visit.patient_uid) !== String(current.patient_uid)) {
        throw AppError.conflict(
          'The linked ED visit does not match this activation',
          'STEMI_ED_VISIT_CONTEXT_MISMATCH',
        );
      }
      if (new Date(visit.arrival_at).getTime() !== doorTimestamp) {
        throw AppError.conflict(
          'door_time_at does not match the linked ED visit arrival time',
          'STEMI_DOOR_TIME_ED_VISIT_MISMATCH',
        );
      }
    }
    if (current.door_time_at
      && new Date(current.door_time_at).getTime() !== new Date(doorTime).getTime()) {
      throw AppError.conflict(
        'door_time_at has already been recorded and cannot be replaced',
        'STEMI_DOOR_TIME_IMMUTABLE',
      );
    }
    if (current.door_time_at) return getActivationTx(tx, tid, current.id);

    const rows = await tx.$queryRawUnsafe(
      `UPDATE stemi_activations
          SET door_time_at = $3::timestamptz,
              clock_metadata = clock_metadata || jsonb_build_object(
                'door_time_recorded_at', NOW(),
                'door_time_recorded_by', $4::text
              ),
              updated_by = $4::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND door_time_at IS NULL
        RETURNING *`,
      tid,
      current.id,
      dbTimestamp(doorTime),
      actor,
    );
    if (!rows[0]) {
      throw AppError.conflict('STEMI activation changed concurrently', 'STEMI_CLOCK_CONFLICT');
    }
    const updated = rows[0];
    await tx.$queryRawUnsafe(
      `UPDATE workflow_sla_instances
          SET started_at = $3::timestamptz,
              due_at = CASE
                WHEN NULLIF(metadata->>'target_minutes', '') IS NULL THEN NULL
                ELSE $3::timestamptz
                  + ((metadata->>'target_minutes')::int * INTERVAL '1 minute')
              END,
              status = CASE
                WHEN status IN ('completed', 'breached')
                  AND completed_at IS NOT NULL
                  AND NULLIF(metadata->>'target_minutes', '') IS NOT NULL
                  AND completed_at > $3::timestamptz
                    + ((metadata->>'target_minutes')::int * INTERVAL '1 minute')
                  THEN 'breached'
                WHEN status IN ('completed', 'breached') THEN 'completed'
                ELSE status
              END,
              breached_at = CASE
                WHEN status IN ('completed', 'breached')
                  AND completed_at IS NOT NULL
                  AND NULLIF(metadata->>'target_minutes', '') IS NOT NULL
                  AND completed_at > $3::timestamptz
                    + ((metadata->>'target_minutes')::int * INTERVAL '1 minute')
                  THEN COALESCE(breached_at, completed_at)
                WHEN status IN ('completed', 'breached') THEN NULL
                ELSE breached_at
              END,
              metadata = metadata || jsonb_build_object(
                'clock_start_pending', false,
                'door_time_pending', false,
                'targets_pending', NULLIF(metadata->>'target_minutes', '') IS NULL,
                'owner_target_pending', NULLIF(metadata->>'target_minutes', '') IS NULL,
                'door_time_recorded_at', NOW(),
                'door_time_recorded_by', $4::text
              ),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND source_table = 'stemi_activations'
          AND source_id = $2::text`,
      tid,
      String(current.id),
      dbTimestamp(doorTime),
      actor,
    );
    await recordCanonicalPairOrThrow(tx, {
      tenantId: tid,
      patientUid: updated.patient_uid,
      encounterId: updated.encounter_id,
      eventType: 'stemi.activation.door_time_recorded',
      eventStatus: updated.status,
      sourceTable: 'stemi_activations',
      sourceId: updated.id,
      sourceUid: updated.activation_uid,
      resourceType: 'stemi_activation',
      actorUid: actor,
      actorRole,
      occurredAt: doorTime,
      summary: 'Code-STEMI door time recorded and SLA clocks started',
      payload: { door_time_at: doorTime },
      tags: ['stemi', 'door_time', 'sla'],
      beforeState: { door_time_at: null },
      afterState: { door_time_at: doorTime },
      timelineIdempotencyKey: `stemi_activations:${updated.id}:door-time:timeline`,
      auditIdempotencyKey: `stemi_activations:${updated.id}:door-time:audit`,
    });
    return getActivationTx(tx, tid, updated.id);
  });
  emitCodeStemi({ kind: 'door-time-recorded', tenantId: tid, activation: result.activation });
  return result;
}

export async function listActivations({
  tenantId,
  activeOnly = false,
  status = null,
  patientUid = null,
  limit = DEFAULT_LIMIT,
} = {}) {
  const tid = tenantOr(tenantId);
  const cleanStatus = status == null ? null : cleanText(status, 32)?.toLowerCase();
  if (cleanStatus && !ACTIVATION_STATUSES.includes(cleanStatus)) {
    throw AppError.badRequest('Invalid STEMI activation status', 'STEMI_BAD_STATUS');
  }
  const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT ${ACTIVATION_COLUMNS_A}, p.name AS patient_name,
             (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.rule_code), '[]'::jsonb)
               FROM workflow_sla_instances s
              WHERE s.tenant_id = a.tenant_id
                AND s.source_table = 'stemi_activations'
                AND s.source_id = a.id::text) AS sla_instances,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'id', n.id,
                       'activation_id', n.activation_id,
                       'staff_id', n.staff_id,
                       'staff_uid', n.staff_uid,
                       'staff_name', u.name,
                       'role_code', n.role_code,
                       'assignment_source', n.assignment_source,
                       'notification_status', n.notification_status,
                       'notified_at', n.notified_at,
                       'acknowledged_by_uid', n.acknowledged_by_uid,
                       'acknowledged_at', n.acknowledged_at,
                       'acknowledgement_note', n.acknowledgement_note,
                       'created_at', n.created_at,
                       'updated_at', n.updated_at
                     ) ORDER BY n.created_at, n.id), '[]'::jsonb)
                FROM stemi_team_notifications n
                LEFT JOIN users u
                  ON u.tenant_id = n.tenant_id AND u.uid = n.staff_uid
               WHERE n.tenant_id = a.tenant_id
                 AND n.activation_id = a.id) AS team_acknowledgements
       FROM stemi_activations a
       JOIN users p
         ON p.tenant_id = a.tenant_id AND p.uid = a.patient_uid
      WHERE a.tenant_id = $1::uuid
        AND ($2::boolean = FALSE OR a.status = ANY($3::text[]))
        AND ($4::text IS NULL OR a.status = $4::text)
        AND ($5::uuid IS NULL OR a.patient_uid = $5::uuid)
      ORDER BY a.activated_at DESC
      LIMIT $6::int`,
    tid,
    parseBoolean(activeOnly),
    NONTERMINAL_STATUSES,
    cleanStatus,
    maybeUuid(patientUid, 'patient_uid'),
    boundedLimit(limit),
  ));
  return normalizeValue({ activations: rows, count: rows.length });
}

export async function getActivation({ tenantId, id } = {}) {
  const tid = tenantOr(tenantId);
  return setTenant(tid, (tx) => getActivationTx(tx, tid, id));
}

export async function updateActivationStatus({
  tenantId,
  id,
  status,
  standDownReason = null,
  actorUid = null,
  actorRole = null,
} = {}) {
  const tid = tenantOr(tenantId);
  const requestedStatus = cleanText(status, 32)?.toLowerCase();
  if (requestedStatus !== 'stood_down') {
    throw AppError.badRequest(
      'Clinical STEMI progress must be recorded through pathway events; direct status updates only support stand-down',
      'STEMI_STATUS_EVENT_REQUIRED',
    );
  }
  const actor = maybeUuid(actorUid, 'actor_uid');
  const result = await setTenantTx(tid, async (tx) => {
    const current = await loadActivation(tx, tid, id, { lock: true });
    const next = assertActivationTransition(current.status, requestedStatus, standDownReason);
    const rows = await tx.$queryRawUnsafe(
      `UPDATE stemi_activations
          SET status = $3::text,
              stand_down_reason = CASE WHEN $3::text = 'stood_down' THEN $4::text ELSE stand_down_reason END,
              stood_down_at = CASE WHEN $3::text = 'stood_down' THEN NOW() ELSE stood_down_at END,
              completed_at = CASE WHEN $3::text = 'completed' THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
              lab_notified_at = CASE WHEN $3::text = 'lab_notified' THEN COALESCE(lab_notified_at, NOW()) ELSE lab_notified_at END,
              in_lab_at = CASE WHEN $3::text = 'in_lab' THEN COALESCE(in_lab_at, NOW()) ELSE in_lab_at END,
              device_deployed_at = CASE WHEN $3::text = 'device_deployed' THEN COALESCE(device_deployed_at, NOW()) ELSE device_deployed_at END,
              updated_by = COALESCE($5::uuid, updated_by),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint AND status = $6::text
        RETURNING *`,
      tid,
      current.id,
      next,
      cleanText(standDownReason),
      actor,
      current.status,
    );
    if (!rows[0]) throw AppError.conflict('STEMI activation changed concurrently', 'STEMI_STATUS_CONFLICT');
    const updated = rows[0];
    if (next === 'stood_down') {
      await tx.$queryRawUnsafe(
        `UPDATE workflow_sla_instances
            SET status = 'cancelled',
                metadata = metadata || jsonb_build_object(
                  'cancel_reason', $3::text,
                  'cancelled_by', $4::text
                ),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND source_table = 'stemi_activations'
            AND source_id = $2::text
            AND status = 'active'`,
        tid,
        String(updated.id),
        cleanText(standDownReason),
        actor,
      );
    }
    await recordCanonicalPairOrThrow(tx, {
      tenantId: tid,
      patientUid: updated.patient_uid,
      encounterId: updated.encounter_id,
      eventType: `stemi.activation.${next}`,
      eventStatus: next,
      sourceTable: 'stemi_activations',
      sourceId: updated.id,
      sourceUid: updated.activation_uid,
      resourceType: 'stemi_activation',
      actorUid: actor,
      actorRole,
      summary: `Code-STEMI activation status changed to ${next}`,
      payload: { from_status: current.status, to_status: next, stand_down_reason: cleanText(standDownReason) },
      tags: ['stemi', 'status'],
      beforeState: { status: current.status },
      afterState: { status: next },
      timelineIdempotencyKey: `stemi_activations:${updated.id}:status:${next}:timeline`,
      auditIdempotencyKey: `stemi_activations:${updated.id}:status:${next}:audit`,
    });
    return getActivationTx(tx, tid, updated.id);
  });
  emitCodeStemi({ kind: 'status-changed', tenantId: tid, activation: result.activation });
  return result;
}

export async function recordPathwayEvent(input = {}) {
  const tenantId = tenantOr(pick(input, 'tenantId', 'tenant_id'));
  const settings = await getStemiPathwaySettings(tenantId);
  assertPathwayEnabled(settings);
  const activationId = positiveId(pick(input, 'activationId', 'activation_id'), 'activation_id');
  const eventType = cleanText(pick(input, 'event_type', 'eventType'), 40)?.toLowerCase();
  if (!PATHWAY_EVENT_TYPES.includes(eventType) || eventType === 'activation') {
    throw AppError.badRequest('Invalid STEMI pathway event type', 'STEMI_BAD_EVENT_TYPE', {
      allowed: PATHWAY_EVENT_TYPES.filter((type) => type !== 'activation'),
    });
  }
  const occurredAt = asIso(pick(input, 'occurred_at', 'occurredAt') || new Date(), 'occurred_at', {
    required: true,
  });
  const actorUid = maybeUuid(
    pick(input, 'actorUid', 'actor_uid', 'recorded_by', 'recordedBy'),
    'actor_uid',
  );
  const actorRole = cleanText(pick(input, 'actorRole', 'actor_role'), 80);
  const result = await setTenantTx(tenantId, async (tx) => {
    const activation = await loadActivation(tx, tenantId, activationId, { lock: true });
    const written = await insertPathwayEventTx(tx, {
      tenantId,
      activation,
      eventType,
      occurredAt,
      eventPayload: jsonObject(pick(input, 'event_payload', 'eventPayload'), 'event_payload'),
      metadata: jsonObject(pick(input, 'metadata'), 'metadata'),
      actorUid,
      actorRole,
    });
    return {
      event: normalizeValue(written.event),
      activation: normalizeValue(written.activation),
      sla_instance: normalizeValue(written.sla),
    };
  });
  emitCodeStemi({ kind: 'pathway-event-recorded', tenantId, activation: result.activation });
  return result;
}

export async function acknowledgeActivation({
  tenantId,
  activationId,
  actorUid,
  actorRole = null,
  acknowledgementNote = null,
} = {}) {
  const tid = tenantOr(tenantId);
  const actor = maybeUuid(actorUid, 'actor_uid', { required: true });
  const result = await setTenantTx(tid, async (tx) => {
    const activation = await loadActivation(tx, tid, activationId, { lock: true });
    const rows = await tx.$queryRawUnsafe(
      `SELECT ${TEAM_NOTIFICATION_COLUMNS} FROM stemi_team_notifications
        WHERE tenant_id = $1::uuid
          AND activation_id = $2::bigint
          AND staff_uid = $3::uuid
        FOR UPDATE`,
      tid,
      activation.id,
      actor,
    );
    const current = rows[0] || null;
    if (!current) {
      throw AppError.forbidden(
        'Only a notified cath-team member can acknowledge this activation',
        'STEMI_TEAM_MEMBERSHIP_REQUIRED',
      );
    }
    if (current.notification_status === 'acknowledged') return normalizeValue(current);
    const pair = await recordCanonicalPairOrThrow(tx, {
      tenantId: tid,
      patientUid: activation.patient_uid,
      encounterId: activation.encounter_id,
      eventType: 'stemi.team.acknowledged',
      eventStatus: 'acknowledged',
      sourceTable: 'stemi_team_notifications',
      sourceId: current.id,
      resourceType: 'stemi_team_notification',
      actorUid: actor,
      actorRole,
      summary: 'Code-STEMI cath-team notification acknowledged',
      payload: {
        activation_id: wireId(activation.id),
        staff_uid: actor,
        role_code: current.role_code,
        acknowledgement_note: cleanText(acknowledgementNote),
      },
      tags: ['stemi', 'cath_team', 'acknowledgement'],
      beforeState: { notification_status: current.notification_status },
      afterState: { notification_status: 'acknowledged' },
      timelineIdempotencyKey: `stemi_team_notifications:${current.id}:acknowledged:timeline`,
      auditIdempotencyKey: `stemi_team_notifications:${current.id}:acknowledged:audit`,
    });
    const updated = await tx.$queryRawUnsafe(
      `UPDATE stemi_team_notifications
          SET notification_status = 'acknowledged',
              acknowledged_by_uid = $3::uuid,
              acknowledged_at = NOW(),
              acknowledgement_note = $4::text,
              canonical_timeline_event_id = $5::uuid,
              canonical_audit_event_id = $6::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        RETURNING *`,
      tid,
      current.id,
      actor,
      cleanText(acknowledgementNote),
      pair.timeline.id,
      pair.audit.id,
    );
    return normalizeValue(updated[0]);
  });
  emitCodeStemi({
    kind: 'team-acknowledged',
    tenantId: tid,
    activation: { id: activationId, status: 'lab_notified' },
  });
  return result;
}

export const __testing__ = {
  settingsCacheDelete,
  validateActivationClock,
  resolveActivationClock,
  assertActivationTransition,
  normalizeTeam,
  optionalPositiveMinutes,
  normalizeCathNotificationRoleCodes,
  buildPathwayCanonicalPayload,
  dbTimestamp,
};
