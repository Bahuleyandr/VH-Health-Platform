// src/services/scheduling/schedulingOptimizationService.js
//
// Roadmap D2 — Cadence-class scheduling on top of the existing
// appointments table: recurring provider templates (+ leave
// auto-blocking), generated slot grids, no-show-fed overbooking
// suggestions, waitlist auto-fill, and bookable rooms/equipment.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const WINDOWS = ['any', 'am', 'pm'];
const SOURCE_CHANNELS = ['kiosk', 'patient_app', 'staff', 'call_centre', 'admin'];
const TEMPLATE_EXCEPTION_TYPES = ['closed', 'blocked', 'modified', 'extra'];
const OVERBOOK_SCOPES = ['tenant', 'department', 'doctor', 'visit_type', 'appointment_type', 'department_doctor'];
const MAX_OVERBOOK_FRACTION = Number(process.env.SCHEDULING_MAX_OVERBOOK_FRACTION || 0.15);
const DEFAULT_SLOT_HOLD_MINUTES = Number.parseInt(process.env.SCHEDULING_SLOT_HOLD_MINUTES || '10', 10);

function tenantOr(value) {
  return requireTenantId(String(value || '').trim());
}

function parsePositiveInt(value, field, code) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${field} required`, code);
  }
  return parsed;
}

function jsonParam(value) {
  if (value == null) return '{}';
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest('metadata must be an object', 'SCHED_METADATA');
  }
  return JSON.stringify(value);
}

function decimalNumber(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value.toNumber === 'function') return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function timeText(value) {
  return String(value || '').slice(0, 5);
}

function isDbConflict(err) {
  return err?.code === '23505'
    || err?.code === '23P01'
    || String(err?.message || '').includes('unique constraint')
    || String(err?.message || '').includes('exclusion constraint');
}

function roleMatchesAuthority(actorRole, authorityRole) {
  const actor = String(actorRole || '').toUpperCase();
  const authority = String(authorityRole || '').toUpperCase();
  return actor === authority || actor === 'ADMIN' || actor === 'SUPER_ADMIN';
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

export function applyOverbookPolicy(capacity, riskScores, policy = {}) {
  if (!policy?.enabled) {
    return {
      allowance: 0,
      suggested_allowance: computeOverbookAllowance(capacity, riskScores),
      reason: 'policy_disabled',
    };
  }
  const fraction = decimalNumber(policy.max_overbook_fraction, 0);
  const slotCap = Number.parseInt(policy.max_overbook_slots ?? 0, 10);
  const suggested = computeOverbookAllowance(capacity, riskScores, fraction);
  const finiteSlotCap = Number.isInteger(slotCap) && slotCap >= 0 ? slotCap : 0;
  return {
    allowance: Math.max(0, Math.min(suggested, finiteSlotCap)),
    suggested_allowance: suggested,
    reason: finiteSlotCap === 0 || fraction === 0 ? 'policy_cap_zero' : 'policy_enabled',
  };
}

// ── Templates + leaves ─────────────────────────────────────────────────────

export async function upsertTemplate({
  doctorId, weekday, startTime, endTime, slotMinutes = 15, location = null,
  effectiveFrom = null, effectiveTo = null, tenantId = null, tenant_id = null,
  replacesTemplateId = null, appointmentType = null, serviceCode = null,
  visitType = null, roomResourceId = null, counterLocation = null,
  metadata = {},
} = {}, context = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const doctor = parsePositiveInt(doctorId, 'doctor_id', 'SCHED_BAD_DOCTOR');
  const day = Number.parseInt(weekday, 10);
  if (!Number.isInteger(day) || day < 0 || day > 6) throw AppError.badRequest('weekday must be 0-6 (Sun-Sat)', 'SCHED_BAD_WEEKDAY');
  const slotSize = Number.parseInt(slotMinutes, 10) || 15;
  if (slotSize < 5 || slotSize > 120) throw AppError.badRequest('slot_minutes must be 5-120', 'SCHED_BAD_SLOT');
  await assertDoctorInTenant(tid, doctor);
  const replacementId = replacesTemplateId == null ? null : Number.parseInt(replacesTemplateId, 10);

  return setTenantTx(tid, async (tx) => {
    let groupUid = null;
    let nextVersion = 1;
    let beforeState = null;
    if (Number.isInteger(replacementId) && replacementId > 0) {
      const existing = await tx.$queryRawUnsafe(
        `SELECT *
           FROM provider_availability_templates
          WHERE tenant_id = $1::uuid
            AND id = $2
          FOR UPDATE`,
        tid,
        replacementId,
      );
      if (!existing.length) throw AppError.notFound('Template to replace not found');
      beforeState = existing[0];
      groupUid = existing[0].template_group_uid;
      nextVersion = Number(existing[0].version || 1) + 1;
      await tx.$queryRawUnsafe(
        `UPDATE provider_availability_templates
            SET status = 'superseded',
                is_active = false,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2`,
        tid,
        replacementId,
      );
    }

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO provider_availability_templates
         (tenant_id, doctor_id, weekday, start_time, end_time, slot_minutes, location,
          effective_from, effective_to, created_by, template_group_uid, version, status,
          appointment_type, service_code, visit_type, room_resource_id, counter_location, metadata)
       VALUES (
          $1::uuid, $2, $3, $4::time, $5::time, $6, $7,
          COALESCE($8::date, CURRENT_DATE), $9::date, $10::uuid,
          COALESCE($11::uuid, gen_random_uuid()), $12, 'active',
          $13, $14, $15, $16::int, $17, $18::jsonb
       )
       RETURNING *`,
      tid,
      doctor,
      day,
      startTime,
      endTime,
      slotSize,
      location,
      effectiveFrom,
      effectiveTo,
      context.actorUid || null,
      groupUid,
      nextVersion,
      appointmentType,
      serviceCode,
      visitType,
      roomResourceId == null ? null : Number.parseInt(roomResourceId, 10),
      counterLocation,
      jsonParam(metadata),
    );
    const template = rows[0];
    await tx.$queryRawUnsafe(
      `INSERT INTO provider_availability_template_audit
         (tenant_id, template_id, action, changed_by, before_state, after_state, metadata)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb, $6::jsonb, $7::jsonb)`,
      tid,
      template.id,
      beforeState ? 'versioned' : 'created',
      context.actorUid || null,
      beforeState ? JSON.stringify(beforeState) : null,
      JSON.stringify(template),
      jsonParam({ replaces_template_id: replacementId || null }),
    );
    return template;
  });
}

