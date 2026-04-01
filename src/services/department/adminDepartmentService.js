// src/services/department/adminDepartmentService.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { formatDate } from '../../utils/department/departmentHelpers.js';
import departmentAuditService from './departmentAuditService.js';

class AdminDepartmentService {
  async getDepartmentOverview(page = 1, limit = 20) {
    try {
      const offset = (page - 1) * limit;
      const [departmentStats, performanceMetrics, staffDistribution] = await Promise.all([
        // Department statistics
        db.query(`
          SELECT d.id, d.name, d.description, d.is_active, d.location,
                 d.contact_number, d.created_at,
                 u.name as head_doctor_name,
                 COUNT(doc.user_id) as doctor_count,
                 COUNT(s.user_id) as staff_count,
                 COUNT(CASE WHEN doc.is_available = true THEN 1 END) as available_doctors
          FROM departments d
          LEFT JOIN users u ON d.head_doctor_id = u.id
          LEFT JOIN doctors doc ON doc.department = d.name
          LEFT JOIN staff s ON s.department = d.name AND s.is_active = true
          WHERE d.is_active = true
          GROUP BY d.id, d.name, d.description, d.is_active, d.location, 
                   d.contact_number, d.created_at, u.name
          ORDER BY d.name
          LIMIT $1 OFFSET $2
        `, [limit, offset]),
        
        // Performance metrics (last 30 days)
        db.query(`
          SELECT doc.department,
                 COUNT(a.id) as total_appointments,
                 COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed_appointments,
                 COUNT(CASE WHEN a.status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
                 AVG(doc.consultation_fee) as avg_consultation_fee,
                 SUM(CASE WHEN a.status = 'COMPLETED' THEN doc.consultation_fee ELSE 0 END) as revenue
          FROM doctors doc
          LEFT JOIN appointments a ON doc.user_id = a.doctor_id 
            AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
          GROUP BY doc.department
          ORDER BY total_appointments DESC
        `),
        
        // Staff distribution
        db.query(`
          SELECT s.department, u.role, COUNT(*) as count
          FROM staff s
          JOIN users u ON s.user_id = u.id
          WHERE s.is_active = true
          GROUP BY s.department, u.role
          ORDER BY s.department, u.role
        `)
      ]);
      
      const departments = departmentStats.rows.map(dept => ({
        ...dept,
        doctor_count: parseInt(dept.doctor_count),
        staff_count: parseInt(dept.staff_count),
        available_doctors: parseInt(dept.available_doctors),
        created_at: formatDate(dept.created_at)
      }));

      const performance = performanceMetrics.rows.map(metric => ({
        ...metric,
        total_appointments: parseInt(metric.total_appointments),
        completed_appointments: parseInt(metric.completed_appointments),
        cancelled_appointments: parseInt(metric.cancelled_appointments),
        avg_consultation_fee: parseFloat(metric.avg_consultation_fee) || 0,
        revenue: parseFloat(metric.revenue) || 0
      }));

      const staffDist = staffDistribution.rows.map(staff => ({
        ...staff,
        count: parseInt(staff.count)
      }));
      
      return {
        departments,
        performance_metrics: performance,
        staff_distribution: staffDist,
        summary: {
          total_departments: departments.length,
          total_doctors: departments.reduce((sum, dept) => sum + dept.doctor_count, 0),
          total_staff: departments.reduce((sum, dept) => sum + dept.staff_count, 0)
        }
      };
    } catch (error) {
      logger.error('Database error in getDepartmentOverview:', error);
      throw new Error('Failed to retrieve department overview');
    }
  }

