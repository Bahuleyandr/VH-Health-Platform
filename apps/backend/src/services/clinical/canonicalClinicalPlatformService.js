// Canonical Clinical Platform Service
//
// This is the additive foundation for one patient timeline, encounter
// lifecycle, normalized clinical audit, medication safety reviews, and
// workflow SLA instances. Existing feature tables stay the source detail
// tables; successful writes emit through these helpers.

import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import { getCurrentTenantId } from '../../lib/tenantContext.js';
import logger from '../../logging/logger.js';
import { validatePrescriptionSafety } from '../../utils/clinical/prescriptionSafetyCheck.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getPatientTimeline as getLegacyPatientTimeline } from '../emr/clinicalTimelineService.js';
import {
  mergedPatientUidsSubquery,
  resolveMergedPatientUidSet,
} from './mergedPatientReadUnion.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GLOBAL_TENANT_SENTINEL = '00000000-0000-0000-0000-000000000000';

const ENCOUNTER_TRANSITIONS = {
  open: new Set(['active', 'signed', 'cancelled']),
  active: new Set(['signed', 'cancelled']),
  signed: new Set(['amended', 'locked']),
  amended: new Set(['signed', 'locked']),
  locked: new Set([]),
  cancelled: new Set([]),
};

const CLINICAL_DOCUMENTATION_TEMPLATES = Object.freeze([
  {
    id: 'op_consultation_v1',
    title: 'OP Consultation',
    encounter_type: 'op',
    context: 'op_consultation',
    version: 1,
    lock_scope: 'encounter_session',
    sections: [
      { id: 'chief_complaints', label: 'Chief Complaints', required: true, multiline: true },
      { id: 'history', label: 'History', required: false, multiline: true },
      { id: 'examination', label: 'Examination', required: false, multiline: true },
      { id: 'diagnosis', label: 'Diagnosis', required: true, multiline: true },
      { id: 'plan', label: 'Plan', required: true, multiline: true },
      { id: 'follow_up', label: 'Follow-up', required: false, multiline: false },
      { id: 'safety_net', label: 'Red flags / return advice', required: false, multiline: true },
    ],
  },
  {
    id: 'ip_progress_v1',
    title: 'IP Progress Note',
    encounter_type: 'ip',
    context: 'ip_progress',
    version: 1,
    lock_scope: 'signed_note',
    sections: [
      { id: 'overnight_events', label: 'Overnight / interval events', required: false, multiline: true },
      { id: 'current_status', label: 'Current status', required: true, multiline: true },
      { id: 'examination', label: 'Examination', required: false, multiline: true },
      { id: 'results_reviewed', label: 'Results reviewed', required: false, multiline: true },
      { id: 'assessment', label: 'Assessment', required: true, multiline: true },
      { id: 'plan', label: 'Plan', required: true, multiline: true },
    ],
  },
  {
    id: 'referral_request_v1',
    title: 'Cross Referral Request',
    encounter_type: 'ip',
    context: 'referral_request',
    version: 1,
    lock_scope: 'submitted_request',
    sections: [
      { id: 'reason', label: 'Reason for referral', required: true, multiline: true },
      { id: 'clinical_summary', label: 'Clinical summary', required: true, multiline: true },
      { id: 'specific_question', label: 'Specific question for consultant', required: true, multiline: true },
      { id: 'urgency', label: 'Urgency', required: true, multiline: false },
      { id: 'relevant_results', label: 'Relevant results', required: false, multiline: true },
    ],
  },
  {
    id: 'handover_v1',
    title: 'Clinical Handover',
    encounter_type: 'ip',
    context: 'handover',
    version: 1,
    lock_scope: 'handover_shift',
    sections: [
      { id: 'situation', label: 'Situation', required: true, multiline: true },
      { id: 'background', label: 'Background', required: false, multiline: true },
      { id: 'assessment', label: 'Assessment', required: true, multiline: true },
      { id: 'recommendation', label: 'Recommendation / tasks', required: true, multiline: true },
      { id: 'watch_items', label: 'Watch items', required: false, multiline: true },
    ],
  },
  {
    id: 'procedure_note_v1',
    title: 'Procedure Note',
    encounter_type: 'procedure',
    context: 'procedure_note',
    version: 1,
    lock_scope: 'signed_note',
    sections: [
      { id: 'procedure', label: 'Procedure', required: true, multiline: false },
      { id: 'indication', label: 'Indication', required: true, multiline: true },
      { id: 'consent', label: 'Consent / time-out', required: true, multiline: true },
      { id: 'findings', label: 'Findings', required: true, multiline: true },
      { id: 'complications', label: 'Complications', required: false, multiline: true },
      { id: 'post_procedure_plan', label: 'Post-procedure plan', required: true, multiline: true },
    ],
  },
]);

const CLINICAL_DOWNTIME_POLICY = Object.freeze({
  policy_version: 'clinical-downtime-v1',
  mode: 'online_first',
  read_allowed: [
    'cached_patient_banner',
    'cached_recent_timeline',
    'cached_own_appointments',
    'cached_own_roster',
    'cached_formulary',
    'cached_role_policy',
    'documentation_templates',
  ],
  queueable_writes: [
    'vitals_draft',
    'intake_output_draft',
    'nursing_note_draft',
    'op_note_draft',
    'handover_draft',
    'housekeeping_task_status_draft',
  ],
  local_draft_only: [
    'op_prescription_draft',
    'ip_drug_chart_draft',
    'investigation_order_draft',
    'referral_request_draft',
  ],
  blocked_offline: [
    'prescription_sign_or_dispense',
    'medication_safety_override',
    'critical_result_acknowledgement',
    'break_glass_access',
    'admission_creation',
    'bed_transfer',
    'discharge_finalization',
    'billing_receipt',
    'role_or_permission_change',
  ],
  reconciliation: [
    'replay queued drafts with original client timestamp and actor',
    'run server validation and medication safety before committing clinical orders',
    'surface conflicts when patient, encounter, or source resource changed while offline',
    'write clinical audit events for queued, replayed, rejected, and conflict outcomes',
  ],
});

function dbClient(db) {
  return db || prisma;
}

function hasRawClient(db) {
  return db && typeof db.$queryRawUnsafe === 'function';
}

// The canonical tables these helpers write to. The swallow below is restricted
// to a genuinely-ABSENT one of these — never a column-drift or a generic fault.
const CANONICAL_TABLE_NAMES = [
  'clinical_timeline_events',
  'clinical_audit_events',
  'patient_encounters',
  'workflow_sla_instances',
  'workflow_sla_rules',
  'medication_safety_reviews',
];