export async function listTemplates(doctorId, { tenantId = null, tenant_id = null, includeInactive = false } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  return prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, doctor_id, weekday, start_time::text, end_time::text,
            slot_minutes, location, effective_from, effective_to, is_active,
            created_by, created_at, updated_at, template_group_uid, version, status,
            appointment_type, service_code, visit_type, room_resource_id,
            counter_location, metadata
       FROM provider_availability_templates
      WHERE tenant_id = $1::uuid
        AND doctor_id = $2
        AND ($3::boolean OR is_active)
      ORDER BY weekday, start_time, version DESC`,
    tid, doctorId, Boolean(includeInactive),
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

export async function recordTemplateException({
  templateId = null, doctorId, exceptionDate, exceptionType = 'blocked', allDay = false,
  startTime = null, endTime = null, slotMinutes = null, location = null, reason = null,
  metadata = {}, tenantId = null, tenant_id = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const doctor = parsePositiveInt(doctorId, 'doctor_id', 'SCHED_BAD_DOCTOR');
  if (!exceptionDate) throw AppError.badRequest('exception_date required', 'SCHED_EXCEPTION_DATE');
  if (!TEMPLATE_EXCEPTION_TYPES.includes(exceptionType)) {
    throw AppError.badRequest('exception_type must be closed|blocked|modified|extra', 'SCHED_EXCEPTION_TYPE');
  }
  await assertDoctorInTenant(tid, doctor);
  const template = templateId == null ? [] : await prisma.$queryRawUnsafe(
    `SELECT id
       FROM provider_availability_templates
      WHERE tenant_id = $1::uuid
        AND id = $2
        AND doctor_id = $3
      LIMIT 1`,
    tid,
    Number.parseInt(templateId, 10),
    doctor,
  );
  if (templateId != null && !template.length) throw AppError.notFound('Template not found for doctor');

  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO provider_availability_template_exceptions
         (tenant_id, template_id, doctor_id, exception_date, exception_type, all_day,
          start_time, end_time, slot_minutes, location, reason, created_by, metadata)
       VALUES ($1::uuid, $2::int, $3, $4::date, $5, $6::boolean,
               $7::time, $8::time, $9::int, $10, $11, $12::uuid, $13::jsonb)
       RETURNING *`,
      tid,
      templateId == null ? null : Number.parseInt(templateId, 10),
      doctor,
      exceptionDate,
      exceptionType,
      Boolean(allDay),
      startTime,
      endTime,
      slotMinutes == null ? null : Number.parseInt(slotMinutes, 10),
      location,
      reason,
      context.actorUid || null,
      jsonParam(metadata),
    );
    const exception = rows[0];
    await tx.$queryRawUnsafe(
      `INSERT INTO provider_availability_template_audit
         (tenant_id, template_id, action, changed_by, after_state, metadata)
       VALUES ($1::uuid, $2::int, 'exception_created', $3::uuid, $4::jsonb, $5::jsonb)`,
      tid,
      exception.template_id || null,
      context.actorUid || null,
      JSON.stringify(exception),
      jsonParam({ exception_id: exception.id }),
    );
    return exception;
  });
}