  async getDepartmentManagementData(filters = {}) {
    try {
      const { status = 'active', search } = filters;
      
      let query = `
        SELECT d.id, d.name, d.description, d.is_active, d.location,
               d.contact_number, d.created_at, d.updated_at,
               u.name as head_doctor_name, u.phone as head_doctor_phone,
               COUNT(doc.user_id) as doctor_count,
               COUNT(s.user_id) as staff_count,
               STRING_AGG(DISTINCT doc_users.name, ', ') as doctor_names
        FROM departments d
        LEFT JOIN users u ON d.head_doctor_id = u.id
        LEFT JOIN doctors doc ON doc.department = d.name
        LEFT JOIN users doc_users ON doc.user_id = doc_users.id
        LEFT JOIN staff s ON s.department = d.name AND s.is_active = true
        WHERE 1=1
      `;
      const params = [];
      
      if (status === 'active') {
        query += ' AND d.is_active = true';
      } else if (status === 'inactive') {
        query += ' AND d.is_active = false';
      }
      
      if (search) {
        query += ` AND (d.name ILIKE $${params.length + 1} OR d.description ILIKE $${params.length + 1})`;
        params.push(`%${search}%`);
      }
      
      query += ` GROUP BY d.id, d.name, d.description, d.is_active, d.location,
                 d.contact_number, d.created_at, d.updated_at, u.name, u.phone
                 ORDER BY d.name`;
      
      const result = await db.query(query, params);
      
      return result.rows.map(dept => ({
        ...dept,
        doctor_count: parseInt(dept.doctor_count),
        staff_count: parseInt(dept.staff_count),
        created_at: formatDate(dept.created_at),
        updated_at: dept.updated_at ? formatDate(dept.updated_at) : null
      }));
    } catch (error) {
      logger.error('Database error in getDepartmentManagementData:', error);
      throw new Error('Failed to retrieve department management data');
    }
  }

  async getDepartmentFinancialData(id, months = 6) {
    try {
      // Get department info
      const deptInfo = await db.query('SELECT name, budget FROM departments WHERE id = $1', [id]);
      if (deptInfo.rows.length === 0) {
        return null;
      }
      
      const departmentName = deptInfo.rows[0].name;
      
      const [revenueData, expenseData, profitability] = await Promise.all([
        // Revenue from consultations and procedures
        db.query(`
          SELECT DATE_TRUNC('month', a.appointment_date) as month,
                 SUM(CASE WHEN a.status = 'COMPLETED' THEN doc.consultation_fee ELSE 0 END) as consultation_revenue,
                 COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed_appointments
          FROM appointments a
          JOIN users d ON a.doctor_id = d.id
          JOIN doctors doc ON d.id = doc.user_id
          WHERE doc.department = $1 
            AND a.appointment_date >= CURRENT_DATE - INTERVAL '${months} months'
          GROUP BY DATE_TRUNC('month', a.appointment_date)
          ORDER BY month DESC
        `, [departmentName]),
        
        // Estimated expenses (staff salaries)
        db.query(`
          SELECT DATE_TRUNC('month', CURRENT_DATE) as month,
                 SUM(s.salary) as estimated_monthly_salary_expense,
                 COUNT(*) as staff_count
          FROM staff s
          WHERE s.department = $1 AND s.is_active = true
          GROUP BY DATE_TRUNC('month', CURRENT_DATE)
        `, [departmentName]),
        
        // Department profitability metrics
        db.query(`
          SELECT 
            AVG(doc.consultation_fee) as avg_consultation_fee,
            COUNT(DISTINCT doc.user_id) as total_doctors,
            COUNT(DISTINCT s.user_id) as total_staff,
            AVG(s.salary) as avg_staff_salary
          FROM doctors doc
          LEFT JOIN staff s ON s.department = doc.department AND s.is_active = true
          WHERE doc.department = $1 AND doc.is_available = true
        `, [departmentName])
      ]);
      
      return {
        department: {
          name: departmentName,
          budget: parseFloat(deptInfo.rows[0].budget) || 0
        },
        financial_data: {
          monthly_revenue: revenueData.rows.map(row => ({
            month: formatDate(row.month, 'MM-YYYY'),
            consultation_revenue: parseFloat(row.consultation_revenue) || 0,
            completed_appointments: parseInt(row.completed_appointments)
          })),
          monthly_expenses: expenseData.rows.map(row => ({
            month: formatDate(row.month, 'MM-YYYY'),
            estimated_monthly_salary_expense: parseFloat(row.estimated_monthly_salary_expense) || 0,
            staff_count: parseInt(row.staff_count)
          })),
          profitability_metrics: {
            avg_consultation_fee: parseFloat(profitability.rows[0]?.avg_consultation_fee) || 0,
            total_doctors: parseInt(profitability.rows[0]?.total_doctors) || 0,
            total_staff: parseInt(profitability.rows[0]?.total_staff) || 0,
            avg_staff_salary: parseFloat(profitability.rows[0]?.avg_staff_salary) || 0
          }
        },
        period_months: months
      };
    } catch (error) {
      logger.error('Database error in getDepartmentFinancialData:', error);
      throw new Error('Failed to retrieve department financial data');
    }
  }

