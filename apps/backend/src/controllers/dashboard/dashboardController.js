// src/controllers/dashboard/dashboardController.js
// Patient dashboard endpoint — JWT + PATIENT role (enforced at mount in app.js).
// Audit finding H1 (2026-06-10): this endpoint previously sat in front of the
// JWT gate, took `phone` from the query string, and returned PHI (name,
// appointment dates/times, doctor name, loyalty tier) for ANY phone number
// with no tenant scoping. It is now self-scoped and tenant-scoped.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as pointService from '../../services/gamification/pointService.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';

/**
 * GET /api/v1/dashboard
 * Returns a summary for the authenticated patient's dashboard in the Flutter
 * app: name, last/next appointment dates, upcoming count, next-appointment
 * detail (incl. doctor name — safe now that the caller is authenticated and
 * self-scoped), and health-points summary.
 *
 * Auth: global jwtAuth + requireRole('PATIENT') at the mount point.
 * Scoping rules (fail closed):
 *   - The phone is derived from the authenticated subject (req.user.phone,
 *     falling back to a tenant-scoped users lookup by uid). A caller-supplied
 *     `?phone=` is accepted ONLY if it normalizes to the caller's own phone;
 *     any other value → 403. The query param is never used as the data key.
 *   - Every query is tenant-scoped via req.tenantId.
 */
export async function getPatientDashboard(req, res) {
  try {
    const tenantId = req.tenantId || req.user?.tenant_id || req.user?.tenantId;
    if (!req.user?.uid || !tenantId) {
      // Fail closed: without an authenticated subject and tenant context we
      // cannot scope the queries safely.
      return error(res, 'Forbidden', 403);
    }

    // --- Resolve the caller's own phone (never trust the query string) ---
    let ownPhone = normalizePhone(req.user.phone);
    if (!ownPhone) {
      const ownUserResult = await prisma.$queryRawUnsafe(
        'SELECT phone FROM users WHERE uid = $1::uuid AND tenant_id = $2::uuid LIMIT 1',
        req.user.uid,
        tenantId
      );
      ownPhone = normalizePhone(ownUserResult[0]?.phone);
    }
    if (!ownPhone) {
      return error(res, 'No phone number associated with this account', 403);
    }

    // Legacy clients still send ?phone= — accept it only when it is the
    // caller's own number; reject anything else (blocks enumeration).
    if (req.query.phone && normalizePhone(req.query.phone) !== ownPhone) {
      return error(res, 'Forbidden: phone does not match authenticated user', 403);
    }

    const normalizedPhone = ownPhone;

    // --- 1. Get patient name (tenant-scoped) ---
    const userResult = await prisma.$queryRawUnsafe(
      'SELECT name FROM users WHERE phone = $1 AND tenant_id = $2::uuid',
      normalizedPhone,
      tenantId
    );

    const name = userResult[0]?.name || null;

    // --- 2. Last appointment (past) — date only (tenant-scoped) ---
    const lastAppointmentResult = await prisma.$queryRawUnsafe(
      `SELECT appointment_date AS date FROM appointments
       WHERE phone = $1 AND tenant_id = $2::uuid AND appointment_date < CURRENT_DATE
       ORDER BY appointment_date DESC
       LIMIT 1`,
      normalizedPhone,
      tenantId
    );

    // --- 3. Next upcoming appointment — date only (tenant-scoped) ---
    const nextAppointmentResult = await prisma.$queryRawUnsafe(
      `SELECT appointment_date AS date FROM appointments
       WHERE phone = $1 AND tenant_id = $2::uuid AND appointment_date >= CURRENT_DATE
       ORDER BY appointment_date ASC
       LIMIT 1`,
      normalizedPhone,
      tenantId
    );

    // --- 4. Total upcoming count (tenant-scoped) ---
    const upcomingCountResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM appointments
       WHERE phone = $1 AND tenant_id = $2::uuid AND appointment_date >= CURRENT_DATE`,
      normalizedPhone,
      tenantId
    );
    const upcomingCount = parseInt(upcomingCountResult[0]?.count || '0', 10);

    // --- 5. Next appointment detail + visit progress (fire-and-forget) ---
    let nextAppointmentDetail = null;
    try {
      const visitProgress = await pointService.getNextVisitProgress(normalizedPhone, tenantId); // CAN-019: tenant-scope
      if (visitProgress && visitProgress.nextAppointment) {
        const next = visitProgress.nextAppointment;
        nextAppointmentDetail = {
          doctorName: next.doctor_name || null,
          date: next.appointment_date || null,
          time: next.appointment_time || null,
          daysUntil: visitProgress.daysUntil,
          totalDaysBetween: visitProgress.totalDaysBetween,
          progressFraction: visitProgress.progressFraction,
        };
      }
    } catch (progressErr) {
      logger.warn('Dashboard: visit progress fetch failed', { error: progressErr.message });
    }

    // --- 6. Health points summary (fire-and-forget) ---
    let healthPoints = null;
    try {
      // Look up user_uid from users table by phone (tenant-scoped)
      const userUidResult = await prisma.$queryRawUnsafe(
        'SELECT uid FROM users WHERE phone = $1 AND tenant_id = $2::uuid LIMIT 1',
        normalizedPhone,
        tenantId
      );
      if (userUidResult.length > 0) {
        const summary = await pointService.getUserPointSummary(userUidResult[0].uid, tenantId); // CAN-012: tenant-scope
        healthPoints = {
          totalPoints: summary.totalPoints,
          currentTier: summary.currentTier,
          nextTier: summary.nextTier,
          unclaimedCount: summary.unclaimedCount,
        };
      }
    } catch (hpErr) {
      logger.warn('Dashboard: health points fetch failed', { error: hpErr.message });
    }

    return success(res, {
      name,
      lastAppointment: lastAppointmentResult[0]?.date || null,
      nextAppointment: nextAppointmentResult[0]?.date || null,
      upcomingCount,
      nextAppointmentDetail,
      healthPoints
    }, 'Dashboard data retrieved successfully');

  } catch (err) {
    logger.error('Dashboard Controller Error:', err.stack || err.toString());
    return error(res, 'Failed to fetch dashboard data');
  }
}
