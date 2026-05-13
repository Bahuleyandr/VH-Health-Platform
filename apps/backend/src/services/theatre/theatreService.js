// src/services/theatre/theatreService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const VALID_STATUSES = ['scheduled', 'pre_op', 'in_progress', 'post_op', 'completed', 'cancelled'];
const VALID_TRANSITIONS = {
  scheduled: ['pre_op', 'cancelled'],
  pre_op: ['in_progress', 'cancelled'],
  in_progress: ['post_op'],
  post_op: ['completed'],
  completed: [],
  cancelled: [],
};

const OT_RETURNING = `id, patient_uid, encounter_id, surgeon, anesthetist, procedure_name,
    procedure_code, ot_room, scheduled_date, scheduled_time, estimated_duration,
    actual_duration, status, pre_op_checklist, equipment_needed, blood_arranged,
    consent_obtained, post_op_notes, complications, created_at, updated_at`;

function requireIntId(id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) throw AppError.badRequest('Invalid id — must be an integer');
  return n;
}

function normalizeMarkedSide(value) {
  if (value == null) return null;
  const side = String(value).trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!side) return null;
  if (['right', 'right eye', 'rt', 'r', 'od'].includes(side)) return 'right';
  if (['left', 'left eye', 'lt', 'l', 'os'].includes(side)) return 'left';
  if (['bilateral', 'both', 'both eyes', 'ou'].includes(side)) return 'bilateral';
  return null;
}

function inferProcedureSide(schedule) {
  const text = `${schedule?.procedure_name || ''} ${schedule?.procedure_code || ''}`.toLowerCase();
  if (!text.trim()) return null;
  if (/\b(bilateral|both eyes|ou)\b/.test(text)) return 'bilateral';

  const hasRight = /\bright\b|\bright[-_\s]?eye\b|\brt\b|\br\/e\b|\bod\b/.test(text);
  const hasLeft = /\bleft\b|\bleft[-_\s]?eye\b|\blt\b|\bl\/e\b|\bos\b/.test(text);

  if (hasRight && !hasLeft) return 'right';
  if (hasLeft && !hasRight) return 'left';
  return null;
}

function assertOtReadySiteMark(checklist, schedule) {
  if (!checklist || typeof checklist !== 'object' || Array.isArray(checklist) || checklist.ot_ready !== true) return;

  if (checklist.site_marked !== true) {
    throw AppError.badRequest(
      'Cannot set OT-ready until the surgical site mark is confirmed',
      'SURGICAL_SITE_MARK_REQUIRED'
    );
  }

  const expectedSide = inferProcedureSide(schedule);
  if (!expectedSide || expectedSide === 'bilateral') return;

  const markedSide = normalizeMarkedSide(
    checklist.site_marked_eye ?? checklist.site_marked_side ?? checklist.site_marked_laterality
  );
  if (!markedSide) {
    throw AppError.badRequest(
      'Cannot set OT-ready until the marked surgical side is documented',
      'SURGICAL_SITE_SIDE_REQUIRED',
      { expectedSide }
    );
  }
  if (markedSide !== expectedSide) {
    throw AppError.badRequest(
      'Marked surgical side does not match the scheduled procedure',
      'SURGICAL_SITE_SIDE_MISMATCH',
      { expectedSide, markedSide }
    );
  }
}

class TheatreService {
  async _assertReadyForClosure(scheduleId) {
    const [anesthesia] = await prisma.$queryRawUnsafe(
      `SELECT status, finalized_by, finalized_at
         FROM anesthesia_records
        WHERE ot_schedule_id = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      scheduleId,
    );
    if (!anesthesia || anesthesia.status !== 'finalized'
        || !anesthesia.finalized_by || !anesthesia.finalized_at) {
      throw AppError.badRequest(
        'Cannot close OT case until the anaesthesia record is finalized and signed',
        'ANAESTHESIA_FINALIZE_REQUIRED',
      );
    }

    const [intraop] = await prisma.$queryRawUnsafe(
      `SELECT status, finalized_by, finalized_at,
              sponge_count_correct, sharp_count_correct, instrument_count_correct
         FROM intraop_notes
        WHERE ot_schedule_id = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      scheduleId,
    );
    if (!intraop || intraop.status !== 'finalized'
        || !intraop.finalized_by || !intraop.finalized_at) {
      throw AppError.badRequest(
        'Cannot close OT case until the intraop note is finalized and signed by the surgeon',
        'INTRAOP_FINALIZE_REQUIRED',
      );
    }
    if (intraop.sponge_count_correct !== true
        || intraop.sharp_count_correct !== true
        || intraop.instrument_count_correct !== true) {
      throw AppError.badRequest(
        'Cannot close OT case until sponge, sharp, and instrument counts are confirmed correct',
        'INSTRUMENT_COUNTS_REQUIRED',
        {
          sponge_count_correct: intraop.sponge_count_correct,
          sharp_count_correct: intraop.sharp_count_correct,
          instrument_count_correct: intraop.instrument_count_correct,
        },
      );
    }
  }

