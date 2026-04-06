// src/services/doctor/adminDoctorService.js
import db from '../../config/database.js';
import { DOCTOR_CONFIG, DOCTOR_MESSAGES } from '../../config/doctorConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

export class AdminDoctorService {
  // Get doctor management overview
  async getDoctorOverview() {
    try {
      const [doctorStats, performanceMetrics, departmentDistribution] = await Promise.all([
        // Doctor statistics
        prisma.$queryRawUnsafe(`
          SELECT 
            COUNT(*) as total_doctors,
            COUNT(CASE WHEN d.is_available = true THEN 1 END) as available_doctors,
            COUNT(CASE WHEN d.is_available = false THEN 1 END) as unavailable_doctors,
            COUNT(CASE WHEN d.created_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as new_doctors_30d,
            AVG(d.experience_years) as avg_experience,
            AVG(d.consultation_fee) as avg_consultation_fee
          FROM doctors d
          WHERE d.is_active = true
        `),
        
        // Performance metrics (last 30 days)
        prisma.$queryRawUnsafe(`
          SELECT d.id, COALESCE(u.name, d.name) as name,
                 d.specialization as specialization, d.department,
                 COUNT(a.id) as total_appointments,
                 COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed_appointments,
                 COUNT(CASE WHEN a.status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
                 0 as revenue,
                 0 as avg_rating
          FROM doctors d
          LEFT JOIN users u ON u.id = d.user_id AND u.role = 'DOCTOR'
          LEFT JOIN appointments a ON a.doctor_id = COALESCE(d.user_id, d.id)
            AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
          WHERE d.is_active = true
          GROUP BY d.id, u.name, d.name, d.specialization, d.department
          ORDER BY total_appointments DESC
          LIMIT 10
        `),
        
        // Department distribution
        prisma.$queryRawUnsafe(`
          SELECT d.department, d.specialization as specialization,
                 COUNT(*) as doctor_count,
                 COUNT(CASE WHEN d.is_available = true THEN 1 END) as available_count,
                 0 as avg_fee
          FROM doctors d
          WHERE d.is_active = true
          GROUP BY d.department, d.specialization
          ORDER BY d.department, doctor_count DESC
        `)
      ]);
      
      return {
        statistics: doctorStats[0],
        top_performers: performanceMetrics,
        department_distribution: departmentDistribution
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
      
      // Drive from doctors table so standalone doctors (no user_id) are included
      let query = `
        SELECT
          d.id,
          COALESCE(u.id, d.user_id) as user_id,
          COALESCE(u.name, d.name) as name,
          u.phone, u.email, u.gender,
          TO_CHAR(COALESCE(u.registered_at, d.created_at), 'DD-MM-YYYY') as registered_at,
          d.specialization as specialization,
          d.department,
          NULL::int as experience_years,
          NULL::numeric as consultation_fee,
          NULL as available_days, NULL as available_hours, d.is_available,
          NULL as bio, NULL as education, NULL as certifications,
          COUNT(a.id) as total_appointments,
          COUNT(CASE WHEN a.status = 'COMPLETED' AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as recent_appointments
        FROM doctors d
        LEFT JOIN users u ON u.id = d.user_id AND u.role = 'DOCTOR'
        LEFT JOIN appointments a ON a.doctor_id = COALESCE(u.id, d.user_id)
        WHERE d.is_active = true
      `;
      const params = [];
      
      if (department) {
        query += ' AND d.department = $' + (params.length + 1);
        params.push(department);
      }
      
      if (specialization) {
        query += ` AND d.specialization ILIKE $${params.length + 1}`;
        params.push(`%${specialization}%`);
      }
      
      if (status === 'available') {
        query += ' AND d.is_available = true';
      } else if (status === 'unavailable') {
        query += ' AND d.is_available = false';
      }
      
      if (search) {
        query += ` AND (COALESCE(u.name, d.name) ILIKE $${params.length + 1} OR d.specialization ILIKE $${params.length + 1} OR d.department ILIKE $${params.length + 1})`;
        params.push(`%${search}%`);
      }
      
      query += ` GROUP BY d.id, u.id, u.name, u.phone, u.email, u.gender, u.registered_at,
                 d.name, d.specialization, d.department, d.is_available, d.created_at
                 ORDER BY COALESCE(u.name, d.name) LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);
      
      const [doctors, total] = await Promise.all([
        prisma.$queryRawUnsafe(query, params),
        this.countManagementDoctors(filters)
      ]);
      
      return {
        doctors: doctors,
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
      
      let query = 'SELECT COUNT(*) FROM doctors d LEFT JOIN users u ON u.id = d.user_id AND u.role = \'DOCTOR\' WHERE d.is_active = true';
      const params = [];
      
      if (department) {
        query += ' AND d.department = $' + (params.length + 1);
        params.push(department);
      }
      if (specialization) {
        query += ` AND d.specialization ILIKE $${params.length + 1}`;
        params.push(`%${specialization}%`);
      }
      if (status === 'available') {
        query += ' AND d.is_available = true';
      } else if (status === 'unavailable') {
        query += ' AND d.is_available = false';
      }
      if (search) {
        query += ` AND (COALESCE(u.name, d.name) ILIKE $${params.length + 1} OR d.specialization ILIKE $${params.length + 1} OR d.department ILIKE $${params.length + 1})`;
        params.push(`%${search}%`);
      }
      
      const result = await prisma.$queryRawUnsafe(query, params);
      return parseInt(result[0].count);
    } catch (error) {
      logger.error('Error counting management doctors:', error);
      throw error;
    }
  }

  // Create comprehensive doctor account
  async createDoctorAccount(doctorData) {
    try {
      const { name, department, specialization, phone, email, consultation_fee } = doctorData;

      // Check if doctor with same name+department already exists
      const existing = await prisma.$queryRaw`
        SELECT id FROM doctors WHERE LOWER(name) = LOWER(${name}) AND LOWER(department) = LOWER(${department})
      `;
      if (existing.length > 0) {
        throw new Error('Doctor with this name already exists in this department');
      }

      // Insert doctor record using actual table schema
      const rows = await prisma.$queryRaw`
        INSERT INTO doctors (name, department, specialty, intro, is_available, is_active, created_at, updated_at)
        VALUES (
          ${name},
          ${department},
          ${specialization || null},
          ${doctorData.intro || null},
          true,
          true,
          NOW(),
          NOW()
        )
        RETURNING id, name, department, specialty, intro, image_url, is_available, is_active, created_at
      `;

      logger.info(`Doctor created: ${name} (${department})`);

      return {
        user: { name, phone: phone || null, email: email || null },
        doctor_profile: rows[0]
      };
    } catch (error) {
      logger.error('Error creating doctor account:', error);
      throw error;
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
      case 'activate': {
        const activateResult = await prisma.$queryRawUnsafe(
          'UPDATE doctors SET is_available = true, updated_at = NOW() WHERE user_id = ANY($1) RETURNING user_id',
          [doctorIds]
        );
        results = activateResult;
        break;
      }
        
      case 'deactivate': {
        const deactivateResult = await prisma.$queryRawUnsafe(
          'UPDATE doctors SET is_available = false, updated_at = NOW() WHERE user_id = ANY($1) RETURNING user_id',
          [doctorIds]
        );
        
        // Cancel future appointments for deactivated doctors
        await prisma.$queryRawUnsafe(`
          UPDATE appointments SET 
            status = 'CANCELLED',
            notes = COALESCE(notes || ' ', '') || 'Doctor deactivated by admin',
            updated_at = NOW()
          WHERE doctor_id = ANY($1) AND status = 'SCHEDULED' AND appointment_date > CURRENT_DATE
        `, [doctorIds]);
        
        results = deactivateResult;
        break;
      }
        
      case 'update_fee': {
        if (!data.consultation_fee) {
          throw new Error('consultation_fee is required for update_fee operation');
        }
        const feeResult = await prisma.$queryRawUnsafe(
          'UPDATE doctors SET consultation_fee = $1, updated_at = NOW() WHERE user_id = ANY($2) RETURNING user_id, consultation_fee',
          [data.consultation_fee, doctorIds]
        );
        results = feeResult;
        break;
      }
        
      case 'change_department': {
        if (!data.department) {
          throw new Error('department is required for change_department operation');
        }
        const deptResult = await prisma.$queryRawUnsafe(
          'UPDATE doctors SET department = $1, updated_at = NOW() WHERE user_id = ANY($2) RETURNING user_id, department',
          [data.department, doctorIds]
        );
        results = deptResult;
        break;
      }
        
      case 'update_schedule': {
        if (!data.available_days || !data.available_hours) {
          throw new Error('available_days and available_hours are required for update_schedule operation');
        }
        const scheduleResult = await prisma.$queryRawUnsafe(
          'UPDATE doctors SET available_days = $1, available_hours = $2, updated_at = NOW() WHERE user_id = ANY($3) RETURNING user_id, available_days, available_hours',
          [data.available_days, data.available_hours, doctorIds]
        );
        results = scheduleResult;
        break;
      }
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
          updated_at = NOW()
        WHERE user_id = $2
        RETURNING id, user_id, specialty as specialization, department, is_available, created_at, updated_at
      `, [is_available, id]);
      
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