// Narrowed (audit 2026-06-18 §4): the swallow is intentionally limited to
// SQLSTATE 42P01 (undefined_table) for one of the canonical tables above —
// i.e. the additive canonical layer hasn't been migrated onto this DB yet, so
// emitting the timeline/audit row is genuinely impossible and the detail write
// should still commit. It deliberately does NOT match 42703 (undefined_column)
// or a "...does not exist" message regex: on schema DRIFT (a real canonical
// table missing a column) or any transient/generic write fault, swallowing
// would silently break the atomic timeline invariant — a detail row with no
// timeline+audit row. Those now PROPAGATE so the in-tx writers
// (recordCanonicalOrderEvent / recordCanonicalVitalsEvent) abort their
// transaction and the failure surfaces / alarms.
// Exported so the operational bridge (canonicalOperationalBridgeService) reuses
// the EXACT same canonical-table-absent predicate instead of keeping a second,
// drifting copy of the table list + SQLSTATE handling.
export function isSchemaMissing(err) {
  const code = err?.meta?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code;
  if (code !== '42P01') return false;
  // 42P01 from an unrelated relation (defensive — every query here targets a
  // canonical table) must not be swallowed either: confirm the absent relation
  // is one of ours when the message names it. A 42P01 with no parseable
  // relation name (some adapter shapes) is treated as a canonical-table miss.
  const message = String(err?.message || '');
  const named = /relation ["']?([a-z_]+)["']? does not exist/i.exec(message);
  if (!named) return true;
  return CANONICAL_TABLE_NAMES.includes(named[1].toLowerCase());
}

function logCanonicalFailure(context, err) {
  if (isSchemaMissing(err)) {
    logger.warn(`Canonical clinical platform table unavailable during ${context}`, {
      error: err?.message || String(err),
    });
    return;
  }
  throw err;
}

function cleanUuid(value) {
  const text = value == null ? '' : String(value).trim();
  return UUID_RE.test(text) ? text : null;
}

function cleanText(value, fallback = null) {
  const text = value == null ? '' : String(value).trim();
  return text || fallback;
}

function truthyFlag(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  return ['1', 'true', 'yes', 'y'].includes(String(value).trim().toLowerCase());
}

function normalizedLimit(value, fallback = 100, max = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

function normalizeTenantId(value) {
  return requireTenantId(cleanUuid(value));
}

async function resolveCanonicalTenantId(db, value) {
  const explicitTenantId = cleanUuid(value);
  if (explicitTenantId) return explicitTenantId;

  const contextTenantId = cleanUuid(getCurrentTenantId());
  if (contextTenantId) return contextTenantId;

  const rows = await db.$queryRawUnsafe(
    `SELECT current_setting('app.current_tenant_id', true) AS tenant_id`,
  );
  return normalizeTenantId(rows[0]?.tenant_id);
}

function safeJson(value, fallback = {}) {
  if (value === undefined || value === null) return fallback;
  return value;
}

function stringifyJson(value, fallback = {}) {
  return JSON.stringify(safeJson(value, fallback));
}

function sourceKey({ eventType, action, sourceTable, sourceId, resourceType, resourceId, patientUid }) {
  return [
    eventType || action || 'clinical.event',
    sourceTable || resourceType || 'resource',
    sourceId || resourceId || patientUid || randomUUID(),
  ].map((part) => String(part).trim()).join(':').slice(0, 220);
}

function mapLegacyTypeToCanonical(type) {
  const raw = String(type || '').toLowerCase();
  if (raw === 'clinical_note' || raw === 'clinical.notes') return 'clinical_note';
  if (raw.includes('vital')) return 'vitals.recorded';
  if (raw.includes('io') || raw.includes('intake') || raw.includes('output')) return 'io.recorded';
  if (raw.includes('prescription')) return 'prescription.created';
  if (raw.includes('investigation') || raw.includes('lab')) return 'investigation.event';
  if (raw.includes('referral')) return 'referral.event';
  if (raw.includes('order')) return 'order.created';
  if (raw.includes('admission')) return 'admission.event';
  if (raw.includes('discharge')) return 'discharge.event';
  if (raw.includes('medication')) return 'medication.event';
  return raw ? `legacy.${raw}` : 'legacy.event';
}

function normalizeLegacyEvent(event) {
  const timestamp = event.timestamp || event.recorded_at || event.created_at || event.occurred_at || null;
  return {
    id: event.id != null ? `legacy-${event.type || 'event'}-${event.id}` : `legacy-${randomUUID()}`,
    canonical: false,
    event_type: mapLegacyTypeToCanonical(event.type || event.event_type),
    event_subtype: event.type || event.event_subtype || null,
    event_status: event.status || null,
    resource_type: event.type || null,
    resource_id: event.id == null ? null : String(event.id),
    occurred_at: timestamp,
    timestamp,
    title: event.title || event.type || 'Clinical event',
    clinical_summary: event.summary || event.description || event.title || null,
    actor_uid: event.actor_uid || event.author_uid || event.recorded_by || null,
    actor_role: event.actor_role || event.author_role || null,
    payload: event,
  };
}

function normalizeCanonicalEvent(row) {
  return {
    id: row.id,
    canonical: true,
    event_type: row.event_type,
    event_subtype: row.event_subtype,
    event_status: row.event_status,
    source_table: row.source_table,
    source_id: row.source_id,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    encounter_id: row.encounter_id,
    occurred_at: row.occurred_at,
    timestamp: row.occurred_at,
    title: row.payload?.title || row.event_subtype || row.event_type,
    clinical_summary: row.clinical_summary,
    actor_uid: row.actor_uid,
    actor_role: row.actor_role,
    visible_to_patient: row.visible_to_patient,
    payload: row.payload || {},
    tags: row.tags || [],
  };
}

function formatIsoDay(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().split('T')[0];
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().split('T')[0];
}

function normalizePatientActivityEvent(row = {}) {
  const day = formatIsoDay(row.source_day);
  if (!day) return null;
  const steps = Number(row.steps || 0);
  const distanceMeters = Number(row.distance_meters || 0);
  const sleepMinutes = Number(row.sleep_minutes || 0);
  const activeEnergyKcal = Number(row.active_energy_kcal || 0);
  const distanceKm = Number((distanceMeters / 1000).toFixed(2));
  const sleepHours = Number((sleepMinutes / 60).toFixed(1));
  const sourceLabel = cleanText(row.sources, 'patient app');
  const occurredAt = `${day}T12:00:00.000Z`;
  const summaryParts = [];
  if (steps > 0) summaryParts.push(`${steps.toLocaleString('en-IN')} steps`);
  if (distanceMeters > 0) summaryParts.push(`${distanceKm} km walked`);
  if (sleepMinutes > 0) summaryParts.push(`${sleepHours} h sleep`);
  if (activeEnergyKcal > 0) summaryParts.push(`${Math.round(activeEnergyKcal)} kcal active energy`);

  return {
    id: `patient-activity-${row.user_uid}-${day}`,
    canonical: false,
    patient_generated: true,
    event_type: 'patient_activity.daily_summary',
    event_subtype: 'activity_summary',
    event_status: 'unverified',
    source_table: 'step_sessions',
    source_id: day,
    resource_type: 'patient_activity',
    resource_id: day,
    occurred_at: occurredAt,
    timestamp: occurredAt,
    title: 'Patient app activity',
    clinical_summary: summaryParts.length
      ? summaryParts.join(' • ')
      : 'Patient app activity summary',
    visible_to_patient: true,
    payload: {
      title: 'Patient app activity',
      source_kind: 'patient_generated',
      verification_status: 'unverified',
      source: sourceLabel,
      source_app: cleanText(row.source_apps),
      source_device: cleanText(row.source_devices),
      source_day: day,
      steps,
      distance_meters: distanceMeters,
      distance_km: distanceKm,
      sleep_minutes: sleepMinutes,
      sleep_hours: sleepHours,
      active_energy_kcal: activeEnergyKcal,
      recorded_at_source: row.recorded_at_source || null,
    },
    tags: ['patient_generated', 'unverified', 'activity'],
  };
}

async function readPatientGeneratedActivityTimeline(uid, filters = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return [];

  const limit = Math.max(1, Math.min(Number.parseInt(filters.limit, 10) || 100, 120));
  const dayExpr = "COALESCE(source_day, DATE(started_at AT TIME ZONE 'UTC'))";
  const params = [uid];
  const where = [
    'user_uid = $1::uuid',
    'is_active = false',
    `${dayExpr} IS NOT NULL`,
  ];
  let idx = 2;
  if (filters.date_from) {
    where.push(`${dayExpr} >= $${idx++}::date`);
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    where.push(`${dayExpr} <= $${idx++}::date`);
    params.push(filters.date_to);
  }

  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT
          user_uid,
          ${dayExpr} AS source_day,
          COALESCE(SUM(steps), 0)::int AS steps,
          COALESCE(SUM(distance_meters), 0)::float AS distance_meters,
          COALESCE(SUM(sleep_minutes), 0)::int AS sleep_minutes,
          COALESCE(SUM(active_energy_kcal), 0)::float AS active_energy_kcal,
          STRING_AGG(DISTINCT NULLIF(source, ''), ', ') AS sources,
          STRING_AGG(DISTINCT NULLIF(source_app, ''), ', ') AS source_apps,
          STRING_AGG(DISTINCT NULLIF(source_device, ''), ', ') AS source_devices,
          MAX(recorded_at_source) AS recorded_at_source
        FROM step_sessions
       WHERE ${where.join(' AND ')}
       GROUP BY user_uid, ${dayExpr}
      HAVING COALESCE(SUM(steps), 0) > 0
          OR COALESCE(SUM(distance_meters), 0) > 0
          OR COALESCE(SUM(sleep_minutes), 0) > 0
          OR COALESCE(SUM(active_energy_kcal), 0) > 0
       ORDER BY ${dayExpr} DESC
       LIMIT $${idx}::int`,
      ...params,
      limit,
    );
    return rows.map(normalizePatientActivityEvent).filter(Boolean);
  } catch (err) {
    logCanonicalFailure('patient-generated activity timeline read', err);
    return [];
  }
}

export async function recordTimelineEvent(input = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return null;

  const tenantId = await resolveCanonicalTenantId(
    db,
    input.tenantId || input.tenant_id,
  );
  const patientUid = cleanUuid(input.patientUid || input.patient_uid);
  if (!patientUid) return null;

  const eventType = cleanText(input.eventType || input.event_type, 'clinical.event');
  const eventStatus = cleanText(input.eventStatus || input.event_status);
  const sourceTable = cleanText(input.sourceTable || input.source_table);
  const sourceId = cleanText(input.sourceId || input.source_id);
  const resourceType = cleanText(input.resourceType || input.resource_type || sourceTable);
  const resourceId = cleanText(input.resourceId || input.resource_id || sourceId);
  const idempotencyKey = cleanText(input.idempotencyKey || input.idempotency_key)
    || sourceKey({ eventType, sourceTable, sourceId, resourceType, resourceId, patientUid });

  // Append-only safe (migration 599): clinical_timeline_events carries the same
  // BEFORE UPDATE/DELETE guard as the audit tables (migration 324's
  // audit_append_only_guard), which aborts the transaction for the non-superuser
  // prod app role — while dev/QA/CI connect as superuser, which the guard
  // exempts. So this idempotent recorder must NOT use ON CONFLICT DO UPDATE:
  // even a no-op `SET idempotency_key = EXCLUDED.idempotency_key` fires the
  // guard and turns a duplicate clinical write into a 500 that rolls back the
  // whole enclosing transaction. Use DO NOTHING, and on an idempotency-key
  // conflict read the existing row back — callers dereference the returned
  // row's id (canonical_timeline_event_id) and recordCanonicalClinicalEvent
  // treats a null return as CANONICAL_TIMELINE_REQUIRED.
  try {
    // The common path remains one statement (mock-sequenced unit tests count
    // queries, same as the audit writer below). Conflict target is the FULL
    // unique constraint on idempotency_key (269: NOT NULL UNIQUE) — no
    // partial-index WHERE clause here, unlike clinical_audit_events.
    let rows = await db.$queryRawUnsafe(
      `WITH ins AS (
         INSERT INTO clinical_timeline_events
           (tenant_id, patient_uid, encounter_id, event_type, event_subtype, event_status,
            source_table, source_id, source_uid, resource_type, resource_id, actor_uid, actor_role,
            occurred_at, visible_to_patient, clinical_summary, payload, tags, idempotency_key)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
                 $7, $8, $9::uuid, $10, $11, $12::uuid, $13,
                 COALESCE($14::timestamptz, NOW()), $15, $16, $17::jsonb, $18::text[], $19)
         ON CONFLICT (idempotency_key)
         DO NOTHING
         RETURNING *
       )
       SELECT * FROM ins
       UNION ALL
       SELECT * FROM clinical_timeline_events
        WHERE idempotency_key = $19 AND NOT EXISTS (SELECT 1 FROM ins)
       LIMIT 1`,
      tenantId,
      patientUid,
      cleanUuid(input.encounterId || input.encounter_id),
      eventType,
      cleanText(input.eventSubtype || input.event_subtype),
      eventStatus,
      sourceTable,
      sourceId,
      cleanUuid(input.sourceUid || input.source_uid),
      resourceType,
      resourceId,
      cleanUuid(input.actorUid || input.actor_uid),
      cleanText(input.actorRole || input.actor_role),
      input.occurredAt || input.occurred_at || null,
      input.visibleToPatient === true || input.visible_to_patient === true,
      cleanText(input.summary || input.clinical_summary),
      stringifyJson(input.payload),
      Array.isArray(input.tags) ? input.tags.map(String) : [],
      idempotencyKey,
    );

    // Under Read Committed, a concurrent uncommitted insert can make
    // ON CONFLICT DO NOTHING suppress this insert while the conflicting row
    // remains invisible to the statement snapshot, so the CTE returns no row.
    // A second statement gets a fresh snapshot after the conflict wait and
    // reads back the now-committed canonical row.
    if (!rows[0]) {
      rows = await db.$queryRawUnsafe(
        `SELECT *
           FROM clinical_timeline_events
          WHERE idempotency_key = $1
          LIMIT 1`,
        idempotencyKey,
      );
    }
    return rows[0] || null;
  } catch (err) {
    logCanonicalFailure('timeline event record', err);
    return null;
  }
}

export async function recordClinicalAuditEvent(input = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return null;

  const tenantId = await resolveCanonicalTenantId(
    db,
    input.tenantId || input.tenant_id,
  );
  const action = cleanText(input.action);
  if (!action) return null;

  // Append-only safe (migration 324): the audit tables carry a BEFORE UPDATE/DELETE
  // guard that aborts the transaction for the non-superuser app role. So this
  // idempotent recorder must NOT use ON CONFLICT DO UPDATE — even the prior no-op
  // `SET idempotency_key = EXCLUDED.idempotency_key` fires the guard and aborts the
  // enclosing clinical-write tx under the sealed prod role. Use DO NOTHING, and on
  // an idempotency-key conflict read the existing row back so callers that consume
  // the returned audit row keep working.
  const idempotencyKey = cleanText(input.idempotencyKey || input.idempotency_key)
    || sourceKey({
      action,
      sourceTable: input.resourceTable || input.resource_table,
      sourceId: input.resourceId || input.resource_id,
      patientUid: input.patientUid || input.patient_uid,
    });
  try {
    // Single statement: INSERT (append-only safe — DO NOTHING never fires the
    // BEFORE UPDATE guard), then UNION-read the existing row on an idempotency
    // conflict so callers that consume the returned audit row (e.g.
    // documentIntegrityService links sig.audit_event_id = events.audit.id) keep
    // working. One query → mock-sequenced unit tests see the same call count as
    // the prior ON CONFLICT DO UPDATE form.
    let rows = await db.$queryRawUnsafe(
      `WITH ins AS (
         INSERT INTO clinical_audit_events
           (tenant_id, patient_uid, encounter_id, action, action_status, actor_uid, actor_role,
            resource_type, resource_table, resource_id, request_id, ip_address, user_agent,
            before_state, after_state, metadata, idempotency_key, occurred_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7,
                 $8, $9, $10, $11, NULLIF($12, '')::inet, $13,
                 $14::jsonb, $15::jsonb, $16::jsonb, $17, COALESCE($18::timestamptz, NOW()))
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING *
       )
       SELECT * FROM ins
       UNION ALL
       SELECT * FROM clinical_audit_events
        WHERE idempotency_key = $17 AND NOT EXISTS (SELECT 1 FROM ins)
       LIMIT 1`,
      tenantId,
      cleanUuid(input.patientUid || input.patient_uid),
      cleanUuid(input.encounterId || input.encounter_id),
      action,
      cleanText(input.actionStatus || input.action_status, 'success'),
      cleanUuid(input.actorUid || input.actor_uid),
      cleanText(input.actorRole || input.actor_role),
      cleanText(input.resourceType || input.resource_type),
      cleanText(input.resourceTable || input.resource_table),
      cleanText(input.resourceId || input.resource_id),
      cleanText(input.requestId || input.request_id),
      cleanText(input.ipAddress || input.ip_address, ''),
      cleanText(input.userAgent || input.user_agent),
      stringifyJson(input.beforeState || input.before_state, null),
      stringifyJson(input.afterState || input.after_state, null),
      stringifyJson(input.metadata),
      idempotencyKey,
      input.occurredAt || input.occurred_at || null,
    );

    // Under Read Committed, a concurrent uncommitted insert can make
    // ON CONFLICT DO NOTHING suppress this insert while the conflicting row
    // remains invisible to the statement snapshot, so the CTE returns no row.
    // A second statement gets a fresh snapshot after the conflict wait and
    // reads back the now-committed canonical row. (The key is always derived
    // non-null here, so the equality predicate stays inside the partial
    // unique index's WHERE idempotency_key IS NOT NULL domain.)
    if (!rows[0]) {
      rows = await db.$queryRawUnsafe(
        `SELECT *
           FROM clinical_audit_events
          WHERE idempotency_key = $1
          LIMIT 1`,
        idempotencyKey,
      );
    }
    return rows[0] || null;
  } catch (err) {
    logCanonicalFailure('clinical audit event record', err);
    return null;
  }
}

/**
 * Transaction-unique revision token for canonical idempotency keys.
 *
 * State-fingerprint keys alone cannot represent A -> B -> A edit sequences:
 * returning to a previously persisted state regenerates the old key, the
 * ON CONFLICT paths above read the OLD rows back as success, and the return
 * to A never gets its own timeline/audit revision. Callers that stamp
 * fingerprint keys for genuine detail mutations must append
 * `:tx:<xid8>` using this token, obtained INSIDE the same tenant
 * transaction as the detail write, so every committed mutation owns exactly
 * one new revision pair while exact retries are handled by effective-state
 * no-op guards before any canonical emit.
 */
export async function currentCanonicalTransactionRevision(db) {
  const client = dbClient(db);
  const rows = await client.$queryRawUnsafe(
    'SELECT pg_current_xact_id()::text AS revision',
  );
  return String(rows[0].revision);
}

export async function recordCanonicalClinicalEvent(input = {}, options = {}) {
  const db = dbClient(options.db);
  const patientIdentityProvided = input.patientUid != null || input.patient_uid != null;
  const atomicPatientWrite = options.db != null
    && patientIdentityProvided
    && options.allowPartial !== true;
  const requireTimeline = atomicPatientWrite
    || options.strict === true
    || options.requireTimeline === true;
  const requireAudit = atomicPatientWrite
    || options.strict === true
    || options.requireAudit === true;
  const resourceTable = input.resourceTable || input.resource_table || input.sourceTable || input.source_table;
  const resourceId = input.resourceId || input.resource_id || input.sourceId || input.source_id;
  const timeline = await recordTimelineEvent({
    ...input,
    sourceTable: input.sourceTable || resourceTable,
    sourceId: input.sourceId || resourceId,
    idempotencyKey: input.timelineIdempotencyKey || input.timeline_idempotency_key,
  }, { db });
  if (requireTimeline && !timeline) {
    const error = new Error('Canonical clinical timeline event was not recorded');
    error.code = 'CANONICAL_TIMELINE_REQUIRED';
    throw error;
  }
  const audit = await recordClinicalAuditEvent({
    ...input,
    action: input.action || input.eventType || input.event_type,
    resourceTable,
    resourceId,
    idempotencyKey: input.auditIdempotencyKey || input.audit_idempotency_key,
  }, { db });
  if (requireAudit && !audit) {
    const error = new Error('Canonical clinical audit event was not recorded');
    error.code = 'CANONICAL_AUDIT_REQUIRED';
    throw error;
  }
  return { timeline, audit };
}

export async function ensureEncounterForAppointment(input = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return null;

  const appointmentId = Number.parseInt(input.appointmentId || input.appointment_id, 10);
  const patientUid = cleanUuid(input.patientUid || input.patient_uid);
  if (!Number.isInteger(appointmentId) || appointmentId <= 0 || !patientUid) return null;

  const tenantId = normalizeTenantId(input.tenantId || input.tenant_id);
  const actorUid = cleanUuid(input.actorUid || input.actor_uid);
  const doctorUid = cleanUuid(input.doctorUid || input.doctor_uid || input.primaryDoctorUid);

  try {
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO patient_encounters
         (tenant_id, patient_uid, encounter_type, status, appointment_id, primary_doctor_uid,
          care_team_uids, created_by, updated_by, status_history, metadata)
       VALUES ($1::uuid, $2::uuid, 'op', 'open', $3::int, $4::uuid,
               ARRAY_REMOVE(ARRAY[$4::uuid, $5::uuid], NULL)::uuid[], $5::uuid, $5::uuid,
               jsonb_build_array(jsonb_build_object(
                 'status', 'open',
                 'changed_at', NOW(),
                 'changed_by', $5::uuid,
                 'reason', 'appointment clinical workflow'
               )),
               $6::jsonb)
       ON CONFLICT (tenant_id, appointment_id) WHERE appointment_id IS NOT NULL
       DO UPDATE SET
         updated_at = NOW(),
         updated_by = COALESCE(EXCLUDED.updated_by, patient_encounters.updated_by),
         primary_doctor_uid = COALESCE(patient_encounters.primary_doctor_uid, EXCLUDED.primary_doctor_uid),
         care_team_uids = (
           SELECT ARRAY(SELECT DISTINCT uid FROM UNNEST(patient_encounters.care_team_uids || EXCLUDED.care_team_uids) AS uid WHERE uid IS NOT NULL)
         )
       RETURNING *`,
      tenantId,
      patientUid,
      appointmentId,
      doctorUid,
      actorUid,
      stringifyJson(input.metadata),
    );
    return rows[0] || null;
  } catch (err) {
    logCanonicalFailure('encounter ensure for appointment', err);
    return null;
  }
}

