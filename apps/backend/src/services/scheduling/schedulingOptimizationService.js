// src/services/scheduling/schedulingOptimizationService.js
//
// Roadmap D2 — Cadence-class scheduling on top of the existing
// appointments table: recurring provider templates (+ leave
// auto-blocking), generated slot grids, no-show-fed overbooking
// suggestions, waitlist auto-fill, and bookable rooms/equipment.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const WINDOWS = ['any', 'am', 'pm'];
const MAX_OVERBOOK_FRACTION = Number(process.env.SCHEDULING_MAX_OVERBOOK_FRACTION || 0.15);
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

function tenantOr(value) {
  return String(value || '').trim() || DEFAULT_TENANT_ID;
}

async function assertDoctorInTenant(tenantId, doctorId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM users
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND UPPER(role) IN ('DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT')
      LIMIT 1`,
    tenantId,
    doctorId,
  );
  if (!rows.length) throw AppError.notFound('Doctor not found');
}

async function assertPatientInTenant(tenantId, patientUid) {
  if (!patientUid) return;
  const rows = await prisma.$queryRawUnsafe(
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

/** 'HH:MM' + minutes → 'HH:MM'. Pure — unit-tested. */
export function addMinutes(hhmm, minutes) {
  const [h, m] = String(hhmm).split(':').map((n) => Number.parseInt(n, 10));
  const total = h * 60 + m + minutes;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Expand one availability template into slot start times. Pure —
 * unit-tested. start/end as 'HH:MM[:SS]'.
 */
export function expandTemplateSlots(startTime, endTime, slotMinutes) {
  const norm = (t) => String(t).slice(0, 5);
  const toMin = (t) => {
    const [h, m] = norm(t).split(':').map((n) => Number.parseInt(n, 10));
    return h * 60 + m;
  };
  const slots = [];
  for (let m = toMin(startTime); m + slotMinutes <= toMin(endTime); m += slotMinutes) {
    slots.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return slots;
}

/**
 * Overbooking allowance: expected no-shows = Σ risk_score over booked
 * appointments, floored, capped at MAX_OVERBOOK_FRACTION × capacity.
 * Pure — unit-tested.
 */
export function computeOverbookAllowance(capacity, riskScores, maxFraction = MAX_OVERBOOK_FRACTION) {
  const expectedNoShows = (riskScores || [])
    .map((r) => Number(r))
    .filter((r) => Number.isFinite(r) && r > 0 && r <= 1)
    .reduce((sum, r) => sum + r, 0);
  const cap = Math.floor(capacity * maxFraction);
  return Math.max(0, Math.min(Math.floor(expectedNoShows), cap));
}

// ── Templates + leaves ─────────────────────────────────────────────────────

export async function upsertTemplate({
  doctorId, weekday, startTime, endTime, slotMinutes = 15, location = null,
  effectiveFrom = null, effectiveTo = null, tenantId = null, tenant_id = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const doctor = Number.parseInt(doctorId, 10);
  const day = Number.parseInt(weekday, 10);
  if (!Number.isInteger(doctor) || doctor <= 0) throw AppError.badRequest('doctor_id required', 'SCHED_BAD_DOCTOR');
  if (!Number.isInteger(day) || day < 0 || day > 6) throw AppError.badRequest('weekday must be 0-6 (Sun-Sat)', 'SCHED_BAD_WEEKDAY');
  await assertDoctorInTenant(tid, doctor);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO provider_availability_templates
       (tenant_id, doctor_id, weekday, start_time, end_time, slot_minutes, location, effective_from, effective_to, created_by)
     VALUES ($1::uuid, $2, $3, $4::time, $5::time, $6, $7, COALESCE($8::date, CURRENT_DATE), $9::date, $10::uuid)
     RETURNING *`,
    tid, doctor, day, startTime, endTime, Number.parseInt(slotMinutes, 10) || 15,
    location, effectiveFrom, effectiveTo, context.actorUid || null,
  );
  return rows[0];
}

export async function listTemplates(doctorId, { tenantId = null, tenant_id = null } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  return prisma.$queryRawUnsafe(
    `SELECT * FROM provider_availability_templates
      WHERE tenant_id = $1::uuid AND doctor_id = $2 AND is_active ORDER BY weekday, start_time`,
    tid, doctorId,
  );
}

