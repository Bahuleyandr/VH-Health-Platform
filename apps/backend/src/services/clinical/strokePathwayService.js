import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { cancelWorkflowSla, recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';
import { hasActivePrivilege } from '../staff/credentialingService.js';
import { requireTenantId } from '../tenant/tenantService.js';

const REFRESH_INTERVAL_MS = 60 * 1000;
const settingsCache = new Map();

const ACTIVATION_STATUSES = new Set([
  'active',
  'imaging',
  'decision_pending',
  'treated',
  'transferred',
  'disposed',
  'closed',
  'cancelled',
]);

const ACTIVATION_TRANSITIONS = {
  active: ['imaging', 'decision_pending', 'cancelled', 'closed'],
  imaging: ['decision_pending', 'treated', 'transferred', 'disposed', 'cancelled', 'closed'],
  decision_pending: ['treated', 'transferred', 'disposed', 'cancelled', 'closed'],
  treated: ['transferred', 'disposed', 'closed'],
  transferred: ['disposed', 'closed'],
  disposed: ['closed'],
  closed: [],
  cancelled: [],
};

const SIGNED_NIHSS_STATUSES = new Set(['signed']);
const APPROVAL_DECISION_STATUSES = new Set(['approved', 'administered']);
const PATHWAY_EVENT_TYPES = new Set([
  'ct_order',
  'ct_start',
  'ct_result',
  'neurology_review',
  'decision',
  'treatment_start',
  'transfer',
  'disposition',
]);

const STATUS_FROM_EVENT = {
  ct_order: 'imaging',
  ct_start: 'imaging',
  ct_result: 'decision_pending',
  neurology_review: 'decision_pending',
  decision: 'decision_pending',
  treatment_start: 'treated',
  transfer: 'transferred',
  disposition: 'disposed',
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function tenantOr(value) {
  return requireTenantId(String(value || '').trim());
}

function cleanString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function intId(value, label = 'id') {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'INVALID_STROKE_ID');
  }
  return n;
}