export async function listTemplateExceptions({ doctorId, date = null, tenantId = null, tenant_id = null } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  return prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, template_id, doctor_id, exception_date, exception_type,
            all_day, start_time::text, end_time::text, slot_minutes, location,
            reason, status, created_by, created_at, updated_at, metadata
       FROM provider_availability_template_exceptions
      WHERE tenant_id = $1::uuid
        AND doctor_id = $2
        AND ($3::date IS NULL OR exception_date = $3::date)
      ORDER BY exception_date DESC, start_time NULLS FIRST, id DESC`,
    tid,
    Number.parseInt(doctorId, 10),
    date,
  );
}

// ── Slot grid ──────────────────────────────────────────────────────────────

function shapeOverbookPolicy(row) {
  if (!row) {
    return {
      id: null,
      enabled: false,
      max_overbook_fraction: 0,
      max_overbook_slots: 0,
      authority_role: 'RECEPTION_INCHARGE',
      override_requires_reason: true,
      policy_scope: 'tenant',
    };
  }
  return {
    ...row,
    max_overbook_fraction: decimalNumber(row.max_overbook_fraction, 0),
    max_overbook_slots: Number.parseInt(row.max_overbook_slots ?? 0, 10),
  };
}

export async function resolveOverbookPolicy({
  tenantId = null, tenant_id = null, doctorId = null, date = null,
  visitType = null, appointmentType = null,
} = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, policy_scope, department_id, department_name,
            doctor_id, visit_type, appointment_type, max_overbook_fraction,
            max_overbook_slots, authority_role, override_requires_reason,
            enabled, effective_from, effective_to, created_by, updated_by,
            created_at, updated_at, metadata
       FROM scheduling_overbook_policies
      WHERE tenant_id = $1::uuid
        AND enabled
        AND effective_from <= COALESCE($2::date, CURRENT_DATE)
        AND (effective_to IS NULL OR effective_to >= COALESCE($2::date, CURRENT_DATE))
        AND (doctor_id IS NULL OR doctor_id = $3::int)
        AND (visit_type IS NULL OR visit_type = $4::text)
        AND (appointment_type IS NULL OR appointment_type = $5::text)
      ORDER BY
        ((CASE WHEN doctor_id = $3::int THEN 8 ELSE 0 END) +
         (CASE WHEN visit_type = $4::text THEN 4 ELSE 0 END) +
         (CASE WHEN appointment_type = $5::text THEN 2 ELSE 0 END) +
         (CASE WHEN policy_scope = 'tenant' THEN 1 ELSE 0 END)) DESC,
        created_at DESC
      LIMIT 1`,
    tid,
    date,
    doctorId == null ? null : Number.parseInt(doctorId, 10),
    visitType,
    appointmentType,
  );
  return shapeOverbookPolicy(rows[0]);
}

/**
 * Generated slot grid for doctor+date: template slots minus leave days,
 * with booked appointment times marked, plus the overbook allowance from
 * live no-show predictions.
 */
