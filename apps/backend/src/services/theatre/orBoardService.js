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
  ot_room, scheduled_date, scheduled_time, estimated_duration,
}) {
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
      WHERE s.ot_room = $4
        AND s.scheduled_date = $1::date
        AND s.status NOT IN ('cancelled', 'completed')
        AND s.scheduled_time IS NOT NULL
        AND COALESCE(s.estimated_duration, 60) > 0
        AND ($1::date + s.scheduled_time) < p.pend
        AND ($1::date + s.scheduled_time
             + (COALESCE(s.estimated_duration, 60) || ' minutes')::interval) > p.pstart
      ORDER BY s.scheduled_time`,
    String(scheduled_date), String(scheduled_time),
    String(estimated_duration), String(ot_room),
  );
}

export async function scheduleWithConflictCheck(payload) {
  const conflicts = await findConflicts({
    ot_room: payload.ot_room,
    scheduled_date: payload.scheduled_date,
    scheduled_time: payload.scheduled_time,
    estimated_duration: payload.estimated_duration,
  });
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
export async function getOrBoard({ date, ot_room } = {}) {
  const targetDate = date || new Date().toISOString().split('T')[0];
  const params = [targetDate];
  const conds = [`s.scheduled_date = $1::date`];
  if (ot_room) { params.push(ot_room); conds.push(`s.ot_room = $${params.length}`); }

  const rows = await prisma.$queryRawUnsafe(
    `SELECT s.id, s.patient_uid, s.procedure_name, s.procedure_code,
            s.surgeon, s.anesthetist, s.ot_room,
            s.scheduled_date, s.scheduled_time,
            s.estimated_duration, s.actual_duration, s.status,
            s.blood_arranged, s.consent_obtained,
            sc.sign_in_complete, sc.time_out_complete, sc.sign_out_complete,
            (SELECT COUNT(*)::int FROM intraop_notes n WHERE n.ot_schedule_id = s.id) AS intraop_note_count,
            (SELECT COUNT(*)::int FROM postop_notes n WHERE n.ot_schedule_id = s.id) AS postop_note_count,
            (SELECT COUNT(*)::int FROM postop_complication_alerts a
              WHERE a.ot_schedule_id = s.id AND a.status NOT IN ('resolved','false_positive')) AS open_complications
       FROM ot_schedules s
       LEFT JOIN or_safety_compliance sc ON sc.ot_schedule_id = s.id
      WHERE ${conds.join(' AND ')}
      ORDER BY s.ot_room, s.scheduled_time NULLS LAST, s.created_at`,
    ...params,
  );
  return { date: targetDate, ot_room: ot_room || null, cases: rows };
}

export async function getDailyThroughput({ date, ot_room } = {}) {
  const targetDate = date || new Date().toISOString().split('T')[0];
  const params = [targetDate];
  const conds = [`scheduled_date = $1::date`];
  if (ot_room) { params.push(ot_room); conds.push(`ot_room = $${params.length}`); }
  return prisma.$queryRawUnsafe(
    `SELECT * FROM or_throughput_daily
      WHERE ${conds.join(' AND ')}
      ORDER BY ot_room`,
    ...params,
  );
}

export async function getWeeklySafetyCompliance({ from, to } = {}) {
  const fromDate = from || new Date(Date.now() - 7 * 86400 * 1000).toISOString().split('T')[0];
  const toDate = to || new Date().toISOString().split('T')[0];
  return prisma.$queryRawUnsafe(
    `SELECT scheduled_date,
            COUNT(*)::int AS cases,
            SUM(CASE WHEN sign_in_complete THEN 1 ELSE 0 END)::int AS sign_in_complete,
            SUM(CASE WHEN time_out_complete THEN 1 ELSE 0 END)::int AS time_out_complete,
            SUM(CASE WHEN sign_out_complete THEN 1 ELSE 0 END)::int AS sign_out_complete
       FROM or_safety_compliance
      WHERE scheduled_date BETWEEN $1::date AND $2::date
        AND case_status NOT IN ('cancelled')
      GROUP BY scheduled_date
      ORDER BY scheduled_date DESC`,
    String(fromDate), String(toDate),
  );
}
