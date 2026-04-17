// src/services/appointment/appointmentQueryService.js
// Migrated from raw pg to Prisma ORM

import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { buildPaginationMeta } from '../../utils/appointment/appointmentHelpers.js';

export class AppointmentQueryService {
  async getAppointments(filters = {}, pagination = {}, userRole = null, userId = null) {
    try {
      const page = pagination.page || APPOINTMENT_CONFIG.DEFAULT_PAGINATION.PAGE;
      const limit = pagination.limit || APPOINTMENT_CONFIG.DEFAULT_PAGINATION.LIMIT;
      const offset = (page - 1) * limit;

      const where = {};
      if (userRole === 'DOCTOR') where.doctor_id = parseInt(userId);
      if (filters.status) where.status = filters.status.toUpperCase();
      if (filters.doctor_id) where.doctor_id = parseInt(filters.doctor_id);
      if (filters.patient_id) where.patient_id = parseInt(filters.patient_id);
      if (filters.date) {
        where.appointment_date = new Date(filters.date);
      }

      // Build the query string and params list dynamically using Prisma.sql joins
      const { Prisma } = await import('@prisma/client');
      const conditions = [Prisma.sql`1=1`];
      if (userRole === 'DOCTOR') conditions.push(Prisma.sql`a.doctor_id = ${parseInt(userId)}`);
      if (filters.status) conditions.push(Prisma.sql`a.status = ${filters.status.toUpperCase()}`);
      if (filters.doctor_id) conditions.push(Prisma.sql`a.doctor_id = ${parseInt(filters.doctor_id)}`);
      if (filters.date) conditions.push(Prisma.sql`DATE(a.appointment_date) = ${filters.date}::date`);

      const whereClause = Prisma.join(conditions, ' AND ');

      const [total, appointments] = await Promise.all([
        prisma.appointments.count({ where }),
        prisma.$queryRaw`
          SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
                 a.created_at, a.updated_at,
                 p.name AS patient_name, p.phone AS patient_phone,
                 d.name AS doctor_name, d.phone AS doctor_phone
          FROM appointments a
          LEFT JOIN users p ON a.uid = p.uid
          LEFT JOIN users d ON a.doctor_id = d.id
          LEFT JOIN doctors dp ON d.id = dp.user_id
          WHERE ${whereClause}
          ORDER BY a.appointment_date, a.appointment_time
          LIMIT ${limit} OFFSET ${offset}
        `,
      ]);

      return {
        appointments,
        pagination: buildPaginationMeta(page, limit, total),
        filters,
      };
    } catch (error) {
      logger.error('Error getting appointments:', error);
      throw error;
    }
  }

  async getDoctorAppointments(doctorId, filters = {}) {
    try {
      const status = (filters.status || APPOINTMENT_CONFIG.STATUSES.SCHEDULED).toUpperCase();

      let rows;
      if (filters.date) {
        rows = await prisma.$queryRaw`
          SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
                 p.name AS patient_name, p.phone AS patient_phone, p.id AS patient_id,
                 p.email AS patient_email
          FROM appointments a
          LEFT JOIN users p ON a.patient_id = p.id
          WHERE a.doctor_id = ${parseInt(doctorId)}
            AND a.status = ${status}
            AND DATE(a.appointment_date) = ${filters.date}::date
          ORDER BY a.appointment_date, a.appointment_time
        `;
      } else {
        rows = await prisma.$queryRaw`
          SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
                 p.name AS patient_name, p.phone AS patient_phone, p.id AS patient_id,
                 p.email AS patient_email
          FROM appointments a
          LEFT JOIN users p ON a.patient_id = p.id
          WHERE a.doctor_id = ${parseInt(doctorId)}
            AND a.status = ${status}
          ORDER BY a.appointment_date, a.appointment_time
        `;
      }

      return rows;
    } catch (error) {
      logger.error('Error getting doctor appointments:', error);
      throw error;
    }
  }

  async getPatientAppointments(patientId, filters = {}) {
    try {
      let rows;
      if (filters.status) {
        rows = await prisma.$queryRaw`
          SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
                 a.created_at, a.updated_at,
                 d.name AS doctor_name, d.phone AS doctor_phone, d.id AS doctor_id,
                 dp.specialty, dp.department
          FROM appointments a
          LEFT JOIN users d ON a.doctor_id = d.id
          LEFT JOIN doctors dp ON d.id = dp.user_id
          WHERE a.patient_id = ${parseInt(patientId)}
            AND a.status = ${filters.status.toUpperCase()}
          ORDER BY a.appointment_date DESC, a.appointment_time DESC
        `;
      } else {
        rows = await prisma.$queryRaw`
          SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
                 a.created_at, a.updated_at,
                 d.name AS doctor_name, d.phone AS doctor_phone, d.id AS doctor_id,
                 dp.specialty, dp.department
          FROM appointments a
          LEFT JOIN users d ON a.doctor_id = d.id
          LEFT JOIN doctors dp ON d.id = dp.user_id
          WHERE a.patient_id = ${parseInt(patientId)}
          ORDER BY a.appointment_date DESC, a.appointment_time DESC
        `;
      }

      return rows;
    } catch (error) {
      logger.error('Error getting patient appointments:', error);
      throw error;
    }
  }

  async getTodayAppointments(userRole = null, userId = null) {
    try {
      const today = new Date().toISOString().split('T')[0];

      let rows;
      if (userRole === 'DOCTOR') {
        rows = await prisma.$queryRaw`
          SELECT a.id, a.appointment_time, a.status, a.reason,
                 p.name AS patient_name, p.phone AS patient_phone,
                 d.name AS doctor_name, dp.department, dp.specialty
          FROM appointments a
          LEFT JOIN users p ON a.patient_id = p.id
          LEFT JOIN users d ON a.doctor_id = d.id
          LEFT JOIN doctors dp ON d.id = dp.user_id
          WHERE DATE(a.appointment_date) = ${today}::date
            AND a.doctor_id = ${parseInt(userId)}
          ORDER BY a.appointment_time
        `;
      } else {
        rows = await prisma.$queryRaw`
          SELECT a.id, a.appointment_time, a.status, a.reason,
                 p.name AS patient_name, p.phone AS patient_phone,
                 d.name AS doctor_name, dp.department, dp.specialty
          FROM appointments a
          LEFT JOIN users p ON a.patient_id = p.id
          LEFT JOIN users d ON a.doctor_id = d.id
          LEFT JOIN doctors dp ON d.id = dp.user_id
          WHERE DATE(a.appointment_date) = ${today}::date
          ORDER BY a.appointment_time
        `;
      }

      return { appointments: rows, date: today };
    } catch (error) {
      logger.error('Error getting today appointments:', error);
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
               dp.specialty, dp.department
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
}

export default new AppointmentQueryService();
