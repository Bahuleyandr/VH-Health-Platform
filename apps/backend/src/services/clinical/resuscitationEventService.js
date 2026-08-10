// src/services/clinical/resuscitationEventService.js
//
// NL-14 P2 — durable code-blue / resuscitation documentation.
//
// INVARIANTS (spec 2026-07-08-nl14-critical-care-emergency-design.md §4.3):
//   * The durable resuscitation_events row is the SINGLE SOURCE OF TRUTH.
//     Creating it MAY emit on staff:code-blue, but WS delivery stays
//     notification-only and at-most-once — never authoritative. Dashboards
//     hydrate persisted events on (re)connect, not the live-only banner.
//   * resuscitation_event_timeline is APPEND-ONLY (DB trigger enforced,
//     migration 514). Corrections are new 'correction_note' entries.
//   * Medication rows REFERENCE MAR administrations (never a parallel
//     med-admin lane). This module NEVER writes medication_administrations;
//     the mig-516 partial unique index makes double-claiming a MAR dose
//     impossible.
//   * Finalization requires a team leader AND a recorder (service check +
//     mig-513 CHECK constraint).
//   * Per-tenant fail-closed flag: resuscitation_settings.enabled (mig-351
//     composition_search_settings pattern). Writes require the flag; the
//     critical-vital hook silently no-ops when disabled so the pre-existing
//     WS-only behaviour is unchanged until an operator flips the flag.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  recordClinicalAuditEvent,
  recordTimelineEvent
} from './canonicalClinicalPlatformService.js';
import { emitCodeBlue } from '../../utils/websocket/realtimeEmitter.js';

const TIMELINE_ENTRY_TYPES = new Set([
  'compressions_started',
  'compressions_stopped',
  'rhythm_check',
  'shock',
  'airway_intervention',
  'medication',
  'lab_sample',
  'fluid_bolus',
  'blood_product',
  'procedure',
  'rosc',
  'transfer',
  'death_declaration',
  'note',
  'correction_note'
]);

const MEDICATION_ENTRY_KINDS = {
  medication: 'medication',
  fluid_bolus: 'fluid',
  blood_product: 'blood_product'
};

const TEAM_ROLES = new Set([
  'team_leader',
  'recorder',
  'airway',
  'compressions',
  'medications',
  'defibrillation',
  'circulation',
  'runner',
  'observer',
  'other'
]);

const DEVICE_LINK_KINDS = new Set([
  'defibrillator',
  'monitor',
  'clinical_alert',
  'vitals_chart'
]);

function tenantOr(tenantId) {
  return requireTenantId(tenantId);
}

function unwrap(rows) {
  return Array.isArray(rows) ? rows[0] : rows;
}

function toInt(value, field) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n)) throw AppError.badRequest(`${field} must be numeric`);
  return n;
}

function json(value, fallback = {}) {
  return JSON.stringify(value == null ? fallback : value);
}

// Wire-shaping LAW (worker-common 2026-07-07): NUMERIC columns come back as
// Prisma Decimal objects (energy_joules here). Convert before serialization.
function normalizeValue(value) {
  if (value == null) return value;
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)])
    );
  }
  return value;
}

function normalizeRows(rows) {
  return (rows || []).map(row => normalizeValue(row));
}

// ── Per-tenant fail-closed feature flag ─────────────────────────────────────
// compositionFeatureService pattern: per-tenant cache keyed by tenant_id (a
// global refresh under an ambient RLS GUC would poison other tenants' entries),
// 60s TTL, fail closed and DON'T cache on error.

const FLAG_REFRESH_INTERVAL_MS = 60 * 1000;
const enabledCache = new Map(); // tenant_id -> { value, fetchedAt }