function boundedLimit(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

function jsonString(value, fallback = {}) {
  const safe = value === undefined || value === null ? fallback : value;
  return JSON.stringify(safe);
}

function arrayJsonString(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function asIso(value, label, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`, 'STROKE_TIMESTAMP_REQUIRED');
    return null;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest(`${label} must be a valid timestamp`, 'STROKE_INVALID_TIMESTAMP');
  }
  return date.toISOString();
}

function parseMaybeDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function requireOwnerSource({ source, version }, code, label) {
  if (!cleanString(source) || !cleanString(version)) {
    throw AppError.forbidden(
      `${label} source and version are required before sign-off`,
      code,
      { source_present: !!cleanString(source), version_present: !!cleanString(version) },
    );
  }
}

function cacheGet(tenantId) {
  const hit = settingsCache.get(String(tenantId));
  if (!hit || Date.now() - hit.fetchedAt > REFRESH_INTERVAL_MS) return null;
  return hit.value;
}

function cacheSet(tenantId, value) {
  settingsCache.set(String(tenantId), { value, fetchedAt: Date.now() });
}

function cacheDelete(tenantId) {
  settingsCache.delete(String(tenantId));
}

function normalizeItemScore(score, label) {
  const value = Number(score);
  if (!Number.isInteger(value) || value < 0) {
    throw AppError.badRequest(`${label} must be a non-negative integer`, 'STROKE_NIHSS_INVALID_ITEM_SCORE');
  }
  return value;
}

export function computeNihssTotal(itemScores) {
  if (Array.isArray(itemScores)) {
    return itemScores.reduce((sum, item, index) => {
      const score = typeof item === 'object' && item !== null ? item.score : item;
      return sum + normalizeItemScore(score, `NIHSS item ${index + 1}`);
    }, 0);
  }
  if (itemScores && typeof itemScores === 'object') {
    return Object.entries(itemScores).reduce((sum, [key, value]) => {
      const score = typeof value === 'object' && value !== null ? value.score : value;
      return sum + normalizeItemScore(score, `NIHSS item ${key}`);
    }, 0);
  }
  throw AppError.badRequest('NIHSS item scores must be an array or object', 'STROKE_NIHSS_ITEMS_REQUIRED');
}

export function validateActivationClock({
  last_known_well_at,
  lastKnownWellAt,
  arrived_at,
  arrivedAt,
  door_time_at,
  doorTimeAt,
  activated_at,
  activatedAt,
} = {}) {
  const lastKnownWell = parseMaybeDate(last_known_well_at ?? lastKnownWellAt);
  const arrived = parseMaybeDate(arrived_at ?? arrivedAt);
  const door = parseMaybeDate(door_time_at ?? doorTimeAt);
  const activated = parseMaybeDate(activated_at ?? activatedAt) || new Date();
  if (!door) {
    throw AppError.badRequest('door_time_at is required', 'STROKE_DOOR_TIME_REQUIRED');
  }
  if (lastKnownWell && lastKnownWell > door) {
    throw AppError.badRequest(
      'Last-known-well must be at or before door time',
      'STROKE_CLOCK_LAST_KNOWN_WELL_AFTER_DOOR',
    );
  }
  if (arrived && arrived > activated) {
    throw AppError.badRequest(
      'Arrival time cannot be after activation time',
      'STROKE_CLOCK_ARRIVAL_AFTER_ACTIVATION',
    );
  }
  if (door > new Date(activated.getTime() + 5 * 60 * 1000)) {
    throw AppError.badRequest(
      'Door time cannot be more than five minutes after activation time',
      'STROKE_CLOCK_DOOR_AFTER_ACTIVATION',
    );
  }
  return {
    lastKnownWellAt: lastKnownWell ? lastKnownWell.toISOString() : null,
    arrivedAt: arrived ? arrived.toISOString() : null,
    doorTimeAt: door.toISOString(),
    activatedAt: activated.toISOString(),
  };
}

export function assertActivationStatusTransition(currentStatus, nextStatus) {
  const current = cleanString(currentStatus)?.toLowerCase();
  const next = cleanString(nextStatus)?.toLowerCase();
  if (!ACTIVATION_STATUSES.has(next)) {
    throw AppError.badRequest('Invalid stroke activation status', 'STROKE_INVALID_STATUS', {
      allowed: [...ACTIVATION_STATUSES],
    });
  }
  if (!current) return next;
  const allowed = ACTIVATION_TRANSITIONS[current] || [];
  if (!allowed.includes(next)) {
    throw AppError.invalidTransition(current, next, allowed);
  }
  return next;
}

function assertEnabledSettings(settings) {
  if (!settings?.enabled) {
    throw AppError.forbidden(
      'Stroke pathway is not enabled for this tenant',
      'STROKE_PATHWAY_DISABLED',
    );
  }
  if (!settings.door_to_ct_target_minutes || !settings.door_to_needle_target_minutes) {
    throw AppError.forbidden(
      'Stroke pathway SLA targets are not configured',
      'STROKE_SLA_TARGETS_REQUIRED',
    );
  }
}

export async function getStrokePathwaySettings(tenantId) {
  const tid = tenantOr(tenantId);
  const cached = cacheGet(tid);
  if (cached) return cached;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id, enabled, enabled_at, enabled_by,
              clock_definition_source, clock_definition_version, clock_definition_attachment_refs,
              nihss_source, nihss_version, nihss_attachment_refs,
              thrombolysis_protocol_source, thrombolysis_protocol_version,
              thrombolysis_protocol_attachment_refs, thrombolysis_approver_privilege_key,
              door_to_ct_target_minutes, door_to_needle_target_minutes,
              acceptance_snapshot, metadata, created_at, updated_at
         FROM stroke_pathway_settings
        WHERE tenant_id = $1::uuid
        LIMIT 1`,
      tid,
    );
    const value = rows[0] || {
      tenant_id: tid,
      enabled: false,
      reason: 'settings_missing',
    };
    cacheSet(tid, value);
    return value;
  } catch (err) {
    logger.warn('getStrokePathwaySettings failed', { tenantId: tid, message: err.message });
    return { tenant_id: tid, enabled: false, reason: 'settings_unavailable' };
  }
}

export async function isStrokePathwayEnabled(tenantId) {
  const settings = await getStrokePathwaySettings(tenantId);
  return settings?.enabled === true;
}

