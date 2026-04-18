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

class TheatreService {
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

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO ot_schedules
        (patient_uid, encounter_id, surgeon, anesthetist, procedure_name, procedure_code,
         ot_room, scheduled_date, scheduled_time, estimated_duration, status,
         equipment_needed, blood_arranged, consent_obtained, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8::date, $9::time,
         $10, 'scheduled', $11::text[], $12, $13, NOW(), NOW())
       RETURNING ${OT_RETURNING}`,
      patient_uid, encounter_id || null, surgeon, anesthetist || null,
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

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM ot_schedules WHERE id = $1`, requireIntId(id));
    if (existing.length === 0) throw AppError.notFound('OT schedule not found');

    const currentStatus = existing[0].status;
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(newStatus)) {
      throw AppError.invalidTransition(currentStatus, newStatus, allowed);
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE ot_schedules SET status = $1, updated_at = NOW() WHERE id = $2
       RETURNING ${OT_RETURNING}`,
      newStatus, requireIntId(id)
    );

    logger.info('OT schedule status updated', { scheduleId: id, from: currentStatus, to: newStatus, updatedBy });
    return result[0];
  }

  async completeChecklist(id, checklist) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM ot_schedules WHERE id = $1`, requireIntId(id));
    if (existing.length === 0) throw AppError.notFound('OT schedule not found');
    if (['completed', 'cancelled'].includes(existing[0].status)) {
      throw AppError.badRequest('Cannot update checklist for a completed or cancelled surgery');
    }

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