export async function isResuscitationEnabled(tenantId) {
  if (!tenantId) return false;
  const key = String(tenantId);
  const cached = enabledCache.get(key);
  if (cached && Date.now() - cached.fetchedAt <= FLAG_REFRESH_INTERVAL_MS) {
    return cached.value;
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT enabled FROM resuscitation_settings WHERE tenant_id = $1::uuid`,
      tenantId
    );
    const value = rows[0]?.enabled === true;
    enabledCache.set(key, { value, fetchedAt: Date.now() });
    return value;
  } catch (err) {
    logger.warn(`isResuscitationEnabled failed for tenant ${tenantId}: ${err.message}`);
    return false;
  }
}

export function clearResuscitationFlagCache() {
  enabledCache.clear();
}

async function assertEnabled(tenantId) {
  if (!(await isResuscitationEnabled(tenantId))) {
    throw AppError.forbidden(
      'Resuscitation documentation is not enabled for this tenant',
      'RESUS_DISABLED'
    );
  }
}

export async function getResuscitationSettings({ tenantId }) {
  const tenant = tenantOr(tenantId);
  const rows = await setTenantTx(tenant, tx =>
    tx.$queryRawUnsafe(
      `SELECT tenant_id, enabled, charting_policy, trigger_policy, policy_source,
              enabled_at, enabled_by, acceptance_snapshot, created_at, updated_at
         FROM resuscitation_settings
        WHERE tenant_id = $1::uuid`,
      tenant
    )
  );
  return (
    normalizeValue(unwrap(rows)) || {
      tenant_id: tenant,
      enabled: false,
      charting_policy: {},
      trigger_policy: {},
      policy_source: 'unavailable'
    }
  );
}

export async function setResuscitationSettings({
  tenantId,
  enabled,
  charting_policy,
  trigger_policy,
  policy_source,
  acceptance_snapshot,
  actorUid
}) {
  const tenant = tenantOr(tenantId);
  if (enabled === true && (!acceptance_snapshot || !actorUid)) {
    throw AppError.badRequest(
      'Enabling resuscitation documentation requires an acceptance_snapshot and an acting admin',
      'RESUS_ENABLE_GATE'
    );
  }
  const rows = await setTenantTx(tenant, tx =>
    tx.$queryRawUnsafe(
      `INSERT INTO resuscitation_settings
         (tenant_id, enabled, charting_policy, trigger_policy, policy_source,
          enabled_at, enabled_by, acceptance_snapshot, updated_at)
       VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5,
               CASE WHEN $2 THEN NOW() ELSE NULL END,
               CASE WHEN $2 THEN $6::uuid ELSE NULL END,
               CASE WHEN $2 THEN $7::jsonb ELSE NULL END,
               NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled = $2,
         charting_policy = $3::jsonb,
         trigger_policy = $4::jsonb,
         policy_source = $5,
         enabled_at = CASE WHEN $2 THEN COALESCE(resuscitation_settings.enabled_at, NOW()) ELSE resuscitation_settings.enabled_at END,
         enabled_by = CASE WHEN $2 THEN $6::uuid ELSE resuscitation_settings.enabled_by END,
         acceptance_snapshot = CASE WHEN $2 THEN COALESCE($7::jsonb, resuscitation_settings.acceptance_snapshot) ELSE resuscitation_settings.acceptance_snapshot END,
         updated_at = NOW()
       RETURNING *`,
      tenant,
      enabled === true,
      json(charting_policy),
      json(trigger_policy),
      policy_source || 'unavailable',
      actorUid || null,
      acceptance_snapshot == null ? null : JSON.stringify(acceptance_snapshot)
    )
  );
  // Flip the cache synchronously so subsequent reads observe the change.
  enabledCache.set(String(tenant), { value: enabled === true, fetchedAt: Date.now() });
  return normalizeValue(unwrap(rows));
}

// ── Canonical timeline/audit pair ───────────────────────────────────────────

async function recordCanonicalPair(
  tx,
  {
    tenantId,
    patientUid,
    resourceTable,
    resourceId,
    eventType,
    action,
    actorUid,
    actorRole,
    summary,
    payload = {},
    beforeState = null,
    afterState = null
  }
) {
  const sourceId = String(resourceId);
  const timeline = await recordTimelineEvent(
    {
      tenantId,
      patientUid,
      eventType,
      eventStatus: 'recorded',
      sourceTable: resourceTable,
      sourceId,
      resourceType: resourceTable,
      resourceId: sourceId,
      actorUid,
      actorRole,
      occurredAt: payload.occurred_at || null,
      summary,
      payload,
      tags: ['resuscitation', 'code-blue', 'nl14'],
      idempotencyKey: `${resourceTable}:${sourceId}:${eventType}`
    },
    { db: tx }
  );
  const audit = await recordClinicalAuditEvent(
    {
      tenantId,
      patientUid,
      action,
      actionStatus: 'success',
      actorUid,
      actorRole,
      resourceType: resourceTable,
      resourceTable,
      resourceId: sourceId,
      beforeState,
      afterState,
      metadata: payload,
      idempotencyKey: `${resourceTable}:${sourceId}:${action}`
    },
    { db: tx }
  );
  if (!timeline || !audit) {
    throw AppError.internal(
      'Canonical resuscitation timeline/audit write failed',
      'RESUS_CANONICAL_WRITE_FAILED'
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function assertEvent(tx, tenantId, eventId, { forUpdate = false } = {}) {
  const id = toInt(eventId, 'eventId');
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, admission_id, emergency_visit_id,
            event_kind, trigger_source, trigger_clinical_alert_id, ward_snapshot,
            bed_snapshot, reason, is_drill, started_at, ended_at, outcome, status,
            team_leader_uid, team_leader_name, recorder_uid, recorder_name,
            post_event_note_status, finalized_at, finalized_by
       FROM resuscitation_events
      WHERE id = $1 AND tenant_id = $2::uuid
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    id,
    tenantOr(tenantId)
  );
  const event = unwrap(rows);
  if (!event) throw AppError.notFound('Resuscitation event not found');
  return event;
}

function assertEventOpen(event) {
  if (event.status === 'finalized' || event.status === 'cancelled_misfire') {
    throw AppError.invalidTransition(event.status, 'documenting', ['active', 'ended']);
  }
}

// Location SNAPSHOT at event time (never a live pointer): copy ward/bed from
// the patient's current admission if the caller did not supply them.
async function resolveLocationSnapshot(tx, tenantId, patientUid) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, ward, bed_number
       FROM admissions
      WHERE patient_uid = $1::uuid
        AND tenant_id = $2::uuid
        AND status IN ('admitted', 'transferred')
      ORDER BY admitted_at DESC NULLS LAST
      LIMIT 1`,
    patientUid,
    tenantId
  );
  const admission = unwrap(rows);
  return {
    admissionId: admission?.id ?? null,
    ward: admission?.ward ?? null,
    bedNumber: admission?.bed_number ?? null
  };
}

// Phase 1.5 — post-commit, best-effort, NOTIFICATION-ONLY. A WS/FCM failure
// never affects the committed durable event; delivery is at-most-once and the
// dashboards re-hydrate from resuscitation_events, not from this push.
async function notifyCodeBlue(event) {
  try {
    emitCodeBlue({
      tenantId: event.tenant_id,
      patientId: event.patient_display_id ?? event.patient_uid,
      bedNumber: event.bed_snapshot,
      ward: event.ward_snapshot,
      triggeredBy: event.triggered_by,
      reason: event.reason,
      eventId: event.id
    });
    await setTenantTx(event.tenant_id, tx =>
      tx.$executeRawUnsafe(
        `UPDATE resuscitation_events SET last_notified_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2::uuid`,
        Number(event.id),
        event.tenant_id
      )
    );
  } catch (err) {
    logger.error(`resuscitationEventService: code-blue notification fan-out failed for event ${event.id}: ${err.message}`);
  }
}

