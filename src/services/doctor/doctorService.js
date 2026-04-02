// src/services/doctor/doctorService.js
import prisma from '../../lib/prisma.js';
import { DOCTOR_CONFIG, DOCTOR_MESSAGES } from '../../config/doctorConfig.js';
import logger from '../../logging/logger.js';

export class DoctorService {
  // Get all doctors with filters
  async getAllDoctors(filters = {}) {
    try {
      const { page, limit, department, available, search } = filters;
      const pageNum = parseInt(page) || 1;
      const limitNum = parseInt(limit) || DOCTOR_CONFIG.PAGINATION.DEFAULT_LIMIT;
      const offset = (pageNum - 1) * limitNum;

      let rows;
      // Build parameterized queries for each filter combination
      if (department && available !== undefined && search) {
        const dep = department.toUpperCase();
        const searchPattern = `%${search}%`;
        rows = await prisma.$queryRaw`
          SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.registered_at,
                 d.specialization, d.department, d.experience_years, d.consultation_fee,
                 d.available_days, d.available_hours, d.is_available, d.bio, d.education,
                 d.qualifications, d.created_at as profile_created
          FROM users u
          LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR'
            AND UPPER(d.department) = ${dep}
            AND d.is_available = ${available}
            AND (u.name ILIKE ${searchPattern} OR d.specialization ILIKE ${searchPattern})
          ORDER BY u.name LIMIT ${limitNum} OFFSET ${offset}
        `;
      } else if (department && available !== undefined) {
        const dep = department.toUpperCase();
        rows = await prisma.$queryRaw`
          SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.registered_at,
                 d.specialization, d.department, d.experience_years, d.consultation_fee,
                 d.available_days, d.available_hours, d.is_available, d.bio, d.education,
                 d.qualifications, d.created_at as profile_created
          FROM users u
          LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR'
            AND UPPER(d.department) = ${dep}
            AND d.is_available = ${available}
          ORDER BY u.name LIMIT ${limitNum} OFFSET ${offset}
        `;
      } else if (department && search) {
        const dep = department.toUpperCase();
        const searchPattern = `%${search}%`;
        rows = await prisma.$queryRaw`
          SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.registered_at,
                 d.specialization, d.department, d.experience_years, d.consultation_fee,
                 d.available_days, d.available_hours, d.is_available, d.bio, d.education,
                 d.qualifications, d.created_at as profile_created
          FROM users u
          LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR'
            AND UPPER(d.department) = ${dep}
            AND (u.name ILIKE ${searchPattern} OR d.specialization ILIKE ${searchPattern})
          ORDER BY u.name LIMIT ${limitNum} OFFSET ${offset}
        `;
      } else if (available !== undefined && search) {
        const searchPattern = `%${search}%`;
        rows = await prisma.$queryRaw`
          SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.registered_at,
                 d.specialization, d.department, d.experience_years, d.consultation_fee,
                 d.available_days, d.available_hours, d.is_available, d.bio, d.education,
                 d.qualifications, d.created_at as profile_created
          FROM users u
          LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR'
            AND d.is_available = ${available}
            AND (u.name ILIKE ${searchPattern} OR d.specialization ILIKE ${searchPattern})
          ORDER BY u.name LIMIT ${limitNum} OFFSET ${offset}
        `;
      } else if (department) {
        const dep = department.toUpperCase();
        rows = await prisma.$queryRaw`
          SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.registered_at,
                 d.specialization, d.department, d.experience_years, d.consultation_fee,
                 d.available_days, d.available_hours, d.is_available, d.bio, d.education,
                 d.qualifications, d.created_at as profile_created
          FROM users u
          LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR' AND UPPER(d.department) = ${dep}
          ORDER BY u.name LIMIT ${limitNum} OFFSET ${offset}
        `;
      } else if (available !== undefined) {
        rows = await prisma.$queryRaw`
          SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.registered_at,
                 d.specialization, d.department, d.experience_years, d.consultation_fee,
                 d.available_days, d.available_hours, d.is_available, d.bio, d.education,
                 d.qualifications, d.created_at as profile_created
          FROM users u
          LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR' AND d.is_available = ${available}
          ORDER BY u.name LIMIT ${limitNum} OFFSET ${offset}
        `;
      } else if (search) {
        const searchPattern = `%${search}%`;
        rows = await prisma.$queryRaw`
          SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.registered_at,
                 d.specialization, d.department, d.experience_years, d.consultation_fee,
                 d.available_days, d.available_hours, d.is_available, d.bio, d.education,
                 d.qualifications, d.created_at as profile_created
          FROM users u
          LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR'
            AND (u.name ILIKE ${searchPattern} OR d.specialization ILIKE ${searchPattern})
          ORDER BY u.name LIMIT ${limitNum} OFFSET ${offset}
        `;
      } else {
        rows = await prisma.$queryRaw`
          SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.registered_at,
                 d.specialization, d.department, d.experience_years, d.consultation_fee,
                 d.available_days, d.available_hours, d.is_available, d.bio, d.education,
                 d.qualifications, d.created_at as profile_created
          FROM users u
          LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR'
          ORDER BY u.name LIMIT ${limitNum} OFFSET ${offset}
        `;
      }

      const countResult = await this.countDoctors(filters);

      return {
        doctors: rows,
        total: countResult,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(countResult / limitNum)
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

      let result;
      if (department && available !== undefined && search) {
        const dep = department.toUpperCase();
        const searchPattern = `%${search}%`;
        result = await prisma.$queryRaw`
          SELECT COUNT(*) FROM users u LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR'
            AND UPPER(d.department) = ${dep}
            AND d.is_available = ${available}
            AND (u.name ILIKE ${searchPattern} OR d.specialization ILIKE ${searchPattern})
        `;
      } else if (department && available !== undefined) {
        const dep = department.toUpperCase();
        result = await prisma.$queryRaw`
          SELECT COUNT(*) FROM users u LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR' AND UPPER(d.department) = ${dep} AND d.is_available = ${available}
        `;
      } else if (department && search) {
        const dep = department.toUpperCase();
        const searchPattern = `%${search}%`;
        result = await prisma.$queryRaw`
          SELECT COUNT(*) FROM users u LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR'
            AND UPPER(d.department) = ${dep}
            AND (u.name ILIKE ${searchPattern} OR d.specialization ILIKE ${searchPattern})
        `;
      } else if (available !== undefined && search) {
        const searchPattern = `%${search}%`;
        result = await prisma.$queryRaw`
          SELECT COUNT(*) FROM users u LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR'
            AND d.is_available = ${available}
            AND (u.name ILIKE ${searchPattern} OR d.specialization ILIKE ${searchPattern})
        `;
      } else if (department) {
        const dep = department.toUpperCase();
        result = await prisma.$queryRaw`
          SELECT COUNT(*) FROM users u LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR' AND UPPER(d.department) = ${dep}
        `;
      } else if (available !== undefined) {
        result = await prisma.$queryRaw`
          SELECT COUNT(*) FROM users u LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR' AND d.is_available = ${available}
        `;
      } else if (search) {
        const searchPattern = `%${search}%`;
        result = await prisma.$queryRaw`
          SELECT COUNT(*) FROM users u LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR'
            AND (u.name ILIKE ${searchPattern} OR d.specialization ILIKE ${searchPattern})
        `;
      } else {
        result = await prisma.$queryRaw`
          SELECT COUNT(*) FROM users u LEFT JOIN doctors d ON u.id = d.user_id WHERE u.role = 'DOCTOR'
        `;
      }
      return parseInt(result[0].count);
    } catch (error) {
      logger.error('Error counting doctors:', error);
      throw error;
    }
  }

  // Get doctor by ID or UID
  async getDoctorById(identifier) {
    try {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

      let rows;
      if (isUUID) {
        rows = await prisma.$queryRaw`
          SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.address,
                 u.birthday, u.profile_picture, u.registered_at,
                 d.specialization, d.department, d.experience_years, d.consultation_fee,
                 d.available_days, d.available_hours, d.is_available, d.bio, d.education,
                 d.qualifications, d.certifications, d.created_at as profile_created,
                 d.updated_at as profile_updated
          FROM users u
          LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.uid = ${identifier}::uuid AND u.role = 'DOCTOR'
        `;
      } else {
        const id = parseInt(identifier);
        rows = await prisma.$queryRaw`
          SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.address,
                 u.birthday, u.profile_picture, u.registered_at,
                 d.specialization, d.department, d.experience_years, d.consultation_fee,
                 d.available_days, d.available_hours, d.is_available, d.bio, d.education,
                 d.qualifications, d.certifications, d.created_at as profile_created,
                 d.updated_at as profile_updated
          FROM users u
          LEFT JOIN doctors d ON u.id = d.user_id
          WHERE u.id = ${id} AND u.role = 'DOCTOR'
        `;
      }

      return rows[0] || null;
    } catch (error) {
      logger.error('Error fetching doctor by ID:', error);
      throw error;
    }
  }

  // Get doctors by department
  async getDoctorsByDepartment(department, availableOnly = false) {
    try {
      let rows;
      if (availableOnly) {
        rows = await prisma.$queryRaw`
          SELECT u.id, u.uid, u.name, u.phone, u.email,
                 d.specialization, d.experience_years, d.consultation_fee, d.is_available,
                 d.available_days, d.available_hours, d.bio
          FROM users u
          JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR' AND UPPER(d.department) = UPPER(${department}) AND d.is_available = true
          ORDER BY d.is_available DESC, u.name
        `;
      } else {
        rows = await prisma.$queryRaw`
          SELECT u.id, u.uid, u.name, u.phone, u.email,
                 d.specialization, d.experience_years, d.consultation_fee, d.is_available,
                 d.available_days, d.available_hours, d.bio
          FROM users u
          JOIN doctors d ON u.id = d.user_id
          WHERE u.role = 'DOCTOR' AND UPPER(d.department) = UPPER(${department})
          ORDER BY d.is_available DESC, u.name
        `;
      }
      return rows;
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
      const todayPattern = `%${today}%`;

      const rows = await prisma.$queryRaw`
        SELECT u.id, u.uid, u.name, u.phone,
               d.specialization, d.department, d.consultation_fee,
               d.available_days, d.available_hours, d.bio
        FROM users u
        JOIN doctors d ON u.id = d.user_id
        WHERE u.role = 'DOCTOR'
          AND d.is_available = true
          AND (d.available_days IS NULL OR d.available_days LIKE ${todayPattern})
        ORDER BY d.department, u.name
      `;

      // Filter by current time
      const availableNow = rows.filter(doctor => {
        if (!doctor.available_hours) { return true; }
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
        currentTime: { day: today, hour: currentHour }
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
      const userCheck = await prisma.$queryRaw`
        SELECT id, role, name FROM users WHERE id = ${user_id}
      `;
      if (userCheck.length === 0) {
        throw new Error(DOCTOR_MESSAGES.NOT_FOUND);
      }
      if (userCheck[0].role !== 'DOCTOR') {
        throw new Error('User must have DOCTOR role');
      }

      // Check if profile already exists
      const existingProfile = await prisma.$queryRaw`
        SELECT user_id FROM doctors WHERE user_id = ${user_id}
      `;
      if (existingProfile.length > 0) {
        throw new Error(DOCTOR_MESSAGES.PROFILE_EXISTS);
      }

      const rows = await prisma.$queryRaw`
        INSERT INTO doctors (
          user_id, specialization, department, experience_years,
          consultation_fee, available_days, available_hours, bio, education,
          qualifications, is_available, created_at
        ) VALUES (
          ${user_id}, ${profileData.specialization}, ${profileData.department.toUpperCase()},
          ${profileData.experience_years || 0}, ${profileData.consultation_fee},
          ${profileData.available_days}, ${profileData.available_hours}, ${profileData.bio},
          ${profileData.education}, ${profileData.qualifications}, true, NOW()
        )
        RETURNING id, name, department, intro, image_url, is_active, created_at
      `;

      return {
        profile: rows[0],
        user_name: userCheck[0].name
      };
    } catch (error) {
      logger.error('Error creating doctor profile:', error);
      throw error;
    }
  }

  // Update doctor profile
  async updateDoctorProfile(id, updates) {
    try {
      const rows = await prisma.$queryRaw`
        UPDATE doctors SET
          specialization = COALESCE(${updates.specialization}, specialization),
          department = COALESCE(${updates.department}, department),
          experience_years = COALESCE(${updates.experience_years}, experience_years),
          consultation_fee = COALESCE(${updates.consultation_fee}, consultation_fee),
          bio = COALESCE(${updates.bio}, bio),
          education = COALESCE(${updates.education}, education),
          qualifications = COALESCE(${updates.qualifications}, qualifications),
          updated_at = NOW()
        WHERE user_id = ${id}
        RETURNING id, name, department, intro, image_url, is_active, created_at
      `;

      if (rows.length === 0) {
        throw new Error(DOCTOR_MESSAGES.NOT_FOUND);
      }
      return rows[0];
    } catch (error) {
      logger.error('Error updating doctor profile:', error);
      throw error;
    }
  }

  // Update doctor availability
  async updateDoctorAvailability(id, availabilityData) {
    try {
      const rows = await prisma.$queryRaw`
        UPDATE doctors SET
          is_available = COALESCE(${availabilityData.is_available}, is_available),
          available_days = COALESCE(${availabilityData.available_days}, available_days),
          available_hours = COALESCE(${availabilityData.available_hours}, available_hours),
          updated_at = NOW()
        WHERE user_id = ${id}
        RETURNING user_id, is_available, available_days, available_hours
      `;

      if (rows.length === 0) {
        throw new Error(DOCTOR_MESSAGES.NOT_FOUND);
      }
      return rows[0];
    } catch (error) {
      logger.error('Error updating doctor availability:', error);
      throw error;
    }
  }

  // Deactivate doctor profile
  async deactivateDoctor(id, reason) {
    try {
      // Check for active appointments
      const activeAppointments = await prisma.$queryRaw`
        SELECT COUNT(*) as count
        FROM appointments
        WHERE doctor_id = ${id} AND status = 'SCHEDULED' AND appointment_date >= CURRENT_DATE
      `;

      if (parseInt(activeAppointments[0].count) > 0) {
        throw new Error(`${DOCTOR_MESSAGES.ACTIVE_APPOINTMENTS}: ${activeAppointments[0].count} appointments`);
      }

      const rows = await prisma.$queryRaw`
        UPDATE doctors SET
          is_available = false,
          updated_at = NOW()
        WHERE user_id = ${id}
        RETURNING user_id
      `;

      if (rows.length === 0) {
        throw new Error(DOCTOR_MESSAGES.NOT_FOUND);
      }

      return { doctor_id: id, reason };
    } catch (error) {
      logger.error('Error deactivating doctor:', error);
      throw error;
    }
  }
}

export const doctorService = new DoctorService();
