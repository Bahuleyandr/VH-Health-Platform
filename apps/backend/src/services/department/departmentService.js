// src/services/department/departmentService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { formatDate, getCurrentDay } from '../../utils/department/departmentHelpers.js';

class DepartmentService {
  async getAllDepartments() {
    try {
      const rows = await prisma.$queryRaw`
        SELECT d.id, d.name, d.description, d.is_active, d.created_at, d.updated_at,
               COUNT(doc.user_id) as doctor_count,
               COUNT(doc.user_id) FILTER (WHERE doc.is_available = true) as available_doctors
        FROM departments d
        LEFT JOIN doctors doc ON doc.department = d.name
        WHERE d.is_active = true
        GROUP BY d.id, d.name, d.description, d.is_active, d.created_at, d.updated_at
        ORDER BY d.name
      `;

      return {
        departments: rows.map(dept => ({
          ...dept,
          doctor_count: parseInt(dept.doctor_count),
          available_doctors: parseInt(dept.available_doctors),
          // Ship ISO timestamps; the admin formatter handles display.
          // Pre-formatting as DD-MM-YYYY broke `new Date(...)` parsing.
          created_at: dept.created_at instanceof Date ? dept.created_at.toISOString() : dept.created_at,
          updated_at: dept.updated_at instanceof Date ? dept.updated_at.toISOString() : dept.updated_at,
        })),
        count: rows.length
      };
    } catch (error) {
      logger.error('Database error in getAllDepartments:', error);

      // Fallback: Get unique departments from doctors table
      try {
        const fallbackRows = await prisma.$queryRaw`
          SELECT department as name, COUNT(*) as doctor_count,
                 COUNT(*) FILTER (WHERE is_available = true) as available_doctors
          FROM doctors
          WHERE department IS NOT NULL
          GROUP BY department
          ORDER BY department
        `;

        const departments = fallbackRows.map(dept => ({
          name: dept.name,
          doctor_count: parseInt(dept.doctor_count),
          available_doctors: parseInt(dept.available_doctors),
          description: `${dept.name} Department`,
          is_active: true,
          location: 'Hospital Building',
          contact_number: null,
          head_doctor_name: null
        }));

        return {
          departments,
          count: departments.length,
          fallback: true,
          note: 'Limited data - create departments table for full functionality'
        };
      } catch (fallbackError) {
        logger.error('Fallback query failed:', fallbackError);
        throw new Error('Failed to retrieve departments');
      }
    }
  }

  async getAvailableDepartments() {
    try {
      const today = getCurrentDay();

      const rows = await prisma.$queryRaw`
        SELECT d.name, d.description,
               COUNT(doc.user_id) as available_doctors,
               STRING_AGG(u.name, ', ') as doctor_names,
               STRING_AGG(doc.specialty, ', ') as specializations
        FROM departments d
        LEFT JOIN doctors doc ON doc.department = d.name
          AND doc.is_available = true
          AND (doc.available_days IS NULL OR doc.available_days LIKE ${'%' + today + '%'})
        LEFT JOIN users u ON doc.user_id = u.id
        WHERE d.is_active = true
        GROUP BY d.name, d.description
        HAVING COUNT(doc.user_id) > 0
        ORDER BY available_doctors DESC, d.name
      `;

      return {
        departments: rows.map(dept => ({
          ...dept,
          available_doctors: parseInt(dept.available_doctors)
        })),
        count: rows.length,
        current_day: today
      };
    } catch (error) {
      logger.error('Database error in getAvailableDepartments:', error);
      return {
        departments: [],
        count: 0,
        current_day: getCurrentDay(),
        note: 'Could not retrieve available departments - table may not exist'
      };
    }
  }