// ── Event header lifecycle ──────────────────────────────────────────────────

export async function createResuscitationEvent({
  tenantId,
  actorUid,
  actorRole,
  ...body
}) {
  const tenant = tenantOr(tenantId);
  await assertEnabled(tenant);
  if (!body.patient_uid) throw AppError.badRequest('patient_uid required');
  if (body.event_kind && !['code_blue', 'rapid_response'].includes(body.event_kind)) {
    throw AppError.badRequest('event_kind must be code_blue or rapid_response');
  }

  const event = await setTenantTx(tenant, async tx => {
    const patient = unwrap(
      await tx.$queryRawUnsafe(
        `SELECT uid, id, name FROM users WHERE uid = $1::uuid LIMIT 1`,
        body.patient_uid
      )
    );
    if (!patient) throw AppError.notFound('Patient not found');

    const location = await resolveLocationSnapshot(tx, tenant, patient.uid);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO resuscitation_events
         (tenant_id, patient_uid, encounter_id, admission_id, emergency_visit_id,
          event_kind, trigger_source, triggered_by, ward_snapshot, bed_snapshot,
          reason, is_drill, started_at, created_by, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'explicit_staff', $7::uuid,
               $8, $9, $10, $11, COALESCE($12::timestamptz, NOW()), $13::uuid, $14::jsonb)
       RETURNING *`,
      tenant,
      patient.uid,
      body.encounter_id || null,
      body.admission_id == null ? location.admissionId : toInt(body.admission_id, 'admission_id'),
      body.emergency_visit_id == null ? null : toInt(body.emergency_visit_id, 'emergency_visit_id'),
      body.event_kind || 'code_blue',
      actorUid || null,
      body.ward ?? location.ward,
      body.bed_number ?? location.bedNumber,
      body.reason || null,
      body.is_drill === true,
      body.started_at || null,
      actorUid || null,
      json(body.metadata)
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      patientUid: patient.uid,
      resourceTable: 'resuscitation_events',
      resourceId: row.id,
      eventType: 'resuscitation.event_started',
      action: 'resuscitation.event.started',
      actorUid,
      actorRole,
      summary: `${row.event_kind === 'rapid_response' ? 'Rapid response' : 'Code blue'} event started${row.ward_snapshot ? ` (ward ${row.ward_snapshot})` : ''}`,
      payload: {
        trigger_source: 'explicit_staff',
        ward: row.ward_snapshot,
        bed_number: row.bed_snapshot,
        reason: row.reason,
        is_drill: row.is_drill,
        occurred_at: row.started_at
      },
      afterState: row
    });
    return { ...row, patient_display_id: patient.id };
  });

  // Notification is post-commit and never authoritative. Drills stay silent.
  if (!event.is_drill) await notifyCodeBlue(event);
  return normalizeValue(event);
}

// Critical-vital fan-out hook (vitalSignMonitor Phase 1.5). Flag-gated and
// never-throws: when the tenant flag is off — or anything fails — behaviour
// degrades to exactly the pre-existing WS-only path. Idempotent per triggering
// clinical alert via ux_resuscitation_events_trigger_alert.
export async function createEventFromCriticalVital({
  tenantId,
  patientUid,
  clinicalAlertId = null,
  vitalsChartId = null,
  reason,
  recordedBy = null
}) {
  try {
    const tenant = tenantOr(tenantId);
    if (!patientUid) return null;
    if (!(await isResuscitationEnabled(tenant))) return null;

    return await setTenantTx(tenant, async tx => {
      // recordedBy arrives as the recorder's INT users.id from the vitals
      // path (clinical_alerts.created_by is Int) — resolve the uuid; a
      // uuid-shaped string passes through unchanged.
      let recorderUid = null;
      if (recordedBy != null) {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(recordedBy))) {
          recorderUid = String(recordedBy);
        } else if (/^\d+$/.test(String(recordedBy))) {
          const staffRow = unwrap(
            await tx.$queryRawUnsafe(
              `SELECT uid FROM users WHERE id = $1::int LIMIT 1`,
              Number(recordedBy)
            )
          );
          recorderUid = staffRow?.uid ?? null;
        }
      }
      if (clinicalAlertId != null) {
        const existing = unwrap(
          await tx.$queryRawUnsafe(
            `SELECT id FROM resuscitation_events
              WHERE tenant_id = $1::uuid AND trigger_clinical_alert_id = $2::int
              LIMIT 1`,
            tenant,
            clinicalAlertId
          )
        );
        if (existing) return normalizeValue(existing);
      }

      const location = await resolveLocationSnapshot(tx, tenant, patientUid);
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO resuscitation_events
           (tenant_id, patient_uid, admission_id, event_kind, trigger_source,
            trigger_clinical_alert_id, trigger_vitals_chart_id, triggered_by,
            ward_snapshot, bed_snapshot, reason, created_by, metadata)
         VALUES ($1::uuid, $2::uuid, $3, 'code_blue', 'critical_vital',
                 $4::int, $5::int, $6::uuid, $7, $8, $9, $6::uuid,
                 '{"source":"vitalSignMonitor"}'::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        tenant,
        patientUid,
        location.admissionId,
        clinicalAlertId,
        vitalsChartId,
        recorderUid,
        location.ward,
        location.bedNumber,
        reason || null
      );
      let row = rows[0];
      if (!row) {
        // Lost the idempotency race — fetch the winner.
        row = unwrap(
          await tx.$queryRawUnsafe(
            `SELECT * FROM resuscitation_events
              WHERE tenant_id = $1::uuid AND trigger_clinical_alert_id = $2::int
              LIMIT 1`,
            tenant,
            clinicalAlertId
          )
        );
        return row ? normalizeValue(row) : null;
      }

      // Alert/device evidence link (spec §4.3 test: critical-vital-derived
      // code-blue links to the alert/device evidence).
      if (clinicalAlertId != null) {
        await tx.$queryRawUnsafe(
          `INSERT INTO resuscitation_device_links
             (tenant_id, resuscitation_event_id, patient_uid, link_kind,
              clinical_alert_id, vitals_chart_id, evidence, linked_by)
           VALUES ($1::uuid, $2, $3::uuid, 'clinical_alert', $4::int, $5::int, $6::jsonb, $7::uuid)
           ON CONFLICT DO NOTHING`,
          tenant,
          row.id,
          patientUid,
          clinicalAlertId,
          vitalsChartId,
          json({ reason: reason || null, source: 'vitalSignMonitor' }),
          recorderUid
        );
      }

      await recordCanonicalPair(tx, {
        tenantId: tenant,
        patientUid,
        resourceTable: 'resuscitation_events',
        resourceId: row.id,
        eventType: 'resuscitation.event_started',
        action: 'resuscitation.event.started',
        actorUid: recorderUid,
        actorRole: 'system',
        summary: `Code blue event started (critical vital)${location.ward ? ` (ward ${location.ward})` : ''}`,
        payload: {
          trigger_source: 'critical_vital',
          clinical_alert_id: clinicalAlertId,
          vitals_chart_id: vitalsChartId,
          ward: row.ward_snapshot,
          bed_number: row.bed_snapshot,
          reason: row.reason,
          occurred_at: row.started_at
        },
        afterState: row
      });
      return normalizeValue(row);
    });
  } catch (err) {
    // NEVER block the alert path — the WS/FCM notification still goes out.
    logger.error(
      `resuscitationEventService: durable event creation from critical vital failed (alert=${clinicalAlertId}): ${err.message}`
    );
    return null;
  }
}

export async function getResuscitationEvent({ tenantId, eventId }) {
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const event = await assertEvent(tx, tenant, eventId);
    const [timeline, roles, medicationLinks, deviceLinks, qaReview] = await Promise.all([
      tx.$queryRawUnsafe(
        `SELECT id, seq, entry_type, occurred_at, rhythm, energy_joules,
                medication_name, dose, route, details, recorded_by, recorded_at
           FROM resuscitation_event_timeline
          WHERE resuscitation_event_id = $1 AND tenant_id = $2::uuid
          ORDER BY seq ASC`,
        event.id,
        tenant
      ),
      tx.$queryRawUnsafe(
        `SELECT id, staff_uid, staff_name, role, joined_at, left_at,
                signed_at, signature_method, assigned_by
           FROM resuscitation_team_roles
          WHERE resuscitation_event_id = $1 AND tenant_id = $2::uuid
          ORDER BY joined_at ASC`,
        event.id,
        tenant
      ),
      tx.$queryRawUnsafe(
        `SELECT id, timeline_entry_id, link_kind, mar_administration_id,
                medication_kind, medication_name, dose, route,
                reconciliation_status, recorded_by, created_at
           FROM resuscitation_medication_links
          WHERE resuscitation_event_id = $1 AND tenant_id = $2::uuid
          ORDER BY created_at ASC`,
        event.id,
        tenant
      ),
      tx.$queryRawUnsafe(
        `SELECT id, timeline_entry_id, link_kind, device_registry_id,
                device_association_id, clinical_alert_id, vitals_chart_id,
                evidence, linked_by, linked_at
           FROM resuscitation_device_links
          WHERE resuscitation_event_id = $1 AND tenant_id = $2::uuid
          ORDER BY linked_at ASC`,
        event.id,
        tenant
      ),
      tx.$queryRawUnsafe(
        `SELECT id, review_status, template_source, template_version,
                template_reference_uri, evidence_owner_uid, responses, findings,
                action_items, debrief_held_at, debrief_lead_uid, reviewer_uid,
                reviewer_signed_at, created_at, updated_at
           FROM resuscitation_qa_reviews
          WHERE resuscitation_event_id = $1 AND tenant_id = $2::uuid
          LIMIT 1`,
        event.id,
        tenant
      )
    ]);
    return {
      event: normalizeValue(event),
      timeline: normalizeRows(timeline),
      team_roles: normalizeRows(roles),
      medication_links: normalizeRows(medicationLinks),
      device_links: normalizeRows(deviceLinks),
      qa_review: normalizeValue(unwrap(qaReview)) || null
    };
  });
}

// Persisted code-blue history with the ward/bed/reason context the live-only
// banner loses — the dashboard reconnect hydration surface.
export async function listResuscitationEvents({
  tenantId,
  patientUid = null,
  status = null,
  hours = 24,
  limit = 50
} = {}) {
  const tenant = tenantOr(tenantId);
  const h = Math.min(Math.max(Number(hours) || 24, 1), 24 * 30);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (status != null && !['active', 'ended', 'finalized', 'cancelled_misfire'].includes(status)) {
    throw AppError.badRequest('invalid status filter');
  }
  const rows = await setTenantTx(tenant, tx =>
    tx.$queryRawUnsafe(
      `SELECT id, patient_uid, encounter_id, admission_id, emergency_visit_id,
              event_kind, trigger_source, trigger_clinical_alert_id, triggered_by,
              ward_snapshot, bed_snapshot, reason, is_drill, started_at, ended_at,
              outcome, status, team_leader_uid, team_leader_name, recorder_uid,
              recorder_name, post_event_note_status, finalized_at, last_notified_at
         FROM resuscitation_events
        WHERE tenant_id = $1::uuid
          AND started_at > (NOW() - make_interval(hours => $2::int))
          AND ($3::text IS NULL OR status = $3::text)
          AND ($4::uuid IS NULL OR patient_uid = $4::uuid)
        ORDER BY started_at DESC
        LIMIT $5::int`,
      tenant,
      h,
      status,
      patientUid,
      lim
    )
  );
  return normalizeRows(rows);
}

// ── Append-only timeline ────────────────────────────────────────────────────

export async function appendTimelineEntry({
  tenantId,
  eventId,
  actorUid,
  actorRole,
  ...body
}) {
  const tenant = tenantOr(tenantId);
  await assertEnabled(tenant);
  if (!TIMELINE_ENTRY_TYPES.has(body.entry_type)) {
    throw AppError.badRequest(
      `entry_type must be one of: ${[...TIMELINE_ENTRY_TYPES].join(', ')}`
    );
  }
  const isMedicationEntry = Object.prototype.hasOwnProperty.call(
    MEDICATION_ENTRY_KINDS,
    body.entry_type
  );
  if (isMedicationEntry && !body.medication_name && body.mar_administration_id == null) {
    throw AppError.badRequest(
      'medication/fluid/blood-product entries require medication_name or mar_administration_id'
    );
  }
  if (body.device_link && !DEVICE_LINK_KINDS.has(body.device_link.link_kind)) {
    throw AppError.badRequest(
      `device_link.link_kind must be one of: ${[...DEVICE_LINK_KINDS].join(', ')}`
    );
  }

  return setTenantTx(tenant, async tx => {
    // FOR UPDATE serializes concurrent appends on one event so seq assignment
    // is race-free (the unique index is the backstop).
    const event = await assertEvent(tx, tenant, eventId, { forUpdate: true });
    assertEventOpen(event);

    // MAR SAFETY: resus medication entries REFERENCE administered MAR rows.
    // We never insert into medication_administrations here, and a MAR row can
    // back at most one resus link ever (mig-516 unique index).
    let marRow = null;
    if (isMedicationEntry && body.mar_administration_id != null) {
      const marId = toInt(body.mar_administration_id, 'mar_administration_id');
      marRow = unwrap(
        await tx.$queryRawUnsafe(
          `SELECT id, patient_uid, medication_name, dose, dosage, route, status
             FROM medication_administrations
            WHERE id = $1 AND tenant_id = $2::uuid
            LIMIT 1`,
          marId,
          tenant
        )
      );
      if (!marRow) throw AppError.notFound('MAR administration not found');
      if (String(marRow.patient_uid) !== String(event.patient_uid)) {
        throw AppError.conflict(
          'MAR administration belongs to a different patient than this resuscitation event',
          'RESUS_MAR_PATIENT_MISMATCH'
        );
      }
      if (marRow.status !== 'administered') {
        throw AppError.conflict(
          'Only administered MAR doses can be referenced from a resuscitation timeline',
          'RESUS_MAR_NOT_ADMINISTERED'
        );
      }
      const alreadyLinked = unwrap(
        await tx.$queryRawUnsafe(
          `SELECT id FROM resuscitation_medication_links
            WHERE tenant_id = $1::uuid AND mar_administration_id = $2::int
            LIMIT 1`,
          tenant,
          marId
        )
      );
      if (alreadyLinked) {
        throw AppError.conflict(
          'This MAR administration is already documented on a resuscitation timeline — a dose cannot be counted twice',
          'RESUS_MAR_ALREADY_LINKED'
        );
      }
    }

    const seqRow = unwrap(
      await tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
           FROM resuscitation_event_timeline
          WHERE resuscitation_event_id = $1 AND tenant_id = $2::uuid`,
        event.id,
        tenant
      )
    );
    const nextSeq = Number(seqRow?.next_seq || 1);

    const entryRows = await tx.$queryRawUnsafe(
      `INSERT INTO resuscitation_event_timeline
         (tenant_id, resuscitation_event_id, patient_uid, seq, entry_type,
          occurred_at, rhythm, energy_joules, medication_name, dose, route,
          details, recorded_by)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, COALESCE($6::timestamptz, NOW()),
               $7, $8::numeric, $9, $10, $11, $12::jsonb, $13::uuid)
       RETURNING *`,
      tenant,
      event.id,
      event.patient_uid,
      nextSeq,
      body.entry_type,
      body.occurred_at || null,
      body.rhythm || null,
      body.energy_joules == null ? null : Number(body.energy_joules),
      body.medication_name || marRow?.medication_name || null,
      body.dose || marRow?.dose || marRow?.dosage || null,
      body.route || marRow?.route || null,
      json(body.details),
      actorUid || null
    );
    const entry = entryRows[0];

    let medicationLink = null;
    if (isMedicationEntry) {
      const linkRows = await tx.$queryRawUnsafe(
        `INSERT INTO resuscitation_medication_links
           (tenant_id, resuscitation_event_id, timeline_entry_id, patient_uid,
            link_kind, mar_administration_id, medication_kind, medication_name,
            dose, route, reconciliation_status, recorded_by, metadata)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::int, $7, $8, $9, $10, $11, $12::uuid, $13::jsonb)
         RETURNING *`,
        tenant,
        event.id,
        entry.id,
        event.patient_uid,
        marRow ? 'mar_administration' : 'unlinked_emergency',
        marRow ? marRow.id : null,
        MEDICATION_ENTRY_KINDS[body.entry_type],
        body.medication_name || marRow?.medication_name || 'Unspecified emergency medication',
        body.dose || marRow?.dose || marRow?.dosage || null,
        body.route || marRow?.route || null,
        marRow ? 'not_required' : 'pending_mar_reconciliation',
        actorUid || null,
        json(body.link_metadata)
      );
      medicationLink = linkRows[0];
    }

    let deviceLink = null;
    if (body.device_link) {
      const dl = body.device_link;
      const deviceRows = await tx.$queryRawUnsafe(
        `INSERT INTO resuscitation_device_links
           (tenant_id, resuscitation_event_id, timeline_entry_id, patient_uid,
            link_kind, device_registry_id, device_association_id,
            clinical_alert_id, vitals_chart_id, evidence, linked_by)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::int, $7::int, $8::int, $9::int, $10::jsonb, $11::uuid)
         RETURNING *`,
        tenant,
        event.id,
        entry.id,
        event.patient_uid,
        dl.link_kind,
        dl.device_registry_id == null ? null : toInt(dl.device_registry_id, 'device_registry_id'),
        dl.device_association_id == null ? null : toInt(dl.device_association_id, 'device_association_id'),
        dl.clinical_alert_id == null ? null : toInt(dl.clinical_alert_id, 'clinical_alert_id'),
        dl.vitals_chart_id == null ? null : toInt(dl.vitals_chart_id, 'vitals_chart_id'),
        json(dl.evidence),
        actorUid || null
      );
      deviceLink = deviceRows[0];
    }

    await recordCanonicalPair(tx, {
      tenantId: tenant,
      patientUid: event.patient_uid,
      resourceTable: 'resuscitation_event_timeline',
      resourceId: entry.id,
      eventType: 'resuscitation.timeline_appended',
      action: 'resuscitation.timeline.appended',
      actorUid,
      actorRole,
      summary: `Resuscitation timeline: ${body.entry_type.replace(/_/g, ' ')} (#${nextSeq})`,
      payload: {
        entry_type: body.entry_type,
        seq: nextSeq,
        rhythm: entry.rhythm,
        energy_joules: entry.energy_joules == null ? null : Number(entry.energy_joules),
        medication_name: entry.medication_name,
        mar_administration_id: marRow ? marRow.id : null,
        occurred_at: entry.occurred_at
      },
      afterState: entry
    });

    return {
      entry: normalizeValue(entry),
      medication_link: normalizeValue(medicationLink),
      device_link: normalizeValue(deviceLink)
    };
  });
}

