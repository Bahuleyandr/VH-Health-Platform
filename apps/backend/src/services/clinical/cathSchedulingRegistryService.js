// NL-13 P1f — cath scheduling on the Scheduling 2.0 rails + dose-audit
// rollups + complication registry.
//
// Cath rooms are plain bookable_resources rows (kind='room') the owner
// creates through the existing scheduling admin — this module ships ZERO
// seeded rooms. Elective/routine/urgent cases book through the shared
// bookResource() rails (overlap guard, compatibility, GiST exclusion);
// emergency/STEMI cases BYPASS booking entirely and only surface as a
// soft-conflict indicator on the schedule strip — they never block or
// auto-cancel an existing booking.
//
// Dose rollups are read-only derivations over cath_contrast_radiation_records
// (migration 485); alert thresholds are owner-configured per tenant
// (migration 570, mig-351 pattern) and the rollup fails closed to
// thresholds_pending when unset — no dose limit is ever fabricated here.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import logger from '../../logging/logger.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { bookResource } from '../scheduling/schedulingOptimizationService.js';
import {
  recordCanonicalClinicalEvent,
  recordClinicalAuditEvent
} from './canonicalClinicalPlatformService.js';

const tenantOr = value => requireTenantId(value);

export const BOOKABLE_CASE_STATUSES = Object.freeze([
  'requested',
  'scheduled',
  'readiness_pending',
  'ready'
]);

export const REGISTRY_SEVERITIES = Object.freeze([
  'unspecified',
  'minor',
  'moderate',
  'severe',
  'fatal'
]);

export const REGISTRY_OUTCOMES = Object.freeze([
  'resolved',
  'ongoing',
  'sequelae',
  'death',
  'unknown'
]);

export const REGISTRY_REVIEW_STATUSES = Object.freeze([
  'open',
  'under_review',
  'reviewed',
  'closed'
]);

// closed is terminal except an explicit reopen to under_review.
export const REGISTRY_REVIEW_TRANSITIONS = Object.freeze({
  open: ['under_review', 'reviewed', 'closed'],
  under_review: ['open', 'reviewed', 'closed'],
  reviewed: ['under_review', 'closed'],
  closed: ['under_review']
});

export const DOSE_THRESHOLD_FIELDS = Object.freeze([
  'fluoro_time_alert_min',
  'dap_alert_gy_cm2',
  'air_kerma_alert_mgy',
  'contrast_volume_alert_ml'
]);

const THRESHOLD_TO_DOSE_COLUMN = Object.freeze({
  fluoro_time_alert_min: 'fluoroscopy_time_min',
  dap_alert_gy_cm2: 'dose_area_product_gy_cm2',
  air_kerma_alert_mgy: 'air_kerma_mgy',
  contrast_volume_alert_ml: 'contrast_volume_ml'
});

function cleanText(value, max = 8000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_SCHED_BAD_ID');
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'CATH_SCHED_BAD_UUID');
  }
  return text;
}

function requireTimestamp(value, label) {
  const date = new Date(value ?? '');
  if (!value || Number.isNaN(date.getTime())) {
    throw AppError.badRequest(`${label} must be a valid timestamp`, 'CATH_SCHED_BAD_TIMESTAMP');
  }
  return date.toISOString();
}

function optionalPositiveNumber(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw AppError.badRequest(`${label} must be a positive number`, 'CATH_SCHED_BAD_NUMBER');
  }
  return number;
}

function normalizeDbValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (Array.isArray(value)) return value.map(normalizeDbValue);
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeDbValue(item)])
    );
  }
  return value;
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows.map(normalizeDbValue) : normalizeDbValue(rows);
}

function unwrap(rows) {
  return Array.isArray(rows) ? rows[0] : rows;
}

function dateOnly(value, label = 'date') {
  const text = cleanText(value, 10);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw AppError.badRequest(`${label} must be YYYY-MM-DD`, 'CATH_SCHED_BAD_DATE');
  }
  return text;
}

/** Emergency/STEMI cases never enter the booking flow. Pure — unit-tested. */
export function assertCaseBookable(cathCase) {
  if (!cathCase) {
    throw AppError.notFound('Cath-lab case not found', 'CATH_SCHED_CASE_NOT_FOUND');
  }
  if (cathCase.urgency === 'emergency') {
    throw AppError.badRequest(
      'Emergency/STEMI cath cases bypass booking; they run immediately and only flag the schedule display',
      'CATH_SCHED_EMERGENCY_BYPASS'
    );
  }
  if (!BOOKABLE_CASE_STATUSES.includes(cathCase.status)) {
    throw AppError.invalidTransition(cathCase.status, 'booked', BOOKABLE_CASE_STATUSES);
  }
  return true;
}