export async function setStrokePathwaySettings({
  tenantId,
  enabled = false,
  actorUid = null,
  clockDefinitionSource = null,
  clockDefinitionVersion = null,
  clockDefinitionAttachmentRefs = [],
  nihssSource = null,
  nihssVersion = null,
  nihssAttachmentRefs = [],
  thrombolysisProtocolSource = null,
  thrombolysisProtocolVersion = null,
  thrombolysisProtocolAttachmentRefs = [],
  thrombolysisApproverPrivilegeKey = null,
  doorToCtTargetMinutes = null,
  doorToNeedleTargetMinutes = null,
  acceptanceSnapshot = null,
  metadata = {},
} = {}) {
  const tid = tenantOr(tenantId);
  const enabledBool = enabled === true;
  if (enabledBool) {
    requireOwnerSource(
      { source: clockDefinitionSource, version: clockDefinitionVersion },
      'STROKE_CLOCK_SOURCE_REQUIRED',
      'Stroke clock definition',
    );
    requireOwnerSource(
      { source: nihssSource, version: nihssVersion },
      'STROKE_NIHSS_SOURCE_REQUIRED',
      'NIHSS',
    );
    requireOwnerSource(
      { source: thrombolysisProtocolSource, version: thrombolysisProtocolVersion },
      'STROKE_THROMBOLYSIS_PROTOCOL_REQUIRED',
      'Thrombolysis protocol',
    );
    if (!actorUid) {
      throw AppError.badRequest('enabled_by is required when enabling stroke pathway', 'STROKE_ENABLED_BY_REQUIRED');
    }
    if (!Number.isInteger(Number(doorToCtTargetMinutes)) || Number(doorToCtTargetMinutes) <= 0
      || !Number.isInteger(Number(doorToNeedleTargetMinutes)) || Number(doorToNeedleTargetMinutes) <= 0) {
      throw AppError.badRequest('Stroke SLA targets must be positive minutes', 'STROKE_SLA_TARGETS_REQUIRED');
    }
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO stroke_pathway_settings
       (tenant_id, enabled, enabled_at, enabled_by,
        clock_definition_source, clock_definition_version, clock_definition_attachment_refs,
        nihss_source, nihss_version, nihss_attachment_refs,
        thrombolysis_protocol_source, thrombolysis_protocol_version,
        thrombolysis_protocol_attachment_refs, thrombolysis_approver_privilege_key,
        door_to_ct_target_minutes, door_to_needle_target_minutes,
        acceptance_snapshot, metadata, updated_at)
     VALUES (
       $1::uuid, $2,
       CASE WHEN $2 THEN NOW() ELSE NULL END,
       CASE WHEN $2 THEN $3::uuid ELSE NULL END,
       $4, $5, $6::jsonb,
       $7, $8, $9::jsonb,
       $10, $11, $12::jsonb, $13,
       $14::int, $15::int, $16::jsonb, $17::jsonb, NOW()
     )
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = $2,
       enabled_at = CASE WHEN $2 THEN NOW() ELSE stroke_pathway_settings.enabled_at END,
       enabled_by = CASE WHEN $2 THEN $3::uuid ELSE stroke_pathway_settings.enabled_by END,
       clock_definition_source = COALESCE($4, stroke_pathway_settings.clock_definition_source),
       clock_definition_version = COALESCE($5, stroke_pathway_settings.clock_definition_version),
       clock_definition_attachment_refs = $6::jsonb,
       nihss_source = COALESCE($7, stroke_pathway_settings.nihss_source),
       nihss_version = COALESCE($8, stroke_pathway_settings.nihss_version),
       nihss_attachment_refs = $9::jsonb,
       thrombolysis_protocol_source = COALESCE($10, stroke_pathway_settings.thrombolysis_protocol_source),
       thrombolysis_protocol_version = COALESCE($11, stroke_pathway_settings.thrombolysis_protocol_version),
       thrombolysis_protocol_attachment_refs = $12::jsonb,
       thrombolysis_approver_privilege_key = $13,
       door_to_ct_target_minutes = COALESCE($14::int, stroke_pathway_settings.door_to_ct_target_minutes),
       door_to_needle_target_minutes = COALESCE($15::int, stroke_pathway_settings.door_to_needle_target_minutes),
       acceptance_snapshot = CASE WHEN $2 THEN $16::jsonb ELSE stroke_pathway_settings.acceptance_snapshot END,
       metadata = COALESCE(stroke_pathway_settings.metadata, '{}'::jsonb) || $17::jsonb,
       updated_at = NOW()
     RETURNING *`,
    tid,
    enabledBool,
    actorUid,
    cleanString(clockDefinitionSource),
    cleanString(clockDefinitionVersion),
    arrayJsonString(clockDefinitionAttachmentRefs),
    cleanString(nihssSource),
    cleanString(nihssVersion),
    arrayJsonString(nihssAttachmentRefs),
    cleanString(thrombolysisProtocolSource),
    cleanString(thrombolysisProtocolVersion),
    arrayJsonString(thrombolysisProtocolAttachmentRefs),
    cleanString(thrombolysisApproverPrivilegeKey),
    doorToCtTargetMinutes == null ? null : Number(doorToCtTargetMinutes),
    doorToNeedleTargetMinutes == null ? null : Number(doorToNeedleTargetMinutes),
    jsonString(acceptanceSnapshot, {}),
    jsonString(metadata, {}),
  );
  cacheSet(tid, rows[0]);
  return rows[0];
}

async function assertPatientInTenant(tenantId, patientUid, db = prisma) {
  const rows = await db.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantId,
    patientUid,
  );
  if (!rows.length) throw AppError.notFound('Patient not found');
}

async function loadActivation(tenantId, activationId, db = prisma, lock = false) {
  const rows = await db.$queryRawUnsafe(
    `SELECT *
       FROM stroke_activations
      WHERE tenant_id = $1::uuid
        AND id = $2
      ${lock ? 'FOR UPDATE' : ''}
      LIMIT 1`,
    tenantId,
    intId(activationId, 'activation_id'),
  );
  if (!rows.length) throw AppError.notFound('Stroke activation not found');
  return rows[0];
}

async function completeStrokeSla({ tenantId, activationId, ruleCode, occurredAt, db }) {
  const rows = await db.$queryRawUnsafe(
    `UPDATE workflow_sla_instances
        SET status = CASE WHEN $4::timestamptz > due_at THEN 'breached' ELSE 'completed' END,
            completed_at = $4::timestamptz,
            breached_at = CASE WHEN $4::timestamptz > due_at THEN COALESCE(breached_at, $4::timestamptz) ELSE breached_at END,
            metadata = metadata || jsonb_build_object('completed_by_event', $5::text),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND rule_code = $2
        AND source_table = 'stroke_activations'
        AND source_id = $3
      RETURNING *`,
    tenantId,
    ruleCode,
    String(activationId),
    occurredAt,
    `${ruleCode}:${activationId}`,
  );
  return rows[0] || null;
}

async function createStrokeSlaRows({ tenantId, activation, settings, db }) {
  const startedAt = activation.door_time_at || activation.arrived_at || activation.activated_at;
  const rows = await db.$queryRawUnsafe(
    `WITH targets(rule_code, target_minutes) AS (
       VALUES
         ('stroke_door_to_ct'::text, $6::int),
         ('stroke_door_to_needle'::text, $7::int)
     )
     INSERT INTO workflow_sla_instances
       (tenant_id, rule_id, rule_code, patient_uid, encounter_id, source_table, source_id,
        source_uid, status, priority, started_at, due_at, assigned_role_codes, metadata)
     SELECT
       $1::uuid,
       NULL::uuid,
       targets.rule_code,
       $2::uuid,
       $3::uuid,
       'stroke_activations',
       $4,
       $5::uuid,
       'active',
       'critical',
       $8::timestamptz,
       $8::timestamptz + (targets.target_minutes * INTERVAL '1 minute'),
       ARRAY['DOCTOR', 'NURSING_STAFF', 'RADIOLOGY_STAFF']::text[],
       jsonb_build_object(
         'source', 'nl13_p2_stroke_pathway',
         'owner_clock_source', $9::text,
         'owner_clock_version', $10::text,
         'target_minutes', targets.target_minutes
       )
     FROM targets
     ON CONFLICT (tenant_id, rule_code, source_table, source_id)
     WHERE source_table IS NOT NULL AND source_id IS NOT NULL
     DO UPDATE SET
       status = CASE
         WHEN workflow_sla_instances.status IN ('completed', 'cancelled') THEN workflow_sla_instances.status
         ELSE 'active'
       END,
       due_at = EXCLUDED.due_at,
       metadata = workflow_sla_instances.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    tenantId,
    activation.patient_uid,
    activation.encounter_id,
    String(activation.id),
    activation.activation_uid,
    Number(settings.door_to_ct_target_minutes),
    Number(settings.door_to_needle_target_minutes),
    startedAt,
    settings.clock_definition_source,
    settings.clock_definition_version,
  );
  return rows;
}