// ── Team roles & signatures ─────────────────────────────────────────────────

export async function upsertTeamRole({
  tenantId,
  eventId,
  actorUid,
  actorRole,
  ...body
}) {
  const tenant = tenantOr(tenantId);
  await assertEnabled(tenant);
  if (!body.staff_uid) throw AppError.badRequest('staff_uid required');
  if (!TEAM_ROLES.has(body.role)) {
    throw AppError.badRequest(`role must be one of: ${[...TEAM_ROLES].join(', ')}`);
  }
  if (body.signature_method && !['app_confirmation', 'pin_confirmed', 'wet_signature_scan'].includes(body.signature_method)) {
    throw AppError.badRequest('invalid signature_method');
  }

  return setTenantTx(tenant, async tx => {
    const event = await assertEvent(tx, tenant, eventId, { forUpdate: true });
    assertEventOpen(event);

    const signNow = body.sign === true;
    // Sol Ultra LD-RRB-02: a signature attests the NAMED staff member's own
    // presence/action, and this path stamped signed_at for any caller-supplied
    // staff_uid — so an unrelated actor could forge another clinician's
    // resuscitation signature. Assigning a team role for someone else stays
    // allowed; SIGNING is self-only (an on-behalf-of flow would need explicit
    // verified delegation, not a body flag).
    if (signNow && String(body.staff_uid) !== String(actorUid || '')) {
      throw AppError.forbidden(
        'You may only sign your own resuscitation participation',
        'RESUS_SIGN_NOT_SELF',
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO resuscitation_team_roles
         (tenant_id, resuscitation_event_id, patient_uid, staff_uid, staff_name,
          role, joined_at, left_at, signed_at, signature_method,
          signature_evidence, assigned_by, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6,
               COALESCE($7::timestamptz, NOW()), $8::timestamptz,
               CASE WHEN $9 THEN NOW() ELSE NULL END,
               CASE WHEN $9 THEN $10 ELSE NULL END,
               $11::jsonb, $12::uuid, $13::jsonb)
       ON CONFLICT (tenant_id, resuscitation_event_id, staff_uid, role)
       DO UPDATE SET
         staff_name = COALESCE(EXCLUDED.staff_name, resuscitation_team_roles.staff_name),
         left_at = COALESCE(EXCLUDED.left_at, resuscitation_team_roles.left_at),
         signed_at = COALESCE(resuscitation_team_roles.signed_at, EXCLUDED.signed_at),
         signature_method = COALESCE(resuscitation_team_roles.signature_method, EXCLUDED.signature_method),
         signature_evidence = CASE
           WHEN resuscitation_team_roles.signed_at IS NULL AND EXCLUDED.signed_at IS NOT NULL
             THEN EXCLUDED.signature_evidence
           ELSE resuscitation_team_roles.signature_evidence
         END,
         updated_at = NOW()
       RETURNING *`,
      tenant,
      event.id,
      event.patient_uid,
      body.staff_uid,
      body.staff_name || null,
      body.role,
      body.joined_at || null,
      body.left_at || null,
      signNow,
      body.signature_method || 'app_confirmation',
      json(body.signature_evidence),
      actorUid || null,
      json(body.metadata)
    );
    const row = rows[0];

    // Leader/recorder land on the header — they are the finalize gate.
    if (body.role === 'team_leader' || body.role === 'recorder') {
      const col = body.role === 'team_leader' ? 'team_leader' : 'recorder';
      await tx.$executeRawUnsafe(
        `UPDATE resuscitation_events
            SET ${col}_uid = $3::uuid, ${col}_name = $4, updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2::uuid`,
        event.id,
        tenant,
        body.staff_uid,
        body.staff_name || null
      );
    }

    await recordCanonicalPair(tx, {
      tenantId: tenant,
      patientUid: event.patient_uid,
      resourceTable: 'resuscitation_team_roles',
      resourceId: row.id,
      eventType: 'resuscitation.team_role_recorded',
      action: 'resuscitation.team_role.recorded',
      actorUid,
      actorRole,
      summary: `Resuscitation team role recorded: ${body.role}${signNow ? ' (signed)' : ''}`,
      payload: {
        role: body.role,
        staff_uid: body.staff_uid,
        signed: signNow,
        occurred_at: row.joined_at
      },
      afterState: row
    });
    return normalizeValue(row);
  });
}

// ── End / finalize / misfire ────────────────────────────────────────────────

export async function endResuscitationEvent({
  tenantId,
  eventId,
  actorUid,
  actorRole,
  ended_at,
  outcome,
  outcome_note
}) {
  const tenant = tenantOr(tenantId);
  await assertEnabled(tenant);
  if (!['rosc', 'death', 'transferred', 'stopped_futility'].includes(outcome)) {
    throw AppError.badRequest(
      'outcome must be one of: rosc, death, transferred, stopped_futility'
    );
  }
  return setTenantTx(tenant, async tx => {
    const event = await assertEvent(tx, tenant, eventId, { forUpdate: true });
    if (event.status !== 'active') {
      throw AppError.invalidTransition(event.status, 'ended', ['active']);
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE resuscitation_events
          SET status = 'ended',
              ended_at = COALESCE($3::timestamptz, NOW()),
              outcome = $4,
              metadata = metadata || $5::jsonb,
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2::uuid
        RETURNING *`,
      event.id,
      tenant,
      ended_at || null,
      outcome,
      json(outcome_note ? { outcome_note } : {})
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      patientUid: event.patient_uid,
      resourceTable: 'resuscitation_events',
      resourceId: row.id,
      eventType: 'resuscitation.event_ended',
      action: 'resuscitation.event.ended',
      actorUid,
      actorRole,
      summary: `Resuscitation event ended (${outcome})`,
      payload: { outcome, occurred_at: row.ended_at },
      beforeState: event,
      afterState: row
    });
    return normalizeValue(row);
  });
}