/**
 * Soft-conflict rule (pure, unit-tested): an emergency case flags a booking
 * when its active interval overlaps the booking window. The active interval
 * starts at actual_start_at || planned_start_at || created_at and ends at
 * actual_end_at || planned_end_at || open-ended (an unfinished emergency
 * contends with everything after it starts). Completed/cancelled emergencies
 * never flag.
 */
export function computeSoftConflicts(bookings = [], emergencies = []) {
  const active = emergencies
    .filter(e => e && !['completed', 'cancelled'].includes(e.status))
    .map(e => ({
      id: e.id,
      start: new Date(e.actual_start_at || e.planned_start_at || e.created_at || 0),
      end: e.actual_end_at
        ? new Date(e.actual_end_at)
        : e.planned_end_at
          ? new Date(e.planned_end_at)
          : null
    }));
  return bookings.map(booking => {
    const startsAt = new Date(booking.starts_at);
    const endsAt = new Date(booking.ends_at);
    const conflicting = active
      .filter(e => e.start < endsAt && (e.end === null || e.end > startsAt))
      .map(e => e.id);
    return {
      ...booking,
      soft_conflict: conflicting.length > 0,
      conflicting_emergency_case_ids: conflicting
    };
  });
}

async function caseById(db, tenantId, caseId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, requested_procedure, urgency,
            lab_room, status, planned_start_at, planned_end_at, actual_start_at,
            actual_end_at, created_at
       FROM cath_lab_cases
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid
      LIMIT 1`,
    normalizeId(caseId, 'case_id'),
    tenantOr(tenantId)
  );
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('Cath-lab case not found', 'CATH_SCHED_CASE_NOT_FOUND');
  return row;
}

async function activeLinkForCase(db, tenantId, caseId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT l.id, l.case_id, l.resource_booking_id, l.resource_id, l.status,
            l.linked_by, l.created_at, b.starts_at, b.ends_at, b.status AS booking_status,
            r.name AS resource_name, r.location AS resource_location
       FROM cath_case_schedule_links l
       JOIN resource_bookings b ON b.id = l.resource_booking_id AND b.tenant_id = l.tenant_id
       JOIN bookable_resources r ON r.id = l.resource_id AND r.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1::uuid
        AND l.case_id = $2::bigint
        AND l.status = 'active'
      LIMIT 1`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id')
  );
  return unwrap(rows) || null;
}

/**
 * Book an ELECTIVE cath case into a room slot on the Scheduling 2.0 rails.
 * Phase 0: validations on plain prisma. Phase 1a: bookResource() (its own
 * tenant-scoped tx — overlap + compatibility + GiST guard). Phase 1b: link
 * row + case planned-window update + canonical event in one tx; a 1b failure
 * compensates by cancelling the just-created booking so no orphan slot holds
 * the room.
 */