export async function recordLeave({ doctorId, startsOn, endsOn, reason = null, tenantId = null, tenant_id = null } = {}, context = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const doctor = Number.parseInt(doctorId, 10);
  await assertDoctorInTenant(tid, doctor);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO provider_leaves (tenant_id, doctor_id, starts_on, ends_on, reason, approved_by)
     VALUES ($1::uuid, $2, $3::date, $4::date, $5, $6::uuid) RETURNING *`,
    tid, doctor, startsOn, endsOn, reason, context.actorUid || null,
  );
  return rows[0];
}

// ── Slot grid ──────────────────────────────────────────────────────────────

/**
 * Generated slot grid for doctor+date: template slots minus leave days,
 * with booked appointment times marked, plus the overbook allowance from
 * live no-show predictions.
 */
export async function getSlotGrid({ doctorId, date, tenantId = null, tenant_id = null } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const doctor = Number.parseInt(doctorId, 10);
  if (!Number.isInteger(doctor) || !date) {
    throw AppError.badRequest('doctor_id and date are required', 'SCHED_BAD_INPUT');
  }
  await assertDoctorInTenant(tid, doctor);
  const [templates, leaves, booked] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT start_time::text, end_time::text, slot_minutes, location
         FROM provider_availability_templates
        WHERE tenant_id = $1::uuid
          AND doctor_id = $2 AND is_active
          AND weekday = EXTRACT(DOW FROM $3::date)::int
          AND effective_from <= $3::date
          AND (effective_to IS NULL OR effective_to >= $3::date)
        ORDER BY start_time`,
      tid, doctor, date,
    ),
    prisma.$queryRawUnsafe(
      `SELECT id, reason FROM provider_leaves
        WHERE tenant_id = $1::uuid
          AND doctor_id = $2
          AND $3::date BETWEEN starts_on AND ends_on
        LIMIT 1`,
      tid, doctor, date,
    ),
    prisma.$queryRawUnsafe(
      `SELECT a.id, LEFT(a.appointment_time, 5) AS hhmm, a.status,
              p.risk_score
         FROM appointments a
         LEFT JOIN clinical_ai_no_show_predictions p ON p.appointment_id = a.id
        WHERE a.tenant_id = $1::uuid
          AND a.doctor_id = $2 AND a.appointment_date = $3::date
          AND UPPER(a.status) NOT IN ('CANCELLED', 'MISSED')`,
      tid, doctor, date,
    ),
  ]);

  if (leaves.length > 0) {
    return {
      doctor_id: doctor, date, on_leave: true, leave_reason: leaves[0].reason,
      slots: [], capacity: 0, booked_count: booked.length, overbook_allowance: 0,
    };
  }

  const bookedByTime = new Map();
  for (const appt of booked) {
    if (!bookedByTime.has(appt.hhmm)) bookedByTime.set(appt.hhmm, []);
    bookedByTime.get(appt.hhmm).push(appt.id);
  }
  const slots = [];
  for (const template of templates) {
    for (const start of expandTemplateSlots(template.start_time, template.end_time, template.slot_minutes)) {
      slots.push({
        start,
        end: addMinutes(start, template.slot_minutes),
        location: template.location || null,
        booked_appointment_ids: bookedByTime.get(start) || [],
        available: !(bookedByTime.get(start)?.length),
      });
    }
  }
  const capacity = slots.length;
  const riskScores = booked.map((b) => (b.risk_score == null ? null : Number(b.risk_score))).filter((r) => r != null);
  const overbook = computeOverbookAllowance(capacity, riskScores);

  return {
    doctor_id: doctor,
    date,
    on_leave: false,
    capacity,
    booked_count: booked.length,
    free_count: slots.filter((s) => s.available).length,
    overbook_allowance: overbook,
    overbook_basis: {
      scored_appointments: riskScores.length,
      expected_no_shows: Number(riskScores.reduce((s, r) => s + r, 0).toFixed(2)),
      max_fraction: MAX_OVERBOOK_FRACTION,
    },
    slots,
  };
}

// ── Waitlist ───────────────────────────────────────────────────────────────

