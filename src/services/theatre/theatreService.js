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
  cancelled: []
};

class TheatreService {

  /**
   * Schedule a new surgery
   */
  async scheduleSurgery(data) {
    const {
      patient_uid, encounter_id, surgeon, anesthetist,
      procedure_name, procedure_code, ot_room, scheduled_date,
      scheduled_time, estimated_duration, equipment_needed = [],
      blood_arranged = false, consent_obtained = false
    } = data;

    if (!patient_uid || !surgeon || !procedure_name || !scheduled_date) {
      throw AppError.badRequest('Missing required fields: patient_uid, surgeon, procedure_name, scheduled_date');
    }

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO ot_schedules
        (patient_uid, encounter_id, surgeon, anesthetist, procedure_name, procedure_code,
         ot_room, scheduled_date, scheduled_time, estimated_duration, status,
         equipment_needed, blood_arranged, consent_obtained, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'scheduled', $11, $12, $13, NOW())
       RETURNING id, patient_uid, encounter_id, surgeon, anesthetist, procedure_name,
                 procedure_code, ot_room, scheduled_date, scheduled_time, estimated_duration,
                 status, equipment_needed, blood_arranged, consent_obtained, created_at`,
      [
        patient_uid, encounter_id || null, surgeon, anesthetist || null,
        procedure_name, procedure_code || null, ot_room || null,
        scheduled_date, scheduled_time || null, estimated_duration || null,
        equipment_needed, blood_arranged, consent_obtained
      ]
    );

    logger.info('Surgery scheduled', { scheduleId: result[0].id, procedure_name, surgeon });
    return result[0];
  }

  /**
   * Get today's OT schedule
   */
  async getTodaySchedule(filters = {}) {
    const { ot_room, status, date } = filters;
    const targetDate = date || new Date().toISOString().split('T')[0];
    const conditions = [`scheduled_date = $1`];
    const params = [targetDate];

    if (ot_room) {
      params.push(ot_room);
      conditions.push(`ot_room = $${params.length}`);
    }

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, encounter_id, surgeon, anesthetist, procedure_name,
              procedure_code, ot_room, scheduled_date, scheduled_time, estimated_duration,
              actual_duration, status, pre_op_checklist, equipment_needed,
              blood_arranged, consent_obtained, post_op_notes, complications, created_at
       FROM ot_schedules
       ${whereClause}
       ORDER BY scheduled_time ASC NULLS LAST, created_at ASC`,
      params
    );

    return result.rows;
  }

  /**
   * Update surgery status with valid transition enforcement
   */
  async updateStatus(id, newStatus, updatedBy) {
    if (!VALID_STATUSES.includes(newStatus)) {
      throw AppError.badRequest(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM ot_schedules WHERE id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      throw AppError.notFound('OT schedule not found');
    }

    const currentStatus = existing[0].status;
    const allowed = VALID_TRANSITIONS[currentStatus] || [];

    if (!allowed.includes(newStatus)) {
      throw AppError.invalidTransition(currentStatus, newStatus, allowed);
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE ot_schedules SET status = $1 WHERE id = $2
       RETURNING id, patient_uid, surgeon, procedure_name, ot_room, scheduled_date, status`,
      [newStatus, id]
    );

    logger.info('OT schedule status updated', { scheduleId: id, from: currentStatus, to: newStatus, updatedBy });
    return result[0];
  }

  /**
   * Complete or update the pre-op checklist
   */
  async completeChecklist(id, checklist) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM ot_schedules WHERE id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      throw AppError.notFound('OT schedule not found');
    }

    if (['completed', 'cancelled'].includes(existing[0].status)) {
      throw AppError.badRequest('Cannot update checklist for a completed or cancelled surgery');
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE ot_schedules SET pre_op_checklist = $1 WHERE id = $2
       RETURNING id, patient_uid, procedure_name, status, pre_op_checklist`,
      [JSON.stringify(checklist), id]
    );

    logger.info('Pre-op checklist updated', { scheduleId: id });
    return result[0];
  }

  /**
   * Get available OT rooms for a given date
   */
  async getAvailableRooms(date) {
    if (!date) {
      throw AppError.badRequest('Date is required');
    }

    // Get rooms that are currently booked (not cancelled/completed) on the given date
    const bookedResult = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ot_room FROM ot_schedules
       WHERE scheduled_date = $1
         AND status NOT IN ('cancelled', 'completed')
         AND ot_room IS NOT NULL`,
      [date]
    );

    const bookedRooms = bookedResult.rows.map(r => r.ot_room);

    // Return schedule summary per room for the date
    const scheduleResult = await prisma.$queryRawUnsafe(
      `SELECT ot_room, COUNT(*) as surgery_count,
              ARRAY_AGG(scheduled_time ORDER BY scheduled_time) as times,
              ARRAY_AGG(status) as statuses
       FROM ot_schedules
       WHERE scheduled_date = $1
         AND status NOT IN ('cancelled')
         AND ot_room IS NOT NULL
       GROUP BY ot_room
       ORDER BY ot_room`,
      [date]
    );

    return {
      date,
      booked_rooms: bookedRooms,
      room_schedules: scheduleResult.rows
    };
  }

  /**
   * Cancel a scheduled surgery
   */
  async cancelSurgery(id, cancelledBy) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM ot_schedules WHERE id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      throw AppError.notFound('OT schedule not found');
    }

    if (['completed', 'cancelled'].includes(existing[0].status)) {
      throw AppError.badRequest(`Cannot cancel a surgery that is already ${existing[0].status}`);
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE ot_schedules SET status = 'cancelled' WHERE id = $1
       RETURNING id, patient_uid, surgeon, procedure_name, ot_room, scheduled_date, status`,
      [id]
    );

    logger.info('Surgery cancelled', { scheduleId: id, cancelledBy });
    return result[0];
  }
}

export default new TheatreService();