export async function scheduleCase(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const resourceId = normalizeId(input.resource_id || input.resourceId, 'resource_id');
  const startsAt = requireTimestamp(input.starts_at || input.startsAt, 'starts_at');
  const endsAt = requireTimestamp(input.ends_at || input.endsAt, 'ends_at');
  if (new Date(endsAt) <= new Date(startsAt)) {
    throw AppError.badRequest('ends_at must be after starts_at', 'CATH_SCHED_BAD_WINDOW');
  }
  const notes = cleanText(input.notes, 300);

  const cathCase = await caseById(prisma, tenantId, caseId);
  assertCaseBookable(cathCase);

  const room = unwrap(await prisma.$queryRawUnsafe(
    `SELECT id, name, kind, location FROM bookable_resources
      WHERE id = $1::int AND tenant_id = $2::uuid AND is_active
      LIMIT 1`,
    resourceId,
    tenantId
  ));
  if (!room) throw AppError.notFound('Bookable resource not found', 'CATH_SCHED_RESOURCE_NOT_FOUND');
  if (room.kind !== 'room') {
    throw AppError.badRequest('Cath cases book into room resources', 'CATH_SCHED_RESOURCE_KIND');
  }

  const existing = await activeLinkForCase(prisma, tenantId, cathCase.id);
  if (existing) {
    throw AppError.conflict('Case already has an active booking', 'CATH_SCHED_ALREADY_BOOKED', {
      link_id: existing.id,
      resource_booking_id: existing.resource_booking_id
    });
  }

  const booking = await bookResource(
    {
      resourceId,
      startsAt,
      endsAt,
      bookedForType: 'other',
      bookedForId: `cath_case:${cathCase.id}`,
      patientUid: cathCase.patient_uid,
      notes,
      tenantId
    },
    context
  );

  try {
    return await setTenantTx(tenantId, async tx => {
      const linkRows = await tx.$queryRawUnsafe(
        `INSERT INTO cath_case_schedule_links
           (tenant_id, case_id, resource_booking_id, resource_id, status, linked_by, metadata)
         VALUES ($1::uuid, $2::bigint, $3::int, $4::int, 'active', $5::uuid, $6::jsonb)
         RETURNING *`,
        tenantId,
        cathCase.id,
        booking.id,
        resourceId,
        maybeUuid(context.actorUid, 'actorUid'),
        JSON.stringify({ booked_for: 'elective_cath_case' })
      );
      const link = unwrap(linkRows);
      await tx.$queryRawUnsafe(
        `UPDATE cath_lab_cases
            SET planned_start_at = $3::timestamptz,
                planned_end_at = $4::timestamptz,
                lab_room = $5,
                updated_by = $6::uuid,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint`,
        tenantId,
        cathCase.id,
        startsAt,
        endsAt,
        cleanText(room.name, 120),
        maybeUuid(context.actorUid, 'actorUid')
      );
      await recordCanonicalClinicalEvent(
        {
          tenantId,
          patientUid: cathCase.patient_uid,
          encounterId: cathCase.encounter_id,
          eventType: 'cath_lab.case_booked',
          eventStatus: 'booked',
          sourceTable: 'cath_case_schedule_links',
          sourceId: link.id,
          actorUid: context.actorUid,
          actorRole: context.actorRole,
          summary: `Cath case booked into ${room.name}`,
          payload: {
            case_id: cathCase.id,
            resource_id: resourceId,
            resource_name: room.name,
            resource_booking_id: booking.id,
            starts_at: startsAt,
            ends_at: endsAt
          },
          tags: ['cath_lab', 'nl13_p1f', 'scheduling']
        },
        { db: tx }
      );
      return normalizeDbValue({
        ...link,
        starts_at: booking.starts_at,
        ends_at: booking.ends_at,
        resource_name: room.name,
        resource_location: room.location
      });
    });
  } catch (err) {
    // Compensate: never leave an orphan booking holding the room.
    try {
      await setTenantTx(tenantId, tx =>
        tx.$queryRawUnsafe(
          `UPDATE resource_bookings SET status = 'cancelled'
            WHERE id = $1::int AND tenant_id = $2::uuid`,
          booking.id,
          tenantId
        )
      );
    } catch (cancelErr) {
      logger.error('Cath schedule compensation failed; booking may be orphaned', {
        bookingId: booking.id,
        error: cancelErr.message
      });
    }
    throw err;
  }
}

/** Cancel a case's active booking (frees the room; the case itself is untouched). */
export async function cancelCaseSchedule(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const reason = cleanText(input.reason, 500);
  const cathCase = await caseById(prisma, tenantId, caseId);
  const link = await activeLinkForCase(prisma, tenantId, cathCase.id);
  if (!link) {
    throw AppError.notFound('Case has no active booking', 'CATH_SCHED_LINK_NOT_FOUND');
  }
  return setTenantTx(tenantId, async tx => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE cath_case_schedule_links
          SET status = 'cancelled',
              cancelled_by = $3::uuid,
              cancelled_at = NOW(),
              cancel_reason = $4,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status = 'active'
        RETURNING *`,
      tenantId,
      link.id,
      maybeUuid(context.actorUid, 'actorUid'),
      reason
    );
    const cancelled = unwrap(rows);
    if (!cancelled) {
      throw AppError.conflict('Booking link is no longer active', 'CATH_SCHED_LINK_STALE');
    }
    await tx.$queryRawUnsafe(
      `UPDATE resource_bookings SET status = 'cancelled'
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      link.resource_booking_id,
      tenantId
    );
    await recordCanonicalClinicalEvent(
      {
        tenantId,
        patientUid: cathCase.patient_uid,
        encounterId: cathCase.encounter_id,
        eventType: 'cath_lab.case_booking_cancelled',
        eventStatus: 'cancelled',
        sourceTable: 'cath_case_schedule_links',
        sourceId: link.id,
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        summary: `Cath case booking cancelled${reason ? `: ${reason}` : ''}`,
        payload: {
          case_id: cathCase.id,
          resource_booking_id: link.resource_booking_id,
          reason
        },
        tags: ['cath_lab', 'nl13_p1f', 'scheduling']
      },
      { db: tx }
    );
    return normalizeDbValue(cancelled);
  });
}

/** Active booking (if any) for one case. */
export async function getCaseSchedule(caseId, { tenantId } = {}) {
  const tid = tenantOr(tenantId);
  const cathCase = await caseById(prisma, tid, caseId);
  const link = await activeLinkForCase(prisma, tid, cathCase.id);
  return normalizeDbValue({
    case_id: cathCase.id,
    urgency: cathCase.urgency,
    status: cathCase.status,
    booking: link
  });
}

/**
 * Schedule strip for one day: booked slots (from the scheduling rails, joined
 * to their cath cases) + active emergency cases + soft-conflict flags.
 * Read-only; emergencies are display indicators and never mutate bookings.
 */
