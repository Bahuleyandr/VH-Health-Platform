// src/services/doctor/doctorService.js
import { DOCTOR_CONFIG, DOCTOR_MESSAGES } from '../../config/doctorConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

export class DoctorService {
  async getDoctorSchema() {
    if (this._doctorSchema) {
      return this._doctorSchema;
    }

    const rows = await prisma.$queryRaw`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'doctors'
    `;

    const columns = new Set(rows.map((row) => row.column_name));
    this._doctorSchema = {
      specialization: columns.has('specialization')
        ? 'specialization'
        : columns.has('specialty')
          ? 'specialty'
          : null,
      bio: columns.has('bio')
        ? 'bio'
        : columns.has('intro')
          ? 'intro'
          : null,
      experienceYears: columns.has('experience_years'),
      consultationFee: columns.has('consultation_fee'),
      availableDays: columns.has('available_days'),
      availableHours: columns.has('available_hours'),
      qualifications: columns.has('qualifications'),
      education: columns.has('education'),
      certifications: columns.has('certifications'),
      isAvailable: columns.has('is_available'),
      createdAt: columns.has('created_at'),
      updatedAt: columns.has('updated_at'),
      department: columns.has('department'),
    };

    return this._doctorSchema;
  }

  // Variant that drives from doctors table (handles doctors with no user_id)
  buildDoctorSelectFieldsFromDoctors(schema, { detailed = false } = {}) {
    const fields = [
      'd.id',
      'COALESCE(u.id, d.user_id) AS user_id',
      'u.uid',
      'u.phone',
      'COALESCE(u.name, d.name) AS name',
      'u.email',
      'u.gender',
      'u.registered_at',
      schema.specialization
        ? `d.${schema.specialization} AS specialization`
        : 'NULL::text AS specialization',
      schema.department
        ? 'd.department'
        : 'NULL::text AS department',
      schema.experienceYears
        ? 'd.experience_years'
        : 'NULL::integer AS experience_years',
      schema.consultationFee
        ? 'd.consultation_fee'
        : 'NULL::numeric AS consultation_fee',
      schema.availableDays
        ? 'd.available_days'
        : 'NULL::text[] AS available_days',
      schema.availableHours
        ? 'd.available_hours'
        : 'NULL::jsonb AS available_hours',
      schema.isAvailable
        ? 'd.is_available'
        : 'NULL::boolean AS is_available',
      schema.bio
        ? `d.${schema.bio} AS bio`
        : 'NULL::text AS bio',
      schema.education
        ? 'd.education'
        : 'NULL::text AS education',
      schema.qualifications
        ? 'd.qualifications'
        : 'NULL::text[] AS qualifications',
      schema.createdAt
        ? 'd.created_at AS profile_created'
        : 'NULL::timestamp AS profile_created',
    ];

    if (detailed) {
      fields.push(
        'u.address',
        'u.birthday',
        'u.profile_picture',
        schema.certifications
          ? 'd.certifications'
          : 'NULL::text[] AS certifications',
        schema.updatedAt
          ? 'd.updated_at AS profile_updated'
          : 'NULL::timestamp AS profile_updated',
      );
    }

    return fields.join(',\n                 ');
  }

  buildDoctorSelectFields(schema, { detailed = false } = {}) {
    const fields = [
      'u.id',
      'u.uid',
      'u.phone',
      'u.name',
      'u.email',
      'u.gender',
      'u.registered_at',
      schema.specialization
        ? `d.${schema.specialization} AS specialization`
        : 'NULL::text AS specialization',
      schema.department
        ? 'd.department'
        : 'NULL::text AS department',
      schema.experienceYears
        ? 'd.experience_years'
        : 'NULL::integer AS experience_years',
      schema.consultationFee
        ? 'd.consultation_fee'
        : 'NULL::numeric AS consultation_fee',
      schema.availableDays
        ? 'd.available_days'
        : 'NULL::text[] AS available_days',
      schema.availableHours
        ? 'd.available_hours'
        : 'NULL::jsonb AS available_hours',
      schema.isAvailable
        ? 'd.is_available'
        : 'NULL::boolean AS is_available',
      schema.bio
        ? `d.${schema.bio} AS bio`
        : 'NULL::text AS bio',
      schema.education
        ? 'd.education'
        : 'NULL::text AS education',
      schema.qualifications
        ? 'd.qualifications'
        : 'NULL::text[] AS qualifications',
      schema.createdAt
        ? 'd.created_at AS profile_created'
        : 'NULL::timestamp AS profile_created',
    ];

    if (detailed) {
      fields.push(
        'u.address',
        'u.birthday',
        'u.profile_picture',
        schema.certifications
          ? 'd.certifications'
          : 'NULL::text[] AS certifications',
        schema.updatedAt
          ? 'd.updated_at AS profile_updated'
          : 'NULL::timestamp AS profile_updated',
      );
    }

    return fields.join(',\n                 ');
  }

  // Get all doctors with filters
  async getAllDoctors(filters = {}) {
    try {
      const schema = await this.getDoctorSchema();
      const { page, limit, department, available, search } = filters;
      const pageNum = parseInt(page) || 1;
      const limitNum = parseInt(limit) || DOCTOR_CONFIG.PAGINATION.DEFAULT_LIMIT;
      const offset = (pageNum - 1) * limitNum;

      const params = [];
      const where = [`d.is_active = true`];

      if (department && schema.department) {
        params.push(department.toUpperCase());
        where.push(`UPPER(d.department) = $${params.length}`);
      }

      if (available !== undefined && schema.isAvailable) {
        params.push(available);
        where.push(`d.is_available = $${params.length}`);
      }

      if (search) {
        params.push(`%${search}%`);
        const searchParam = `$${params.length}`;
        const searchClauses = [`COALESCE(u.name, d.name) ILIKE ${searchParam}`];
        if (schema.specialization) {
          searchClauses.push(`COALESCE(d.${schema.specialization}, '') ILIKE ${searchParam}`);
        }
        where.push(`(${searchClauses.join(' OR ')})`);
      }

      params.push(limitNum, offset);
      const rows = await prisma.$queryRawUnsafe(
        `
          SELECT ${this.buildDoctorSelectFieldsFromDoctors(schema)}
          FROM doctors d
          LEFT JOIN users u ON u.id = d.user_id AND u.role = 'DOCTOR'
          WHERE ${where.join(' AND ')}
          ORDER BY COALESCE(u.name, d.name)
          LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
        ...params,
      );

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
      const schema = await this.getDoctorSchema();
      const { department, available, search } = filters;

      const params = [];
      const where = [`d.is_active = true`];

      if (department && schema.department) {
        params.push(department.toUpperCase());
        where.push(`UPPER(d.department) = $${params.length}`);
      }

      if (available !== undefined && schema.isAvailable) {
        params.push(available);
        where.push(`d.is_available = $${params.length}`);
      }

      if (search) {
        params.push(`%${search}%`);
        const searchParam = `$${params.length}`;
        const searchClauses = [`COALESCE(u.name, d.name) ILIKE ${searchParam}`];
        if (schema.specialization) {
          searchClauses.push(`COALESCE(d.${schema.specialization}, '') ILIKE ${searchParam}`);
        }
        where.push(`(${searchClauses.join(' OR ')})`);
      }

      const result = await prisma.$queryRawUnsafe(
        `
          SELECT COUNT(*)::int as count
          FROM doctors d
          LEFT JOIN users u ON u.id = d.user_id AND u.role = 'DOCTOR'
          WHERE ${where.join(' AND ')}
        `,
        ...params,
      );
      return result[0].count;
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