export async function getEncounter(encounterId, options = {}) {
  const db = dbClient(options.db);
  const id = cleanUuid(encounterId);
  if (!id || !hasRawClient(db)) return null;
  const tenantId = cleanUuid(options.tenantId || options.tenant_id);
  const params = [id];
  const tenantFilter = tenantId ? ' AND tenant_id = $2::uuid' : '';
  if (tenantId) params.push(tenantId);
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT * FROM patient_encounters WHERE id = $1::uuid${tenantFilter} LIMIT 1`,
      ...params,
    );
    return rows[0] || null;
  } catch (err) {
    logCanonicalFailure('encounter load', err);
    return null;
  }
}

export async function transitionEncounter(encounterId, nextStatus, input = {}, options = {}) {
  const db = dbClient(options.db);
  const id = cleanUuid(encounterId);
  const target = cleanText(nextStatus)?.toLowerCase();
  if (!id || !target || !hasRawClient(db)) {
    throw AppError.badRequest('encounter id and target status are required');
  }
  const tenantId = cleanUuid(input.tenantId || input.tenant_id);
  const existing = await getEncounter(id, { db, tenantId });
  if (!existing) throw AppError.notFound('Encounter not found');

  const current = String(existing.status || '').toLowerCase();
  if (!ENCOUNTER_TRANSITIONS[current]?.has(target)) {
    throw AppError.conflict(`Invalid encounter transition: ${current} -> ${target}`, 'INVALID_ENCOUNTER_TRANSITION');
  }

  const actorUid = cleanUuid(input.actorUid || input.actor_uid);
  const metadata = safeJson(input.metadata);
  const timestampColumn = {
    active: 'activated_at',
    signed: 'signed_at',
    amended: 'amended_at',
    locked: 'locked_at',
    cancelled: 'closed_at',
  }[target];
  const actorColumn = {
    signed: 'signed_by',
    amended: 'amended_by',
    locked: 'locked_by',
  }[target];

  try {
    const params = [
      id,
      target,
      actorUid,
      current,
      cleanText(input.reason),
      stringifyJson(metadata),
    ];
    const tenantFilter = tenantId ? ' AND tenant_id = $7::uuid' : '';
    if (tenantId) params.push(tenantId);
    // The status UPDATE and the canonical timeline + audit emits must commit
    // or roll back together, and the WHERE re-checks `status = $4` (the
    // status the pre-check above validated) so a concurrent transition in the
    // read-then-write gap surfaces as a conflict instead of being silently
    // overwritten.
    const applyTransition = async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE patient_encounters
            SET status = $2::text,
                ${timestampColumn ? `${timestampColumn} = NOW(),` : ''}
                ${actorColumn ? `${actorColumn} = $3::uuid,` : ''}
                updated_by = $3::uuid,
                updated_at = NOW(),
                status_history = status_history || jsonb_build_array(jsonb_build_object(
                  'from_status', $4::text,
                  'to_status', $2::text,
                  'changed_at', NOW(),
                  'changed_by', $3::uuid,
                  'reason', $5::text,
                  'metadata', $6::jsonb
                ))
          WHERE id = $1::uuid AND status = $4::text${tenantFilter}
          RETURNING *`,
        ...params,
      );
      const updated = rows[0];
      if (!updated) {
        // 0 rows back: the encounter left `current` between the pre-check
        // read and this UPDATE (concurrent transition). Same conflict shape
        // as the pre-check above.
        throw AppError.conflict(
          `Invalid encounter transition: ${current} -> ${target}`,
          'INVALID_ENCOUNTER_TRANSITION',
        );
      }
      await recordCanonicalClinicalEvent({
        tenantId: updated.tenant_id,
        patientUid: updated.patient_uid,
        encounterId: updated.id,
        eventType: `encounter.${target}`,
        eventStatus: target,
        sourceTable: 'patient_encounters',
        sourceId: updated.id,
        resourceType: 'encounter',
        resourceId: updated.id,
        actorUid,
        actorRole: input.actorRole || input.actor_role,
        summary: `Encounter ${target}`,
        payload: { from_status: current, to_status: target, metadata },
        beforeState: { status: current },
        afterState: { status: target },
        timelineIdempotencyKey: `encounter:${updated.id}:${target}:${updated.updated_at?.toISOString?.() || Date.now()}`,
        auditIdempotencyKey: `encounter-audit:${updated.id}:${target}:${updated.updated_at?.toISOString?.() || Date.now()}`,
      }, { db: tx });
      return updated;
    };
    // A caller-supplied client owns its transaction boundary; otherwise open
    // a tenant-scoped transaction. A bare prisma.$transaction callback does
    // not install app.current_tenant_id, so it would make this PHI mutation
    // atomic while silently bypassing the repository's RLS boundary.
    return options.db
      ? await applyTransition(db)
      : await setTenantTx(requireTenantId(existing.tenant_id), applyTransition);
  } catch (err) {
    // House-style narrow tolerance (see isSchemaMissing): only a
    // genuinely-absent canonical table (SQLSTATE 42P01) is swallowed into a
    // null return. Every other failure — the concurrent-transition conflict
    // above and canonical emit failures included — rethrows, so routes
    // surface it via next(err) instead of a silent 200.
    logCanonicalFailure('encounter transition', err);
    return null;
  }
}