export async function getScheduleStrip({ tenantId, date } = {}) {
  const tid = tenantOr(tenantId);
  const day = dateOnly(date || new Date().toISOString().slice(0, 10));
  const bookings = await prisma.$queryRawUnsafe(
    `SELECT l.id AS link_id, l.case_id, l.resource_booking_id, l.resource_id,
            b.starts_at, b.ends_at, r.name AS resource_name, r.location AS resource_location,
            c.status AS case_status, c.urgency, c.requested_procedure, c.patient_uid,
            u.name AS patient_name
       FROM cath_case_schedule_links l
       JOIN resource_bookings b
         ON b.id = l.resource_booking_id AND b.tenant_id = l.tenant_id
       JOIN bookable_resources r
         ON r.id = l.resource_id AND r.tenant_id = l.tenant_id
       JOIN cath_lab_cases c
         ON c.id = l.case_id AND c.tenant_id = l.tenant_id
       LEFT JOIN users u
         ON u.uid = c.patient_uid AND u.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1::uuid
        AND l.status = 'active'
        AND b.status = 'booked'
        AND DATE(b.starts_at AT TIME ZONE 'Asia/Kolkata') = $2::date
      ORDER BY b.starts_at, r.name`,
    tid,
    day
  );
  const emergencies = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.status, c.urgency, c.requested_procedure, c.lab_room,
            c.planned_start_at, c.planned_end_at, c.actual_start_at, c.actual_end_at,
            c.created_at, c.patient_uid, u.name AS patient_name
       FROM cath_lab_cases c
       LEFT JOIN users u
         ON u.uid = c.patient_uid AND u.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1::uuid
        AND c.urgency = 'emergency'
        AND c.status NOT IN ('completed', 'cancelled')
        AND DATE(COALESCE(c.actual_start_at, c.planned_start_at, c.created_at)
              AT TIME ZONE 'Asia/Kolkata') = $2::date
      ORDER BY COALESCE(c.actual_start_at, c.planned_start_at, c.created_at)`,
    tid,
    day
  );
  const flagged = computeSoftConflicts(normalizeRows(bookings), normalizeRows(emergencies));
  return {
    date: day,
    bookings: flagged,
    emergencies: normalizeRows(emergencies),
    has_soft_conflict: flagged.some(b => b.soft_conflict)
  };
}

// ---------------------------------------------------------------------------
// Dose-audit rollups + owner thresholds (mig 570)
// ---------------------------------------------------------------------------

/**
 * Fail-closed per-tenant threshold read (mig-351 pattern). No row or all-NULL
 * thresholds → thresholds_pending; alerting logic must not run.
 */
export async function getDoseAlertSettings(tenantId) {
  const tid = tenantOr(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, fluoro_time_alert_min, dap_alert_gy_cm2, air_kerma_alert_mgy,
            contrast_volume_alert_ml, notes, configured_by, configured_at, updated_at
       FROM cath_dose_alert_settings
      WHERE tenant_id = $1::uuid`,
    tid
  );
  const row = normalizeDbValue(unwrap(rows) || null);
  const configured = Boolean(row && DOSE_THRESHOLD_FIELDS.some(field => row[field] != null));
  return {
    thresholds_status: configured ? 'configured' : 'thresholds_pending',
    configured,
    settings: row
  };
}

/** Owner-configured thresholds; NULL clears a threshold. Never seeded. */
export async function setDoseAlertSettings(tenantId, input = {}, context = {}) {
  const tid = tenantOr(tenantId);
  const values = {};
  for (const field of DOSE_THRESHOLD_FIELDS) {
    values[field] = optionalPositiveNumber(input[field], field);
  }
  const notes = cleanText(input.notes, 2000);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO cath_dose_alert_settings
       (tenant_id, fluoro_time_alert_min, dap_alert_gy_cm2, air_kerma_alert_mgy,
        contrast_volume_alert_ml, notes, configured_by, configured_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, NOW(), NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET
       fluoro_time_alert_min = EXCLUDED.fluoro_time_alert_min,
       dap_alert_gy_cm2 = EXCLUDED.dap_alert_gy_cm2,
       air_kerma_alert_mgy = EXCLUDED.air_kerma_alert_mgy,
       contrast_volume_alert_ml = EXCLUDED.contrast_volume_alert_ml,
       notes = EXCLUDED.notes,
       configured_by = EXCLUDED.configured_by,
       configured_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    tid,
    values.fluoro_time_alert_min,
    values.dap_alert_gy_cm2,
    values.air_kerma_alert_mgy,
    values.contrast_volume_alert_ml,
    notes,
    maybeUuid(context.actorUid, 'actorUid')
  );
  await prisma.$queryRawUnsafe(
    `INSERT INTO audit_logs (uid, role, action, resource, resource_id, metadata, created_at)
     VALUES ($1::uuid, $2, 'CATH_DOSE_SETTINGS_UPDATED', 'cath_dose_alert_settings', $3, $4::jsonb, NOW())`,
    maybeUuid(context.actorUid, 'actorUid'),
    cleanText(context.actorRole, 60) || 'system',
    tid,
    JSON.stringify({ thresholds: values, notes: Boolean(notes) })
  );
  return normalizeDbValue(unwrap(rows));
}

