import db from '../../config/database.js';
import { APPOINTMENT_CONFIG, APPOINTMENT_QUERIES } from '../../config/appointmentConfig.js';
import logger from '../../logging/logger.js';
import { buildPaginationMeta } from '../../utils/appointment/appointmentHelpers.js';

export class AppointmentQueryService {
  // Build filter conditions for queries
  buildFilterConditions(filters, params = [], startIndex = 1) {
    let conditions = [];
    let currentIndex = startIndex;

    if (filters.status) {
      conditions.push(`a.status = $${currentIndex}`);
      params.push(filters.status.toUpperCase());
      currentIndex++;
    }

    if (filters.doctor_id) {
      conditions.push(`a.doctor_id = $${currentIndex}`);
      params.push(filters.doctor_id);
      currentIndex++;
    }

    if (filters.patient_id) {
      conditions.push(`a.patient_id = $${currentIndex}`);
      params.push(filters.patient_id);
      currentIndex++;
    }

    if (filters.date) {
      conditions.push(`DATE(a.appointment_date) = $${currentIndex}`);
      params.push(filters.date);
      currentIndex++;
    }

    return { conditions, params, nextIndex: currentIndex };
  }

  // Get appointments with filters and pagination
  async getAppointments(filters = {}, pagination = {}, userRole = null, userId = null) {
    try {
      const page = pagination.page || APPOINTMENT_CONFIG.DEFAULT_PAGINATION.PAGE;
      const limit = pagination.limit || APPOINTMENT_CONFIG.DEFAULT_PAGINATION.LIMIT;
      const offset = (page - 1) * limit;

      let query = APPOINTMENT_QUERIES.LIST_ALL + ' WHERE 1=1';
      let params = [];
      let paramIndex = 1;

      // Apply role-based filtering
      if (userRole === 'DOCTOR') {
        query += ` AND a.doctor_id = $${paramIndex}`;
        params.push(userId);
        paramIndex++;
      }

      // Apply filters
      const { conditions, params: filterParams, nextIndex } = this.buildFilterConditions(
        filters,
        params,
        paramIndex
      );

      if (conditions.length > 0) {
        query += ' AND ' + conditions.join(' AND ');
      }

      // Add ordering and pagination
      query += ` ORDER BY a.appointment_date, a.appointment_time LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`;
      filterParams.push(limit, offset);

      const result = await db.query(query, filterParams);

      // Get total count
      const countQuery = `
        SELECT COUNT(*) FROM appointments a 
        WHERE 1=1 ${userRole === 'DOCTOR' ? `AND a.doctor_id = $1` : ''} 
        ${conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : ''}
      `;
      const countParams = userRole === 'DOCTOR' ? [userId, ...params.slice(1)] : params;
      const countResult = await db.query(countQuery, countParams.slice(0, -2)); // Remove limit and offset

      const total = parseInt(countResult.rows[0].count);

      return {
        appointments: result.rows,
        pagination: buildPaginationMeta(page, limit, total),
        filters
      };
    } catch (error) {
      logger.error('Error getting appointments:', error);
      throw error;
    }
  }

  // Get doctor appointments
  async getDoctorAppointments(doctorId, filters = {}) {
    try {
      let query = `
        SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
               p.name as patient_name, p.phone as patient_phone, p.id as patient_id,
               p.email as patient_email
        FROM appointments a
        LEFT JOIN users p ON a.patient_id = p.id
        WHERE a.doctor_id = $1
      `;
      let params = [doctorId];
      let paramIndex = 2;

      const status = filters.status || APPOINTMENT_CONFIG.STATUSES.SCHEDULED;
      query += ` AND a.status = $${paramIndex}`;
      params.push(status.toUpperCase());
      paramIndex++;

      if (filters.date) {
        query += ` AND DATE(a.appointment_date) = $${paramIndex}`;
        params.push(filters.date);
      }

      query += ' ORDER BY a.appointment_date, a.appointment_time';

      const result = await db.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error('Error getting doctor appointments:', error);
      throw error;
    }
  }

  // Get patient appointments
  async getPatientAppointments(patientId, filters = {}) {
    try {
      let query = `
        SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
               a.created_at, a.updated_at,
               d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
               dp.specialization, dp.department, dp.consultation_fee
        FROM appointments a
        LEFT JOIN users d ON a.doctor_id = d.id
        LEFT JOIN doctors dp ON d.id = dp.user_id
        WHERE a.patient_id = $1
      `;
      let params = [patientId];

      if (filters.status) {
        query += ' AND a.status = $2';
        params.push(filters.status.toUpperCase());
      }

      query += ' ORDER BY a.appointment_date DESC, a.appointment_time DESC';

      const result = await db.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error('Error getting patient appointments:', error);
      throw error;
    }
  }

  // Get today's appointments
  async getTodayAppointments(userRole = null, userId = null) {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      let query = `
        SELECT a.id, a.appointment_time, a.status, a.reason,
               p.name as patient_name, p.phone as patient_phone,
               d.name as doctor_name, dp.department, dp.specialization
        FROM appointments a
        LEFT JOIN users p ON a.patient_id = p.id
        LEFT JOIN users d ON a.doctor_id = d.id
        LEFT JOIN doctors dp ON d.id = dp.user_id
        WHERE DATE(a.appointment_date) = $1
      `;
      let params = [today];

      if (userRole === 'DOCTOR') {
        query += ' AND a.doctor_id = $2';
        params.push(userId);
      }

      query += ' ORDER BY a.appointment_time';

      const result = await db.query(query, params);
      return {
        appointments: result.rows,
        date: today
      };
    } catch (error) {
      logger.error('Error getting today appointments:', error);
      throw error;
    }
  }
}

export default new AppointmentQueryService();