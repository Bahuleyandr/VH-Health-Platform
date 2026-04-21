// src/services/department/departmentExportService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { formatDate } from '../../utils/department/departmentHelpers.js';

async function getDepartmentColumns() {
  const rows = await prisma.$queryRaw`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'departments'
  `;

  return new Set(rows.map((row) => row.column_name));
}

class DepartmentExportService {
  async exportDepartmentsToCSV(filters = {}) {
    try {
      const { status = 'all' } = filters;
      const departmentColumns = await getDepartmentColumns();
      const hasHeadDoctor = departmentColumns.has('head_doctor_id');
      const locationSelect = departmentColumns.has('location')
        ? 'd.location'
        : 'NULL::text AS location';
      const contactSelect = departmentColumns.has('contact_number')
        ? 'd.contact_number'
        : 'NULL::text AS contact_number';
      const budgetSelect = departmentColumns.has('budget')
        ? 'd.budget'
        : 'NULL::numeric AS budget';
      const headDoctorSelect = hasHeadDoctor
        ? 'u.name as head_doctor_name'
        : 'NULL::text AS head_doctor_name';
      const headDoctorJoin = hasHeadDoctor
        ? 'LEFT JOIN users u ON d.head_doctor_id = u.id'
        : '';
      const whereClause = status === 'active'
        ? 'WHERE d.is_active = true'
        : status === 'inactive'
          ? 'WHERE d.is_active = false'
          : '';
      const groupByExtras = [
        departmentColumns.has('location') ? ', d.location' : '',
        departmentColumns.has('contact_number') ? ', d.contact_number' : '',
        departmentColumns.has('budget') ? ', d.budget' : '',
        hasHeadDoctor ? ', u.name' : '',
      ].join('');

      const rows = await prisma.$queryRawUnsafe(`
        SELECT d.id, d.name, d.description, d.is_active,
               ${locationSelect},
               ${contactSelect},
               ${budgetSelect},
               d.created_at, d.updated_at,
               ${headDoctorSelect},
               COUNT(DISTINCT doc.user_id) as doctor_count,
               COUNT(DISTINCT s.user_id) as staff_count
        FROM departments d
        ${headDoctorJoin}
        LEFT JOIN doctors doc ON doc.department_id = d.id OR doc.department = d.name
        LEFT JOIN staff s ON s.department = d.name AND s.is_active = true
        ${whereClause}
        GROUP BY d.id, d.name, d.description, d.is_active, d.created_at, d.updated_at
                 ${groupByExtras}
        ORDER BY d.name
      `);

      const headers = [
        'ID', 'Name', 'Description', 'Status', 'Location',
        'Contact', 'Budget (INR)', 'Head Doctor', 'Total Doctors',
        'Total Staff', 'Created Date', 'Updated Date'
      ];

      const csvRows = rows.map(dept => [
        dept.id,
        dept.name,
        dept.description,
        dept.is_active ? 'Active' : 'Inactive',
        dept.location || 'N/A',
        dept.contact_number || 'N/A',
        dept.budget || 0,
        dept.head_doctor_name || 'N/A',
        dept.doctor_count,
        dept.staff_count,
        formatDate(dept.created_at),
        dept.updated_at ? formatDate(dept.updated_at) : 'N/A'
      ]);

      return {
        headers,
        rows: csvRows,
        count: csvRows.length
      };
    } catch (error) {
      logger.error('Error exporting departments:', error);
      throw error;
    }
  }

  async exportDepartmentReport(departmentId) {
    try {
      const departmentColumns = await getDepartmentColumns();
      const hasHeadDoctor = departmentColumns.has('head_doctor_id');
      const deptInfoQuery = hasHeadDoctor
        ? prisma.$queryRaw`
            SELECT d.*, u.name as head_doctor_name
            FROM departments d
            LEFT JOIN users u ON d.head_doctor_id = u.id
            WHERE d.id = ${departmentId}
          `
        : prisma.$queryRaw`
            SELECT d.*, NULL::text as head_doctor_name
            FROM departments d
            WHERE d.id = ${departmentId}
          `;

      const [deptInfo, stats, recentActivities] = await Promise.all([
        deptInfoQuery,
        prisma.$queryRaw`
          SELECT
            COUNT(DISTINCT doc.user_id) as total_doctors,
            COUNT(DISTINCT s.user_id) as total_staff,
            COUNT(DISTINCT a.id) as total_appointments_30d,
            SUM(CASE WHEN a.status = 'COMPLETED' THEN doc.consultation_fee ELSE 0 END) as revenue_30d
          FROM departments d
          LEFT JOIN doctors doc ON doc.department = d.name
          LEFT JOIN staff s ON s.department = d.name AND s.is_active = true
          LEFT JOIN appointments a ON doc.user_id = a.doctor_id
            AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
          WHERE d.id = ${departmentId}
          GROUP BY d.id
        `,
        prisma.$queryRaw`
          SELECT action, created_at, u.name as user_name
          FROM department_audit_log dal
          JOIN users u ON dal.user_id::text = u.id::text
          WHERE dal.department_id = ${departmentId}
          ORDER BY dal.created_at DESC
          LIMIT 10
        `
      ]);

      if (deptInfo.length === 0) {
        throw new Error('Department not found');
      }

      return {
        department: {
          ...deptInfo[0],
          created_at: formatDate(deptInfo[0].created_at),
          updated_at: deptInfo[0].updated_at ? formatDate(deptInfo[0].updated_at) : null
        },
        statistics: stats[0] || {},
        recent_activities: recentActivities.map(activity => ({
          ...activity,
          created_at: formatDate(activity.created_at)
        }))
      };
    } catch (error) {
      logger.error('Error generating department report:', error);
      throw error;
    }
  }
}

export default new DepartmentExportService();
