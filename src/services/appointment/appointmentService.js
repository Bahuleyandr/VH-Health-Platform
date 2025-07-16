import { APPOINTMENT_CONFIG, APPOINTMENT_QUERIES } from '../../config/appointmentConfig.js';
import db from '../../config/database.js';
import logger from '../../logging/logger.js';

export class AppointmentService {
  // Check if user exists and has correct role
  async validateUser(userId, requiredRole = null) {
    try {
      let query = 'SELECT id, name, role FROM users WHERE id = $1';
      const params = [userId];
      
      if (requiredRole) {
        query += ' AND role = $2';
        params.push(requiredRole);
      }
      
      const result = await db.query(query, params);
      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
      logger.error('Error validating user:', error);
      throw error;
    }
  }

  // Check for appointment conflicts
  async checkConflict(doctorId, appointmentDate, appointmentTime, excludeId = null) {
    try {
      let query = `
        SELECT id FROM appointments 
        WHERE doctor_id = $1 AND appointment_date = $2 AND appointment_time = $3 
        AND status = $4
      `;
      const params = [doctorId, appointmentDate, appointmentTime, APPOINTMENT_CONFIG.STATUSES.SCHEDULED];
      
      if (excludeId) {
        query += ' AND id != $5';
        params.push(excludeId);
      }
      
      const result = await db.query(query, params);
      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
      logger.error('Error checking appointment conflict:', error);
      throw error;
    }
  }

  // Create new appointment
  async createAppointment(appointmentData) {
    const { patient_id, doctor_id, appointment_date, appointment_time, reason, notes = null } = appointmentData;
    
    try {
      const result = await db.query(`
        INSERT INTO appointments (
          patient_id, doctor_id, appointment_date, appointment_time, 
          reason, notes, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        RETURNING *
      `, [patient_id, doctor_id, appointment_date, appointment_time, reason, notes, APPOINTMENT_CONFIG.STATUSES.SCHEDULED]);
      
      return result.rows[0];
    } catch (error) {
      logger.error('Error creating appointment:', error);
      throw error;
    }
  }

  // Update appointment
  async updateAppointment(id, updateData) {
    const { appointment_date, appointment_time, reason, notes } = updateData;
    
    try {
      const result = await db.query(`
        UPDATE appointments SET 
          appointment_date = COALESCE($1, appointment_date),
          appointment_time = COALESCE($2, appointment_time),
          reason = COALESCE($3, reason),
          notes = COALESCE($4, notes),
          updated_at = NOW()
        WHERE id = $5
        RETURNING *
      `, [appointment_date, appointment_time, reason, notes, id]);
      
      return result.rows[0];
    } catch (error) {
      logger.error('Error updating appointment:', error);
      throw error;
    }
  }

  // Update appointment status
  async updateAppointmentStatus(id, status, notes = null, updatedBy = null) {
    try {
      const result = await db.query(`
        UPDATE appointments SET 
          status = $1,
          notes = CASE 
            WHEN $2 IS NOT NULL THEN COALESCE(notes || ' | ', '') || $2
            ELSE notes
          END,
          updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `, [status, notes, id]);
      
      return result.rows[0];
    } catch (error) {
      logger.error('Error updating appointment status:', error);
      throw error;
    }
  }

  // Get appointment by ID
  async getAppointmentById(id) {
    try {
      const result = await db.query(
        APPOINTMENT_QUERIES.APPOINTMENT_DETAIL + ' WHERE a.id = $1',
        [id]
      );
      
      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
      logger.error('Error getting appointment by ID:', error);
      throw error;
    }
  }

  // Cancel appointment
  async cancelAppointment(id, cancelledBy) {
    try {
      const note = `Cancelled by ${cancelledBy}`;
      return await this.updateAppointmentStatus(id, APPOINTMENT_CONFIG.STATUSES.CANCELLED, note);
    } catch (error) {
      logger.error('Error cancelling appointment:', error);
      throw error;
    }
  }
}

export default new AppointmentService();