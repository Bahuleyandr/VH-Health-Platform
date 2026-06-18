// src/services/theatre/orBoardService.js
//
// Sprint 6 — operational layer over migration 154 + the existing OT
// scheduling / surgical documentation services. Provides:
//   - OR room master CRUD
//   - Procedure catalog browse
//   - Conflict-aware booking helper (wraps theatreService.scheduleSurgery)
//   - Today's OR board (combined view of cases + checklist + WHO phases)
//   - Per-room daily throughput stats
//
// The clinical documentation (preop/intraop/postop notes, anesthesia,
// implants, complications) is already covered by
// services/theatre/surgicalDocumentationService.js — this module sits
// on top, not next to.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import theatreService from './theatreService.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

function tenantOr(value) {
  return String(value || '').trim() || DEFAULT_TENANT_ID;
}

// ── OR room master ───────────────────────────────────────────────────

export async function listOrRooms({ status = 'active' } = {}) {
  const params = [];
  let where = '';
  if (status && status !== 'all') {
    params.push(status);
    where = `WHERE status = $${params.length}`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT id, code, display_name, block, specialty_focus,
            laminar_flow, c_arm_available, microscope,
            prime_time_start, prime_time_end, status, notes
       FROM or_rooms
       ${where}
       ORDER BY block, code`,
    ...params,
  );
}

export async function upsertOrRoom({
  code, display_name, block, specialty_focus,
  laminar_flow, c_arm_available, microscope,
  prime_time_start, prime_time_end, status, notes,
}) {
  if (!code || !display_name) {
    throw AppError.badRequest('code and display_name are required');
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO or_rooms
       (code, display_name, block, specialty_focus,
        laminar_flow, c_arm_available, microscope,
        prime_time_start, prime_time_end, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::time, $9::time, $10, $11)
     ON CONFLICT (code) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       block = EXCLUDED.block,
       specialty_focus = EXCLUDED.specialty_focus,
       laminar_flow = EXCLUDED.laminar_flow,
       c_arm_available = EXCLUDED.c_arm_available,
       microscope = EXCLUDED.microscope,
       prime_time_start = EXCLUDED.prime_time_start,
       prime_time_end = EXCLUDED.prime_time_end,
       status = EXCLUDED.status,
       notes = EXCLUDED.notes,
       updated_at = NOW()
     RETURNING *`,
    String(code), String(display_name), block || null,
    specialty_focus || null,
    !!laminar_flow, !!c_arm_available, !!microscope,
    prime_time_start || null, prime_time_end || null,
    status || 'active', notes || null,
  );
  return rows[0];
}

// ── Procedure catalog ────────────────────────────────────────────────

export async function listProcedures({ specialty, q } = {}) {
  const params = [];
  const where = [`active = true`];
  if (specialty) { params.push(specialty); where.push(`specialty = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(display_name ILIKE $${params.length} OR procedure_code ILIKE $${params.length})`);
  }
  return prisma.$queryRawUnsafe(
    `SELECT id, procedure_code, display_name, specialty,
            typical_duration_min, setup_time_min, cleanup_time_min,
            requires_blood, requires_icu_postop, requires_laminar,
            default_anesthesia
       FROM or_procedure_catalog
      WHERE ${where.join(' AND ')}
      ORDER BY specialty, display_name`,
    ...params,
  );
}

// ── Booking conflict check ───────────────────────────────────────────

/**
 * Given a proposed booking (room, date, time, duration), return any
 * already-scheduled cases that overlap. Caller decides whether to
 * proceed (typically blocks unless force=true).
 */
export async function findConflicts({
  ot_room, scheduled_date, scheduled_time, estimated_duration, tenantId = null,
}) {
  const tid = tenantOr(tenantId);
  if (!ot_room || !scheduled_date || !scheduled_time || !estimated_duration) {
    return [];
  }
  // Postgres doesn't have a clean way to add minutes to a time without
  // a date. We compose a timestamp for the math.
  return prisma.$queryRawUnsafe(
    `WITH proposed AS (
       SELECT ($1::date + $2::time) AS pstart,
              ($1::date + $2::time + ($3 || ' minutes')::interval) AS pend
     )
     SELECT s.id, s.procedure_name, s.surgeon, s.scheduled_time,
            s.estimated_duration, s.status
       FROM ot_schedules s, proposed p
      WHERE s.tenant_id = $4::uuid
        AND s.ot_room = $5
        AND s.scheduled_date = $1::date
        AND s.status NOT IN ('cancelled', 'completed')
        AND s.scheduled_time IS NOT NULL
        AND COALESCE(s.estimated_duration, 60) > 0
        AND ($1::date + s.scheduled_time) < p.pend
        AND ($1::date + s.scheduled_time
             + (COALESCE(s.estimated_duration, 60) || ' minutes')::interval) > p.pstart
      ORDER BY s.scheduled_time`,
    String(scheduled_date), String(scheduled_time),
    String(estimated_duration), tid, String(ot_room),
  );
}

