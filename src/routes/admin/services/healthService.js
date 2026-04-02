// src/routes/admin/services/healthService.js
import prisma from '../../../lib/prisma.js';

/**
 * Module health:
 * - 'healthy' if table is readable and no detected conflicts
 * - 'warning' only for real heuristics (e.g., appointment overlaps, SOS backlog, attendance issues)
 * - 'unhealthy' if the underlying query fails (missing table/permissions/DB down)
 */
export async function getModuleHealth() {
  const health = {};

  const exists = async (sql, params = []) => {
    try {
      const r = await prisma.$queryRawUnsafe(sql, params);
      return r.length > 0;
    } catch {
      return false;
    }
  };

  // Users
  try {
    await prisma.$queryRawUnsafe('SELECT 1 FROM users LIMIT 1');
    health.users = 'healthy';
  } catch {
    health.users = 'unhealthy';
  }

  // Appointments (warning on schedule conflicts)
  try {
    await prisma.$queryRawUnsafe('SELECT 1 FROM appointments LIMIT 1');
    const hasConflict = await exists(
      `
      SELECT 1
      FROM appointments a1
      JOIN appointments a2 ON a1.doctor_id = a2.doctor_id
      WHERE a1.id <> a2.id
        AND a1.status = 'scheduled' AND a2.status = 'scheduled'
        AND DATE(a1.appointment_date) = CURRENT_DATE
        AND a1.appointment_date < a2.appointment_date
        AND a1.appointment_date + INTERVAL '30 minutes' > a2.appointment_date
      LIMIT 1
      `
    );
    health.appointments = hasConflict ? 'warning' : 'healthy';
  } catch {
    health.appointments = 'unhealthy';
  }

  // Pharmacy
  try {
    await prisma.$queryRawUnsafe('SELECT 1 FROM pharmacy_orders LIMIT 1');
    health.pharmacy = 'healthy';
  } catch {
    health.pharmacy = 'unhealthy';
  }

  // Investigations
  try {
    await prisma.$queryRawUnsafe('SELECT 1 FROM investigations LIMIT 1');
    health.investigations = 'healthy';
  } catch {
    health.investigations = 'unhealthy';
  }

  // Emergency (warning if a lot of active alerts)
  try {
    const sosWarning = await exists(
      `
      SELECT 1 FROM sos_alerts
      WHERE status = 'active'
      OFFSET 5 LIMIT 1
      `
    );
    health.emergency = sosWarning ? 'warning' : 'healthy';
  } catch {
    health.emergency = 'unhealthy';
  }

  // Staff (warning if many active staff did not check in)
  try {
    const staffIssuesWarning = await exists(
      `
      SELECT 1
      FROM staff s
      WHERE COALESCE(s.is_active, true) = true 
        AND COALESCE(s.on_leave, false) = false
        AND NOT EXISTS (
          SELECT 1 FROM staff_attendance a 
          WHERE a.staff_id = s.id 
            AND a.check_in_time::date = CURRENT_DATE
        )
      OFFSET 10 LIMIT 1
      `
    );
    health.staff = staffIssuesWarning ? 'warning' : 'healthy';
  } catch {
    health.staff = 'unhealthy';
  }

  return health;
}

/**
 * Optional system-level health (not used by endpoints, but kept for parity).
 */
export async function getSystemHealth() {
  // Keep shape as in existing codebase
  return {
    database: 'connected',
    cache: 'active',
    storage: 'available',
    notifications: 'operational',
  };
}

export default { getModuleHealth, getSystemHealth };