  async getDepartmentStaffAllocation(id) {
    try {
      // Get department info
      const deptInfo = await db.query('SELECT name FROM departments WHERE id = $1', [id]);
      if (deptInfo.rows.length === 0) {
        return null;
      }
      
      const departmentName = deptInfo.rows[0].name;
      
      const [doctors, staff, workload] = await Promise.all([
        // Doctors in department
        db.query(`
          SELECT u.id, u.name, u.phone, u.email,
                 doc.specialization, doc.experience_years, doc.consultation_fee,
                 doc.available_days, doc.available_hours, doc.is_available
          FROM users u
          JOIN doctors doc ON u.id = doc.user_id
          WHERE doc.department = $1
          ORDER BY u.name
        `, [departmentName]),
        
        // Other staff in department
        db.query(`
          SELECT u.id, u.name, u.phone, u.role,
                 s.position, s.shift, s.salary, s.hire_date, s.is_active
          FROM users u
          JOIN staff s ON u.id = s.user_id
          WHERE s.department = $1
          ORDER BY u.role, u.name
        `, [departmentName]),
        
        // Workload analysis (last 30 days)
        db.query(`
          SELECT u.name as doctor_name,
                 COUNT(a.id) as total_appointments,
                 COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed_appointments,
                 COUNT(CASE WHEN a.status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
                 ROUND(COUNT(a.id)::numeric / 30, 2) as avg_appointments_per_day
          FROM users u
          JOIN doctors doc ON u.id = doc.user_id
          LEFT JOIN appointments a ON u.id = a.doctor_id 
            AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
          WHERE doc.department = $1
          GROUP BY u.id, u.name
          ORDER BY total_appointments DESC
        `, [departmentName])
      ]);
      
      return {
        department: {
          name: departmentName
        },
        allocation: {
          doctors: doctors.rows.map(doc => ({
            ...doc,
            experience_years: parseInt(doc.experience_years),
            consultation_fee: parseFloat(doc.consultation_fee)
          })),
          staff: staff.rows.map(s => ({
            ...s,
            salary: parseFloat(s.salary),
            hire_date: formatDate(s.hire_date)
          })),
          workload_analysis: workload.rows.map(w => ({
            ...w,
            total_appointments: parseInt(w.total_appointments),
            completed_appointments: parseInt(w.completed_appointments),
            cancelled_appointments: parseInt(w.cancelled_appointments),
            avg_appointments_per_day: parseFloat(w.avg_appointments_per_day)
          }))
        },
        summary: {
          total_doctors: doctors.rows.length,
          available_doctors: doctors.rows.filter(d => d.is_available).length,
          total_staff: staff.rows.length,
          active_staff: staff.rows.filter(s => s.is_active).length
        }
      };
    } catch (error) {
      logger.error('Database error in getDepartmentStaffAllocation:', error);
      throw new Error('Failed to retrieve staff allocation');
    }
  }

  async createDepartmentWithValidation(data) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      const { 
        name, description, head_doctor_id, contact_number, 
        location, budget, is_active = true 
      } = data;
      
      // Check if department already exists
      const existingDept = await client.query(
        'SELECT id FROM departments WHERE name = $1', 
        [name]
      );
      
      if (existingDept.rows.length > 0) {
        throw new Error('Department with this name already exists');
      }
      
      // Verify head doctor exists and is available
      if (head_doctor_id) {
        const doctorCheck = await client.query(
          'SELECT id, name FROM users WHERE id = $1 AND role = $2', 
          [head_doctor_id, 'DOCTOR']
        );
        
        if (doctorCheck.rows.length === 0) {
          throw new Error('Head doctor not found or invalid role');
        }
        
        // Check if doctor is already head of another department
        const existingHead = await client.query(
          'SELECT name FROM departments WHERE head_doctor_id = $1 AND is_active = true', 
          [head_doctor_id]
        );
        
        if (existingHead.rows.length > 0) {
          throw new Error(`Doctor is already head of ${existingHead.rows[0].name} department`);
        }
      }
      