export async function getSlotGrid({
  doctorId, date, tenantId = null, tenant_id = null,
  visitType = null, appointmentType = null,
} = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const doctor = Number.parseInt(doctorId, 10);
  if (!Number.isInteger(doctor) || !date) {
    throw AppError.badRequest('doctor_id and date are required', 'SCHED_BAD_INPUT');
  }
  await assertDoctorInTenant(tid, doctor);
  await prisma.$queryRawUnsafe(
    `UPDATE appointment_slot_holds
        SET status = 'expired', updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND doctor_id = $2
        AND appointment_date = $3::date
        AND status = 'held'
        AND expires_at <= NOW()`,
    tid, doctor, date,
  ).catch((err) => {
    logger.warn('Scheduling slot-hold expiry sweep failed', { doctorId: doctor, date, error: err.message });
  });

  const [templates, leaves, booked, exceptions, holds, policy] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT id, start_time::text, end_time::text, slot_minutes, location,
              appointment_type, service_code, visit_type, room_resource_id,
              counter_location, metadata
         FROM provider_availability_templates
        WHERE tenant_id = $1::uuid
          AND doctor_id = $2
          AND is_active
          AND status = 'active'
          AND weekday = EXTRACT(DOW FROM $3::date)::int
          AND effective_from <= $3::date
          AND (effective_to IS NULL OR effective_to >= $3::date)
          AND ($4::text IS NULL OR appointment_type IS NULL OR appointment_type = $4::text)
          AND ($5::text IS NULL OR visit_type IS NULL OR visit_type = $5::text)
        ORDER BY start_time`,
      tid, doctor, date, appointmentType, visitType,
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
    prisma.$queryRawUnsafe(
      `SELECT id, template_id, exception_type, all_day, start_time::text,
              end_time::text, slot_minutes, location, reason, metadata
         FROM provider_availability_template_exceptions
        WHERE tenant_id = $1::uuid
          AND doctor_id = $2
          AND exception_date = $3::date
          AND status = 'active'
        ORDER BY all_day DESC, start_time NULLS FIRST, id`,
      tid, doctor, date,
    ),
    prisma.$queryRawUnsafe(
      `SELECT id, slot_start::text, expires_at
         FROM appointment_slot_holds
        WHERE tenant_id = $1::uuid
          AND doctor_id = $2
          AND appointment_date = $3::date
          AND status = 'held'
          AND expires_at > NOW()
        ORDER BY slot_start`,
      tid, doctor, date,
    ),
    resolveOverbookPolicy({ tenantId: tid, doctorId: doctor, date, visitType, appointmentType }),
  ]);

  if (leaves.length > 0) {
    return {
      doctor_id: doctor, date, on_leave: true, leave_reason: leaves[0].reason,
      slots: [], capacity: 0, booked_count: booked.length, overbook_allowance: 0,
      overbook_policy: policy,
    };
  }

  const closed = exceptions.find((entry) => entry.exception_type === 'closed' && entry.all_day);
  if (closed) {
    return {
      doctor_id: doctor,
      date,
      on_leave: false,
      schedule_closed: true,
      closure_reason: closed.reason,
      slots: [],
      capacity: 0,
      booked_count: booked.length,
      overbook_allowance: 0,
      overbook_policy: policy,
    };
  }

  const bookedByTime = new Map();
  for (const appt of booked) {
    if (!bookedByTime.has(appt.hhmm)) bookedByTime.set(appt.hhmm, []);
    bookedByTime.get(appt.hhmm).push(appt.id);
  }
  const holdsByTime = new Map(holds.map((hold) => [timeText(hold.slot_start), hold]));
  const blockedWindows = exceptions
    .filter((entry) => entry.exception_type === 'blocked' && entry.start_time && entry.end_time)
    .map((entry) => ({
      id: entry.id,
      reason: entry.reason,
      start: timeText(entry.start_time),
      end: timeText(entry.end_time),
    }));
  const slots = [];
  const modified = exceptions.filter((entry) => entry.exception_type === 'modified' && entry.start_time && entry.end_time);
  const extra = exceptions.filter((entry) => entry.exception_type === 'extra' && entry.start_time && entry.end_time);
  const slotSources = (modified.length ? modified : templates)
    .concat(extra)
    .map((source) => ({
      ...source,
      source: source.exception_type ? `exception:${source.exception_type}` : 'template',
      slot_minutes: Number.parseInt(source.slot_minutes, 10) || 15,
      template_id: source.exception_type ? source.template_id : source.id,
    }));
  for (const template of slotSources) {
    for (const start of expandTemplateSlots(template.start_time, template.end_time, template.slot_minutes)) {
      const held = holdsByTime.get(start);
      const blocked = blockedWindows.find((window) => start >= window.start && start < window.end);
      slots.push({
        template_id: template.template_id,
        source: template.source,
        start,
        end: addMinutes(start, template.slot_minutes),
        location: template.location || null,
        counter_location: template.counter_location || null,
        room_resource_id: template.room_resource_id || null,
        booked_appointment_ids: bookedByTime.get(start) || [],
        active_hold_id: held?.id || null,
        blocked_by_exception_id: blocked?.id || null,
        block_reason: blocked?.reason || null,
        available: !(bookedByTime.get(start)?.length) && !held && !blocked,
      });
    }
  }
  const capacity = slots.length;
  const riskScores = booked.map((b) => (b.risk_score == null ? null : Number(b.risk_score))).filter((r) => r != null);
  const policyResult = applyOverbookPolicy(capacity, riskScores, policy);

  return {
    doctor_id: doctor,
    date,
    on_leave: false,
    capacity,
    booked_count: booked.length,
    free_count: slots.filter((s) => s.available).length,
    held_count: holds.length,
    overbook_allowance: policyResult.allowance,
    overbook_basis: {
      scored_appointments: riskScores.length,
      expected_no_shows: Number(riskScores.reduce((s, r) => s + r, 0).toFixed(2)),
      suggested_allowance: policyResult.suggested_allowance,
      policy_reason: policyResult.reason,
      max_fraction: policy.max_overbook_fraction ?? 0,
      max_slots: policy.max_overbook_slots ?? 0,
    },
    overbook_policy: policy,
    slots,
  };
}

// ── Slot holds ─────────────────────────────────────────────────────────────

export async function createSlotHold({
  doctorId, date, slotStart, slotEnd = null, patientUid = null,
  sourceChannel = 'staff', idempotencyKey, holdMinutes = DEFAULT_SLOT_HOLD_MINUTES,
  tenantId = null, tenant_id = null, metadata = {},
} = {}, context = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const doctor = parsePositiveInt(doctorId, 'doctor_id', 'SCHED_HOLD_DOCTOR');
  if (!date) throw AppError.badRequest('date required', 'SCHED_HOLD_DATE');
  if (!slotStart) throw AppError.badRequest('slot_start required', 'SCHED_HOLD_SLOT');
  if (!idempotencyKey || !String(idempotencyKey).trim()) {
    throw AppError.badRequest('idempotency_key required', 'SCHED_HOLD_IDEMPOTENCY');
  }
  if (!SOURCE_CHANNELS.includes(sourceChannel)) {
    throw AppError.badRequest('source_channel must be kiosk|patient_app|staff|call_centre|admin', 'SCHED_HOLD_SOURCE');
  }
  await assertDoctorInTenant(tid, doctor);
  await assertPatientInTenant(tid, patientUid);
  const expiresSql = `${Number.parseInt(holdMinutes, 10) || DEFAULT_SLOT_HOLD_MINUTES} minutes`;
  const effectiveEnd = slotEnd || addMinutes(timeText(slotStart), 15);

  return setTenantTx(tid, async (tx) => {
    await tx.$queryRawUnsafe(
      `UPDATE appointment_slot_holds
          SET status = 'expired', updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND status = 'held'
          AND expires_at <= NOW()`,
      tid,
    );

    const existing = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, doctor_id, appointment_date, slot_start::text,
              slot_end::text, source_channel, idempotency_key, hold_token,
              held_by_uid, held_by_role, patient_uid, expires_at, status,
              appointment_id, created_at, updated_at, metadata
         FROM appointment_slot_holds
        WHERE tenant_id = $1::uuid
          AND idempotency_key = $2
          AND status = 'held'
          AND expires_at > NOW()
        LIMIT 1`,
      tid,
      String(idempotencyKey).trim(),
    );
    if (existing.length) return { ...existing[0], idempotent: true };

    const booked = await tx.$queryRawUnsafe(
      `SELECT id
         FROM appointments
        WHERE tenant_id = $1::uuid
          AND doctor_id = $2
          AND appointment_date = $3::date
          AND LEFT(appointment_time, 5) = LEFT($4::time::text, 5)
          AND UPPER(status) NOT IN ('CANCELLED', 'MISSED')
        LIMIT 1`,
      tid,
      doctor,
      date,
      slotStart,
    );
    if (booked.length) {
      throw AppError.conflict('Appointment slot already booked', 'SCHED_SLOT_BOOKED', {
        appointment_id: booked[0].id,
      });
    }

    try {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO appointment_slot_holds
           (tenant_id, doctor_id, appointment_date, slot_start, slot_end,
            source_channel, idempotency_key, held_by_uid, held_by_role,
            patient_uid, expires_at, metadata)
         VALUES (
           $1::uuid, $2, $3::date, $4::time, $5::time,
           $6, $7, $8::uuid, $9, $10::uuid,
           NOW() + $11::interval, $12::jsonb
         )
         RETURNING id, tenant_id, doctor_id, appointment_date, slot_start::text,
                   slot_end::text, source_channel, idempotency_key, hold_token,
                   held_by_uid, held_by_role, patient_uid, expires_at, status,
                   appointment_id, created_at, updated_at, metadata`,
        tid,
        doctor,
        date,
        slotStart,
        effectiveEnd,
        sourceChannel,
        String(idempotencyKey).trim(),
        context.actorUid || null,
        context.actorRole || null,
        patientUid,
        expiresSql,
        jsonParam(metadata),
      );
      return { ...rows[0], idempotent: false };
    } catch (err) {
      if (isDbConflict(err)) {
        throw AppError.conflict('Appointment slot is already held', 'SCHED_SLOT_HELD');
      }
      throw err;
    }
  });
}

export async function confirmSlotHold(id, {
  appointmentId = null, tenantId = null, tenant_id = null,
} = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE appointment_slot_holds
        SET status = 'confirmed',
            appointment_id = $3::int,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2
        AND status = 'held'
        AND expires_at > NOW()
      RETURNING id, tenant_id, doctor_id, appointment_date, slot_start::text,
                slot_end::text, source_channel, idempotency_key, hold_token,
                held_by_uid, held_by_role, patient_uid, expires_at, status,
                appointment_id, created_at, updated_at, metadata`,
    tid,
    Number.parseInt(id, 10),
    appointmentId == null ? null : Number.parseInt(appointmentId, 10),
  );
  if (!rows.length) throw AppError.notFound('Active slot hold not found');
  return rows[0];
}

