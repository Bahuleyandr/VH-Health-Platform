// src/controllers/staff/staffAdminDashboardController.js
import prisma from '../../lib/prisma.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

// Staff Admin Dashboard
export const getStaffAdminDashboard = async (req, res) => {
  try {
    const dashboardData = await prisma.$queryRawUnsafe(`
      WITH staff_stats AS (
        SELECT 
          COUNT(DISTINCT s.id) as total_staff,
          COUNT(DISTINCT s.id) FILTER (WHERE s.is_active = true) as active_staff,
          COUNT(DISTINCT s.id) FILTER (WHERE s.on_leave = true) as on_leave,
          COUNT(DISTINCT s.id) FILTER (WHERE s.department = 'nursing') as nursing_staff,
          COUNT(DISTINCT s.id) FILTER (WHERE s.department = 'pharmacy') as pharmacy_staff,
          COUNT(DISTINCT s.id) FILTER (WHERE s.department = 'lab') as lab_staff,
          COUNT(DISTINCT s.id) FILTER (WHERE s.department = 'administrative') as admin_staff
        FROM staff s
      ),
      attendance_today AS (
        SELECT 
          COUNT(DISTINCT staff_id) as present_today,
          COUNT(DISTINCT staff_id) FILTER (WHERE check_in_time::time > '09:30:00') as late_today,
          COUNT(DISTINCT staff_id) FILTER (WHERE check_out_time IS NULL) as currently_on_site
        FROM staff_attendance
        WHERE check_in_time::date = CURRENT_DATE
      ),
      hr_pending AS (
        SELECT 
          COUNT(*) FILTER (WHERE status = 'pending') as pending_reviews,
          COUNT(*) FILTER (WHERE status = 'pending') as pending_leaves
        FROM (
          SELECT status FROM performance_reviews WHERE status = 'pending'
          UNION ALL
          SELECT status FROM leave_applications WHERE status = 'pending'
        ) hr_actions
      )
      SELECT 
        to_json(staff_stats.*) as staff,
        to_json(attendance_today.*) as attendance,
        to_json(hr_pending.*) as hr_actions
      FROM staff_stats, attendance_today, hr_pending
    `);

    const recentActivity = await prisma.$queryRawUnsafe(`
      SELECT 
        'attendance' as type,
        CONCAT(s.name, ' checked in') as description,
        a.check_in_time as timestamp
      FROM staff_attendance a
      JOIN staff s ON a.staff_id = s.id
      WHERE a.check_in_time >= NOW() - INTERVAL '24 hours'
      ORDER BY a.check_in_time DESC
      LIMIT 10
    `);

    success(res, {
      overview: dashboardData[0],
      recentActivity: recentActivity,
      lastUpdated: new Date()
    }, 'Staff admin dashboard loaded successfully');
  } catch (err) {
    logger.error('Staff Admin Dashboard Error:', err);
    error(res, 'Failed to load staff admin dashboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
