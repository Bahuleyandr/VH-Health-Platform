// src/controllers/staff/staffAdminDashboardController.js
import { setTenantTx } from '../../lib/prisma.js';
import { success, relayAppError } from '../../utils/responseHelper.js';
import { requestTenantId } from './staffAdminTenant.js';

// Staff Admin Dashboard
export const getStaffAdminDashboard = async (req, res) => {
  try {
    const tenantId = requestTenantId(req);
    const dashboardData = await setTenantTx(tenantId, tx => tx.$queryRawUnsafe(`
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
        WHERE s.tenant_id = $1::uuid
      ),
      attendance_today AS (
        SELECT 
          COUNT(DISTINCT staff_id) as present_today,
          COUNT(DISTINCT staff_id) FILTER (WHERE check_in_time::time > '09:30:00') as late_today,
          COUNT(DISTINCT staff_id) FILTER (WHERE check_out_time IS NULL) as currently_on_site
        FROM staff_attendance
        WHERE check_in_time::date = CURRENT_DATE
          AND tenant_id = $1::uuid
      ),
      hr_pending AS (
        SELECT
          COALESCE((
            SELECT COUNT(*)
            FROM staff_performance_reviews
            WHERE review_date IS NULL
              AND tenant_id = $1::uuid
          ), 0) as pending_reviews,
          COALESCE((
            SELECT COUNT(*)
            FROM leave_applications
            WHERE status = 'pending'
              AND tenant_id = $1::uuid
          ), 0) as pending_leaves
      )
      SELECT 
        to_json(staff_stats.*) as staff,
        to_json(attendance_today.*) as attendance,
        to_json(hr_pending.*) as hr_actions
      FROM staff_stats, attendance_today, hr_pending
    `, tenantId));

    const recentActivity = await setTenantTx(tenantId, tx => tx.$queryRawUnsafe(`
      SELECT 
        'attendance' as type,
        CONCAT(s.name, ' checked in') as description,
        a.check_in_time as timestamp
      FROM staff_attendance a
      JOIN users u ON a.staff_id = u.id AND u.tenant_id = $1::uuid
      JOIN staff s ON s.user_id = u.uid AND s.tenant_id = $1::uuid
      WHERE a.check_in_time >= NOW() - INTERVAL '24 hours'
        AND a.tenant_id = $1::uuid
      ORDER BY a.check_in_time DESC
      LIMIT 10
    `, tenantId));

    success(res, {
      overview: dashboardData[0],
      recentActivity: recentActivity,
      lastUpdated: new Date()
    }, 'Staff admin dashboard loaded successfully');
  } catch (err) {
    relayAppError(res, err, 'Failed to load staff admin dashboard');
  }
};