  async getDepartmentById(identifier) {
    try {
      const isNumeric = /^\d+$/.test(identifier);

      let rows;
      if (isNumeric) {
        const id = parseInt(identifier);
        rows = await prisma.$queryRaw`
          SELECT d.id, d.name, d.description, d.is_active, d.created_at, d.updated_at
          FROM departments d
          WHERE d.id = ${id} AND d.is_active = true
        `;
      } else {
        rows = await prisma.$queryRaw`
          SELECT d.id, d.name, d.description, d.is_active, d.created_at, d.updated_at
          FROM departments d
          WHERE LOWER(d.name) = LOWER(${identifier}) AND d.is_active = true
        `;
      }

      if (rows.length === 0) {
        return null;
      }

      const department = rows[0];

      // Get doctors in this department
      const doctorsRows = await prisma.$queryRaw`
        SELECT u.id, u.name, u.phone, u.email,
               doc.specialty, doc.experience_years, doc.consultation_fee,
               doc.available_days, doc.available_hours, doc.is_available,
               doc.qualifications
        FROM users u
        JOIN doctors doc ON u.id = doc.user_id
        WHERE u.role = 'DOCTOR' AND LOWER(doc.department) = LOWER(${department.name})
        ORDER BY doc.is_available DESC, u.name
      `;

      return {
        ...department,
        doctors: doctorsRows,
        doctor_count: doctorsRows.length,
        available_doctor_count: doctorsRows.filter(d => d.is_available).length,
        created_at: formatDate(department.created_at),
        updated_at: department.updated_at ? formatDate(department.updated_at) : null
      };
    } catch (error) {
      logger.error('Database error in getDepartmentById:', error);
      throw new Error('Failed to retrieve department');
    }
  }

  async createDepartment(data, userId) {
    try {
      const {
        name, description, head_doctor_id, is_active = true
      } = data;

      // Check if department already exists
      const existing = await prisma.$queryRaw`
        SELECT id FROM departments WHERE LOWER(name) = LOWER(${name})
      `;
      if (existing.length > 0) {
        throw new Error('Department with this name already exists');
      }

      // Verify head doctor exists if provided
      if (head_doctor_id) {
        const doctorCheck = await prisma.$queryRaw`
          SELECT id, name FROM users WHERE id = ${head_doctor_id} AND role = 'DOCTOR'
        `;
        if (doctorCheck.length === 0) {
          throw new Error('Head doctor not found');
        }
      }

      const rows = await prisma.$queryRaw`
        INSERT INTO departments (name, description, is_active, created_at, updated_at)
        VALUES (${name}, ${description || null}, ${is_active}, NOW(), NOW())
        RETURNING id, name, description, is_active, created_at, updated_at
      `;

      logger.info(`Department created: ${name} by user ID ${userId}`);

      return {
        ...rows[0],
        created_at: formatDate(rows[0].created_at)
      };
    } catch (error) {
      logger.error('Database error in createDepartment:', error);
      throw error;
    }
  }