export async function addToWaitlist({
  patientUid, doctorId, preferredDate = null, preferredWindow = 'any', priority = 5, notes = null,
  tenantId = null, tenant_id = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const doctor = Number.parseInt(doctorId, 10);
  if (!patientUid) throw AppError.badRequest('patient_uid required', 'SCHED_WAITLIST_PATIENT');
  if (!WINDOWS.includes(preferredWindow)) {
    throw AppError.badRequest("preferred_window must be any|am|pm", 'SCHED_WAITLIST_WINDOW');
  }
  await assertPatientInTenant(tid, patientUid);
  await assertDoctorInTenant(tid, doctor);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO appointment_waitlist
       (tenant_id, patient_uid, doctor_id, preferred_date, preferred_window, priority, notes, created_by)
     VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::uuid) RETURNING *`,
    tid, patientUid, doctor, preferredDate, preferredWindow,
    Number.parseInt(priority, 10) || 5, notes, context.actorUid || null,
  );
  return rows[0];
}

/**
 * Waitlist auto-fill for one doctor+date: offer freed slots to waiting
 * entries (priority, then FIFO). Returns the offers made. Runs from the
 * 10-minute sweep and on demand after cancellations.
 */
export async function fillWaitlist({ doctorId, date, tenantId = null, tenant_id = null } = {}, context = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const grid = await getSlotGrid({ doctorId, date, tenantId: tid });
  if (grid.on_leave) return { offers: [], reason: 'doctor_on_leave' };
  const freeSlots = grid.slots.filter((s) => s.available);
  if (freeSlots.length === 0) return { offers: [], reason: 'no_free_slots' };

  const waiting = await prisma.$queryRawUnsafe(
    `SELECT * FROM appointment_waitlist
      WHERE tenant_id = $1::uuid
        AND doctor_id = $2 AND status = 'waiting'
        AND (preferred_date IS NULL OR preferred_date = $3::date)
      ORDER BY priority ASC, created_at ASC
      LIMIT $4::int`,
    tid, Number.parseInt(doctorId, 10), date, freeSlots.length,
  );

  const offers = [];
  for (const [index, entry] of waiting.entries()) {
    const windowSlots = freeSlots.filter((s) => {
      if (entry.preferred_window === 'am') return s.start < '12:00';
      if (entry.preferred_window === 'pm') return s.start >= '12:00';
      return true;
    });
    const slot = windowSlots[0] && freeSlots.includes(windowSlots[0]) ? windowSlots[0] : null;
    if (!slot) continue;
    freeSlots.splice(freeSlots.indexOf(slot), 1);
    const updated = await prisma.$queryRawUnsafe(
      `UPDATE appointment_waitlist SET
         status = 'offered', offered_slot = $2::jsonb, offered_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $3::uuid AND status = 'waiting' RETURNING id, patient_uid`,
      entry.id, JSON.stringify({ date, start: slot.start, end: slot.end, location: slot.location }), tid,
    );
    if (updated.length) {
      offers.push({ waitlist_id: entry.id, patient_uid: entry.patient_uid, slot: { date, start: slot.start } });
    }
    if (index >= freeSlots.length + offers.length) break;
  }
  if (offers.length) {
    logger.info('Waitlist auto-fill made offers', { doctorId, date, offers: offers.length, by: context.actorUid || 'sweep' });
  }
  return { offers, free_slots_remaining: freeSlots.length };
}

export async function resolveWaitlistEntry(id, { status, tenantId = null, tenant_id = null } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  if (!['booked', 'expired', 'cancelled'].includes(status)) {
    throw AppError.badRequest('status must be booked|expired|cancelled', 'SCHED_WAITLIST_RESOLVE');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE appointment_waitlist SET status = $2, resolved_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND tenant_id = $3::uuid AND status IN ('waiting', 'offered') RETURNING *`,
    Number.parseInt(id, 10), status, tid,
  );
  if (!rows.length) throw AppError.notFound('Open waitlist entry not found');
  return rows[0];
}