export async function readCanonicalPatientTimeline(patientUid, filters = {}, options = {}) {
  const db = dbClient(options.db);
  const uid = cleanUuid(patientUid);
  if (!uid) throw AppError.badRequest('patient uid is required');

  const tenantId = normalizeTenantId(filters.tenantId || filters.tenant_id);
  const limit = Math.max(1, Math.min(Number.parseInt(filters.limit, 10) || 100, 500));
  const includeLegacy = truthyFlag(filters.includeLegacy) || truthyFlag(filters.include_legacy);
  // Merged-uid union: canonical events recorded before a patient merge stay
  // under the merged-away uid (the timeline is append-only), so the
  // survivor's chart reads the whole chain.
  const uidSet = await resolveMergedPatientUidSet(db, {
    tenantId,
    patientUid: uid,
  });
  const params = [tenantId, uidSet];
  let idx = 3;
  const where = ['tenant_id = $1::uuid', 'patient_uid = ANY($2::uuid[])'];
  if (filters.date_from) {
    where.push(`occurred_at >= $${idx++}::timestamptz`);
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    where.push(`occurred_at <= $${idx++}::timestamptz`);
    params.push(filters.date_to);
  }

  let canonical = [];
  if (hasRawClient(db)) {
    try {
      const rows = await db.$queryRawUnsafe(
        `SELECT *
           FROM clinical_timeline_events
          WHERE ${where.join(' AND ')}
          ORDER BY occurred_at DESC
          LIMIT $${idx}::int`,
        ...params,
        limit,
      );
      canonical = rows.map(normalizeCanonicalEvent);
    } catch (err) {
      logCanonicalFailure('patient timeline read', err);
    }
  }

  const includePatientGenerated = filters.includePatientGenerated !== false
    && filters.include_patient_generated !== false
    && String(filters.include_patient_generated || '').toLowerCase() !== 'false';
  const patientGenerated = includePatientGenerated
    ? await readPatientGeneratedActivityTimeline(uid, filters, { db })
    : [];

  let legacy = [];
  if (includeLegacy) {
    try {
      legacy = (await getLegacyPatientTimeline(uid, {
        dateFrom: filters.date_from || null,
        dateTo: filters.date_to || null,
        limit,
        sort: 'desc',
      })).map(normalizeLegacyEvent);
    } catch (err) {
      logger.warn('Legacy timeline merge failed', {
        patientUid: uid,
        error: err?.message || String(err),
      });
    }
  }

  const seen = new Set(canonical.map((event) => `${event.source_table || event.resource_type}:${event.source_id || event.resource_id}:${event.event_type}`));
  const merged = [
    ...canonical,
    ...patientGenerated.filter((event) => {
      const key = `${event.source_table || event.resource_type}:${event.source_id || event.resource_id}:${event.event_type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    ...legacy.filter((event) => {
      const key = `${event.resource_type || 'legacy'}:${event.resource_id || event.id}:${event.event_type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ].sort((a, b) => new Date(b.timestamp || b.occurred_at || 0) - new Date(a.timestamp || a.occurred_at || 0))
    .slice(0, limit);

  return {
    patient_uid: uid,
    source: 'canonical',
    legacy_included: includeLegacy,
    events: merged,
    counts: {
      canonical: canonical.length,
      patient_generated: patientGenerated.length,
      legacy: legacy.length,
      returned: merged.length,
    },
    generated_at: new Date().toISOString(),
  };
}

function addOptionalFilter({ clauses, params, field, value, cast = null, operator = '=', transform = null }) {
  if (value === undefined || value === null || String(value).trim() === '') return;
  const sqlValue = transform ? transform(value) : value;
  params.push(sqlValue);
  const placeholder = `$${params.length}${cast ? `::${cast}` : ''}`;
  clauses.push(`${field} ${operator} ${placeholder}`);
}

export async function listClinicalAuditEvents(filters = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return { events: [], total: 0 };

  const tenantId = normalizeTenantId(filters.tenantId || filters.tenant_id);
  const limit = normalizedLimit(filters.limit);
  const clauses = ['tenant_id = $1::uuid'];
  const params = [tenantId];

  const patientUid = cleanUuid(filters.patientUid || filters.patient_uid);
  if (patientUid) {
    params.push(patientUid);
    clauses.push(`patient_uid IN (${mergedPatientUidsSubquery('$1::uuid', `$${params.length}::uuid`)})`);
  }
  addOptionalFilter({ clauses, params, field: 'encounter_id', value: cleanUuid(filters.encounterId || filters.encounter_id), cast: 'uuid' });
  addOptionalFilter({ clauses, params, field: 'actor_uid', value: cleanUuid(filters.actorUid || filters.actor_uid), cast: 'uuid' });
  addOptionalFilter({ clauses, params, field: 'action_status', value: cleanText(filters.status || filters.action_status) });
  addOptionalFilter({ clauses, params, field: 'resource_type', value: cleanText(filters.resourceType || filters.resource_type) });
  addOptionalFilter({ clauses, params, field: 'action', value: cleanText(filters.action), operator: 'ILIKE', transform: (value) => `%${value}%` });
  addOptionalFilter({ clauses, params, field: 'occurred_at', value: filters.from || filters.date_from, cast: 'timestamptz', operator: '>=' });
  addOptionalFilter({ clauses, params, field: 'occurred_at', value: filters.to || filters.date_to, cast: 'timestamptz', operator: '<=' });

  try {
    const where = clauses.join(' AND ');
    const rows = await db.$queryRawUnsafe(
      `SELECT *
         FROM clinical_audit_events
        WHERE ${where}
        ORDER BY occurred_at DESC
        LIMIT $${params.length + 1}::int`,
      ...params,
      limit,
    );
    return {
      events: rows,
      total: rows.length,
      limit,
      filters,
    };
  } catch (err) {
    logCanonicalFailure('clinical audit event list', err);
    return { events: [], total: 0, limit, filters };
  }
}

export async function listWorkflowSlaInstances(filters = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return { slas: [], total: 0 };

  const tenantId = normalizeTenantId(filters.tenantId || filters.tenant_id);
  const limit = normalizedLimit(filters.limit);
  const clauses = ['tenant_id = $1::uuid'];
  const params = [tenantId];

  const patientUid = cleanUuid(filters.patientUid || filters.patient_uid);
  if (patientUid) {
    params.push(patientUid);
    clauses.push(`patient_uid IN (${mergedPatientUidsSubquery('$1::uuid', `$${params.length}::uuid`)})`);
  }
  addOptionalFilter({ clauses, params, field: 'encounter_id', value: cleanUuid(filters.encounterId || filters.encounter_id), cast: 'uuid' });
  addOptionalFilter({ clauses, params, field: 'rule_code', value: cleanText(filters.ruleCode || filters.rule_code) });
  addOptionalFilter({ clauses, params, field: 'status', value: cleanText(filters.status) });
  addOptionalFilter({ clauses, params, field: 'source_table', value: cleanText(filters.sourceTable || filters.source_table) });
  addOptionalFilter({ clauses, params, field: 'source_id', value: cleanText(filters.sourceId || filters.source_id) });

  try {
    const where = clauses.join(' AND ');
    const rows = await db.$queryRawUnsafe(
      `SELECT *
         FROM workflow_sla_instances
        WHERE ${where}
        ORDER BY
          CASE status WHEN 'breached' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
          due_at ASC
        LIMIT $${params.length + 1}::int`,
      ...params,
      limit,
    );
    return {
      slas: rows,
      total: rows.length,
      limit,
      filters,
    };
  } catch (err) {
    logCanonicalFailure('workflow SLA list', err);
    return { slas: [], total: 0, limit, filters };
  }
}

export async function listMedicationSafetyReviews(filters = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return { reviews: [], total: 0 };

  const tenantId = normalizeTenantId(filters.tenantId || filters.tenant_id);
  const limit = normalizedLimit(filters.limit);
  const clauses = ['tenant_id = $1::uuid'];
  const params = [tenantId];

  addOptionalFilter({ clauses, params, field: 'patient_uid', value: cleanUuid(filters.patientUid || filters.patient_uid), cast: 'uuid' });
  addOptionalFilter({ clauses, params, field: 'encounter_id', value: cleanUuid(filters.encounterId || filters.encounter_id), cast: 'uuid' });
  addOptionalFilter({ clauses, params, field: 'prescription_id', value: filters.prescriptionId || filters.prescription_id, cast: 'int' });
  addOptionalFilter({ clauses, params, field: 'clinical_order_id', value: filters.clinicalOrderId || filters.clinical_order_id, cast: 'int' });
  addOptionalFilter({ clauses, params, field: 'status', value: cleanText(filters.status) });
  addOptionalFilter({ clauses, params, field: 'severity', value: cleanText(filters.severity) });
  addOptionalFilter({ clauses, params, field: 'review_type', value: cleanText(filters.reviewType || filters.review_type) });

  try {
    const where = clauses.join(' AND ');
    const rows = await db.$queryRawUnsafe(
      `SELECT *
         FROM medication_safety_reviews
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1}::int`,
      ...params,
      limit,
    );
    return {
      reviews: rows,
      total: rows.length,
      limit,
      filters,
    };
  } catch (err) {
    logCanonicalFailure('medication safety review list', err);
    return { reviews: [], total: 0, limit, filters };
  }
}

export async function startWorkflowSla(input = {}, options = {}) {
  const db = dbClient(options.db);
  const strict = options.strict === true;
  if (!hasRawClient(db)) {
    if (strict) {
      throw AppError.internal(
        'Workflow SLA start requires a database client',
        'WORKFLOW_SLA_DATABASE_REQUIRED',
      );
    }
    return null;
  }
  const tenantId = await resolveCanonicalTenantId(
    db,
    input.tenantId || input.tenant_id,
  );
  const ruleCode = cleanText(input.ruleCode || input.rule_code);
  if (!ruleCode) {
    if (strict) {
      throw AppError.internal(
        'Workflow SLA start requires a rule code',
        'WORKFLOW_SLA_RULE_CODE_REQUIRED',
      );
    }
    return null;
  }

  try {
    const rules = await db.$queryRawUnsafe(
      `SELECT *
         FROM workflow_sla_rules
        WHERE enabled = TRUE
          AND rule_code = $1
          AND (tenant_id = $2::uuid OR tenant_id IS NULL)
        ORDER BY CASE WHEN tenant_id = $2::uuid THEN 0 ELSE 1 END
        LIMIT 1`,
      ruleCode,
      tenantId,
    );
    const rule = rules[0];
    if (!rule) return null;

    const rows = await db.$queryRawUnsafe(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_id, rule_code, patient_uid, encounter_id, source_table, source_id,
          source_uid, status, priority, started_at, due_at, assigned_role_codes,
          assigned_user_uid, metadata)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7,
               $8::uuid, 'active', $9, NOW(), NOW() + ($10::int * INTERVAL '1 minute'),
               $11::text[], $12::uuid, $13::jsonb)
       ON CONFLICT (tenant_id, rule_code, source_table, source_id)
       WHERE source_table IS NOT NULL AND source_id IS NOT NULL
       DO UPDATE SET
         -- This is an idempotent start, not a reopen operation. Preserve the
         -- existing clock exactly (including breached/escalated state and its
         -- timestamps); domain-specific reopen helpers own explicit re-arming.
         updated_at = workflow_sla_instances.updated_at
       RETURNING *`,
      tenantId,
      rule.id,
      rule.rule_code,
      cleanUuid(input.patientUid || input.patient_uid),
      cleanUuid(input.encounterId || input.encounter_id),
      cleanText(input.sourceTable || input.source_table),
      cleanText(input.sourceId || input.source_id),
      cleanUuid(input.sourceUid || input.source_uid),
      cleanText(input.priority, 'normal'),
      rule.target_minutes,
      Array.isArray(input.assignedRoleCodes || input.assigned_role_codes)
        ? (input.assignedRoleCodes || input.assigned_role_codes).map(String)
        : (rule.owner_role_codes || []),
      cleanUuid(input.assignedUserUid || input.assigned_user_uid),
      stringifyJson(input.metadata),
    );
    const started = rows[0] || null;
    if (strict && !started) {
      throw AppError.internal(
        'Workflow SLA start returned no instance for an enabled rule',
        'WORKFLOW_SLA_MATERIALIZATION_FAILED',
      );
    }
    return started;
  } catch (err) {
    logCanonicalFailure('workflow SLA start', err);
    if (strict) throw err;
    return null;
  }
}

export async function completeWorkflowSla(input = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return null;
  const tenantId = await resolveCanonicalTenantId(
    db,
    input.tenantId || input.tenant_id,
  );
  const ruleCode = cleanText(input.ruleCode || input.rule_code);
  const sourceTable = cleanText(input.sourceTable || input.source_table);
  const sourceId = cleanText(input.sourceId || input.source_id);
  if (!ruleCode || !sourceTable || !sourceId) return null;

  try {
    // Terminal-state guard: 'completed' and 'cancelled' rows are never
    // re-touched — a re-completion after due_at must not flip a completed SLA
    // to 'breached'. The UNION readback keeps re-completion idempotent (the
    // existing terminal row is returned unchanged). 'breached'/'escalated'
    // are not terminal (house convention — resultsInboxService, death
    // certification treat them as still-completable): the status is preserved
    // while the late completion stamps completed_at once.
    const rows = await db.$queryRawUnsafe(
      `WITH upd AS (
         UPDATE workflow_sla_instances
            SET status = CASE
                  WHEN status IN ('breached', 'escalated') THEN status
                  WHEN NOW() > due_at THEN 'breached'
                  ELSE 'completed'
                END,
                completed_at = COALESCE(completed_at, NOW()),
                breached_at = CASE
                  WHEN status NOT IN ('breached', 'escalated') AND NOW() > due_at
                    THEN COALESCE(breached_at, NOW())
                  ELSE breached_at
                END,
                metadata = metadata || $5::jsonb,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND rule_code = $2
            AND source_table = $3
            AND source_id = $4
            AND status NOT IN ('completed', 'cancelled')
          RETURNING *
       )
       SELECT * FROM upd
       UNION ALL
       SELECT * FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND rule_code = $2
          AND source_table = $3
          AND source_id = $4
          AND NOT EXISTS (SELECT 1 FROM upd)
       LIMIT 1`,
      tenantId,
      ruleCode,
      sourceTable,
      sourceId,
      stringifyJson(input.metadata),
    );
    return rows[0] || null;
  } catch (err) {
    logCanonicalFailure('workflow SLA complete', err);
    return null;
  }
}

// Cancel is the third SLA lifecycle verb: the monitored obligation itself went
// away (case cancelled, activation stood down, request abandoned), so the
// clock must stop without counting as met. Raw copies of this UPDATE already
// live in stemiPathwayService (stand-down) and porterTransportService
// (transition close); this shared wrapper is the canonical home for new
// callers (cath-lab cancel, stroke cancel, housekeeping cancel).
//
// Guard: 'completed' and 'cancelled' rows are terminal and never re-touched —
// but unlike completeWorkflowSla, a 'breached'/'escalated' clock IS
// cancellable (the obligation disappearing supersedes an open breach).
// ruleCode is optional: omitted, every open clock on the source row is
// cancelled (e.g. both stroke door-to-CT and door-to-needle).
// Returns the array of cancelled instances (possibly empty).
export async function cancelWorkflowSla(input = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return [];
  const tenantId = await resolveCanonicalTenantId(
    db,
    input.tenantId || input.tenant_id,
  );
  const sourceTable = cleanText(input.sourceTable || input.source_table);
  const sourceId = cleanText(input.sourceId || input.source_id);
  if (!sourceTable || !sourceId) return [];
  const ruleCode = cleanText(input.ruleCode || input.rule_code);

  try {
    const rows = await db.$queryRawUnsafe(
      `UPDATE workflow_sla_instances
          SET status = 'cancelled',
              metadata = metadata || $4::jsonb,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND source_table = $2
          AND source_id = $3
          AND status NOT IN ('completed', 'cancelled')
          AND ($5::text IS NULL OR rule_code = $5::text)
        RETURNING *`,
      tenantId,
      sourceTable,
      sourceId,
      stringifyJson(input.metadata),
      ruleCode || null,
    );
    return rows;
  } catch (err) {
    logCanonicalFailure('workflow SLA cancel', err);
    return [];
  }
}

function issueMessage(issue) {
  return cleanText(issue?.message || issue?.reason || issue?.summary || issue?.title, 'Medication safety review finding');
}

function issueType(issue, fallback) {
  return cleanText(issue?.type || issue?.category || issue?.code, fallback);
}

function issueSeverity(issue, fallback) {
  return cleanText(issue?.severity, fallback)?.toLowerCase() || fallback;
}

function issueMedication(issue) {
  return cleanText(issue?.medication || issue?.medication_name || issue?.drug || issue?.drug_name || issue?.name);
}

export async function recordMedicationSafetyReviews(input = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return [];

  const safety = input.safety || { warnings: [], blockers: [], safe: true };
  const findings = [
    ...(Array.isArray(safety.blockers) ? safety.blockers.map((issue) => ({ issue, status: 'blocked', fallbackSeverity: 'high' })) : []),
    ...(Array.isArray(safety.warnings) ? safety.warnings.map((issue) => ({ issue, status: 'warning', fallbackSeverity: 'medium' })) : []),
  ];
  if (findings.length === 0) {
    findings.push({
      issue: { type: 'overall', message: 'No medication safety findings detected' },
      status: 'passed',
      fallbackSeverity: 'info',
    });
  }

  const tenantId = await resolveCanonicalTenantId(
    db,
    input.tenantId || input.tenant_id,
  );
  const rows = [];
  for (const finding of findings) {
    const issue = finding.issue || {};
    const overrideReason = cleanText(input.override?.reason || input.override_reason);
    try {
      const inserted = await db.$queryRawUnsafe(
        `INSERT INTO medication_safety_reviews
           (tenant_id, patient_uid, patient_id, encounter_id, prescription_id, clinical_order_id,
            review_type, severity, status, finding_code, medication_name, message,
            override_required, override_reason, overridden_by, overridden_at, payload, created_by)
         VALUES ($1::uuid, $2::uuid, $3::int, $4::uuid, $5::int, $6::int,
                 $7, $8, $9, $10, $11, $12,
                 $13, $14, $15::uuid, CASE WHEN $14::text IS NOT NULL THEN NOW() ELSE NULL END,
                 $16::jsonb, $17::uuid)
         RETURNING *`,
        tenantId,
        cleanUuid(input.patientUid || input.patient_uid),
        input.patientId || input.patient_id || null,
        cleanUuid(input.encounterId || input.encounter_id),
        input.prescriptionId || input.prescription_id || null,
        input.clinicalOrderId || input.clinical_order_id || null,
        issueType(issue, 'overall'),
        issueSeverity(issue, finding.fallbackSeverity),
        overrideReason && finding.status === 'blocked' ? 'overridden' : finding.status,
        cleanText(issue.code || issue.finding_code),
        issueMedication(issue),
        issueMessage(issue),
        finding.status === 'blocked',
        overrideReason,
        cleanUuid(input.override?.approvedBy || input.override?.approved_by || input.actorUid || input.actor_uid),
        stringifyJson(issue),
        cleanUuid(input.actorUid || input.actor_uid),
      );
      if (inserted[0]) rows.push(inserted[0]);
    } catch (err) {
      logCanonicalFailure('medication safety review record', err);
    }
  }
  return rows;
}

export async function evaluateMedicationSafety(input = {}, options = {}) {
  const db = dbClient(options.db);
  const tenantId = await resolveCanonicalTenantId(
    db,
    input.tenantId || input.tenant_id,
  );
  const safety = await validatePrescriptionSafety(
    input.patientId || input.patient_id,
    input.medications || [],
    { tenantId, db },
  );
  const reviews = await recordMedicationSafetyReviews(
    { ...input, tenantId, safety },
    { ...options, db },
  );
  return {
    ...safety,
    reviews,
  };
}

export function getClinicalDocumentationTemplates(filters = {}) {
  const context = cleanText(filters.context)?.toLowerCase();
  const encounterType = cleanText(filters.encounterType || filters.encounter_type)?.toLowerCase();
  const templates = CLINICAL_DOCUMENTATION_TEMPLATES.filter((template) => {
    if (context && template.context !== context) return false;
    if (encounterType && template.encounter_type !== encounterType) return false;
    return true;
  });
  return {
    templates,
    total: templates.length,
    generated_at: new Date().toISOString(),
    guardrails: [
      'Templates are structured prompts, not mandatory wording.',
      'Signed or locked encounter documentation requires amendment workflow.',
      'Every persisted note should emit canonical timeline and clinical audit events.',
    ],
  };
}

export function getClinicalDowntimePolicy(filters = {}) {
  const role = cleanText(filters.role || filters.actorRole || filters.actor_role)?.toUpperCase();
  return {
    ...CLINICAL_DOWNTIME_POLICY,
    role,
    generated_at: new Date().toISOString(),
    role_notes: role
      ? [`${role} must still pass normal RBAC/ReBAC checks when queued work is replayed.`]
      : ['Role-specific checks are applied at replay time.'],
  };
}

export const CANONICAL_GLOBAL_TENANT_SENTINEL = GLOBAL_TENANT_SENTINEL;