      const result = await client.query(`
        INSERT INTO departments (
          name, description, head_doctor_id, contact_number, 
          location, budget, is_active, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        RETURNING id, name, code, head_uid, is_active, description, floor, building, created_at, updated_at
      `, [name, description, head_doctor_id, contact_number, location, budget, is_active]);
      
      await client.query('COMMIT');
      
      // Log audit
      await departmentAuditService.logDepartmentChange(
        result.rows[0].id,
        data.created_by || 1, // Pass user ID from controller
        'CREATE',
        null,
        result.rows[0]
      );

      return {
        ...result.rows[0],
        budget: parseFloat(result.rows[0].budget) || 0,
        created_at: formatDate(result.rows[0].created_at)
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async performBulkOperation(operation, departmentIds, data = {}) {
    try {
      let results = [];
      
      switch (operation) {
        case 'activate': {
          const activateResult = await db.query(
            'UPDATE departments SET is_active = true, updated_at = NOW() WHERE id = ANY($1) RETURNING id, name',
            [departmentIds]
          );
          results = activateResult.rows;
          break;
          }
        case 'deactivate': {
          const deactivateResult = await db.query(
            'UPDATE departments SET is_active = false, updated_at = NOW() WHERE id = ANY($1) RETURNING id, name',
            [departmentIds]
          );
          results = deactivateResult.rows;
          break;
          }
        case 'update_budget': {
          if (!data.budget) {
            throw new Error('Budget is required for update_budget operation');
          }
          const budgetResult = await db.query(
            'UPDATE departments SET budget = $1, updated_at = NOW() WHERE id = ANY($2) RETURNING id, name, budget',
            [data.budget, departmentIds]
          );
          results = budgetResult.rows.map(row => ({
            ...row,
            budget: parseFloat(row.budget)
          }));
          break;
          }
        case 'reassign_head': {
          if (!data.head_doctor_id) {
            throw new Error('Head doctor ID is required for reassign_head operation');
          }
          
          // Verify doctor exists
          const doctorCheck = await db.query(
            'SELECT name FROM users WHERE id = $1 AND role = $2', 
            [data.head_doctor_id, 'DOCTOR']
          );
          if (doctorCheck.rows.length === 0) {
            throw new Error('Head doctor not found');
          }
          
          const reassignResult = await db.query(
            'UPDATE departments SET head_doctor_id = $1, updated_at = NOW() WHERE id = ANY($2) RETURNING id, name',
            [data.head_doctor_id, departmentIds]
          );
          results = reassignResult.rows;
          break;
          }
        default:
          throw new Error('Invalid operation');
      }
      
      return {
        operation,
        affected_departments: results,
        count: results.length
      };
    } catch (error) {
      logger.error('Error in performBulkOperation:', error);
      throw error;
    }
  }

  async deactivateDepartmentWithReassignment(id, reason, reassignToDepartment) {
    const client = await db.getClient();

    try {
      await client.query('BEGIN');
      
      // Get department info
      const deptCheck = await client.query(
        'SELECT name, is_active FROM departments WHERE id = $1', 
        [id]
      );
      
      if (deptCheck.rows.length === 0) {
        throw new Error('Department not found');
      }
      
      if (!deptCheck.rows[0].is_active) {
        throw new Error('Department is already inactive');
      }
      
      // Check if there are active doctors/staff in this department
      const [activeDoctors, activeStaff] = await Promise.all([
        client.query(
          'SELECT COUNT(*) as count FROM doctors WHERE department = $1 AND is_available = true', 
          [deptCheck.rows[0].name]
        ),
        client.query(
          'SELECT COUNT(*) as count FROM staff WHERE department = $1 AND is_active = true', 
          [deptCheck.rows[0].name]
        )
      ]);
      
      const doctorCount = parseInt(activeDoctors.rows[0].count);
      const staffCount = parseInt(activeStaff.rows[0].count);
      
      if ((doctorCount > 0 || staffCount > 0) && !reassignToDepartment) {
        throw new Error(`Cannot deactivate department with ${doctorCount} active doctors and ${staffCount} active staff`);
      }
      
      // Reassign staff if requested
      let targetDeptName = null;
      if (reassignToDepartment && (doctorCount > 0 || staffCount > 0)) {
        const targetDept = await client.query(
          'SELECT name FROM departments WHERE id = $1 AND is_active = true', 
          [reassignToDepartment]
        );
        
        if (targetDept.rows.length === 0) {
          throw new Error('Target department for reassignment not found');
        }
        
        targetDeptName = targetDept.rows[0].name;
        
        // Reassign doctors and staff
        await Promise.all([
          client.query(
            'UPDATE doctors SET department = $1 WHERE department = $2 AND is_available = true', 
            [targetDeptName, deptCheck.rows[0].name]
          ),
          client.query(
            'UPDATE staff SET department = $1 WHERE department = $2 AND is_active = true', 
            [targetDeptName, deptCheck.rows[0].name]
          )
        ]);
      }
      
      // Deactivate department
      const result = await client.query(`
        UPDATE departments SET 
          is_active = false,
          head_doctor_id = NULL,
          deactivation_reason = $1,
          updated_at = NOW()
        WHERE id = $2
        RETURNING id, name, code, head_uid, is_active, description, floor, building, created_at, updated_at
      `, [reason, id]);
      
      await client.query('COMMIT');

      // Log audit
      await departmentAuditService.logDepartmentChange(
        id,
        1, // TODO: Pass user ID from controller
        'DEACTIVATE',
        deptCheck.rows[0],
        result.rows[0]
      );

      return {
        department: {
          ...result.rows[0],
          created_at: formatDate(result.rows[0].created_at),
          updated_at: formatDate(result.rows[0].updated_at)
        },
        reassigned: {
          doctors: reassignToDepartment ? doctorCount : 0,
          staff: reassignToDepartment ? staffCount : 0,
          to_department: targetDeptName
        }
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
async updateDepartment(id, data) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      const { 
        name, description, head_doctor_id, contact_number, 
        location, budget, is_active 
      } = data;
      
      // Check if department exists
      const existingDept = await client.query(
        'SELECT id, name, code, head_uid, is_active, description, floor, building, created_at, updated_at FROM departments WHERE id = $1',
        [id]
      );

      if (existingDept.rows.length === 0) {
        throw new Error('Department not found');
      }

      // If changing name, check if new name already exists
      if (name && name !== existingDept.rows[0].name) {
        const nameCheck = await client.query(
          'SELECT id FROM departments WHERE name = $1 AND id != $2', 
          [name, id]
        );
        
        if (nameCheck.rows.length > 0) {
          throw new Error('Department with this name already exists');
        }
      }
      
      // Verify head doctor if changing
      if (head_doctor_id && head_doctor_id !== existingDept.rows[0].head_doctor_id) {
        const doctorCheck = await client.query(
          'SELECT name FROM users WHERE id = $1 AND role = $2', 
          [head_doctor_id, 'DOCTOR']
        );
        
        if (doctorCheck.rows.length === 0) {
          throw new Error('Head doctor not found or invalid role');
        }
        
        // Check if doctor is already head of another department
        const existingHead = await client.query(
          'SELECT name FROM departments WHERE head_doctor_id = $1 AND id != $2 AND is_active = true', 
          [head_doctor_id, id]
        );
        
        if (existingHead.rows.length > 0) {
          throw new Error(`Doctor is already head of ${existingHead.rows[0].name} department`);
        }
      }
      
      const result = await client.query(`
        UPDATE departments SET 
          name = COALESCE($1, name),
          description = COALESCE($2, description),
          head_doctor_id = COALESCE($3, head_doctor_id),
          contact_number = COALESCE($4, contact_number),
          location = COALESCE($5, location),
          budget = COALESCE($6, budget),
          is_active = COALESCE($7, is_active),
          updated_at = NOW()
        WHERE id = $8
        RETURNING id, name, code, head_uid, is_active, description, floor, building, created_at, updated_at
      `, [name, description, head_doctor_id, contact_number, location, budget, is_active, id]);
      
      await client.query('COMMIT');
      
      // Log audit
      await departmentAuditService.logDepartmentChange(
        id,
        data.updated_by || 1, // Pass user ID from controller
        'UPDATE',
        existingDept.rows[0],
        result.rows[0]
      );
      
      return {
        ...result.rows[0],
        budget: parseFloat(result.rows[0].budget) || 0,
        created_at: formatDate(result.rows[0].created_at),
        updated_at: formatDate(result.rows[0].updated_at)
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
export default new AdminDepartmentService();