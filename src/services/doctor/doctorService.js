// src/services/doctor/doctorService.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { DOCTOR_CONFIG, DOCTOR_MESSAGES } from '../../config/doctorConfig.js';

export class DoctorService {
  // Get all doctors with filters
  async getAllDoctors(filters = {}) {
    try {
      const { page, limit, department, available, search } = filters;
      const offset = ((page || 1) - 1) * (limit || DOCTOR_CONFIG.PAGINATION.DEFAULT_LIMIT);
      
      let query = `
        SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.registered_at,
               d.specialization, d.department, d.experience_years, d.consultation_fee,
               d.available_days, d.available_hours, d.is_available, d.bio, d.education,
               d.qualifications, d.created_at as profile_created
        FROM users u 
        LEFT JOIN doctors d ON u.id = d.user_id 
        WHERE u.role = 'DOCTOR'
      `;
      let params = [];
      
      if (department) {
        query += ' AND UPPER(d.department) = UPPER($' + (params.length + 1) + ')';
        params.push(department);
      }
      
      if (available !== undefined) {
        query += ' AND d.is_available = $' + (params.length + 1);
        params.push(available);
      }
      
      if (search) {
        query += ` AND (u.name ILIKE $${params.length + 1} OR d.specialization ILIKE $${params.length + 1})`;
        params.push(`%${search}%`);
      }
      
      query += ' ORDER BY u.name LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
      params.push(limit || DOCTOR_CONFIG.PAGINATION.DEFAULT_LIMIT, offset);
      
      const [doctors, countResult] = await Promise.all([
        db.query(query, params),
        this.countDoctors(filters)
      ]);
      
      return {
        doctors: doctors.rows,
        total: countResult,
        page: page || 1,
        limit: limit || DOCTOR_CONFIG.PAGINATION.DEFAULT_LIMIT,
        totalPages: Math.ceil(countResult / (limit || DOCTOR_CONFIG.PAGINATION.DEFAULT_LIMIT))
      };
    } catch (error) {
      logger.error('Error fetching doctors:', error);
      throw error;
    }
  }

  // Count doctors with filters
  async countDoctors(filters = {}) {
    try {
      const { department, available, search } = filters;
      
      let query = 'SELECT COUNT(*) FROM users u LEFT JOIN doctors d ON u.id = d.user_id WHERE u.role = \'DOCTOR\'';
      let params = [];
      
      if (department) {
        query += ' AND UPPER(d.department) = UPPER($' + (params.length + 1) + ')';
        params.push(department);
      }
      
      if (available !== undefined) {
        query += ' AND d.is_available = $' + (params.length + 1);
        params.push(available);
      }
      
      if (search) {
        query += ` AND (u.name ILIKE $${params.length + 1} OR d.specialization ILIKE $${params.length + 1})`;
        params.push(`%${search}%`);
      }
      
      const result = await db.query(query, params);
      return parseInt(result.rows[0].count);
    } catch (error) {
      logger.error('Error counting doctors:', error);
      throw error;
    }
  }

  // Get doctor by ID or UID
  async getDoctorById(identifier) {
    try {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
      const column = isUUID ? 'u.uid' : 'u.id';
      
      const result = await db.query(`
        SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.address, 
               u.birthday, u.profile_picture, u.registered_at,
               d.specialization, d.department, d.experience_years, d.consultation_fee,
               d.available_days, d.available_hours, d.is_available, d.bio, d.education,
               d.qualifications, d.certifications, d.created_at as profile_created, 
               d.updated_at as profile_updated
        FROM users u 
        LEFT JOIN doctors d ON u.id = d.user_id 
        WHERE ${column} = $1 AND u.role = 'DOCTOR'
      `, [identifier]);
      
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error fetching doctor by ID:', error);
      throw error;
    }
  }

  // Get doctors by department
  async getDoctorsByDepartment(department, availableOnly = false) {
    try {
      let query = `
        SELECT u.id, u.uid, u.name, u.phone, u.email,
               d.specialization, d.experience_years, d.consultation_fee, d.is_available,
               d.available_days, d.available_hours, d.bio
        FROM users u 
        JOIN doctors d ON u.id = d.user_id 
        WHERE u.role = 'DOCTOR' AND UPPER(d.department) = UPPER($1)
      `;
      let params = [department];
      
      if (availableOnly) {
        query += ' AND d.is_available = true';
      }
      
      query += ' ORDER BY d.is_available DESC, u.name';
      
      const result = await db.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error('Error fetching doctors by department:', error);
      throw error;
    }
  }