export async function finalizeResuscitationEvent({ tenantId, eventId, actorUid, actorRole }) {
  const tenant = tenantOr(tenantId);
  await assertEnabled(tenant);
  return setTenantTx(tenant, async tx => {
    const event = await assertEvent(tx, tenant, eventId, { forUpdate: true });
    if (event.status !== 'ended') {
      throw AppError.invalidTransition(event.status, 'finalized', ['ended']);
    }
    // Spec §4.3: missing team leader/recorder BLOCKS finalization. The mig-513
    // CHECK constraint is the DB backstop; this is the caller-friendly gate.
    if (!event.team_leader_uid || !event.recorder_uid) {
      const missing = [
        !event.team_leader_uid ? 'team leader' : null,
        !event.recorder_uid ? 'recorder' : null
      ].filter(Boolean).join(' and ');
      throw AppError.conflict(
        `Finalization blocked: a documented ${missing} is required`,
        'RESUS_FINALIZE_BLOCKED'
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE resuscitation_events
          SET status = 'finalized',
              finalized_at = NOW(),
              finalized_by = $3::uuid,
              post_event_note_status = 'completed',
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2::uuid
        RETURNING *`,
      event.id,
      tenant,
      actorUid || null
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      patientUid: event.patient_uid,
      resourceTable: 'resuscitation_events',
      resourceId: row.id,
      eventType: 'resuscitation.event_finalized',
      action: 'resuscitation.event.finalized',
      actorUid,
      actorRole,
      summary: 'Resuscitation event finalized',
      payload: {
        team_leader_uid: row.team_leader_uid,
        recorder_uid: row.recorder_uid,
        occurred_at: row.finalized_at
      },
      beforeState: event,
      afterState: row
    });
    return normalizeValue(row);
  });
}

// Misfire reconciliation (code-blue-misfire runbook): the durable event is
// status-cancelled with an audited reason — never deleted.
export async function cancelMisfire({ tenantId, eventId, actorUid, actorRole, reason }) {
  const tenant = tenantOr(tenantId);
  await assertEnabled(tenant);
  if (!reason) throw AppError.badRequest('reason required to cancel a misfire');
  return setTenantTx(tenant, async tx => {
    const event = await assertEvent(tx, tenant, eventId, { forUpdate: true });
    if (event.status === 'finalized' || event.status === 'cancelled_misfire') {
      throw AppError.invalidTransition(event.status, 'cancelled_misfire', ['active', 'ended']);
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE resuscitation_events
          SET status = 'cancelled_misfire',
              outcome = 'misfire',
              ended_at = COALESCE(ended_at, NOW()),
              metadata = metadata || $3::jsonb,
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2::uuid
        RETURNING *`,
      event.id,
      tenant,
      json({ misfire_reason: reason, misfire_cancelled_by: actorUid || null })
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      patientUid: event.patient_uid,
      resourceTable: 'resuscitation_events',
      resourceId: row.id,
      eventType: 'resuscitation.event_misfire_cancelled',
      action: 'resuscitation.event.misfire_cancelled',
      actorUid,
      actorRole,
      summary: 'Resuscitation event cancelled as misfire',
      payload: { reason, occurred_at: row.ended_at },
      beforeState: event,
      afterState: row
    });
    return normalizeValue(row);
  });
}

