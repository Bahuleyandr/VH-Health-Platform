// src/services/department/adminDepartmentService.js
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { formatDate } from '../../utils/department/departmentHelpers.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import departmentAuditService from './departmentAuditService.js';

class AdminDepartmentService {
  async getDepartmentOverview(page = 1, limit = 20) {
    try {
      const offset = (page - 1) * limit;

      const [departmentStats, performanceMetrics, staffDistribution] = await Promise.all([
        prisma.$queryRaw`
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
          LIMIT ${limit} OFFSET ${offset}
        `,
        prisma.$queryRaw`
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
        `,
        prisma.$queryRaw`
          SELECT s.department, u.role, COUNT(*) as count
          FROM staff s
          JOIN users u ON s.user_id::text = u.uid::text
          WHERE s.is_active = true
          GROUP BY s.department, u.role
          ORDER BY s.department, u.role
        `
      ]);

      const departments = departmentStats.map(dept => ({
        ...dept,
        doctor_count: parseInt(dept.doctor_count),
        staff_count: parseInt(dept.staff_count),
        available_doctors: parseInt(dept.available_doctors),
        created_at: formatDate(dept.created_at)
      }));

      const performance = performanceMetrics.map(metric => ({
        ...metric,
        total_appointments: parseInt(metric.total_appointments),
        completed_appointments: parseInt(metric.completed_appointments),
        cancelled_appointments: parseInt(metric.cancelled_appointments),
        avg_consultation_fee: parseFloat(metric.avg_consultation_fee) || 0,
        revenue: parseFloat(metric.revenue) || 0
      }));

      const staffDist = staffDistribution.map(s => ({
        ...s,
        count: parseInt(s.count)
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
      const allowedSortFields = {
        name: 'd.name',
        status: 'd.is_active',
        created_at: 'd.created_at',
        updated_at: 'd.updated_at',
        doctor_count: 'doctor_count',
        staff_count: 'staff_count',
      };
      const listQuery = parseListQuery({ ...filters, search }, {
        defaultLimit: 20,
        maxLimit: 100,
        defaultSortBy: 'name',
        defaultSortOrder: 'ASC',
        allowedSortFields: Object.keys(allowedSortFields),
      });

      // Build WHERE clause dynamically using only real columns
      const conditions = [];
      const params = [];

      if (status === 'active') {
        conditions.push('d.is_active = true');
      } else if (status === 'inactive') {
        conditions.push('d.is_active = false');
      }

      if (listQuery.search) {
        params.push(`%${listQuery.search}%`);
        conditions.push(`(d.name ILIKE $${params.length} OR d.description ILIKE $${params.length})`);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const listParams = [...params, listQuery.limit, listQuery.offset];
      const [rows, countRows] = await Promise.all([
        prisma.$queryRawUnsafe(`
          SELECT d.id, d.name, d.description, d.is_active,
                 d.created_at, d.updated_at,
                 COUNT(DISTINCT doc.id) as doctor_count,
                 COUNT(DISTINCT s.user_id) as staff_count,
                 STRING_AGG(DISTINCT COALESCE(doc_users.name, doc.name), ', ') as doctor_names
          FROM departments d
          LEFT JOIN doctors doc ON doc.department = d.name AND doc.is_active = true
          LEFT JOIN users doc_users ON doc_users.id = doc.user_id
          LEFT JOIN staff s ON s.department = d.name AND s.is_active = true
          ${where}
          GROUP BY d.id, d.name, d.description, d.is_active, d.created_at, d.updated_at
          ORDER BY ${allowedSortFields[listQuery.sortBy]} ${listQuery.sortOrder}, d.name ASC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `, ...listParams),
        prisma.$queryRawUnsafe(`
          SELECT COUNT(*)::int AS count
          FROM departments d
          ${where}
        `, ...params),
      ]);
      const total = Number.parseInt(countRows?.[0]?.count, 10) || 0;
      const departments = rows.map(dept => ({
        ...dept,
        doctor_count: parseInt(dept.doctor_count) || 0,
        staff_count: parseInt(dept.staff_count) || 0,
        created_at: formatDate(dept.created_at),
        updated_at: dept.updated_at ? formatDate(dept.updated_at) : null
      }));

      return {
        departments,
        pagination: buildPagination(total, listQuery.page, listQuery.limit),
        filters: {
          status,
          search: listQuery.search || null,
          sortBy: listQuery.sortBy,
          sortOrder: listQuery.sortOrder,
        },
      };
    } catch (error) {
      logger.error('Database error in getDepartmentManagementData:', error);
      throw new Error('Failed to retrieve department management data');
    }
  }

  async getDepartmentFinancialData(id, months = 6) {
    try {
      const deptRows = await prisma.$queryRaw`
        SELECT name, budget FROM departments WHERE id = ${id}
      `;
      if (deptRows.length === 0) {
        return null;
      }

      const departmentName = deptRows[0].name;
      const safeMonths = parseInt(months) || 6;

      const [revenueData, expenseData, profitability] = await Promise.all([
        prisma.$queryRaw(
          Prisma.sql`
            SELECT DATE_TRUNC('month', a.appointment_date) as month,
                   SUM(CASE WHEN a.status = 'COMPLETED' THEN doc.consultation_fee ELSE 0 END) as consultation_revenue,
                   COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed_appointments
            FROM appointments a
            JOIN users d ON a.doctor_id = d.id
            JOIN doctors doc ON d.id = doc.user_id
            WHERE doc.department = ${departmentName}
              AND a.appointment_date >= CURRENT_DATE - ${Prisma.raw(`'${safeMonths} months'`)}::interval
            GROUP BY DATE_TRUNC('month', a.appointment_date)
            ORDER BY month DESC
          `
        ),
        prisma.$queryRaw`
          SELECT DATE_TRUNC('month', CURRENT_DATE) as month,
                 SUM(s.salary) as estimated_monthly_salary_expense,
                 COUNT(*) as staff_count
          FROM staff s
          WHERE s.department = ${departmentName} AND s.is_active = true
          GROUP BY DATE_TRUNC('month', CURRENT_DATE)
        `,
        prisma.$queryRaw`
          SELECT
            AVG(doc.consultation_fee) as avg_consultation_fee,
            COUNT(DISTINCT doc.user_id) as total_doctors,
            COUNT(DISTINCT s.user_id) as total_staff,
            AVG(s.salary) as avg_staff_salary
          FROM doctors doc
          LEFT JOIN staff s ON s.department = doc.department AND s.is_active = true
          WHERE doc.department = ${departmentName} AND doc.is_available = true
        `
      ]);

      return {
        department: {
          name: departmentName,
          budget: parseFloat(deptRows[0].budget) || 0
        },
        financial_data: {
          monthly_revenue: revenueData.map(row => ({
            month: formatDate(row.month, 'MM-YYYY'),
            consultation_revenue: parseFloat(row.consultation_revenue) || 0,
            completed_appointments: parseInt(row.completed_appointments)
          })),
          monthly_expenses: expenseData.map(row => ({
            month: formatDate(row.month, 'MM-YYYY'),
            estimated_monthly_salary_expense: parseFloat(row.estimated_monthly_salary_expense) || 0,
            staff_count: parseInt(row.staff_count)
          })),
          profitability_metrics: {
            avg_consultation_fee: parseFloat(profitability[0]?.avg_consultation_fee) || 0,
            total_doctors: parseInt(profitability[0]?.total_doctors) || 0,
            total_staff: parseInt(profitability[0]?.total_staff) || 0,
            avg_staff_salary: parseFloat(profitability[0]?.avg_staff_salary) || 0
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
      const deptRows = await prisma.$queryRaw`
        SELECT name FROM departments WHERE id = ${id}
      `;
      if (deptRows.length === 0) {
        return null;
      }

      const departmentName = deptRows[0].name;

      const [doctors, staffRows, workload] = await Promise.all([
        prisma.$queryRaw`
          SELECT u.id, u.name, u.phone, u.email,
                 doc.specialty AS specialization, doc.experience_years, doc.consultation_fee,
                 doc.available_days, doc.available_hours, doc.is_available
          FROM users u
          JOIN doctors doc ON u.id = doc.user_id
          WHERE doc.department = ${departmentName}
          ORDER BY u.name
        `,
        prisma.$queryRaw`
          SELECT u.id, u.name, u.phone, u.role,
                 s.position, s.shift, s.salary, s.hire_date, s.is_active
          FROM users u
          JOIN staff s ON u.uid = s.user_id
          WHERE s.department = ${departmentName}
          ORDER BY u.role, u.name
        `,
        prisma.$queryRaw`
          SELECT u.name as doctor_name,
                 COUNT(a.id) as total_appointments,
                 COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed_appointments,
                 COUNT(CASE WHEN a.status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
                 ROUND(COUNT(a.id)::numeric / 30, 2) as avg_appointments_per_day
          FROM users u
          JOIN doctors doc ON u.id = doc.user_id
          LEFT JOIN appointments a ON u.id = a.doctor_id
            AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
          WHERE doc.department = ${departmentName}
          GROUP BY u.id, u.name
          ORDER BY total_appointments DESC
        `
      ]);

      return {
        department: { name: departmentName },
        allocation: {
          doctors: doctors.map(doc => ({
            ...doc,
            experience_years: parseInt(doc.experience_years),
            consultation_fee: parseFloat(doc.consultation_fee)
          })),
          staff: staffRows.map(s => ({
            ...s,
            salary: parseFloat(s.salary),
            hire_date: formatDate(s.hire_date)
          })),
          workload_analysis: workload.map(w => ({
            ...w,
            total_appointments: parseInt(w.total_appointments),
            completed_appointments: parseInt(w.completed_appointments),
            cancelled_appointments: parseInt(w.cancelled_appointments),
            avg_appointments_per_day: parseFloat(w.avg_appointments_per_day)
          }))
        },
        summary: {
          total_doctors: doctors.length,
          available_doctors: doctors.filter(d => d.is_available).length,
          total_staff: staffRows.length,
          active_staff: staffRows.filter(s => s.is_active).length
        }
      };
    } catch (error) {
      logger.error('Database error in getDepartmentStaffAllocation:', error);
      throw new Error('Failed to retrieve staff allocation');
    }
  }

  async createDepartmentWithValidation(data) {
      const {
        name, description, head_doctor_id, contact_number,
        location, budget, is_active = true
      } = data;

      // Check if department already exists
      const existingDept = await prisma.$queryRaw`
        SELECT id FROM departments WHERE name = ${name}
      `;
      if (existingDept.length > 0) {
        throw new Error('Department with this name already exists');
      }

      // Verify head doctor exists and is available
      if (head_doctor_id) {
        const doctorCheck = await prisma.$queryRaw`
          SELECT id, name FROM users WHERE id = ${head_doctor_id} AND role = 'DOCTOR'
        `;
        if (doctorCheck.length === 0) {
          throw new Error('Head doctor not found or invalid role');
        }

        // Check if doctor is already head of another department
        const existingHead = await prisma.$queryRaw`
          SELECT name FROM departments WHERE head_doctor_id = ${head_doctor_id} AND is_active = true
        `;
        if (existingHead.length > 0) {
          throw new Error(`Doctor is already head of ${existingHead[0].name} department`);
        }
      }

      const rows = await prisma.$queryRaw`
        INSERT INTO departments (
          name, description, head_doctor_id, contact_number,
          location, budget, is_active, created_at
        ) VALUES (${name}, ${description}, ${head_doctor_id}, ${contact_number}, ${location}, ${budget}, ${is_active}, NOW())
        RETURNING id, name, code, head_uid, is_active, description, floor, building, created_at, updated_at
      `;

      // Log audit
      await departmentAuditService.logDepartmentChange(
        rows[0].id,
        data.created_by || 1,
        'CREATE',
        null,
        rows[0]
      );

      return {
        ...rows[0],
        budget: parseFloat(rows[0].budget) || 0,
        created_at: formatDate(rows[0].created_at)
      };
  }

  async performBulkOperation(operation, departmentIds, data = {}) {
    try {
      let results = [];

      switch (operation) {
        case 'activate': {
          results = await prisma.$queryRaw`
            UPDATE departments SET is_active = true, updated_at = NOW()
            WHERE id = ANY(${departmentIds}::int[])
            RETURNING id, name
          `;
          break;
        }
        case 'deactivate': {
          results = await prisma.$queryRaw`
            UPDATE departments SET is_active = false, updated_at = NOW()
            WHERE id = ANY(${departmentIds}::int[])
            RETURNING id, name
          `;
          break;
        }
        case 'update_budget': {
          if (!data.budget) {
            throw new Error('Budget is required for update_budget operation');
          }
          const rawResults = await prisma.$queryRaw`
            UPDATE departments SET budget = ${data.budget}, updated_at = NOW()
            WHERE id = ANY(${departmentIds}::int[])
            RETURNING id, name, budget
          `;
          results = rawResults.map(row => ({
            ...row,
            budget: parseFloat(row.budget)
          }));
          break;
        }
        case 'reassign_head': {
          if (!data.head_doctor_id) {
            throw new Error('Head doctor ID is required for reassign_head operation');
          }
          const doctorCheck = await prisma.$queryRaw`
            SELECT name FROM users WHERE id = ${data.head_doctor_id} AND role = 'DOCTOR'
          `;
          if (doctorCheck.length === 0) {
            throw new Error('Head doctor not found');
          }
          results = await prisma.$queryRaw`
            UPDATE departments SET head_doctor_id = ${data.head_doctor_id}, updated_at = NOW()
            WHERE id = ANY(${departmentIds}::int[])
            RETURNING id, name
          `;
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
      // Get department info
      const deptCheck = await prisma.$queryRaw`
        SELECT name, is_active FROM departments WHERE id = ${id}
      `;
      if (deptCheck.length === 0) {
        throw new Error('Department not found');
      }
      if (!deptCheck[0].is_active) {
        throw new Error('Department is already inactive');
      }

      // Check active doctors/staff
      const [activeDoctors, activeStaff] = await Promise.all([
        prisma.$queryRaw`
          SELECT COUNT(*) as count FROM doctors WHERE department = ${deptCheck[0].name} AND is_available = true
        `,
        prisma.$queryRaw`
          SELECT COUNT(*) as count FROM staff WHERE department = ${deptCheck[0].name} AND is_active = true
        `
      ]);

      const doctorCount = parseInt(activeDoctors[0].count);
      const staffCount = parseInt(activeStaff[0].count);

      if ((doctorCount > 0 || staffCount > 0) && !reassignToDepartment) {
        throw new Error(`Cannot deactivate department with ${doctorCount} active doctors and ${staffCount} active staff`);
      }

      let targetDeptName = null;

      if (reassignToDepartment && (doctorCount > 0 || staffCount > 0)) {
        const targetDept = await prisma.$queryRaw`
          SELECT name FROM departments WHERE id = ${reassignToDepartment} AND is_active = true
        `;
        if (targetDept.length === 0) {
          throw new Error('Target department for reassignment not found');
        }
        targetDeptName = targetDept[0].name;

        // Reassign doctors and staff
        await Promise.all([
          prisma.$executeRaw`
            UPDATE doctors SET department = ${targetDeptName}
            WHERE department = ${deptCheck[0].name} AND is_available = true
          `,
          prisma.$executeRaw`
            UPDATE staff SET department = ${targetDeptName}
            WHERE department = ${deptCheck[0].name} AND is_active = true
          `
        ]);
      }

      const rows = await prisma.$queryRaw`
        UPDATE departments SET
          is_active = false,
          head_doctor_id = NULL,
          deactivation_reason = ${reason},
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING id, name, code, head_uid, is_active, description, floor, building, created_at, updated_at
      `;

      // Log audit
      await departmentAuditService.logDepartmentChange(
        id,
        1,
        'DEACTIVATE',
        deptCheck[0],
        rows[0]
      );

      return {
        department: {
          ...rows[0],
          created_at: formatDate(rows[0].created_at),
          updated_at: formatDate(rows[0].updated_at)
        },
        reassigned: {
          doctors: reassignToDepartment ? doctorCount : 0,
          staff: reassignToDepartment ? staffCount : 0,
          to_department: targetDeptName
        }
      };
  }

  async updateDepartment(id, data) {
      const {
        name, description, head_doctor_id, contact_number,
        location, budget, is_active
      } = data;

      // Check if department exists
      const existingDept = await prisma.$queryRaw`
        SELECT id, name, code, head_uid, is_active, description, floor, building, created_at, updated_at
        FROM departments WHERE id = ${id}
      `;
      if (existingDept.length === 0) {
        throw new Error('Department not found');
      }

      // If changing name, check if new name already exists
      if (name && name !== existingDept[0].name) {
        const nameCheck = await prisma.$queryRaw`
          SELECT id FROM departments WHERE name = ${name} AND id != ${id}
        `;
        if (nameCheck.length > 0) {
          throw new Error('Department with this name already exists');
        }
      }

      // Verify head doctor if changing
      if (head_doctor_id && head_doctor_id !== existingDept[0].head_doctor_id) {
        const doctorCheck = await prisma.$queryRaw`
          SELECT name FROM users WHERE id = ${head_doctor_id} AND role = 'DOCTOR'
        `;
        if (doctorCheck.length === 0) {
          throw new Error('Head doctor not found or invalid role');
        }

        const existingHead = await prisma.$queryRaw`
          SELECT name FROM departments WHERE head_doctor_id = ${head_doctor_id} AND id != ${id} AND is_active = true
        `;
        if (existingHead.length > 0) {
          throw new Error(`Doctor is already head of ${existingHead[0].name} department`);
        }
      }

      const rows = await prisma.$queryRaw`
        UPDATE departments SET
          name = COALESCE(${name}, name),
          description = COALESCE(${description}, description),
          head_doctor_id = COALESCE(${head_doctor_id}, head_doctor_id),
          contact_number = COALESCE(${contact_number}, contact_number),
          location = COALESCE(${location}, location),
          budget = COALESCE(${budget}, budget),
          is_active = COALESCE(${is_active}, is_active),
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING id, name, code, head_uid, is_active, description, floor, building, created_at, updated_at
      `;

      // Log audit
      await departmentAuditService.logDepartmentChange(
        id,
        data.updated_by || 1,
        'UPDATE',
        existingDept[0],
        rows[0]
      );

      return {
        ...rows[0],
        budget: parseFloat(rows[0].budget) || 0,
        created_at: formatDate(rows[0].created_at),
        updated_at: formatDate(rows[0].updated_at)
      };
  }
}

export default new AdminDepartmentService();