export async function createActivation(input = {}) {
  const tenantId = tenantOr(input.tenantId || input.tenant_id);
  const settings = await getStrokePathwaySettings(tenantId);
  assertEnabledSettings(settings);

  const patientUid = cleanString(input.patient_uid || input.patientUid);
  if (!patientUid) throw AppError.badRequest('patient_uid is required', 'STROKE_PATIENT_REQUIRED');
  await assertPatientInTenant(tenantId, patientUid);

  const clock = validateActivationClock(input);
  const status = assertActivationStatusTransition(null, input.status || 'active');
  const activationSource = cleanString(input.activation_source || input.activationSource);
  if (!activationSource) {
    throw AppError.badRequest('activation_source is required', 'STROKE_ACTIVATION_SOURCE_REQUIRED');
  }

  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO stroke_activations
         (tenant_id, patient_uid, encounter_id, activation_source,
          last_known_well_at, arrived_at, door_time_at, activated_at,
          team, status, notes, metadata, created_by, updated_by)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4,
          $5::timestamptz, $6::timestamptz, $7::timestamptz, $8::timestamptz,
          $9::jsonb, $10, $11, $12::jsonb, $13::uuid, $13::uuid)
       RETURNING *`,
      tenantId,
      patientUid,
      cleanString(input.encounter_id || input.encounterId),
      activationSource,
      clock.lastKnownWellAt,
      clock.arrivedAt,
      clock.doorTimeAt,
      clock.activatedAt,
      jsonString(input.team, {}),
      status,
      cleanString(input.notes),
      jsonString({
        ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
        radiology_reuse: {
          context_tags: ['code_stroke'],
          signal_codes: ['STROKE_PROTOCOL'],
          note: 'Reuses the existing radiology prioritizer; no duplicate priority path.',
        },
      }),
      cleanString(input.actorUid || input.created_by || input.createdBy),
    );
    const activation = rows[0];
    await createStrokeSlaRows({ tenantId, activation, settings, db: tx });
    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid,
      encounterId: activation.encounter_id,
      eventType: 'stroke.activation.created',
      eventStatus: activation.status,
      sourceTable: 'stroke_activations',
      sourceId: activation.id,
      sourceUid: activation.activation_uid,
      resourceType: 'stroke_activation',
      actorUid: input.actorUid || input.created_by || input.createdBy || null,
      actorRole: input.actorRole || input.actor_role || null,
      summary: 'Stroke pathway activation recorded',
      payload: {
        activation_source: activation.activation_source,
        last_known_well_at: activation.last_known_well_at,
        door_time_at: activation.door_time_at,
        radiology_context_tags: activation.radiology_context_tags,
        radiology_signal_codes: activation.radiology_signal_codes,
      },
      tags: ['stroke', 'code_stroke', 'STROKE_PROTOCOL'],
      beforeState: null,
      afterState: { status: activation.status },
    }, { db: tx });
    if (canonical?.timeline?.id) {
      const updated = await tx.$queryRawUnsafe(
        `UPDATE stroke_activations
            SET canonical_timeline_event_id = $1::uuid,
                updated_at = NOW()
          WHERE tenant_id = $2::uuid
            AND id = $3
          RETURNING *`,
        canonical.timeline.id,
        tenantId,
        activation.id,
      );
      return updated[0] || activation;
    }
    return activation;
  });
}

export async function listActivations({
  tenantId,
  status = null,
  patientUid = null,
  limit = DEFAULT_LIMIT,
} = {}) {
  const tid = tenantOr(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.*,
            (
              SELECT row_to_json(n)
                FROM (
                  SELECT id, total_score, signoff_status, assessed_at, nihss_source, nihss_version
                    FROM stroke_nihss_assessments n
                   WHERE n.tenant_id = a.tenant_id
                     AND n.activation_id = a.id
                   ORDER BY n.assessed_at DESC
                   LIMIT 1
                ) n
            ) AS latest_nihss,
            (
              SELECT row_to_json(d)
                FROM (
                  SELECT id, decision_status, decided_at, protocol_source, protocol_version
                    FROM stroke_thrombolysis_decisions d
                   WHERE d.tenant_id = a.tenant_id
                     AND d.activation_id = a.id
                   ORDER BY d.decided_at DESC
                   LIMIT 1
                ) d
            ) AS latest_thrombolysis_decision,
            (
              SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.due_at), '[]'::jsonb)
                FROM workflow_sla_instances s
               WHERE s.tenant_id = a.tenant_id
                 AND s.source_table = 'stroke_activations'
                 AND s.source_id = a.id::text
            ) AS sla_instances
       FROM stroke_activations a
      WHERE a.tenant_id = $1::uuid
        AND ($2::text IS NULL OR a.status = $2)
        AND ($3::uuid IS NULL OR a.patient_uid = $3::uuid)
      ORDER BY a.activated_at DESC
      LIMIT $4::int`,
    tid,
    cleanString(status),
    cleanString(patientUid),
    boundedLimit(limit),
  );
  return { activations: rows, count: rows.length };
}

