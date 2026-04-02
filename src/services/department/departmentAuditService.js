// src/services/department/departmentAuditService.js
import prisma from '../../lib/prisma.js';
import { Prisma } from '@prisma/client';
import logger from '../../logging/logger.js';
import { formatDate } from '../../utils/department/departmentHelpers.js';

class DepartmentAuditService {
  async logDepartmentChange(departmentId, userId, action, oldData, newData) {
    try {
      await prisma.$executeRaw`
        INSERT INTO department_audit_log (
          department_id, user_id, action, old_data, new_data, created_at
        ) VALUES (${departmentId}, ${String(userId)}, ${action}, ${oldData ? JSON.stringify(oldData) : null}::jsonb, ${newData ? JSON.stringify(newData) : null}::jsonb, NOW())
      `;
      logger.info(`Department audit logged: ${action} on department ${departmentId} by user ${userId}`);
    } catch (error) {
      logger.error('Failed to log department change:', error);
      // Don't throw - audit logging should not break main operations
    }
  }

  async getDepartmentHistory(departmentId, limit = 50) {
    try {
      const rows = await prisma.$queryRaw`
        SELECT dal.*, u.name as user_name
        FROM department_audit_log dal
        JOIN users u ON dal.user_id::text = u.id::text
        WHERE dal.department_id = ${departmentId}
        ORDER BY dal.created_at DESC
        LIMIT ${limit}
      `;

      return rows.map(row => ({
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
      const safeLimit = parseInt(limit) || 100;
      const safeDays = parseInt(days) || 7;
      const rows = await prisma.$queryRaw(
        Prisma.sql`
          SELECT dal.*, u.name as user_name, d.name as department_name
          FROM department_audit_log dal
          JOIN users u ON dal.user_id::text = u.id::text
          JOIN departments d ON dal.department_id = d.id
          WHERE dal.created_at >= CURRENT_DATE - ${Prisma.raw(`'${safeDays} days'`)}::interval
          ORDER BY dal.created_at DESC
          LIMIT ${safeLimit}
        `
      );

      return rows.map(row => ({
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