export async function scheduleWithConflictCheck(payload) {
  const conflicts = await findConflicts({
    ot_room: payload.ot_room,
    scheduled_date: payload.scheduled_date,
    scheduled_time: payload.scheduled_time,
    estimated_duration: payload.estimated_duration,
    tenantId: payload.tenantId || payload.tenant_id,
  });
  // `force` only skips this friendly pre-check (which exists to give the
  // coordinator a readable conflict list). It is NOT an override for a real
  // double-booking: migration 319's gist EXCLUDE constraint
  // (excl_ot_schedules_room_no_overlap) is the durable guard. If `force=true`
  // would create a genuine overlap, theatreService.scheduleSurgery surfaces the
  // 23P01 exclusion_violation as AppError.conflict('OT_ROOM_DOUBLE_BOOKED')
  // (409) — the insert is rejected at the DB layer regardless of `force`.
  if (conflicts.length && !payload.force) {
    throw AppError.badRequest(
      `Booking conflicts with ${conflicts.length} existing case(s). ` +
      `Pass force=true to override.`,
    );
  }
  const created = await theatreService.scheduleSurgery(payload);
  return { schedule: created, conflicts };
}

// ── Today's OR board ─────────────────────────────────────────────────

/**
 * Combined view of cases scheduled on a date, with checklist and WHO
 * checklist phase status. The OR coordinator dashboard hits this for
 * a single-screen view.
 */
export async function getOrBoard({ date, ot_room, tenantId = null, tenant_id = null } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const targetDate = date || new Date().toISOString().split('T')[0];
  const params = [tid, targetDate];
  const conds = [`s.tenant_id = $1::uuid`, `s.scheduled_date = $2::date`];
  if (ot_room) { params.push(ot_room); conds.push(`s.ot_room = $${params.length}`); }

  const rows = await prisma.$queryRawUnsafe(
    `SELECT s.id, s.patient_uid, s.procedure_name, s.procedure_code,
            s.surgeon, s.anesthetist, s.ot_room,
            s.scheduled_date, s.scheduled_time,
            s.estimated_duration, s.actual_duration, s.status,
            s.blood_arranged, s.consent_obtained,
            sc.sign_in_complete, sc.time_out_complete, sc.sign_out_complete,
            (SELECT COUNT(*)::int FROM intraop_notes n
              WHERE n.ot_schedule_id = s.id AND n.tenant_id = s.tenant_id) AS intraop_note_count,
            (SELECT COUNT(*)::int FROM postop_notes n
              WHERE n.ot_schedule_id = s.id AND n.tenant_id = s.tenant_id) AS postop_note_count,
            (SELECT COUNT(*)::int FROM postop_complication_alerts a
              WHERE a.ot_schedule_id = s.id
                AND a.tenant_id = s.tenant_id
                AND a.status NOT IN ('resolved','false_positive')) AS open_complications
       FROM ot_schedules s
       LEFT JOIN or_safety_compliance sc ON sc.ot_schedule_id = s.id
      WHERE ${conds.join(' AND ')}
      ORDER BY s.ot_room, s.scheduled_time NULLS LAST, s.created_at`,
    ...params,
  );
  return { date: targetDate, ot_room: ot_room || null, cases: rows };
}

export async function getDailyThroughput({ date, ot_room, tenantId = null, tenant_id = null } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const targetDate = date || new Date().toISOString().split('T')[0];
  const params = [tid, targetDate];
  const conds = [`tenant_id = $1::uuid`, `scheduled_date = $2::date`, `ot_room IS NOT NULL`];
  if (ot_room) { params.push(ot_room); conds.push(`ot_room = $${params.length}`); }
  return prisma.$queryRawUnsafe(
    `SELECT ot_room,
            scheduled_date,
            COUNT(*)::int AS scheduled_cases,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int AS completed_cases,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END)::int AS cancelled_cases,
            COALESCE(SUM(estimated_duration), 0)::int AS estimated_minutes,
            COALESCE(SUM(actual_duration), 0)::int AS actual_minutes,
            CASE
              WHEN COALESCE(SUM(estimated_duration), 0) = 0 THEN NULL
              ELSE ROUND(
                (COALESCE(SUM(actual_duration), 0)::numeric /
                 NULLIF(SUM(estimated_duration), 0)) * 100, 1)
            END AS minutes_efficiency_pct
       FROM ot_schedules
      WHERE ${conds.join(' AND ')}
      GROUP BY ot_room, scheduled_date
      ORDER BY ot_room`,
    ...params,
  );
}

export async function getWeeklySafetyCompliance({ from, to, tenantId = null, tenant_id = null } = {}) {
  const tid = tenantOr(tenantId || tenant_id);
  const fromDate = from || new Date(Date.now() - 7 * 86400 * 1000).toISOString().split('T')[0];
  const toDate = to || new Date().toISOString().split('T')[0];
  return prisma.$queryRawUnsafe(
    `SELECT or_safety_compliance.scheduled_date,
            COUNT(*)::int AS cases,
            SUM(CASE WHEN sign_in_complete THEN 1 ELSE 0 END)::int AS sign_in_complete,
            SUM(CASE WHEN time_out_complete THEN 1 ELSE 0 END)::int AS time_out_complete,
            SUM(CASE WHEN sign_out_complete THEN 1 ELSE 0 END)::int AS sign_out_complete
       FROM or_safety_compliance
       JOIN ot_schedules s ON s.id = or_safety_compliance.ot_schedule_id
      WHERE s.tenant_id = $1::uuid
        AND or_safety_compliance.scheduled_date BETWEEN $2::date AND $3::date
        AND case_status NOT IN ('cancelled')
      GROUP BY or_safety_compliance.scheduled_date
      ORDER BY or_safety_compliance.scheduled_date DESC`,
    tid, String(fromDate), String(toDate),
  );
}
