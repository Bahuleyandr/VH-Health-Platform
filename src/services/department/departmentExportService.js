// src/services/department/departmentExportService.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { formatDate } from '../../utils/department/departmentHelpers.js';

class DepartmentExportService {
  async exportDepartmentsToCSV(filters = {}) {
    try {
      const { status = 'all' } = filters;
      
      let query = `
        SELECT d.id, d.name, d.description, d.is_active, d.location,
               d.contact_number, d.budget, d.created_at, d.updated_at,
               u.name as head_doctor_name,
               COUNT(DISTINCT doc.user_id) as doctor_count,
               COUNT(DISTINCT s.user_id) as staff_count
        FROM departments d
        LEFT JOIN users u ON d.head_doctor_id = u.id
        LEFT JOIN doctors doc ON doc.department = d.name
        LEFT JOIN staff s ON s.department = d.name AND s.is_active = true
        WHERE 1=1
      `;
      
      if (status === 'active') {
        query += ' AND d.is_active = true';
      } else if (status === 'inactive') {
        query += ' AND d.is_active = false';
      }
      
      query += ` GROUP BY d.id, d.name, d.description, d.is_active, d.location,
                 d.contact_number, d.budget, d.created_at, d.updated_at, u.name
                 ORDER BY d.name`;
      
      const result = await db.query(query);
      
      // Format for CSV
      const headers = [
        'ID', 'Name', 'Description', 'Status', 'Location', 
        'Contact', 'Budget (INR)', 'Head Doctor', 'Total Doctors', 
        'Total Staff', 'Created Date', 'Updated Date'
      ];
      
      const rows = result.rows.map(dept => [
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
        rows,
        count: rows.length
      };
    } catch (error) {
      logger.error('Error exporting departments:', error);
      throw error;
    }
  }
  
  async exportDepartmentReport(departmentId) {
    try {
      const [deptInfo, stats, financial] = await Promise.all([
        // Department info
        db.query(`
          SELECT d.*, u.name as head_doctor_name
          FROM departments d
          LEFT JOIN users u ON d.head_doctor_id = u.id
          WHERE d.id = $1
        `, [departmentId]),
        
        // Statistics
        db.query(`
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
          WHERE d.id = $1
          GROUP BY d.id
        `, [departmentId]),
        
        // Recent activities
        db.query(`
          SELECT action, created_at, u.name as user_name
          FROM department_audit_log dal
          JOIN users u ON dal.user_id = u.id
          WHERE dal.department_id = $1
          ORDER BY dal.created_at DESC
          LIMIT 10
        `, [departmentId])
      ]);
      
      if (deptInfo.rows.length === 0) {
        throw new Error('Department not found');
      }
      
      return {
        department: {
          ...deptInfo.rows[0],
          created_at: formatDate(deptInfo.rows[0].created_at),
          updated_at: deptInfo.rows[0].updated_at ? formatDate(deptInfo.rows[0].updated_at) : null
        },
        statistics: stats.rows[0] || {},
        recent_activities: financial.rows.map(activity => ({
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