export async function getActivation({ tenantId, id } = {}) {
  const tid = tenantOr(tenantId);
  const activationId = intId(id, 'activation_id');
  const [activation] = await prisma.$queryRawUnsafe(
    `SELECT *
       FROM stroke_activations
      WHERE tenant_id = $1::uuid
        AND id = $2
      LIMIT 1`,
    tid,
    activationId,
  );
  if (!activation) throw AppError.notFound('Stroke activation not found');
  const [nihss, decisions, events, slas, settings] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT * FROM stroke_nihss_assessments
        WHERE tenant_id = $1::uuid AND activation_id = $2
        ORDER BY assessed_at DESC`,
      tid,
      activationId,
    ),
    prisma.$queryRawUnsafe(
      `SELECT * FROM stroke_thrombolysis_decisions
        WHERE tenant_id = $1::uuid AND activation_id = $2
        ORDER BY decided_at DESC`,
      tid,
      activationId,
    ),
    prisma.$queryRawUnsafe(
      `SELECT * FROM stroke_pathway_events
        WHERE tenant_id = $1::uuid AND activation_id = $2
        ORDER BY occurred_at DESC`,
      tid,
      activationId,
    ),
    prisma.$queryRawUnsafe(
      `SELECT * FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'stroke_activations'
          AND source_id = $2
        ORDER BY due_at ASC`,
      tid,
      String(activationId),
    ),
    getStrokePathwaySettings(tid),
  ]);
  return { activation, nihss, thrombolysis_decisions: decisions, pathway_events: events, sla_instances: slas, settings };
}

export async function updateActivationStatus({
  tenantId,
  id,
  status,
  actorUid = null,
  actorRole = null,
  notes = null,
} = {}) {
  const tid = tenantOr(tenantId);
  const activationId = intId(id, 'activation_id');
  return setTenantTx(tid, async (tx) => {
    const current = await loadActivation(tid, activationId, tx, true);
    const nextStatus = assertActivationStatusTransition(current.status, status);
    const rows = await tx.$queryRawUnsafe(
      `UPDATE stroke_activations
          SET status = $1,
              notes = COALESCE($2, notes),
              updated_by = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $4::uuid
          AND id = $5
          AND status = $6
        RETURNING *`,
      nextStatus,
      cleanString(notes),
      cleanString(actorUid),
      tid,
      activationId,
      current.status,
    );
    if (!rows[0]) {
      throw AppError.conflict('Stroke activation status changed concurrently', 'STROKE_STATUS_CONFLICT');
    }
    const updated = rows[0];
    if (nextStatus === 'cancelled') {
      // Mimic / stood-down stroke: the door-to-CT and door-to-needle
      // obligations no longer exist, so stop both clocks as 'cancelled'
      // (mirrors the STEMI stand-down cancel). Deliberately NOT done for
      // closed/disposed/transferred — a never-met door-to-needle there is a
      // genuine miss, which the overdue sweep surfaces as 'breached'.
      await cancelWorkflowSla({
        tenantId: tid,
        sourceTable: 'stroke_activations',
        sourceId: String(updated.id),
        metadata: {
          cancel_reason: cleanString(notes),
          cancelled_by: cleanString(actorUid),
        },
      }, { db: tx });
    }
    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: updated.patient_uid,
      encounterId: updated.encounter_id,
      eventType: `stroke.activation.${nextStatus}`,
      eventStatus: nextStatus,
      sourceTable: 'stroke_activations',
      sourceId: updated.id,
      sourceUid: updated.activation_uid,
      resourceType: 'stroke_activation',
      actorUid,
      actorRole,
      summary: `Stroke activation status changed to ${nextStatus}`,
      payload: { from_status: current.status, to_status: nextStatus },
      beforeState: { status: current.status },
      afterState: { status: nextStatus },
    }, { db: tx });
    return updated;
  });
}

export async function recordNihssAssessment(input = {}) {
  const tenantId = tenantOr(input.tenantId || input.tenant_id);
  const settings = await getStrokePathwaySettings(tenantId);
  assertEnabledSettings(settings);
  const activationId = intId(input.activation_id || input.activationId, 'activation_id');
  const itemScores = input.item_scores || input.itemScores;
  const totalScore = computeNihssTotal(itemScores);
  const signoffStatus = cleanString(input.signoff_status || input.signoffStatus || 'draft')?.toLowerCase();
  const nihssSource = cleanString(input.nihss_source || input.nihssSource || settings.nihss_source);
  const nihssVersion = cleanString(input.nihss_version || input.nihssVersion || settings.nihss_version);
  const signedOffBy = cleanString(input.signed_off_by || input.signedOffBy || input.actorUid || input.assessor_uid || input.assessorUid);
  if (SIGNED_NIHSS_STATUSES.has(signoffStatus)) {
    requireOwnerSource(
      { source: nihssSource, version: nihssVersion },
      'STROKE_NIHSS_SOURCE_REQUIRED',
      'NIHSS',
    );
    if (!signedOffBy) {
      throw AppError.forbidden('NIHSS sign-off requires a signer', 'STROKE_NIHSS_SIGNER_REQUIRED');
    }
  }

  return setTenantTx(tenantId, async (tx) => {
    const activation = await loadActivation(tenantId, activationId, tx);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO stroke_nihss_assessments
         (tenant_id, activation_id, patient_uid, encounter_id, assessed_at, assessor_uid,
          item_scores, total_score, nihss_source, nihss_version, source_owner_uid,
          source_attachment_refs, signoff_status, signed_off_by, signed_off_at, metadata)
       VALUES
         ($1::uuid, $2, $3::uuid, $4::uuid, $5::timestamptz, $6::uuid,
           $7::jsonb, $8::int, $9::text, $10::text, $11::uuid, $12::jsonb, $13::text,
           $14::uuid, CASE WHEN $13::text = 'signed' THEN NOW() ELSE NULL END, $15::jsonb)
       RETURNING *`,
      tenantId,
      activation.id,
      activation.patient_uid,
      activation.encounter_id,
      asIso(input.assessed_at || input.assessedAt, 'assessed_at') || new Date().toISOString(),
      cleanString(input.assessor_uid || input.assessorUid || input.actorUid),
      JSON.stringify(itemScores),
      totalScore,
      nihssSource,
      nihssVersion,
      cleanString(input.source_owner_uid || input.sourceOwnerUid || input.actorUid),
      arrayJsonString(input.source_attachment_refs || input.sourceAttachmentRefs || settings.nihss_attachment_refs),
      signoffStatus,
      signedOffBy,
      jsonString(input.metadata, {}),
    );
    const assessment = rows[0];
    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: activation.patient_uid,
      encounterId: activation.encounter_id,
      eventType: signoffStatus === 'signed' ? 'stroke.nihss.signed' : 'stroke.nihss.recorded',
      eventStatus: signoffStatus,
      sourceTable: 'stroke_nihss_assessments',
      sourceId: assessment.id,
      resourceType: 'stroke_nihss_assessment',
      actorUid: input.actorUid || input.assessor_uid || input.assessorUid || null,
      actorRole: input.actorRole || input.actor_role || null,
      summary: `NIHSS assessment recorded with total score ${totalScore}`,
      payload: {
        activation_id: activation.id,
        total_score: totalScore,
        signoff_status: signoffStatus,
        nihss_source: nihssSource,
        nihss_version: nihssVersion,
      },
      tags: ['stroke', 'nihss'],
      afterState: { total_score: totalScore, signoff_status: signoffStatus },
    }, { db: tx });
    if (canonical?.timeline?.id) {
      const updated = await tx.$queryRawUnsafe(
        `UPDATE stroke_nihss_assessments
            SET canonical_timeline_event_id = $1::uuid,
                updated_at = NOW()
          WHERE tenant_id = $2::uuid
            AND id = $3
          RETURNING *`,
        canonical.timeline.id,
        tenantId,
        assessment.id,
      );
      return updated[0] || assessment;
    }
    return assessment;
  });
}

