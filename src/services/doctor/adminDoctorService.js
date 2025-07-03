// src/services/doctor/adminDoctorService.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { DOCTOR_CONFIG, DOCTOR_MESSAGES } from '../../config/doctorConfig.js';

export class AdminDoctorService {
  // Get doctor management overview
  async getDoctorOverview() {
    try {
      const [doctorStats, performanceMetrics, departmentDistribution] = await Promise.all([
        // Doctor statistics
        db.query(`
          SELECT 
            COUNT(*) as total_doctors,
            COUNT(CASE WHEN d.is_available = true THEN 1 END) as available_doctors,
            COUNT(CASE WHEN d.is_available = false THEN 1 END) as unavailable_doctors,
            COUNT(CASE WHEN u.registered_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as new_doctors_30d,
            AVG(d.experience_years) as avg_experience,
            AVG(d.consultation_fee) as avg_consultation_fee
          FROM users u
          JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR'
        `),
        
        // Performance metrics (last 30 days)
        db.query(`
          SELECT u.id, u.name, d.specialization, d.department,
                 COUNT(a.id) as total_appointments,
                 COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed_appointments,
                 COUNT(CASE WHEN a.status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
                 SUM(CASE WHEN a.status = 'COMPLETED' THEN d.consultation_fee ELSE 0 END) as revenue,
                 ROUND(AVG(CASE WHEN a.status = 'COMPLETED' THEN 5 ELSE 0 END), 2) as avg_rating
          FROM users u
          JOIN doctors d ON u.id = d.user_id
          LEFT JOIN appointments a ON u.id = a.doctor_id 
            AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
          WHERE u.role = 'DOCTOR'
          GROUP BY u.id, u.name, d.specialization, d.department, d.consultation_fee
          ORDER BY total_appointments DESC
          LIMIT 10
        `),
        
        // Department distribution
        db.query(`
          SELECT d.department, d.specialization,
                 COUNT(*) as doctor_count,
                 COUNT(CASE WHEN d.is_available = true THEN 1 END) as available_count,
                 AVG(d.consultation_fee) as avg_fee
          FROM doctors d
          GROUP BY d.department, d.specialization
          ORDER BY d.department, doctor_count DESC
        `)
      ]);
      
      return {
        statistics: doctorStats.rows[0],
        top_performers: performanceMetrics.rows,
        department_distribution: departmentDistribution.rows
      };
    } catch (error) {
      logger.error('Error fetching doctor overview:', error);
      throw error;
    }
  }

