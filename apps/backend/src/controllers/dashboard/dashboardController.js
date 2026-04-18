// src/controllers/dashboard/dashboardController.js
// Patient dashboard endpoint — API key only (no JWT), used by Flutter app

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as pointService from '../../services/gamification/pointService.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';

/**
 * GET /api/v1/dashboard?phone=<phone>
 * Returns a minimal summary for the patient dashboard in the Flutter app.
 * Auth: API key only (validateApiKey middleware applied at mount point).
 *
 * Security: Returns minimal data to limit enumeration risk.
 * Does NOT return doctor names or appointment details — only dates and counts.
 */
export async function getPatientDashboard(req, res) {
  try {
    const { phone } = req.query;

    if (!phone) {
      return error(res, 'phone query parameter is required', 400);
    }

    const normalizedPhone = normalizePhone(phone);

    // --- 1. Get patient name ---
    const userResult = await prisma.$queryRawUnsafe(
      'SELECT name FROM users WHERE phone = $1', normalizedPhone);

    // Allow the request even if the user doesn't exist yet (might be first login)
    const name = userResult[0]?.name || null;

    // --- 2. Last appointment (past) — date only, no doctor/details ---
    const lastAppointmentResult = await prisma.$queryRawUnsafe(
      `SELECT date FROM appointments
       WHERE phone = $1 AND date < NOW()
       ORDER BY date DESC
       LIMIT 1`,
      normalizedPhone
    );

    // --- 3. Next upcoming appointment — date only ---
    const nextAppointmentResult = await prisma.$queryRawUnsafe(
      `SELECT date FROM appointments
       WHERE phone = $1 AND date >= NOW()
       ORDER BY date ASC
       LIMIT 1`,
      normalizedPhone
    );

    // --- 4. Total upcoming count ---
    const upcomingCountResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM appointments
       WHERE phone = $1 AND date >= NOW()`,
      normalizedPhone
    );
    const upcomingCount = parseInt(upcomingCountResult[0]?.count || '0', 10);

    // --- 5. Next appointment detail + visit progress (fire-and-forget) ---
    let nextAppointmentDetail = null;
    try {
      const visitProgress = await pointService.getNextVisitProgress(normalizedPhone);
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
      // Look up user_uid from users table by phone
      const userUidResult = await prisma.$queryRawUnsafe(
        'SELECT uid FROM users WHERE phone = $1 LIMIT 1', normalizedPhone
      );
      if (userUidResult.length > 0) {
        const summary = await pointService.getUserPointSummary(userUidResult[0].uid);
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
