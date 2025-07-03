// src/services/department/departmentService.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { formatDate, getCurrentDay } from '../../utils/department/departmentHelpers.js';

class DepartmentService {
  async getAllDepartments() {
    try {
      const result = await db.query(`
        SELECT d.id, d.name, d.description, d.head_doctor_id, d.contact_number,
               d.location, d.is_active, d.created_at, d.updated_at,
               u.name as head_doctor_name, u.phone as head_doctor_phone,
               COUNT(doc.user_id) as doctor_count,
               COUNT(doc.user_id) FILTER (WHERE doc.is_available = true) as available_doctors
        FROM departments d
        LEFT JOIN users u ON d.head_doctor_id = u.id
        LEFT JOIN doctors doc ON doc.department = d.name
        WHERE d.is_active = true
        GROUP BY d.id, d.name, d.description, d.head_doctor_id, d.contact_number, 
                 d.location, d.is_active, d.created_at, d.updated_at, u.name, u.phone
        ORDER BY d.name
      `);
      
      return {
        departments: result.rows.map(dept => ({
          ...dept,
          doctor_count: parseInt(dept.doctor_count),
          available_doctors: parseInt(dept.available_doctors),
          created_at: formatDate(dept.created_at),
          updated_at: dept.updated_at ? formatDate(dept.updated_at) : null
        })),
        count: result.rows.length
      };
    } catch (error) {
      logger.error('Database error in getAllDepartments:', error);
      
      // Fallback: Get unique departments from doctors table
      try {
        const fallbackResult = await db.query(`
          SELECT department as name, COUNT(*) as doctor_count,
                 COUNT(*) FILTER (WHERE is_available = true) as available_doctors
          FROM doctors 
          WHERE department IS NOT NULL
          GROUP BY department
          ORDER BY department
        `);
        
        const departments = fallbackResult.rows.map(dept => ({
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
      
      const result = await db.query(`
        SELECT d.name, d.description, d.location, d.contact_number,
               COUNT(doc.user_id) as available_doctors,
               STRING_AGG(u.name, ', ') as doctor_names,
               STRING_AGG(doc.specialization, ', ') as specializations
        FROM departments d
        LEFT JOIN doctors doc ON doc.department = d.name 
          AND doc.is_available = true 
          AND (doc.available_days IS NULL OR doc.available_days LIKE '%' || $1 || '%')
        LEFT JOIN users u ON doc.user_id = u.id
        WHERE d.is_active = true
        GROUP BY d.name, d.description, d.location, d.contact_number
        HAVING COUNT(doc.user_id) > 0
        ORDER BY available_doctors DESC, d.name
      `, [today]);
      
      return {
        departments: result.rows.map(dept => ({
          ...dept,
          available_doctors: parseInt(dept.available_doctors)
        })),
        count: result.rows.length,
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
      
      let result;
      if (isNumeric) {
        // Search by ID
        result = await db.query(`
          SELECT d.*, u.name as head_doctor_name, u.phone as head_doctor_phone,
                 u.email as head_doctor_email
          FROM departments d
          LEFT JOIN users u ON d.head_doctor_id = u.id
          WHERE d.id = $1 AND d.is_active = true
        `, [identifier]);
      } else {
        // Search by name
        result = await db.query(`
          SELECT d.*, u.name as head_doctor_name, u.phone as head_doctor_phone,
                 u.email as head_doctor_email
          FROM departments d
          LEFT JOIN users u ON d.head_doctor_id = u.id
          WHERE LOWER(d.name) = LOWER($1) AND d.is_active = true
        `, [identifier]);
      }
      
      if (result.rows.length === 0) {
        return null;
      }
      
      const department = result.rows[0];
      
      // Get doctors in this department
      const doctorsResult = await db.query(`
        SELECT u.id, u.name, u.phone, u.email,
               doc.specialization, doc.experience_years, doc.consultation_fee,
               doc.available_days, doc.available_hours, doc.is_available,
               doc.qualifications
        FROM users u
        JOIN doctors doc ON u.id = doc.user_id
        WHERE u.role = 'DOCTOR' AND LOWER(doc.department) = LOWER($1)
        ORDER BY doc.is_available DESC, u.name
      `, [department.name]);
      
      return {
        ...department,
        doctors: doctorsResult.rows,
        doctor_count: doctorsResult.rows.length,
        available_doctor_count: doctorsResult.rows.filter(d => d.is_available).length,
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
        name, description, head_doctor_id, contact_number, 
        location, is_active = true 
      } = data;
      
      // Check if department already exists
      const existingDept = await db.query(
        'SELECT id FROM departments WHERE LOWER(name) = LOWER($1)', 
        [name]
      );
      
      if (existingDept.rows.length > 0) {
        throw new Error('Department with this name already exists');
      }
      
      // Verify head doctor exists if provided
      if (head_doctor_id) {
        const doctorCheck = await db.query(
          'SELECT id, name FROM users WHERE id = $1 AND role = $2', 
          [head_doctor_id, 'DOCTOR']
        );
        if (doctorCheck.rows.length === 0) {
          throw new Error('Head doctor not found');
        }
      }
      
      const result = await db.query(`
        INSERT INTO departments (name, description, head_doctor_id, contact_number, location, is_active, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *
      `, [name, description, head_doctor_id, contact_number, location, is_active]);
      
      logger.info(`Department created: ${name} by user ID ${userId}`);
      
      return {
        ...result.rows[0],
        created_at: formatDate(result.rows[0].created_at)
      };
    } catch (error) {
      logger.error('Database error in createDepartment:', error);
      throw error;
    }
  }

  async updateDepartment(id, data, userId) {
    try {
      const { 
        name, description, head_doctor_id, contact_number, 
        location, is_active 
      } = data;
      
      // Check if department exists
      const existingDept = await db.query('SELECT * FROM departments WHERE id = $1', [id]);
      if (existingDept.rows.length === 0) {
        return null;
      }
      
      // Verify head doctor exists if provided
      if (head_doctor_id) {
        const doctorCheck = await db.query(
          'SELECT id, name FROM users WHERE id = $1 AND role = $2', 
          [head_doctor_id, 'DOCTOR']
        );
        if (doctorCheck.rows.length === 0) {
          throw new Error('Head doctor not found');
        }
      }
      
      const result = await db.query(`
        UPDATE departments SET 
          name = COALESCE($1, name),
          description = COALESCE($2, description),
          head_doctor_id = COALESCE($3, head_doctor_id),
          contact_number = COALESCE($4, contact_number),
          location = COALESCE($5, location),
          is_active = COALESCE($6, is_active),
          updated_at = NOW()
        WHERE id = $7
        RETURNING *
      `, [name, description, head_doctor_id, contact_number, location, is_active, id]);
      
      logger.info(`Department updated: ${result.rows[0].name} by user ID ${userId}`);
      
      return {
        ...result.rows[0],
        created_at: formatDate(result.rows[0].created_at),
        updated_at: formatDate(result.rows[0].updated_at)
      };
    } catch (error) {
      logger.error('Database error in updateDepartment:', error);
      throw error;
    }
  }

  async deactivateDepartment(id, reason, userId) {
    try {
      // Check if department exists
      const existingDept = await db.query(
        'SELECT * FROM departments WHERE id = $1', 
        [id]
      );
      
      if (existingDept.rows.length === 0) {
        return null;
      }
      
      // Check if department has active doctors
      const activeDoctors = await db.query(`
        SELECT COUNT(*) as count 
        FROM doctors doc 
        JOIN users u ON doc.user_id = u.id 
        WHERE LOWER(doc.department) = LOWER($1) AND doc.is_available = true
      `, [existingDept.rows[0].name]);
      
      if (parseInt(activeDoctors.rows[0].count) > 0) {
        throw new Error(`Cannot deactivate department with ${activeDoctors.rows[0].count} active doctors`);
      }
      
      // Soft delete by setting is_active to false
      const result = await db.query(`
        UPDATE departments SET 
          is_active = false,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [id]);
      
      logger.info(`Department deactivated: ${result.rows[0].name} by user ID ${userId} - Reason: ${reason}`);
      
      return {
        ...result.rows[0],
        created_at: formatDate(result.rows[0].created_at),
        updated_at: formatDate(result.rows[0].updated_at)
      };
    } catch (error) {
      logger.error('Database error in deactivateDepartment:', error);
      throw error;
    }
  }

  async getDepartmentsWithDoctors() {
    try {
      const result = await db.query(`
        SELECT d.id, d.name, d.description, d.location,
               COUNT(doc.user_id) as doctor_count,
               json_agg(
                 json_build_object(
                   'id', u.id,
                   'name', u.name,
                   'specialization', doc.specialization,
                   'is_available', doc.is_available
                 )
               ) as doctors
        FROM departments d
        LEFT JOIN doctors doc ON doc.department = d.name
        LEFT JOIN users u ON doc.user_id = u.id
        WHERE d.is_active = true
        GROUP BY d.id, d.name, d.description, d.location
        ORDER BY d.name
      `);
      
      return result.rows.map(dept => ({
        ...dept,
        doctor_count: parseInt(dept.doctor_count),
        doctors: dept.doctors[0]?.id ? dept.doctors : []
      }));
    } catch (error) {
      logger.error('Database error in getDepartmentsWithDoctors:', error);
      throw new Error('Failed to retrieve departments with doctors');
    }
  }
}

export default new DepartmentService();