async function enforceThrombolysisPrivilege({ tenantId, settings, approverUid }) {
  const key = cleanString(settings.thrombolysis_approver_privilege_key);
  if (!key) {
    throw AppError.forbidden(
      'Stroke thrombolysis approver privilege is not configured',
      'STROKE_THROMBOLYSIS_PRIVILEGE_NOT_CONFIGURED',
    );
  }
  if (!approverUid) {
    throw AppError.forbidden(
      'Stroke thrombolysis approval requires an approver',
      'STROKE_THROMBOLYSIS_APPROVER_REQUIRED',
      { privilege_key: key },
    );
  }
  const verdict = await hasActivePrivilege(approverUid, key, { tenantId });
  if (!verdict.allowed) {
    throw AppError.forbidden(
      'Staff member does not hold an active stroke thrombolysis privilege',
      'STROKE_THROMBOLYSIS_PRIVILEGE_REQUIRED',
      { privilege_key: key, reason: verdict.reason },
    );
  }
  return verdict.privilege_key || key;
}

export async function recordThrombolysisDecision(input = {}) {
  const tenantId = tenantOr(input.tenantId || input.tenant_id);
  const settings = await getStrokePathwaySettings(tenantId);
  assertEnabledSettings(settings);
  const activationId = intId(input.activation_id || input.activationId, 'activation_id');
  const decisionStatus = cleanString(input.decision_status || input.decisionStatus || 'draft')?.toLowerCase();
  const protocolSource = cleanString(input.protocol_source || input.protocolSource || settings.thrombolysis_protocol_source);
  const protocolVersion = cleanString(input.protocol_version || input.protocolVersion || settings.thrombolysis_protocol_version);
  const approverUid = cleanString(input.approver_uid || input.approverUid || input.actorUid);
  let approverPrivilegeKey = cleanString(input.approver_privilege_key || input.approverPrivilegeKey);
  if (APPROVAL_DECISION_STATUSES.has(decisionStatus)) {
    requireOwnerSource(
      { source: protocolSource, version: protocolVersion },
      'STROKE_THROMBOLYSIS_PROTOCOL_REQUIRED',
      'Thrombolysis protocol',
    );
    approverPrivilegeKey = await enforceThrombolysisPrivilege({ tenantId, settings, approverUid });
  }

  return setTenantTx(tenantId, async (tx) => {
    const activation = await loadActivation(tenantId, activationId, tx);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO stroke_thrombolysis_decisions
         (tenant_id, activation_id, patient_uid, encounter_id, decided_at, decision_status,
          eligibility_payload, contraindication_payload, dose_payload, decision_payload,
          protocol_source, protocol_version, protocol_attachment_refs,
          patient_family_documentation, approver_uid, approver_privilege_key,
          approved_at, metadata, created_by)
       VALUES
          ($1::uuid, $2, $3::uuid, $4::uuid, $5::timestamptz, $6::text,
           $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
           $11::text, $12::text, $13::jsonb, $14::jsonb, $15::uuid, $16::text,
           CASE WHEN $6::text IN ('approved', 'administered') THEN NOW() ELSE NULL END,
          $17::jsonb, $18::uuid)
       RETURNING *`,
      tenantId,
      activation.id,
      activation.patient_uid,
      activation.encounter_id,
      asIso(input.decided_at || input.decidedAt, 'decided_at') || new Date().toISOString(),
      decisionStatus,
      jsonString(input.eligibility_payload || input.eligibilityPayload, {}),
      jsonString(input.contraindication_payload || input.contraindicationPayload, {}),
      jsonString(input.dose_payload || input.dosePayload, {}),
      jsonString(input.decision_payload || input.decisionPayload, {}),
      protocolSource,
      protocolVersion,
      arrayJsonString(input.protocol_attachment_refs || input.protocolAttachmentRefs || settings.thrombolysis_protocol_attachment_refs),
      jsonString(input.patient_family_documentation || input.patientFamilyDocumentation, {}),
      approverUid,
      approverPrivilegeKey,
      jsonString(input.metadata, {}),
      cleanString(input.actorUid || input.created_by || input.createdBy),
    );
    const decision = rows[0];
    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: activation.patient_uid,
      encounterId: activation.encounter_id,
      eventType: 'stroke.thrombolysis.decision',
      eventStatus: decisionStatus,
      sourceTable: 'stroke_thrombolysis_decisions',
      sourceId: decision.id,
      resourceType: 'stroke_thrombolysis_decision',
      actorUid: input.actorUid || approverUid || null,
      actorRole: input.actorRole || input.actor_role || null,
      summary: `Stroke thrombolysis decision recorded: ${decisionStatus}`,
      payload: {
        activation_id: activation.id,
        decision_status: decisionStatus,
        protocol_source: protocolSource,
        protocol_version: protocolVersion,
        approver_privilege_key: approverPrivilegeKey,
      },
      tags: ['stroke', 'thrombolysis'],
      afterState: { decision_status: decisionStatus },
    }, { db: tx });
    if (canonical?.timeline?.id) {
      const updated = await tx.$queryRawUnsafe(
        `UPDATE stroke_thrombolysis_decisions
            SET canonical_timeline_event_id = $1::uuid,
                updated_at = NOW()
          WHERE tenant_id = $2::uuid
            AND id = $3
          RETURNING *`,
        canonical.timeline.id,
        tenantId,
        decision.id,
      );
      return updated[0] || decision;
    }
    return decision;
  });
}

export async function recordPathwayEvent(input = {}) {
  const tenantId = tenantOr(input.tenantId || input.tenant_id);
  const settings = await getStrokePathwaySettings(tenantId);
  assertEnabledSettings(settings);
  const activationId = intId(input.activation_id || input.activationId, 'activation_id');
  const eventType = cleanString(input.event_type || input.eventType)?.toLowerCase();
  if (!PATHWAY_EVENT_TYPES.has(eventType)) {
    throw AppError.badRequest('Invalid stroke pathway event type', 'STROKE_INVALID_PATHWAY_EVENT', {
      allowed: [...PATHWAY_EVENT_TYPES],
    });
  }
  const occurredAt = asIso(input.occurred_at || input.occurredAt, 'occurred_at') || new Date().toISOString();

  return setTenantTx(tenantId, async (tx) => {
    const activation = await loadActivation(tenantId, activationId, tx, true);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO stroke_pathway_events
         (tenant_id, activation_id, patient_uid, encounter_id, event_type, occurred_at,
          radiology_order_id, event_payload, recorded_by, metadata)
       VALUES
         ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::timestamptz,
          $7::int, $8::jsonb, $9::uuid, $10::jsonb)
       RETURNING *`,
      tenantId,
      activation.id,
      activation.patient_uid,
      activation.encounter_id,
      eventType,
      occurredAt,
      input.radiology_order_id || input.radiologyOrderId || null,
      jsonString(input.event_payload || input.eventPayload, {}),
      cleanString(input.recorded_by || input.recordedBy || input.actorUid),
      jsonString(input.metadata, {}),
    );
    const event = rows[0];
    const nextStatus = STATUS_FROM_EVENT[eventType];
    if (nextStatus && nextStatus !== activation.status) {
      const allowed = ACTIVATION_TRANSITIONS[activation.status] || [];
      if (allowed.includes(nextStatus)) {
        await tx.$queryRawUnsafe(
          `UPDATE stroke_activations
              SET status = $1,
                  updated_by = $2::uuid,
                  updated_at = NOW()
            WHERE tenant_id = $3::uuid
              AND id = $4
              AND status = $5`,
          nextStatus,
          cleanString(input.actorUid || input.recorded_by || input.recordedBy),
          tenantId,
          activation.id,
          activation.status,
        );
      }
    }
    if (eventType === 'ct_start') {
      await completeStrokeSla({
        tenantId,
        activationId: activation.id,
        ruleCode: 'stroke_door_to_ct',
        occurredAt,
        db: tx,
      });
    }
    if (eventType === 'treatment_start') {
      await completeStrokeSla({
        tenantId,
        activationId: activation.id,
        ruleCode: 'stroke_door_to_needle',
        occurredAt,
        db: tx,
      });
    }
    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: activation.patient_uid,
      encounterId: activation.encounter_id,
      eventType: `stroke.pathway.${eventType}`,
      eventStatus: eventType,
      sourceTable: 'stroke_pathway_events',
      sourceId: event.id,
      resourceType: 'stroke_pathway_event',
      actorUid: input.actorUid || input.recorded_by || input.recordedBy || null,
      actorRole: input.actorRole || input.actor_role || null,
      summary: `Stroke pathway milestone recorded: ${eventType}`,
      payload: {
        activation_id: activation.id,
        event_type: eventType,
        radiology_order_id: event.radiology_order_id,
      },
      tags: ['stroke', 'pathway', eventType],
      afterState: { event_type: eventType },
    }, { db: tx });
    if (canonical?.timeline?.id) {
      const updated = await tx.$queryRawUnsafe(
        `UPDATE stroke_pathway_events
            SET canonical_timeline_event_id = $1::uuid,
                updated_at = NOW()
          WHERE tenant_id = $2::uuid
            AND id = $3
          RETURNING *`,
        canonical.timeline.id,
        tenantId,
        event.id,
      );
      return updated[0] || event;
    }
    return event;
  });
}

export const __testing__ = {
  computeNihssTotal,
  validateActivationClock,
  assertActivationStatusTransition,
  requireOwnerSource,
  enforceThrombolysisPrivilege,
  cacheDelete,
};
