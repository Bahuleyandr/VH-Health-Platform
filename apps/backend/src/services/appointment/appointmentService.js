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

  async validateDoctor(doctorId) {
    try {
      const id = parseInt(doctorId, 10);
      const rows = await prisma.$queryRaw`
        SELECT COALESCE(u.id, d.id) AS id,
               COALESCE(u.name, d.name) AS name,
               'DOCTOR'::text AS role
        FROM doctors d
        LEFT JOIN users u ON u.id = d.user_id AND u.role = 'DOCTOR'
        WHERE d.is_active = true
          AND (u.id = ${id} OR d.id = ${id})
        ORDER BY CASE WHEN u.id = ${id} THEN 0 ELSE 1 END
        LIMIT 1
      `;
      return rows[0] || null;
    } catch (error) {
      logger.error('Error validating doctor:', error);
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
        // Resolve patient phone + doctor name for the NOT NULL columns on appointments.
        const [pRows, dRows] = await Promise.all([
          tx.$queryRaw`SELECT id, phone, name FROM users WHERE id = ${parseInt(patient_id)}`,
          tx.$queryRaw`
            SELECT COALESCE(u.id, d.id) AS id,
                   COALESCE(u.name, d.name) AS name
            FROM doctors d
            LEFT JOIN users u ON u.id = d.user_id AND u.role = 'DOCTOR'
            WHERE d.is_active = true
              AND (u.id = ${parseInt(doctor_id)} OR d.id = ${parseInt(doctor_id)})
            ORDER BY CASE WHEN u.id = ${parseInt(doctor_id)} THEN 0 ELSE 1 END
            LIMIT 1
          `,
        ]);
        const patientPhone = pRows[0]?.phone ?? '';
        const patientName = pRows[0]?.name ?? null;
        const doctorName = dRows[0]?.name ?? '';

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
            phone, patient_id, patient_name, doctor_id, doctor_name,
            appointment_date, appointment_time,
            reason, notes, status, created_at, updated_at
          ) VALUES (
            ${patientPhone}, ${parseInt(patient_id)}, ${patientName},
            ${parseInt(doctor_id)}, ${doctorName},
            ${appointment_date}::date, ${appointment_time},
            ${reason ?? null}, ${notes ?? null},
            ${APPOINTMENT_CONFIG.STATUSES.SCHEDULED}, NOW(), NOW()
          )
          RETURNING id, uid, phone, patient_id, patient_name, doctor_id, doctor_name,
            appointment_date, appointment_time, status, reason, notes, created_at, updated_at
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
      // Use $queryRawUnsafe with explicit ::text cast so NULL params have a known type.
      // Prisma can't infer `$2 IS NOT NULL` on a bare tagged-template null (42P18).
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE appointments SET
           status     = $1,
           notes      = CASE
                          WHEN $2::text IS NOT NULL
                          THEN COALESCE(notes || ' | ', '') || $2::text
                          ELSE notes
                        END,
           updated_at = NOW()
         WHERE id = $3
         RETURNING id, uid, phone, patient_id, doctor_id, patient_name, doctor_name,
           appointment_date, appointment_time, status, notes, created_at, updated_at`,
        status, notes ?? null, parseInt(id)
      );
      return rows[0];
    } catch (error) {
      logger.error('Error updating appointment status:', error);
      throw error;
    }
  }

  async getAppointmentById(id) {
    try {
      // Duplicate of AppointmentQueryService.getAppointmentById — both
      // services export this method under slightly different consumer
      // paths. Delegating here keeps the flattening logic in one place.
      const { default: queryService } = await import('./appointmentQueryService.js');
      return queryService.getAppointmentById(id);
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