  async updateDepartment(id, data, userId) {
    try {
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid request body');
      }
      const {
        name, description, head_doctor_id, is_active
      } = data;

      // Check if department exists
      const existing = await prisma.$queryRaw`
        SELECT id, name, description, is_active, created_at, updated_at
        FROM departments WHERE id = ${id}::int
      `;
      if (existing.length === 0) {
        return null;
      }

      // Verify head doctor exists if provided
      if (head_doctor_id) {
        const doctorCheck = await prisma.$queryRaw`
          SELECT id, name FROM users WHERE id = ${head_doctor_id} AND role = 'DOCTOR'
        `;
        if (doctorCheck.length === 0) {
          throw new Error('Head doctor not found');
        }
      }

      const rows = await prisma.$queryRaw`
        UPDATE departments SET
          name = COALESCE(${name}, name),
          description = COALESCE(${description}, description),
          is_active = COALESCE(${is_active}, is_active),
          updated_at = NOW()
        WHERE id = ${id}::int
        RETURNING id, name, description, is_active, created_at, updated_at
      `;

      logger.info(`Department updated: ${rows[0].name} by user ID ${userId}`);

      return {
        ...rows[0],
        created_at: formatDate(rows[0].created_at),
        updated_at: formatDate(rows[0].updated_at)
      };
    } catch (error) {
      logger.error('Database error in updateDepartment:', error);
      throw error;
    }
  }

  async deactivateDepartment(id, reason, userId) {
    try {
      const existing = await prisma.$queryRaw`
        SELECT id, name, description, is_active, created_at, updated_at
        FROM departments WHERE id = ${id}::int
      `;
      if (existing.length === 0) {
        return null;
      }

      // Check if department has active doctors
      const activeDoctors = await prisma.$queryRaw`
        SELECT COUNT(*) as count
        FROM doctors doc
        JOIN users u ON doc.user_id = u.id
        WHERE LOWER(doc.department) = LOWER(${existing[0].name}) AND doc.is_available = true
      `;

      if (parseInt(activeDoctors[0].count) > 0) {
        throw new Error(`Cannot deactivate department with ${activeDoctors[0].count} active doctors`);
      }

      const rows = await prisma.$queryRaw`
        UPDATE departments SET
          is_active = false,
          updated_at = NOW()
        WHERE id = ${id}::int
        RETURNING id, name, description, is_active, created_at, updated_at
      `;

      logger.info(`Department deactivated: ${rows[0].name} by user ID ${userId} - Reason: ${reason}`);

      return {
        ...rows[0],
        created_at: formatDate(rows[0].created_at),
        updated_at: formatDate(rows[0].updated_at)
      };
    } catch (error) {
      logger.error('Database error in deactivateDepartment:', error);
      throw error;
    }
  }

  async getDepartmentsWithDoctors(tenantId) {
    // Tenant-scope the guest directory (audit / cross-tenant fix): this
    // surface is API-key-only and mounted BEFORE the tenant/RLS middleware,
    // so it previously joined departments/doctors/users with no tenant
    // predicate at all and served every tenant's directory to any caller.
    // The controller resolves the tenant from the request Host (SEC-5/W4
    // pattern, resolveTenantForRequest); requireTenantId keeps the house
    // fail-closed semantics with the ALLOW_DEFAULT_TENANT single-tenant floor.
    const scopedTenantId = requireTenantId(tenantId);
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT d.id, d.name, d.description,
               COUNT(doc.id) as doctor_count,
               json_agg(
                 json_build_object(
                  'id', COALESCE(u.id, doc.id),
                  'doctor_profile_id', doc.id,
                  'user_id', u.id,
                  'name', COALESCE(u.name, doc.name),
                  'specialization', doc.specialty,
                  'is_available', doc.is_available,
                  'experience_years', null,
                  'consultation_fee', null,
                  'available_days', null,
                  'available_hours', null,
                  'bio', doc.intro,
                  'education', null,
                  'qualifications', null,
                  'image_url', doc.image_url
                )
                ) FILTER (WHERE doc.id IS NOT NULL) as doctors
        FROM departments d
        LEFT JOIN doctors doc ON doc.is_active = true
          AND doc.tenant_id = $1::uuid
          AND (
            doc.department_id = d.id
            OR (doc.department_id IS NULL AND LOWER(doc.department) = LOWER(d.name))
          )
        LEFT JOIN users u ON doc.user_id = u.id AND u.role = 'DOCTOR'
          AND u.tenant_id = $1::uuid
        WHERE d.is_active = true
          AND d.tenant_id = $1::uuid
        GROUP BY d.id, d.name, d.description
        ORDER BY d.name`,
        scopedTenantId,
      );

      return rows.map(dept => ({
        ...dept,
        doctor_count: parseInt(dept.doctor_count),
        doctors: dept.doctors || []
      }));
    } catch (error) {
      logger.error('Database error in getDepartmentsWithDoctors:', error);
      throw new Error('Failed to retrieve departments with doctors');
    }
  }
}

export default new DepartmentService();