// ── Post-event QA / debrief (fail-closed, governance-owned content) ─────────

export async function upsertQaReview({
  tenantId,
  eventId,
  actorUid,
  actorRole,
  ...body
}) {
  const tenant = tenantOr(tenantId);
  await assertEnabled(tenant);
  const requestedStatus = body.review_status || 'template_unavailable';
  if (!['template_unavailable', 'draft', 'submitted', 'signed_off'].includes(requestedStatus)) {
    throw AppError.badRequest('invalid review_status');
  }
  const templateSource = body.template_source || 'unavailable';
  if (!['nl5_content_studio', 'operator_supplied', 'unavailable'].includes(templateSource)) {
    throw AppError.badRequest('invalid template_source');
  }
  // FAIL CLOSED: no approved template content → the review cannot progress.
  if (requestedStatus !== 'template_unavailable'
    && (templateSource === 'unavailable' || !body.template_version)) {
    throw AppError.conflict(
      'QA/debrief template content is unavailable — the review stays inert until clinical governance supplies an approved template',
      'RESUS_QA_TEMPLATE_UNAVAILABLE'
    );
  }
  // Sol Ultra LD-RRB-02: a QA sign-off attests the REVIEWER's own decision, so
  // bind it to the authenticated actor rather than a caller-supplied
  // reviewer_uid (which let an actor sign off under another clinician's id).
  if (requestedStatus === 'signed_off' && !actorUid) {
    throw AppError.conflict(
      'QA review sign-off requires an authenticated reviewer',
      'RESUS_QA_REVIEWER_REQUIRED'
    );
  }
  const reviewerUid = requestedStatus === 'signed_off'
    ? actorUid
    : (body.reviewer_uid || null);

  return setTenantTx(tenant, async tx => {
    const event = await assertEvent(tx, tenant, eventId);
    if (event.status === 'active') {
      throw AppError.conflict(
        'QA/debrief review opens after the event has ended',
        'RESUS_QA_EVENT_STILL_ACTIVE'
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO resuscitation_qa_reviews
         (tenant_id, resuscitation_event_id, patient_uid, review_status,
          template_source, template_version, template_reference_uri,
          template_snapshot, evidence_owner_uid, responses, findings,
          action_items, debrief_held_at, debrief_lead_uid, reviewer_uid,
          reviewer_signed_at, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9::uuid,
               $10::jsonb, $11, $12::jsonb, $13::timestamptz, $14::uuid, $15::uuid,
               CASE WHEN $4 = 'signed_off' THEN NOW() ELSE NULL END, $16::jsonb)
       ON CONFLICT (tenant_id, resuscitation_event_id) DO UPDATE SET
         review_status = EXCLUDED.review_status,
         template_source = EXCLUDED.template_source,
         template_version = EXCLUDED.template_version,
         template_reference_uri = EXCLUDED.template_reference_uri,
         template_snapshot = EXCLUDED.template_snapshot,
         evidence_owner_uid = COALESCE(EXCLUDED.evidence_owner_uid, resuscitation_qa_reviews.evidence_owner_uid),
         responses = EXCLUDED.responses,
         findings = EXCLUDED.findings,
         action_items = EXCLUDED.action_items,
         debrief_held_at = COALESCE(EXCLUDED.debrief_held_at, resuscitation_qa_reviews.debrief_held_at),
         debrief_lead_uid = COALESCE(EXCLUDED.debrief_lead_uid, resuscitation_qa_reviews.debrief_lead_uid),
         reviewer_uid = EXCLUDED.reviewer_uid,
         reviewer_signed_at = CASE
           WHEN EXCLUDED.review_status = 'signed_off'
             THEN COALESCE(resuscitation_qa_reviews.reviewer_signed_at, NOW())
           ELSE NULL
         END,
         metadata = resuscitation_qa_reviews.metadata || EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      tenant,
      event.id,
      event.patient_uid,
      requestedStatus,
      templateSource,
      body.template_version || null,
      body.template_reference_uri || null,
      json(body.template_snapshot),
      body.evidence_owner_uid || null,
      json(body.responses),
      body.findings || null,
      json(body.action_items, []),
      body.debrief_held_at || null,
      body.debrief_lead_uid || null,
      reviewerUid,
      json(body.metadata)
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      patientUid: event.patient_uid,
      resourceTable: 'resuscitation_qa_reviews',
      resourceId: row.id,
      eventType: 'resuscitation.qa_review_updated',
      action: 'resuscitation.qa_review.updated',
      actorUid,
      actorRole,
      summary: `Resuscitation QA/debrief review ${requestedStatus.replace(/_/g, ' ')}`,
      payload: {
        review_status: requestedStatus,
        template_source: templateSource,
        template_version: body.template_version || null,
        occurred_at: row.updated_at
      },
      afterState: row
    });
    return normalizeValue(row);
  });
}