/** Sweep: auto-fill every doctor with waiting entries for today+tomorrow. */
export async function sweepWaitlists() {
  const targets = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT tenant_id, doctor_id FROM appointment_waitlist WHERE status = 'waiting' LIMIT 50`,
  );
  const dates = [0, 1].map((d) => {
    const date = new Date();
    date.setDate(date.getDate() + d);
    return date.toISOString().slice(0, 10);
  });
  let offers = 0;
  for (const target of targets) {
    for (const date of dates) {
      try {
        const result = await fillWaitlist({
          tenantId: target.tenant_id,
          doctorId: target.doctor_id,
          date,
        });
        offers += result.offers.length;
      } catch (err) {
        logger.warn('Waitlist sweep failed for doctor', { doctor_id: target.doctor_id, date, error: err.message });
      }
    }
  }
  return { doctors: targets.length, offers };
}

// ── Bookable resources ─────────────────────────────────────────────────────

export async function createResource({ kind, name, location = null, tenantId = null, tenant_id = null } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  if (!['room', 'equipment'].includes(kind)) throw AppError.badRequest('kind must be room|equipment', 'SCHED_RESOURCE_KIND');
  if (!(name || '').trim()) throw AppError.badRequest('name required', 'SCHED_RESOURCE_NAME');
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO bookable_resources (tenant_id, kind, name, location)
     VALUES ($1::uuid, $2, $3, $4)
     ON CONFLICT (tenant_id, kind, name) DO UPDATE SET is_active = true, location = EXCLUDED.location
     RETURNING *`,
    tid, kind, name.trim(), location,
  );
  return rows[0];
}

export async function bookResource({
  resourceId, startsAt, endsAt, bookedForType = 'other', bookedForId = null, patientUid = null, notes = null,
  tenantId = null, tenant_id = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const id = Number.parseInt(resourceId, 10);
  if (!Number.isInteger(id)) throw AppError.badRequest('resource_id required', 'SCHED_RESOURCE_ID');
  if (!startsAt || !endsAt || new Date(endsAt) <= new Date(startsAt)) {
    throw AppError.badRequest('starts_at/ends_at window invalid', 'SCHED_RESOURCE_WINDOW');
  }
  await assertPatientInTenant(tid, patientUid);
  // Tenant-scope this multi-statement PHI write (resource_bookings carries
  // tenant_id + patient_uid). A bare prisma.$transaction leaves the
  // app.current_tenant_id GUC unset, so migration 075/304's tenant_isolation
  // policy falls through to its PERMISSIVE branch and the FOR UPDATE lock,
  // overlap check, and INSERT can all see/write cross-tenant rows. `tid` is
  // already <in-scope tenant> || DEFAULT_TENANT_ID via tenantOr(), so the
  // single-tenant fallback keeps working and this never passes a falsy tenant.
  return setTenantTx(tid, async (tx) => {
    // Serialise per resource, then overlap-check inside the tx.
    await tx.$queryRawUnsafe(
      `SELECT id FROM bookable_resources
        WHERE id = $1 AND tenant_id = $2::uuid AND is_active
        FOR UPDATE`,
      id, tid,
    )
      .then((rows) => {
        if (!rows.length) throw AppError.notFound('Resource not found or inactive');
      });
    const clash = await tx.$queryRawUnsafe(
      `SELECT id FROM resource_bookings
        WHERE tenant_id = $1::uuid
          AND resource_id = $2 AND status = 'booked'
          AND tstzrange(starts_at, ends_at) && tstzrange($3::timestamptz, $4::timestamptz)
        LIMIT 1`,
      tid, id, startsAt, endsAt,
    );
    if (clash.length) {
      throw AppError.conflict('Resource already booked for an overlapping window', 'SCHED_RESOURCE_CLASH', {
        conflicting_booking_id: clash[0].id,
      });
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO resource_bookings
         (tenant_id, resource_id, starts_at, ends_at, booked_for_type, booked_for_id, patient_uid, booked_by, notes)
       VALUES ($1::uuid, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7::uuid, $8::uuid, $9)
       RETURNING *`,
      tid, id, startsAt, endsAt, bookedForType, bookedForId, patientUid, context.actorUid || null, notes,
    );
    return rows[0];
  });
}

export async function listResourceSchedule({ resourceId, date, tenantId = null, tenant_id = null } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  return prisma.$queryRawUnsafe(
    `SELECT b.*, r.name AS resource_name, r.kind
       FROM resource_bookings b JOIN bookable_resources r ON r.id = b.resource_id
      WHERE b.tenant_id = $1::uuid
        AND r.tenant_id = $1::uuid
        AND b.resource_id = $2 AND b.status = 'booked'
        AND b.starts_at::date = $3::date
      ORDER BY b.starts_at`,
    tid, Number.parseInt(resourceId, 10), date,
  );
}

export default {
  addMinutes,
  expandTemplateSlots,
  computeOverbookAllowance,
  upsertTemplate,
  listTemplates,
  recordLeave,
  getSlotGrid,
  addToWaitlist,
  fillWaitlist,
  resolveWaitlistEntry,
  sweepWaitlists,
  createResource,
  bookResource,
  listResourceSchedule,
};
