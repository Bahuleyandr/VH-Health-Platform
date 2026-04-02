// src/controllers/dashboard/dashboardController.js
// Patient dashboard endpoint — API key only (no JWT), used by Flutter app

import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';
import { normalizePhone } from '../../utils/phoneUtils.js';

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
    const userResult = await db.query(
      'SELECT name FROM users WHERE phone = $1',
      [normalizedPhone]
    );

    // Allow the request even if the user doesn't exist yet (might be first login)
    const name = userResult.rows[0]?.name || null;

    // --- 2. Last appointment (past) — date only, no doctor/details ---
    const lastAppointmentResult = await db.query(
      `SELECT date FROM appointments
       WHERE phone = $1 AND date < NOW()
       ORDER BY date DESC
       LIMIT 1`,
      [normalizedPhone]
    );

    // --- 3. Next upcoming appointment — date only ---
    const nextAppointmentResult = await db.query(
      `SELECT date FROM appointments
       WHERE phone = $1 AND date >= NOW()
       ORDER BY date ASC
       LIMIT 1`,
      [normalizedPhone]
    );

    // --- 4. Total upcoming count ---
    const upcomingCountResult = await db.query(
      `SELECT COUNT(*) FROM appointments
       WHERE phone = $1 AND date >= NOW()`,
      [normalizedPhone]
    );
    const upcomingCount = parseInt(upcomingCountResult.rows[0]?.count || '0', 10);

    return success(res, {
      name,
      lastAppointment: lastAppointmentResult.rows[0]?.date || null,
      nextAppointment: nextAppointmentResult.rows[0]?.date || null,
      upcomingCount
    }, 'Dashboard data retrieved successfully');

  } catch (err) {
    logger.error('Dashboard Controller Error:', err.stack || err.toString());
    return error(res, 'Failed to fetch dashboard data');
  }
}
