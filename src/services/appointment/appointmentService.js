// src/services/appointment/appointmentService.js
// Migrated from raw pg to Prisma ORM

import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

export class AppointmentService {
  async validateUser(userId, requiredRole = null) {
    try {
      const where = { id: parseInt(userId) };
      if (requiredRole) where.role = requiredRole;
      return prisma.users.findFirst({
        where,
        select: { id: true, name: true, role: true },
      });
    } catch (error) {
      logger.error('Error validating user:', error);
      throw error;
    }
  }

  async checkConflict(doctorId, appointmentDate, appointmentTime, excludeId = null) {
    try {
      let rows;
      if (excludeId) {
        rows = await prisma.$queryRaw`
          SELECT id FROM appointments
          WHERE doctor_id = ${parseInt(doctorId)}
            AND DATE(appointment_date) = DATE(${appointmentDate}::date)
            AND appointment_time = ${appointmentTime}
            AND status NOT IN ('CANCELLED', 'NO_SHOW')
            AND id != ${parseInt(excludeId)}
          LIMIT 1
        `;
      } else {
        rows = await prisma.$queryRaw`
          SELECT id FROM appointments
          WHERE doctor_id = ${parseInt(doctorId)}
            AND DATE(appointment_date) = DATE(${appointmentDate}::date)
            AND appointment_time = ${appointmentTime}
            AND status NOT IN ('CANCELLED', 'NO_SHOW')
          LIMIT 1
        `;
      }
      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      logger.error('Error checking appointment conflict:', error);
      throw error;
    }
  }

  async createAppointment(appointmentData) {
    const { patient_id, doctor_id, appointment_date, appointment_time, reason, notes = null } = appointmentData;

    try {
      return await prisma.$transaction(async (tx) => {
        // Lock conflicting rows
        const conflict = await tx.$queryRaw`
          SELECT id FROM appointments
          WHERE doctor_id = ${parseInt(doctor_id)}
            AND DATE(appointment_date) = DATE(${appointment_date}::date)
            AND appointment_time = ${appointment_time}
            AND status NOT IN ('CANCELLED', 'NO_SHOW')
          FOR UPDATE
        `;

        if (conflict.length > 0) {
          const err = new Error('Slot no longer available');
          err.isConflict = true;
          err.conflictingId = conflict[0].id;
          throw err;
        }

        const rows = await tx.$queryRaw`
          INSERT INTO appointments (
            patient_id, doctor_id, appointment_date, appointment_time,
            reason, notes, status, created_at
          ) VALUES (
            ${parseInt(patient_id)}, ${parseInt(doctor_id)},
            ${appointment_date}::date, ${appointment_time},
            ${reason ?? null}, ${notes ?? null},
            ${APPOINTMENT_CONFIG.STATUSES.SCHEDULED}, NOW()
          )
          RETURNING id, uid, phone, patient_name, doctor_name, appointment_date,
            appointment_time, status, notes, created_at, updated_at
        `;

        return rows[0];
      });
    } catch (error) {
      logger.error('Error creating appointment:', error);
      throw error;
    }
  }

  async updateAppointment(id, updateData) {
    const { appointment_date, appointment_time, reason, notes } = updateData;
    try {
      const rows = await prisma.$queryRaw`
        UPDATE appointments SET
          appointment_date = COALESCE(${appointment_date ?? null}::date, appointment_date),
          appointment_time = COALESCE(${appointment_time ?? null}, appointment_time),
          reason           = COALESCE(${reason ?? null}, reason),
          notes            = COALESCE(${notes ?? null}, notes),
          updated_at       = NOW()
        WHERE id = ${parseInt(id)}
        RETURNING id, uid, phone, patient_name, doctor_name, appointment_date,
          appointment_time, status, notes, created_at, updated_at
      `;
      return rows[0];
    } catch (error) {
      logger.error('Error updating appointment:', error);
      throw error;
    }
  }

  async updateAppointmentStatus(id, status, notes = null, _updatedBy = null) {
    try {
      const rows = await prisma.$queryRaw`
        UPDATE appointments SET
          status     = ${status},
          notes      = CASE
                         WHEN ${notes ?? null} IS NOT NULL
                         THEN COALESCE(notes || ' | ', '') || ${notes ?? null}
                         ELSE notes
                       END,
          updated_at = NOW()
        WHERE id = ${parseInt(id)}
        RETURNING id, uid, phone, patient_name, doctor_name, appointment_date,
          appointment_time, status, notes, created_at, updated_at
      `;
      return rows[0];
    } catch (error) {
      logger.error('Error updating appointment status:', error);
      throw error;
    }
  }

  async getAppointmentById(id) {
    try {
      const rows = await prisma.$queryRaw`
        SELECT a.id, a.uid, a.phone, a.doctor_id, a.doctor_name, a.patient_name,
               a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
               a.created_at, a.updated_at,
               u.email AS patient_email,
               d.name AS doctor_name_detail, d.phone AS doctor_phone, d.email AS doctor_email,
               dp.specialization, dp.department, dp.consultation_fee
        FROM appointments a
        LEFT JOIN users u ON a.uid = u.uid
        LEFT JOIN users d ON a.doctor_id = d.id
        LEFT JOIN doctors dp ON d.id = dp.user_id
        WHERE a.id = ${parseInt(id)}
      `;
      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      logger.error('Error getting appointment by ID:', error);
      throw error;
    }
  }

  async cancelAppointment(id, cancelledBy) {
    try {
      return await this.updateAppointmentStatus(
        id, APPOINTMENT_CONFIG.STATUSES.CANCELLED,
        `Cancelled by ${cancelledBy}`
      );
    } catch (error) {
      logger.error('Error cancelling appointment:', error);
      throw error;
    }
  }
}

export default new AppointmentService();