/** Threshold breach test for one dose record. Pure — unit-tested. */
export function evaluateDoseRecordAgainstThresholds(record = {}, settings = null) {
  if (!settings) return { thresholds_status: 'thresholds_pending', breaches: [] };
  const breaches = [];
  for (const [thresholdField, doseColumn] of Object.entries(THRESHOLD_TO_DOSE_COLUMN)) {
    const limit = settings[thresholdField];
    const value = record[doseColumn];
    if (limit != null && value != null && Number(value) > Number(limit)) {
      breaches.push({ field: doseColumn, value: Number(value), threshold: Number(limit) });
    }
  }
  return { thresholds_status: 'configured', breaches };
}

/**
 * Per-month or per-operator rollup of radiation dose / contrast usage.
 * Read-only derivation from cath_contrast_radiation_records — no writes, no
 * audit spam (route-level phiAccessLogger only). Breach counts appear ONLY
 * when the owner has configured thresholds; otherwise the payload carries
 * thresholds_status='thresholds_pending' and null breach fields (fail-closed).
 */
export async function getDoseRollup({ tenantId, from, to, groupBy = 'month' } = {}) {
  const tid = tenantOr(tenantId);
  const fromDay = dateOnly(from, 'from');
  const toDay = dateOnly(to, 'to');
  if (new Date(fromDay) > new Date(toDay)) {
    throw AppError.badRequest('from must be <= to', 'CATH_SCHED_PERIOD_INVERTED');
  }
  const grouping = cleanText(groupBy, 20) || 'month';
  if (!['month', 'operator'].includes(grouping)) {
    throw AppError.badRequest('group_by must be month or operator', 'CATH_SCHED_BAD_GROUP');
  }
  const { configured, settings } = await getDoseAlertSettings(tid);

  const breachSelect = configured
    ? `COUNT(*) FILTER (WHERE
         (d.fluoroscopy_time_min IS NOT NULL AND $4::numeric IS NOT NULL AND d.fluoroscopy_time_min > $4::numeric)
         OR (d.dose_area_product_gy_cm2 IS NOT NULL AND $5::numeric IS NOT NULL AND d.dose_area_product_gy_cm2 > $5::numeric)
         OR (d.air_kerma_mgy IS NOT NULL AND $6::numeric IS NOT NULL AND d.air_kerma_mgy > $6::numeric)
         OR (d.contrast_volume_ml IS NOT NULL AND $7::numeric IS NOT NULL AND d.contrast_volume_ml > $7::numeric)
       )::int`
    : 'NULL::int';
  const thresholdParams = configured
    ? [
        settings.fluoro_time_alert_min,
        settings.dap_alert_gy_cm2,
        settings.air_kerma_alert_mgy,
        settings.contrast_volume_alert_ml
      ]
    : [];

  const groupExpr = grouping === 'month'
    ? `to_char(date_trunc('month', d.recorded_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM')`
    : `CASE
         WHEN op.value IS NULL THEN 'unattributed'
         WHEN jsonb_typeof(op.value) = 'string' THEN COALESCE(NULLIF(TRIM(op.value #>> '{}'), ''), 'unattributed')
         ELSE COALESCE(NULLIF(TRIM(op.value ->> 'name'), ''), NULLIF(TRIM(op.value ->> 'uid'), ''), 'unattributed')
       END`;
  const operatorJoin = grouping === 'operator'
    ? `LEFT JOIN cath_procedure_logs p
         ON p.id = d.procedure_log_id AND p.tenant_id = d.tenant_id
       LEFT JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(p.operators) = 'array' THEN p.operators ELSE '[]'::jsonb END
       ) AS op(value) ON TRUE`
    : '';

  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${groupExpr} AS bucket,
            COUNT(DISTINCT d.case_id)::int AS case_count,
            COUNT(d.id)::int AS record_count,
            SUM(d.fluoroscopy_time_min)::numeric(14,2) AS total_fluoro_time_min,
            AVG(d.fluoroscopy_time_min)::numeric(14,2) AS avg_fluoro_time_min,
            SUM(d.dose_area_product_gy_cm2)::numeric(14,3) AS total_dap_gy_cm2,
            AVG(d.dose_area_product_gy_cm2)::numeric(14,3) AS avg_dap_gy_cm2,
            SUM(d.air_kerma_mgy)::numeric(14,3) AS total_air_kerma_mgy,
            SUM(d.contrast_volume_ml)::numeric(14,2) AS total_contrast_ml,
            AVG(d.contrast_volume_ml)::numeric(14,2) AS avg_contrast_ml,
            ${breachSelect} AS breach_count
       FROM cath_contrast_radiation_records d
       ${operatorJoin}
      WHERE d.tenant_id = $1::uuid
        AND d.recorded_at >= $2::date
        AND d.recorded_at < ($3::date + 1)
      GROUP BY 1
      ORDER BY 1`,
    tid,
    fromDay,
    toDay,
    ...thresholdParams
  );
  return {
    period: { from: fromDay, to: toDay },
    group_by: grouping,
    thresholds_status: configured ? 'configured' : 'thresholds_pending',
    thresholds: configured ? settings : null,
    rows: normalizeRows(rows)
  };
}

// ---------------------------------------------------------------------------
// Complication registry (mig 571)
// ---------------------------------------------------------------------------

/** Map one free-form procedure-log complication element to registry fields. Pure. */
export function mapComplicationElement(element) {
  if (element == null) return null;
  if (typeof element === 'string') {
    const text = element.trim();
    if (!text) return null;
    return {
      complication_code: null,
      complication_category: 'uncategorised',
      description: text.slice(0, 8000),
      severity: 'unspecified',
      outcome: null
    };
  }
  if (typeof element !== 'object') return null;
  const severity = REGISTRY_SEVERITIES.includes(element.severity) ? element.severity : 'unspecified';
  const outcome = REGISTRY_OUTCOMES.includes(element.outcome) ? element.outcome : null;
  const description = cleanText(
    element.description ?? element.text ?? element.note ?? element.summary,
    8000
  );
  return {
    complication_code: cleanText(element.code ?? element.complication_code, 80),
    complication_category: cleanText(element.category ?? element.complication_category, 80) || 'uncategorised',
    description,
    severity,
    outcome
  };
}

/**
 * Derive registry rows from a procedure log's complications JSONB. Runs
 * INSIDE the caller's transaction (recordProcedureLog) so the registry row,
 * its canonical timeline event, and its audit event land atomically with the
 * procedure log itself.
 */
export async function deriveComplicationRegistryRows(
  tx,
  { tenantId, caseId, procedureLogId, patientUid, encounterId = null, complications = [], occurredAt = null },
  context = {}
) {
  const tid = tenantOr(tenantId);
  const mapped = (Array.isArray(complications) ? complications : [])
    .map(mapComplicationElement)
    .filter(Boolean);
  const created = [];
  for (const entry of mapped) {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_complication_registry
         (tenant_id, case_id, procedure_log_id, patient_uid, complication_code,
          complication_category, description, severity, outcome, review_status,
          occurred_at, source, reported_by, metadata)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, $5,
               $6, $7, $8, $9, 'open',
               $10::timestamptz, 'procedure_log', $11::uuid, '{}'::jsonb)
       RETURNING *`,
      tid,
      normalizeId(caseId, 'case_id'),
      procedureLogId ? normalizeId(procedureLogId, 'procedure_log_id') : null,
      maybeUuid(patientUid, 'patient_uid'),
      entry.complication_code,
      entry.complication_category,
      entry.description,
      entry.severity,
      entry.outcome,
      occurredAt,
      maybeUuid(context.actorUid, 'actorUid')
    );
    const row = unwrap(rows);
    const event = await recordCanonicalClinicalEvent(
      {
        tenantId: tid,
        patientUid,
        encounterId,
        eventType: 'cath_lab.complication_recorded',
        eventStatus: 'open',
        sourceTable: 'cath_complication_registry',
        sourceId: row.id,
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        summary: `Cath complication recorded: ${entry.complication_category}`,
        payload: {
          case_id: row.case_id,
          procedure_log_id: row.procedure_log_id,
          complication_category: entry.complication_category,
          severity: entry.severity
        },
        tags: ['cath_lab', 'nl13_p1f', 'complication_registry']
      },
      { db: tx }
    );
    await tx.$queryRawUnsafe(
      `UPDATE cath_complication_registry
          SET timeline_event_id = $3::uuid, audit_event_id = $4::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      tid,
      row.id,
      event?.timeline?.id || null,
      event?.audit?.id || null
    );
    created.push(normalizeDbValue(row));
  }
  return created;
}

/** Manual registry entry (source='manual'), same canonical-event contract. */
export async function addRegistryEntry(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const cathCase = await caseById(prisma, tenantId, caseId);
  const entry = mapComplicationElement({
    code: input.complication_code ?? input.code,
    category: input.complication_category ?? input.category,
    description: input.description,
    severity: input.severity,
    outcome: input.outcome
  });
  if (!entry || (!entry.description && !entry.complication_code && entry.complication_category === 'uncategorised')) {
    throw AppError.badRequest(
      'A complication code, category, or description is required',
      'CATH_REGISTRY_ENTRY_REQUIRED'
    );
  }
  if (input.severity && !REGISTRY_SEVERITIES.includes(input.severity)) {
    throw AppError.badRequest(
      `severity must be one of: ${REGISTRY_SEVERITIES.join(', ')}`,
      'CATH_REGISTRY_BAD_SEVERITY'
    );
  }
  if (input.outcome && !REGISTRY_OUTCOMES.includes(input.outcome)) {
    throw AppError.badRequest(
      `outcome must be one of: ${REGISTRY_OUTCOMES.join(', ')}`,
      'CATH_REGISTRY_BAD_OUTCOME'
    );
  }
  return setTenantTx(tenantId, async tx => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_complication_registry
         (tenant_id, case_id, procedure_log_id, patient_uid, complication_code,
          complication_category, description, severity, outcome, review_status,
          occurred_at, source, reported_by, metadata)
       VALUES ($1::uuid, $2::bigint, NULL, $3::uuid, $4,
               $5, $6, $7, $8, 'open',
               $9::timestamptz, 'manual', $10::uuid, '{}'::jsonb)
       RETURNING *`,
      tenantId,
      cathCase.id,
      cathCase.patient_uid,
      entry.complication_code,
      entry.complication_category,
      entry.description,
      entry.severity,
      entry.outcome,
      input.occurred_at ? requireTimestamp(input.occurred_at, 'occurred_at') : null,
      maybeUuid(context.actorUid, 'actorUid')
    );
    const row = unwrap(rows);
    const event = await recordCanonicalClinicalEvent(
      {
        tenantId,
        patientUid: cathCase.patient_uid,
        encounterId: cathCase.encounter_id,
        eventType: 'cath_lab.complication_recorded',
        eventStatus: 'open',
        sourceTable: 'cath_complication_registry',
        sourceId: row.id,
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        summary: `Cath complication recorded: ${entry.complication_category}`,
        payload: {
          case_id: row.case_id,
          complication_category: entry.complication_category,
          severity: entry.severity,
          source: 'manual'
        },
        tags: ['cath_lab', 'nl13_p1f', 'complication_registry']
      },
      { db: tx }
    );
    await tx.$queryRawUnsafe(
      `UPDATE cath_complication_registry
          SET timeline_event_id = $3::uuid, audit_event_id = $4::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      tenantId,
      row.id,
      event?.timeline?.id || null,
      event?.audit?.id || null
    );
    return normalizeDbValue({ ...row, timeline_event_id: event?.timeline?.id || null, audit_event_id: event?.audit?.id || null });
  });
}

export async function listRegistry({
  tenantId,
  from = null,
  to = null,
  reviewStatus = null,
  severity = null,
  category = null,
  limit = 100
} = {}) {
  const tid = tenantOr(tenantId);
  const params = [tid];
  const clauses = ['reg.tenant_id = $1::uuid'];
  if (from) {
    params.push(dateOnly(from, 'from'));
    clauses.push(`COALESCE(reg.occurred_at, reg.created_at) >= $${params.length}::date`);
  }
  if (to) {
    params.push(dateOnly(to, 'to'));
    clauses.push(`COALESCE(reg.occurred_at, reg.created_at) < ($${params.length}::date + 1)`);
  }
  if (reviewStatus) {
    if (!REGISTRY_REVIEW_STATUSES.includes(reviewStatus)) {
      throw AppError.badRequest(
        `review_status must be one of: ${REGISTRY_REVIEW_STATUSES.join(', ')}`,
        'CATH_REGISTRY_BAD_REVIEW_STATUS'
      );
    }
    params.push(reviewStatus);
    clauses.push(`reg.review_status = $${params.length}`);
  }
  if (severity) {
    if (!REGISTRY_SEVERITIES.includes(severity)) {
      throw AppError.badRequest(
        `severity must be one of: ${REGISTRY_SEVERITIES.join(', ')}`,
        'CATH_REGISTRY_BAD_SEVERITY'
      );
    }
    params.push(severity);
    clauses.push(`reg.severity = $${params.length}`);
  }
  if (category) {
    params.push(cleanText(category, 80));
    clauses.push(`reg.complication_category = $${params.length}`);
  }
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));
  params.push(safeLimit);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT reg.id, reg.case_id, reg.procedure_log_id, reg.patient_uid,
            u.name AS patient_name, reg.complication_code, reg.complication_category,
            reg.description, reg.severity, reg.outcome, reg.review_status,
            reg.review_notes, reg.reviewed_by, reg.reviewed_at, reg.occurred_at,
            reg.source, reg.reported_by, reg.created_at, reg.updated_at,
            c.requested_procedure, c.urgency
       FROM cath_complication_registry reg
       JOIN cath_lab_cases c
         ON c.id = reg.case_id AND c.tenant_id = reg.tenant_id
       LEFT JOIN users u
         ON u.uid = reg.patient_uid AND u.tenant_id = reg.tenant_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY COALESCE(reg.occurred_at, reg.created_at) DESC, reg.id DESC
      LIMIT $${params.length}::int`,
    ...params
  );
  return normalizeRows(rows);
}