  async scheduleSurgery(data) {
    const {
      patient_uid, encounter_id, surgeon, anesthetist,
      procedure_name, procedure_code, ot_room, scheduled_date,
      scheduled_time, estimated_duration, equipment_needed = [],
      blood_arranged = false, consent_obtained = false,
    } = data;

    if (!patient_uid || !surgeon || !procedure_name || !scheduled_date) {
      throw AppError.badRequest('Missing required fields: patient_uid, surgeon, procedure_name, scheduled_date');
    }

    // ot_schedules.encounter_id is INTEGER (legacy HL7 visit_no column),
    // but admissions.encounter_id is UUID. Callers pass the admission's
    // UUID here, which Postgres rejects with a type error → previously
    // surfaced as a generic 500. Accept the UUID form and store NULL
    // until the table is widened to a uuid/int split (matches what
    // vitalsChartService does for the same column collision).
    let encounterIdInt = null;
    if (encounter_id !== null && encounter_id !== undefined && encounter_id !== '') {
      const asInt = Number.parseInt(encounter_id, 10);
      if (Number.isFinite(asInt) && String(asInt) === String(encounter_id).trim()) {
        encounterIdInt = asInt;
      } else if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(encounter_id)) {
        logger.warn('scheduleSurgery: UUID encounter_id passed; ot_schedules.encounter_id is INT — storing NULL', {
          patient_uid, encounter_id,
        });
      } else {
        throw AppError.badRequest('encounter_id must be an integer or a UUID');
      }
    }

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO ot_schedules
        (patient_uid, encounter_id, surgeon, anesthetist, procedure_name, procedure_code,
         ot_room, scheduled_date, scheduled_time, estimated_duration, status,
         equipment_needed, blood_arranged, consent_obtained, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8::date, $9::time,
         $10, 'scheduled', $11::text[], $12, $13, NOW(), NOW())
       RETURNING ${OT_RETURNING}`,
      patient_uid, encounterIdInt, surgeon, anesthetist || null,
      procedure_name, procedure_code || null, ot_room || null,
      scheduled_date, scheduled_time || null, estimated_duration || null,
      equipment_needed, blood_arranged, consent_obtained
    );

    logger.info('Surgery scheduled', { scheduleId: result[0].id, procedure_name, surgeon });
    return result[0];
  }

  async getTodaySchedule(filters = {}) {
    const { ot_room, status, date } = filters;
    const targetDate = date || new Date().toISOString().split('T')[0];
    const conditions = [`scheduled_date = $1::date`];
    const params = [targetDate];

    if (ot_room) {
      params.push(ot_room);
      conditions.push(`ot_room = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    return prisma.$queryRawUnsafe(
      `SELECT ${OT_RETURNING}
       FROM ot_schedules
       WHERE ${conditions.join(' AND ')}
       ORDER BY scheduled_time ASC NULLS LAST, created_at ASC`,
      ...params
    );
  }

  async updateStatus(id, newStatus, updatedBy) {
    if (!VALID_STATUSES.includes(newStatus)) {
      throw AppError.badRequest(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const scheduleId = requireIntId(id);
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM ot_schedules WHERE id = $1`, scheduleId);
    if (existing.length === 0) throw AppError.notFound('OT schedule not found');

    const currentStatus = existing[0].status;
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(newStatus)) {
      throw AppError.invalidTransition(currentStatus, newStatus, allowed);
    }

    if (currentStatus === 'pre_op' && newStatus === 'in_progress') {
      const timeOutRows = await prisma.$queryRawUnsafe(
        `SELECT id FROM surgical_safety_checklists
         WHERE ot_schedule_id = $1
           AND phase = 'time_out'
           AND (
             status = 'complete'
             OR (
               status = 'incomplete_with_override'
               AND NULLIF(TRIM(override_reason), '') IS NOT NULL
               AND override_authorized_by IS NOT NULL
             )
           )
         LIMIT 1`,
        scheduleId
      );
      if (timeOutRows.length === 0) {
        throw AppError.badRequest(
          'WHO time-out must be completed before moving an OT case to in_progress',
          'WHO_TIMEOUT_REQUIRED'
        );
      }
    }

    // Wave-2 fix: gate post_op + completed on signed anaesthesia + intraop
    // notes + correct instrument counts. An OT case cannot transition past
    // in_progress until both the surgeon's intraop note and the
    // anaesthetist's anaesthesia record are finalized, and the closing
    // sponge/sharp/instrument counts are correct. Finding:
    // 2026-05-09-surgical-day-care-ot-staff-case-close-no-gate.
    if (newStatus === 'post_op' || newStatus === 'completed') {
      await this._assertReadyForClosure(scheduleId);
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE ot_schedules SET status = $1, updated_at = NOW() WHERE id = $2
       RETURNING ${OT_RETURNING}`,
      newStatus, scheduleId
    );

    logger.info('OT schedule status updated', { scheduleId: id, from: currentStatus, to: newStatus, updatedBy });
    return result[0];
  }

  async completeChecklist(id, checklist) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status, procedure_name, procedure_code FROM ot_schedules WHERE id = $1`, requireIntId(id));
    if (existing.length === 0) throw AppError.notFound('OT schedule not found');
    if (['completed', 'cancelled'].includes(existing[0].status)) {
      throw AppError.badRequest('Cannot update checklist for a completed or cancelled surgery');
    }
    assertOtReadySiteMark(checklist, existing[0]);

    const result = await prisma.$queryRawUnsafe(
      `UPDATE ot_schedules SET pre_op_checklist = $1::jsonb, updated_at = NOW()
       WHERE id = $2
       RETURNING ${OT_RETURNING}`,
      JSON.stringify(checklist ?? {}), requireIntId(id)
    );

    logger.info('Pre-op checklist updated', { scheduleId: id });
    return result[0];
  }

  async getAvailableRooms(date) {
    if (!date) throw AppError.badRequest('Date is required');

    const bookedResult = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ot_room FROM ot_schedules
       WHERE scheduled_date = $1::date
         AND status NOT IN ('cancelled', 'completed')
         AND ot_room IS NOT NULL`,
      date
    );
    const bookedRooms = bookedResult.map((r) => r.ot_room);

    const scheduleResult = await prisma.$queryRawUnsafe(
      `SELECT ot_room, COUNT(*)::int AS surgery_count,
              ARRAY_AGG(scheduled_time ORDER BY scheduled_time) AS times,
              ARRAY_AGG(status) AS statuses
       FROM ot_schedules
       WHERE scheduled_date = $1::date
         AND status NOT IN ('cancelled')
         AND ot_room IS NOT NULL
       GROUP BY ot_room
       ORDER BY ot_room`,
      date
    );

    return { date, booked_rooms: bookedRooms, room_schedules: scheduleResult };
  }

  async cancelSurgery(id, cancelledBy) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM ot_schedules WHERE id = $1`, requireIntId(id));
    if (existing.length === 0) throw AppError.notFound('OT schedule not found');
    if (['completed', 'cancelled'].includes(existing[0].status)) {
      throw AppError.badRequest(`Cannot cancel a surgery that is already ${existing[0].status}`);
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE ot_schedules SET status = 'cancelled', updated_at = NOW() WHERE id = $1
       RETURNING ${OT_RETURNING}`,
      requireIntId(id)
    );

    logger.info('Surgery cancelled', { scheduleId: id, cancelledBy });
    return result[0];
  }
}

export default new TheatreService();