  // Get doctor management list with advanced filtering
  async getDoctorManagementList(filters = {}) {
    try {
      const {
        page = 1,
        limit = DOCTOR_CONFIG.PAGINATION.DEFAULT_LIMIT,
        department,
        specialization,
        status,
        experience_min,
        experience_max,
        search
      } = filters;
      
      const offset = (page - 1) * limit;
      
      let query = `
        SELECT u.id, u.uid, u.name, u.phone, u.email, u.gender, 
               TO_CHAR(u.registered_at, '${DOCTOR_CONFIG.DATE_FORMAT}') as registered_at,
               d.specialization, d.department, d.experience_years, d.consultation_fee,
               d.available_days, d.available_hours, d.is_available, d.bio,
               d.education, d.certifications,
               COUNT(a.id) as total_appointments,
               COUNT(CASE WHEN a.status = 'COMPLETED' AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as recent_appointments
        FROM users u
        JOIN doctors d ON u.id = d.user_id
        LEFT JOIN appointments a ON u.id = a.doctor_id
        WHERE u.role = 'DOCTOR'
      `;
      let params = [];
      
      if (department) {
        query += ' AND d.department = $' + (params.length + 1);
        params.push(department);
      }
      
      if (specialization) {
        query += ' AND d.specialization = $' + (params.length + 1);
        params.push(specialization);
      }
      
      if (status === 'available') {
        query += ' AND d.is_available = true';
      } else if (status === 'unavailable') {
        query += ' AND d.is_available = false';
      }
      
      if (experience_min) {
        query += ' AND d.experience_years >= $' + (params.length + 1);
        params.push(parseInt(experience_min));
      }
      
      if (experience_max) {
        query += ' AND d.experience_years <= $' + (params.length + 1);
        params.push(parseInt(experience_max));
      }
      
      if (search) {
        query += ` AND (u.name ILIKE $${params.length + 1} OR d.specialization ILIKE $${params.length + 1} OR d.department ILIKE $${params.length + 1})`;
        params.push(`%${search}%`);
      }
      
      query += ` GROUP BY u.id, u.uid, u.name, u.phone, u.email, u.gender, u.registered_at,
                 d.specialization, d.department, d.experience_years, d.consultation_fee,
                 d.available_days, d.available_hours, d.is_available, d.bio, d.education, d.certifications
                 ORDER BY u.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);
      
      const [doctors, total] = await Promise.all([
        db.query(query, params),
        this.countManagementDoctors(filters)
      ]);
      
      return {
        doctors: doctors.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrev: page > 1
        },
        filters
      };
    } catch (error) {
      logger.error('Error fetching doctor management list:', error);
      throw error;
    }
  }

  // Count doctors for management list
  async countManagementDoctors(filters) {
    try {
      const { department, specialization, status, experience_min, experience_max, search } = filters;
      
      let query = 'SELECT COUNT(*) FROM users u JOIN doctors d ON u.id = d.user_id WHERE u.role = \'DOCTOR\'';
      let params = [];
      
      if (department) {
        query += ' AND d.department = $' + (params.length + 1);
        params.push(department);
      }
      if (specialization) {
        query += ' AND d.specialization = $' + (params.length + 1);
        params.push(specialization);
      }
      if (status === 'available') {
        query += ' AND d.is_available = true';
      } else if (status === 'unavailable') {
        query += ' AND d.is_available = false';
      }
      if (experience_min) {
        query += ' AND d.experience_years >= $' + (params.length + 1);
        params.push(parseInt(experience_min));
      }
      if (experience_max) {
        query += ' AND d.experience_years <= $' + (params.length + 1);
        params.push(parseInt(experience_max));
      }
      if (search) {
        query += ` AND (u.name ILIKE $${params.length + 1} OR d.specialization ILIKE $${params.length + 1} OR d.department ILIKE $${params.length + 1})`;
        params.push(`%${search}%`);
      }
      
      const result = await db.query(query, params);
      return parseInt(result.rows[0].count);
    } catch (error) {
      logger.error('Error counting management doctors:', error);
      throw error;
    }
  }

  // Create comprehensive doctor account
  async createDoctorAccount(doctorData) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { phone } = doctorData;
      
      // Check if user already exists
      const existingUser = await client.query('SELECT id FROM users WHERE phone = $1', [phone]);
      if (existingUser.rows.length > 0) {
        throw new Error('User with this phone number already exists');
      }
      
      // Create user account
      const userResult = await client.query(`
        INSERT INTO users (phone, name, email, gender, address, birthday, role, registered_at)
        VALUES ($1, $2, $3, $4, $5, TO_DATE($6, 'DD-MM-YYYY'), 'DOCTOR', NOW())
        RETURNING *
      `, [
        phone,
        doctorData.name,
        doctorData.email,
        doctorData.gender,
        doctorData.address,
        doctorData.birthday
      ]);
      
      const userId = userResult.rows[0].id;
      
      // Create doctor profile
      const doctorResult = await client.query(`
        INSERT INTO doctors (
          user_id, specialization, department, experience_years, consultation_fee,
          available_days, available_hours, bio, education, certifications,
          is_available, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, NOW())
        RETURNING *
      `, [
        userId,
        doctorData.specialization,
        doctorData.department,
        doctorData.experience_years || 0,
        doctorData.consultation_fee,
        doctorData.available_days,
        doctorData.available_hours,
        doctorData.bio,
        doctorData.education,
        doctorData.certifications
      ]);
      
      await client.query('COMMIT');
      
      return {
        user: userResult.rows[0],
        doctor_profile: doctorResult.rows[0]
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating doctor account:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Bulk doctor operations
  async performBulkOperation(operation, doctorIds, data = {}) {
    try {
      const validOperations = ['activate', 'deactivate', 'update_fee', 'change_department', 'update_schedule'];
      if (!validOperations.includes(operation)) {
        throw new Error('Invalid operation');
      }
      
      let results = [];
      
      switch (operation) {
        case 'activate':
          const activateResult = await db.query(
            'UPDATE doctors SET is_available = true, updated_at = NOW() WHERE user_id = ANY($1) RETURNING user_id',
            [doctorIds]
          );
          results = activateResult.rows;
          break;
          
        case 'deactivate':
          const deactivateResult = await db.query(
            'UPDATE doctors SET is_available = false, updated_at = NOW() WHERE user_id = ANY($1) RETURNING user_id',
            [doctorIds]
          );
          
          // Cancel future appointments for deactivated doctors
          await db.query(`
            UPDATE appointments SET 
              status = 'CANCELLED',
              notes = COALESCE(notes || ' ', '') || 'Doctor deactivated by admin',
              updated_at = NOW()
            WHERE doctor_id = ANY($1) AND status = 'SCHEDULED' AND appointment_date > CURRENT_DATE
          `, [doctorIds]);
          
          results = deactivateResult.rows;
          break;
          
        case 'update_fee':
          if (!data.consultation_fee) {
            throw new Error('consultation_fee is required for update_fee operation');
          }
          const feeResult = await db.query(
            'UPDATE doctors SET consultation_fee = $1, updated_at = NOW() WHERE user_id = ANY($2) RETURNING user_id, consultation_fee',
            [data.consultation_fee, doctorIds]
          );
          results = feeResult.rows;
          break;
          
        case 'change_department':
          if (!data.department) {
            throw new Error('department is required for change_department operation');
          }
          const deptResult = await db.query(
            'UPDATE doctors SET department = $1, updated_at = NOW() WHERE user_id = ANY($2) RETURNING user_id, department',
            [data.department, doctorIds]
          );
          results = deptResult.rows;
          break;
          
        case 'update_schedule':
          if (!data.available_days || !data.available_hours) {
            throw new Error('available_days and available_hours are required for update_schedule operation');
          }
          const scheduleResult = await db.query(
            'UPDATE doctors SET available_days = $1, available_hours = $2, updated_at = NOW() WHERE user_id = ANY($3) RETURNING user_id, available_days, available_hours',
            [data.available_days, data.available_hours, doctorIds]
          );
          results = scheduleResult.rows;
          break;
      }
      
      return {
        operation,
        affected_doctors: results,
        count: results.length
      };
    } catch (error) {
      logger.error('Error performing bulk operation:', error);
      throw error;
    }
  }

  // Update doctor availability with appointment handling
  async updateDoctorAvailability(id, availabilityData) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { is_available, available_days, available_hours, reason } = availabilityData;
      
      const result = await client.query(`
        UPDATE doctors SET 
          is_available = $1,
          available_days = COALESCE($2, available_days),
          available_hours = COALESCE($3, available_hours),
          notes = COALESCE($4, notes),
          updated_at = NOW()
        WHERE user_id = $5
        RETURNING *
      `, [is_available, available_days, available_hours, reason, id]);
      
      if (result.rows.length === 0) {
        throw new Error(DOCTOR_MESSAGES.NOT_FOUND);
      }
      
      let affectedAppointments = [];
      
      // If making unavailable, update scheduled appointments
      if (!is_available) {
        const appointmentResult = await client.query(`
          UPDATE appointments SET 
            status = 'CANCELLED',
            notes = COALESCE(notes || ' ', '') || 'Doctor became unavailable: ' || COALESCE($1, 'Administrative decision'),
            updated_at = NOW()
          WHERE doctor_id = $2 AND status = 'SCHEDULED' AND appointment_date > CURRENT_DATE
          RETURNING id, appointment_date, appointment_time
        `, [reason, id]);
        
        affectedAppointments = appointmentResult.rows;
      }
      
      await client.query('COMMIT');
      
      return {
        doctor: result.rows[0],
        affected_appointments: affectedAppointments.length,
        cancelled_appointments: affectedAppointments
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating doctor availability:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Delete doctor account with appointment handling
  async deleteDoctorAccount(id, options = {}) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { reason, transfer_patients_to } = options;
      
      // Verify doctor exists
      const doctorCheck = await client.query(
        'SELECT u.name, d.department FROM users u JOIN doctors d ON u.id = d.user_id WHERE u.id = $1',
        [id]
      );
      
      if (doctorCheck.rows.length === 0) {
        throw new Error(DOCTOR_MESSAGES.NOT_FOUND);
      }
      
      // Check for future appointments
      const futureAppointments = await client.query(
        'SELECT COUNT(*) as count FROM appointments WHERE doctor_id = $1 AND status = $2 AND appointment_date > CURRENT_DATE',
        [id, 'SCHEDULED']
      );
      
      const futureCount = parseInt(futureAppointments.rows[0].count);
      
      if (futureCount > 0 && !transfer_patients_to) {
        throw new Error(`Doctor has ${futureCount} future appointments. Provide transfer_patients_to doctor ID or cancel appointments first`);
      }
      
      // Transfer or cancel future appointments
      if (futureCount > 0) {
        if (transfer_patients_to) {
          // Verify transfer target doctor exists
          const transferDoctor = await client.query(
            'SELECT name FROM users WHERE id = $1 AND role = $2',
            [transfer_patients_to, 'DOCTOR']
          );
          
          if (transferDoctor.rows.length === 0) {
            throw new Error('Transfer target doctor not found');
          }
          
          await client.query(`
            UPDATE appointments SET 
              doctor_id = $1,
              notes = COALESCE(notes || ' ', '') || 'Transferred due to doctor account deletion',
              updated_at = NOW()
            WHERE doctor_id = $2 AND status = 'SCHEDULED' AND appointment_date > CURRENT_DATE
          `, [transfer_patients_to, id]);
        } else {
          await client.query(`
            UPDATE appointments SET 
              status = 'CANCELLED',
              notes = COALESCE(notes || ' ', '') || 'Doctor account deleted: ' || COALESCE($1, 'Administrative decision'),
              updated_at = NOW()
            WHERE doctor_id = $2 AND status = 'SCHEDULED' AND appointment_date > CURRENT_DATE
          `, [reason, id]);
        }
      }
      
      // Soft delete: deactivate doctor
      await client.query(
        'UPDATE doctors SET is_available = false, updated_at = NOW() WHERE user_id = $1',
        [id]
      );
      
      await client.query('COMMIT');
      
      return {
        doctor: doctorCheck.rows[0],
        appointments_handled: {
          future_appointments: futureCount,
          action: transfer_patients_to ? 'transferred' : 'cancelled',
          transfer_to: transfer_patients_to || null
        },
        deletion_reason: reason
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error deleting doctor account:', error);
      throw error;
    } finally {
      client.release();
    }
  }
}

export const adminDoctorService = new AdminDoctorService();