/**
 * Review-status transition (+ optional outcome/severity refinement). Emits an
 * audit event only — the clinical fact already carries its timeline event from
 * creation; review is a governance action.
 */
export async function updateRegistryReview(registryId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const id = normalizeId(registryId, 'registry_id');
  const nextStatus = cleanText(input.review_status ?? input.reviewStatus, 30);
  if (!nextStatus || !REGISTRY_REVIEW_STATUSES.includes(nextStatus)) {
    throw AppError.badRequest(
      `review_status must be one of: ${REGISTRY_REVIEW_STATUSES.join(', ')}`,
      'CATH_REGISTRY_BAD_REVIEW_STATUS'
    );
  }
  const outcome = cleanText(input.outcome, 30);
  if (outcome && !REGISTRY_OUTCOMES.includes(outcome)) {
    throw AppError.badRequest(
      `outcome must be one of: ${REGISTRY_OUTCOMES.join(', ')}`,
      'CATH_REGISTRY_BAD_OUTCOME'
    );
  }
  const severity = cleanText(input.severity, 30);
  if (severity && !REGISTRY_SEVERITIES.includes(severity)) {
    throw AppError.badRequest(
      `severity must be one of: ${REGISTRY_SEVERITIES.join(', ')}`,
      'CATH_REGISTRY_BAD_SEVERITY'
    );
  }
  const reviewNotes = cleanText(input.review_notes ?? input.reviewNotes, 4000);

  return setTenantTx(tenantId, async tx => {
    const existingRows = await tx.$queryRawUnsafe(
      `SELECT id, case_id, patient_uid, review_status, severity, outcome
         FROM cath_complication_registry
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        FOR UPDATE`,
      tenantId,
      id
    );
    const existing = unwrap(existingRows);
    if (!existing) {
      throw AppError.notFound('Registry entry not found', 'CATH_REGISTRY_NOT_FOUND');
    }
    const allowed = REGISTRY_REVIEW_TRANSITIONS[existing.review_status] || [];
    if (nextStatus !== existing.review_status && !allowed.includes(nextStatus)) {
      throw AppError.invalidTransition(existing.review_status, nextStatus, allowed);
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE cath_complication_registry
          SET review_status = $3,
              review_notes = COALESCE($4, review_notes),
              outcome = COALESCE($5, outcome),
              severity = COALESCE($6, severity),
              reviewed_by = $7::uuid,
              reviewed_at = NOW(),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        RETURNING *`,
      tenantId,
      id,
      nextStatus,
      reviewNotes,
      outcome,
      severity,
      maybeUuid(context.actorUid, 'actorUid')
    );
    const updated = unwrap(rows);
    // Unique idempotency key per transition: the default source-derived key
    // would dedupe every later review of the same row into the first audit row.
    await recordClinicalAuditEvent(
      {
        tenantId,
        patientUid: existing.patient_uid,
        action: 'cath_lab.complication_review_updated',
        actionStatus: nextStatus,
        resourceType: 'cath_complication_registry',
        resourceTable: 'cath_complication_registry',
        resourceId: id,
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        requestId: context.requestId,
        idempotencyKey: `cath_registry_review:${id}:${existing.review_status}->${nextStatus}:${Date.now()}`,
        metadata: {
          case_id: existing.case_id,
          from_status: existing.review_status,
          to_status: nextStatus,
          outcome: outcome || existing.outcome,
          severity: severity || existing.severity
        }
      },
      { db: tx }
    );
    return normalizeDbValue(updated);
  });
}

export const __testing__ = {
  cleanText,
  dateOnly,
  normalizeDbValue
};

export default {
  BOOKABLE_CASE_STATUSES,
  REGISTRY_SEVERITIES,
  REGISTRY_OUTCOMES,
  REGISTRY_REVIEW_STATUSES,
  REGISTRY_REVIEW_TRANSITIONS,
  DOSE_THRESHOLD_FIELDS,
  assertCaseBookable,
  computeSoftConflicts,
  scheduleCase,
  cancelCaseSchedule,
  getCaseSchedule,
  getScheduleStrip,
  getDoseAlertSettings,
  setDoseAlertSettings,
  evaluateDoseRecordAgainstThresholds,
  getDoseRollup,
  mapComplicationElement,
  deriveComplicationRegistryRows,
  addRegistryEntry,
  listRegistry,
  updateRegistryReview
};
