// src/services/department/departmentAuditService.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { formatDate } from '../../utils/department/departmentHelpers.js';

class DepartmentAuditService {
  async logDepartmentChange(departmentId, userId, action, oldData, newData) {
    try {
      await db.query(`
        INSERT INTO department_audit_log (
          department_id, user_id, action, old_data, new_data, created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())
      `, [departmentId, userId, action, JSON.stringify(oldData), JSON.stringify(newData)]);
      
      logger.info(`Department audit logged: ${action} on department ${departmentId} by user ${userId}`);
    } catch (error) {
      logger.error('Failed to log department change:', error);
      // Don't throw - audit logging should not break main operations
    }
  }
  
  async getDepartmentHistory(departmentId, limit = 50) {
    try {
      const result = await db.query(`
        SELECT dal.*, u.name as user_name
        FROM department_audit_log dal
        JOIN users u ON dal.user_id = u.id
        WHERE dal.department_id = $1
        ORDER BY dal.created_at DESC
        LIMIT $2
      `, [departmentId, limit]);
      
      return result.rows.map(row => ({
        ...row,
        created_at: formatDate(row.created_at),
        old_data: row.old_data,
        new_data: row.new_data
      }));
    } catch (error) {
      logger.error('Failed to get department history:', error);
      throw error;
    }
  }
  
  async getRecentDepartmentActivities(days = 7, limit = 100) {
    try {
      const result = await db.query(`
        SELECT dal.*, u.name as user_name, d.name as department_name
        FROM department_audit_log dal
        JOIN users u ON dal.user_id = u.id
        JOIN departments d ON dal.department_id = d.id
        WHERE dal.created_at >= CURRENT_DATE - INTERVAL '${days} days'
        ORDER BY dal.created_at DESC
        LIMIT $1
      `, [limit]);
      
      return result.rows.map(row => ({
        ...row,
        created_at: formatDate(row.created_at)
      }));
    } catch (error) {
      logger.error('Failed to get recent activities:', error);
      throw error;
    }
  }
}

export default new DepartmentAuditService();