export async function releaseSlotHold(id, { tenantId = null, tenant_id = null } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE appointment_slot_holds
        SET status = 'cancelled',
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2
        AND status = 'held'
      RETURNING id, tenant_id, doctor_id, appointment_date, slot_start::text,
                slot_end::text, source_channel, idempotency_key, hold_token,
                held_by_uid, held_by_role, patient_uid, expires_at, status,
                appointment_id, created_at, updated_at, metadata`,
    tid,
    Number.parseInt(id, 10),
  );
  if (!rows.length) throw AppError.notFound('Active slot hold not found');
  return rows[0];
}

// ── Waitlist ───────────────────────────────────────────────────────────────

export async function addToWaitlist({
  patientUid, doctorId, preferredDate = null, preferredWindow = 'any', priority = 5, notes = null,
  sourceChannel = 'staff', overrideReason = null, metadata = {}, tenantId = null, tenant_id = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const doctor = Number.parseInt(doctorId, 10);
  if (!patientUid) throw AppError.badRequest('patient_uid required', 'SCHED_WAITLIST_PATIENT');
  if (!WINDOWS.includes(preferredWindow)) {
    throw AppError.badRequest("preferred_window must be any|am|pm", 'SCHED_WAITLIST_WINDOW');
  }
  if (!SOURCE_CHANNELS.includes(sourceChannel)) {
    throw AppError.badRequest('source_channel must be kiosk|patient_app|staff|call_centre|admin', 'SCHED_WAITLIST_SOURCE');
  }
  await assertPatientInTenant(tid, patientUid);
  await assertDoctorInTenant(tid, doctor);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO appointment_waitlist
       (tenant_id, patient_uid, doctor_id, preferred_date, preferred_window,
        priority, notes, created_by, source_channel, override_reason, metadata)
     VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::uuid, $9, $10, $11::jsonb)
     RETURNING *`,
    tid, patientUid, doctor, preferredDate, preferredWindow,
    Number.parseInt(priority, 10) || 5, notes, context.actorUid || null,
    sourceChannel, overrideReason, jsonParam(metadata),
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
         status = 'offered',
         offered_slot = $2::jsonb,
         offered_at = NOW(),
         offer_expires_at = NOW() + INTERVAL '15 minutes',
         notification_state = 'queued',
         updated_at = NOW()
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

export async function resolveWaitlistEntry(id, { status, overrideReason = null, tenantId = null, tenant_id = null } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  if (!['booked', 'expired', 'cancelled'].includes(status)) {
    throw AppError.badRequest('status must be booked|expired|cancelled', 'SCHED_WAITLIST_RESOLVE');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE appointment_waitlist
        SET status = $2,
            override_reason = COALESCE($4::text, override_reason),
            resolved_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND tenant_id = $3::uuid AND status IN ('waiting', 'offered') RETURNING *`,
    Number.parseInt(id, 10), status, tid, overrideReason,
  );
  if (!rows.length) throw AppError.notFound('Open waitlist entry not found');
  return rows[0];
}

/** Sweep: auto-fill every doctor with waiting entries for today+tomorrow. */
export async function sweepWaitlists() {
  await prisma.$queryRawUnsafe(
    `UPDATE appointment_waitlist
        SET status = 'expired',
            resolved_at = NOW(),
            updated_at = NOW()
      WHERE status = 'offered'
        AND offer_expires_at IS NOT NULL
        AND offer_expires_at <= NOW()`,
  ).catch((err) => {
    logger.warn('Waitlist offer expiry sweep failed', { error: err.message });
  });
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

// ── Overbook policies ──────────────────────────────────────────────────────

export async function saveOverbookPolicy({
  policyId = null, policyScope = 'tenant', doctorId = null, departmentId = null,
  departmentName = null, visitType = null, appointmentType = null,
  maxOverbookFraction = 0, maxOverbookSlots = 0, authorityRole = 'RECEPTION_INCHARGE',
  overrideRequiresReason = true, enabled = false, effectiveFrom = null, effectiveTo = null,
  metadata = {}, tenantId = null, tenant_id = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  if (!OVERBOOK_SCOPES.includes(policyScope)) {
    throw AppError.badRequest('policy_scope invalid', 'SCHED_OVERBOOK_SCOPE');
  }
  const fraction = Number(maxOverbookFraction);
  const slots = Number.parseInt(maxOverbookSlots, 10);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw AppError.badRequest('max_overbook_fraction must be between 0 and 1', 'SCHED_OVERBOOK_FRACTION');
  }
  if (!Number.isInteger(slots) || slots < 0) {
    throw AppError.badRequest('max_overbook_slots must be >= 0', 'SCHED_OVERBOOK_SLOTS');
  }
  if (doctorId != null) await assertDoctorInTenant(tid, Number.parseInt(doctorId, 10));
  const id = policyId == null ? null : Number.parseInt(policyId, 10);
  const rows = id ? await prisma.$queryRawUnsafe(
    `UPDATE scheduling_overbook_policies
        SET policy_scope = $3,
            department_id = $4::int,
            department_name = $5,
            doctor_id = $6::int,
            visit_type = $7,
            appointment_type = $8,
            max_overbook_fraction = $9::numeric,
            max_overbook_slots = $10,
            authority_role = $11,
            override_requires_reason = $12::boolean,
            enabled = $13::boolean,
            effective_from = COALESCE($14::date, effective_from),
            effective_to = $15::date,
            updated_by = $16::uuid,
            updated_at = NOW(),
            metadata = $17::jsonb
      WHERE tenant_id = $1::uuid
        AND id = $2
      RETURNING *`,
    tid, id, policyScope, departmentId, departmentName,
    doctorId == null ? null : Number.parseInt(doctorId, 10),
    visitType, appointmentType, fraction, slots, authorityRole,
    Boolean(overrideRequiresReason), Boolean(enabled), effectiveFrom, effectiveTo,
    context.actorUid || null, jsonParam(metadata),
  ) : await prisma.$queryRawUnsafe(
    `INSERT INTO scheduling_overbook_policies
       (tenant_id, policy_scope, department_id, department_name, doctor_id,
        visit_type, appointment_type, max_overbook_fraction, max_overbook_slots,
        authority_role, override_requires_reason, enabled, effective_from,
        effective_to, created_by, updated_by, metadata)
     VALUES (
        $1::uuid, $2, $3::int, $4, $5::int,
        $6, $7, $8::numeric, $9,
        $10, $11::boolean, $12::boolean, COALESCE($13::date, CURRENT_DATE),
        $14::date, $15::uuid, $15::uuid, $16::jsonb
     )
     RETURNING *`,
    tid, policyScope, departmentId, departmentName,
    doctorId == null ? null : Number.parseInt(doctorId, 10),
    visitType, appointmentType, fraction, slots, authorityRole,
    Boolean(overrideRequiresReason), Boolean(enabled), effectiveFrom, effectiveTo,
    context.actorUid || null, jsonParam(metadata),
  );
  if (!rows.length) throw AppError.notFound('Overbook policy not found');
  return shapeOverbookPolicy(rows[0]);
}

export async function listOverbookPolicies({ tenantId = null, tenant_id = null, doctorId = null } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, policy_scope, department_id, department_name,
            doctor_id, visit_type, appointment_type, max_overbook_fraction,
            max_overbook_slots, authority_role, override_requires_reason,
            enabled, effective_from, effective_to, created_by, updated_by,
            created_at, updated_at, metadata
       FROM scheduling_overbook_policies
      WHERE tenant_id = $1::uuid
        AND ($2::int IS NULL OR doctor_id IS NULL OR doctor_id = $2::int)
      ORDER BY enabled DESC, doctor_id NULLS LAST, created_at DESC`,
    tid,
    doctorId == null ? null : Number.parseInt(doctorId, 10),
  );
  return rows.map(shapeOverbookPolicy);
}

export async function evaluateOverbookRequest({
  doctorId, date, slotStart = null, appointmentId = null, requestedSlots = 1,
  visitType = null, appointmentType = null, overrideReason = null,
  tenantId = null, tenant_id = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const doctor = parsePositiveInt(doctorId, 'doctor_id', 'SCHED_OVERBOOK_DOCTOR');
  if (!date) throw AppError.badRequest('date required', 'SCHED_OVERBOOK_DATE');
  const requested = Number.parseInt(requestedSlots, 10) || 1;
  const grid = await getSlotGrid({ tenantId: tid, doctorId: doctor, date, visitType, appointmentType });
  const policy = grid.overbook_policy || await resolveOverbookPolicy({
    tenantId: tid,
    doctorId: doctor,
    date,
    visitType,
    appointmentType,
  });
  let decision = 'denied';
  let reason = policy.enabled ? 'overbook_cap_exceeded' : 'policy_disabled';
  if (policy.enabled && requested <= grid.overbook_allowance) {
    decision = 'allowed';
    reason = 'within_policy_cap';
  } else if (
    policy.enabled
    && overrideReason
    && roleMatchesAuthority(context.actorRole, policy.authority_role)
  ) {
    decision = 'override';
    reason = 'authorized_override';
  }
  if (policy.override_requires_reason && decision === 'override' && !overrideReason) {
    decision = 'denied';
    reason = 'override_reason_required';
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO scheduling_overbook_audit_events
       (tenant_id, policy_id, doctor_id, appointment_id, appointment_date,
        slot_start, requested_overbook_slots, allowed_overbook_slots, decision,
        override_by, override_role, override_reason, evidence)
     VALUES (
        $1::uuid, $2::bigint, $3, $4::int, $5::date,
        $6::time, $7, $8, $9,
        $10::uuid, $11, $12, $13::jsonb
     )
     RETURNING *`,
    tid,
    policy.id || null,
    doctor,
    appointmentId == null ? null : Number.parseInt(appointmentId, 10),
    date,
    slotStart,
    requested,
    grid.overbook_allowance || 0,
    decision,
    context.actorUid || null,
    context.actorRole || null,
    overrideReason,
    JSON.stringify({
      reason,
      capacity: grid.capacity,
      booked_count: grid.booked_count,
      free_count: grid.free_count,
      overbook_basis: grid.overbook_basis,
    }),
  );
  return {
    decision,
    reason,
    allowed: decision === 'allowed' || decision === 'override',
    overbook_allowance: grid.overbook_allowance,
    policy,
    audit_event: rows[0],
  };
}

// ── Bookable resources ─────────────────────────────────────────────────────

export async function createResource({
  kind, name, location = null, serviceCode = null, departmentId = null,
  capacity = 1, metadata = {}, tenantId = null, tenant_id = null,
} = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  if (!['room', 'equipment'].includes(kind)) throw AppError.badRequest('kind must be room|equipment', 'SCHED_RESOURCE_KIND');
  if (!(name || '').trim()) throw AppError.badRequest('name required', 'SCHED_RESOURCE_NAME');
  const parsedCapacity = Number.parseInt(capacity, 10) || 1;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO bookable_resources
       (tenant_id, kind, name, location, service_code, department_id, capacity, metadata, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::int, $7, $8::jsonb, NOW())
     ON CONFLICT (tenant_id, kind, name) DO UPDATE SET
       is_active = true,
       location = EXCLUDED.location,
       service_code = EXCLUDED.service_code,
       department_id = EXCLUDED.department_id,
       capacity = EXCLUDED.capacity,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    tid, kind, name.trim(), location, serviceCode,
    departmentId == null ? null : Number.parseInt(departmentId, 10),
    parsedCapacity, jsonParam(metadata),
  );
  return rows[0];
}

async function assertResourceCompatible(tx, {
  tenantId, resourceId, doctorId = null, appointmentType = null, serviceCode = null, visitType = null,
}) {
  const configured = await tx.$queryRawUnsafe(
    `SELECT id
       FROM scheduling_resource_compatibility
      WHERE tenant_id = $1::uuid
        AND resource_id = $2
        AND is_active
      LIMIT 1`,
    tenantId,
    resourceId,
  );
  if (!configured.length) return;

  const matches = await tx.$queryRawUnsafe(
    `SELECT id
       FROM scheduling_resource_compatibility
      WHERE tenant_id = $1::uuid
        AND resource_id = $2
        AND is_active
        AND (doctor_id IS NULL OR doctor_id = $3::int)
        AND (appointment_type IS NULL OR appointment_type = $4::text)
        AND (service_code IS NULL OR service_code = $5::text)
        AND (visit_type IS NULL OR visit_type = $6::text)
      LIMIT 1`,
    tenantId,
    resourceId,
    doctorId == null ? null : Number.parseInt(doctorId, 10),
    appointmentType,
    serviceCode,
    visitType,
  );
  if (!matches.length) {
    throw AppError.conflict('Resource is not compatible with this scheduling context', 'SCHED_RESOURCE_INCOMPATIBLE');
  }
}

export async function addResourceCompatibility({
  resourceId, templateId = null, doctorId = null, appointmentType = null,
  serviceCode = null, visitType = null, requirement = 'compatible',
  metadata = {}, tenantId = null, tenant_id = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const id = parsePositiveInt(resourceId, 'resource_id', 'SCHED_RESOURCE_ID');
  if (!['compatible', 'preferred', 'required'].includes(requirement)) {
    throw AppError.badRequest('requirement must be compatible|preferred|required', 'SCHED_RESOURCE_REQUIREMENT');
  }
  const rows = await prisma.$queryRawUnsafe(
    `WITH resource_match AS (
       SELECT id FROM bookable_resources
        WHERE tenant_id = $1::uuid
          AND id = $2
          AND is_active
     )
     INSERT INTO scheduling_resource_compatibility
       (tenant_id, resource_id, template_id, doctor_id, appointment_type,
        service_code, visit_type, requirement, created_by, metadata)
     SELECT $1::uuid, id, $3::int, $4::int, $5, $6, $7, $8, $9::uuid, $10::jsonb
       FROM resource_match
     RETURNING *`,
    tid,
    id,
    templateId == null ? null : Number.parseInt(templateId, 10),
    doctorId == null ? null : Number.parseInt(doctorId, 10),
    appointmentType,
    serviceCode,
    visitType,
    requirement,
    context.actorUid || null,
    jsonParam(metadata),
  );
  if (!rows.length) throw AppError.notFound('Resource not found or inactive');
  return rows[0];
}

export async function listResourceCompatibility({ resourceId, tenantId = null, tenant_id = null } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  return prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, resource_id, template_id, doctor_id,
            appointment_type, service_code, visit_type, requirement,
            is_active, created_by, created_at, metadata
       FROM scheduling_resource_compatibility
      WHERE tenant_id = $1::uuid
        AND resource_id = $2
        AND is_active
      ORDER BY created_at DESC`,
    tid,
    Number.parseInt(resourceId, 10),
  );
}

export async function bookResource({
  resourceId, startsAt, endsAt, bookedForType = 'other', bookedForId = null, patientUid = null, notes = null,
  doctorId = null, appointmentType = null, serviceCode = null, visitType = null,
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
    await assertResourceCompatible(tx, {
      tenantId: tid,
      resourceId: id,
      doctorId,
      appointmentType,
      serviceCode,
      visitType,
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
    try {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO resource_bookings
           (tenant_id, resource_id, starts_at, ends_at, booked_for_type, booked_for_id, patient_uid, booked_by, notes)
         VALUES ($1::uuid, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7::uuid, $8::uuid, $9)
         RETURNING *`,
        tid, id, startsAt, endsAt, bookedForType, bookedForId, patientUid, context.actorUid || null, notes,
      );
      return rows[0];
    } catch (err) {
      if (isDbConflict(err)) {
        throw AppError.conflict('Resource already booked for an overlapping window', 'SCHED_RESOURCE_CLASH');
      }
      throw err;
    }
  });
}

export async function listResourceSchedule({ resourceId, date, tenantId = null, tenant_id = null } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  return prisma.$queryRawUnsafe(
    `SELECT b.id, b.tenant_id, b.resource_id, b.starts_at, b.ends_at,
            b.booked_for_type, b.booked_for_id, b.patient_uid, b.booked_by,
            b.status, b.notes, b.created_at, r.name AS resource_name, r.kind
       FROM resource_bookings b
       JOIN bookable_resources r ON r.id = b.resource_id
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
  applyOverbookPolicy,
  upsertTemplate,
  listTemplates,
  recordLeave,
  recordTemplateException,
  listTemplateExceptions,
  resolveOverbookPolicy,
  getSlotGrid,
  createSlotHold,
  confirmSlotHold,
  releaseSlotHold,
  addToWaitlist,
  fillWaitlist,
  resolveWaitlistEntry,
  sweepWaitlists,
  saveOverbookPolicy,
  listOverbookPolicies,
  evaluateOverbookRequest,
  createResource,
  addResourceCompatibility,
  listResourceCompatibility,
  bookResource,
  listResourceSchedule,
};