  // Get available doctors
  async getAvailableDoctors() {
    try {
      const today = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
      const currentHour = new Date().getHours();
      
      const result = await db.query(`
        SELECT u.id, u.uid, u.name, u.phone,
               d.specialization, d.department, d.consultation_fee,
               d.available_days, d.available_hours, d.bio
        FROM users u 
        JOIN doctors d ON u.id = d.user_id 
        WHERE u.role = 'DOCTOR' 
          AND d.is_available = true
          AND (d.available_days IS NULL OR d.available_days LIKE '%' || $1 || '%')
        ORDER BY d.department, u.name
      `, [today]);
      
      // Filter by current time
      const availableNow = result.rows.filter(doctor => {
        if (!doctor.available_hours) return true;
        
        try {
          const hours = doctor.available_hours.split('-');
          const startHour = parseInt(hours[0]);
          const endHour = parseInt(hours[1]);
          return currentHour >= startHour && currentHour <= endHour;
        } catch {
          return true;
        }
      });
      
      return {
        doctors: availableNow,
        currentTime: {
          day: today,
          hour: currentHour
        }
      };
    } catch (error) {
      logger.error('Error fetching available doctors:', error);
      throw error;
    }
  }

  // Create doctor profile
  async createDoctorProfile(profileData) {
    try {
      const { user_id } = profileData;
      
      // Check if user exists and is a doctor
      const userCheck = await db.query(
        'SELECT id, role, name FROM users WHERE id = $1',
        [user_id]
      );
      
      if (userCheck.rows.length === 0) {
        throw new Error(DOCTOR_MESSAGES.NOT_FOUND);
      }
      
      if (userCheck.rows[0].role !== 'DOCTOR') {
        throw new Error('User must have DOCTOR role');
      }
      
      // Check if profile already exists
      const existingProfile = await db.query(
        'SELECT user_id FROM doctors WHERE user_id = $1',
        [user_id]
      );
      
      if (existingProfile.rows.length > 0) {
        throw new Error(DOCTOR_MESSAGES.PROFILE_EXISTS);
      }
      
      // Create profile
      const result = await db.query(`
        INSERT INTO doctors (
          user_id, specialization, department, experience_years, 
          consultation_fee, available_days, available_hours, bio, education,
          qualifications, is_available, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, NOW())
        RETURNING *
      `, [
        user_id,
        profileData.specialization,
        profileData.department.toUpperCase(),
        profileData.experience_years || 0,
        profileData.consultation_fee,
        profileData.available_days,
        profileData.available_hours,
        profileData.bio,
        profileData.education,
        profileData.qualifications
      ]);
      
      return {
        profile: result.rows[0],
        user_name: userCheck.rows[0].name
      };
    } catch (error) {
      logger.error('Error creating doctor profile:', error);
      throw error;
    }
  }

  // Update doctor profile
  async updateDoctorProfile(id, updates) {
    try {
      const result = await db.query(`
        UPDATE doctors SET 
          specialization = COALESCE($1, specialization),
          department = COALESCE($2, department),
          experience_years = COALESCE($3, experience_years),
          consultation_fee = COALESCE($4, consultation_fee),
          bio = COALESCE($5, bio),
          education = COALESCE($6, education),
          qualifications = COALESCE($7, qualifications),
          updated_at = NOW()
        WHERE user_id = $8
        RETURNING *
      `, [
        updates.specialization,
        updates.department?.toUpperCase(),
        updates.experience_years,
        updates.consultation_fee,
        updates.bio,
        updates.education,
        updates.qualifications,
        id
      ]);
      
      if (result.rows.length === 0) {
        throw new Error(DOCTOR_MESSAGES.NOT_FOUND);
      }
      
      return result.rows[0];
    } catch (error) {
      logger.error('Error updating doctor profile:', error);
      throw error;
    }
  }

  // Update doctor availability
  async updateDoctorAvailability(id, availabilityData) {
    try {
      const result = await db.query(`
        UPDATE doctors SET 
          is_available = COALESCE($1, is_available),
          available_days = COALESCE($2, available_days),
          available_hours = COALESCE($3, available_hours),
          updated_at = NOW()
        WHERE user_id = $4
        RETURNING user_id, is_available, available_days, available_hours
      `, [
        availabilityData.is_available,
        availabilityData.available_days,
        availabilityData.available_hours,
        id
      ]);
      
      if (result.rows.length === 0) {
        throw new Error(DOCTOR_MESSAGES.NOT_FOUND);
      }
      
      return result.rows[0];
    } catch (error) {
      logger.error('Error updating doctor availability:', error);
      throw error;
    }
  }

  // Deactivate doctor profile
  async deactivateDoctor(id, reason) {
    try {
      // Check for active appointments
      const activeAppointments = await db.query(`
        SELECT COUNT(*) as count 
        FROM appointments 
        WHERE doctor_id = $1 AND status = 'SCHEDULED' AND appointment_date >= CURRENT_DATE
      `, [id]);
      
      if (parseInt(activeAppointments.rows[0].count) > 0) {
        throw new Error(`${DOCTOR_MESSAGES.ACTIVE_APPOINTMENTS}: ${activeAppointments.rows[0].count} appointments`);
      }
      
      const result = await db.query(`
        UPDATE doctors SET 
          is_available = false,
          updated_at = NOW()
        WHERE user_id = $1
        RETURNING user_id
      `, [id]);
      
      if (result.rows.length === 0) {
        throw new Error(DOCTOR_MESSAGES.NOT_FOUND);
      }
      
      return {
        doctor_id: id,
        reason
      };
    } catch (error) {
      logger.error('Error deactivating doctor:', error);
      throw error;
    }
  }
}

export const doctorService = new DoctorService();