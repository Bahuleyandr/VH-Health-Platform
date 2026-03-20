// src/controllers/dashboard/dashboardController.js
// Patient dashboard endpoint — API key only (no JWT), used by Flutter app

import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

/**
 * GET /api/v1/dashboard?phone=<phone>
 * Returns a summary for the patient dashboard in the Flutter app.
 * Auth: API key only (validateApiKey middleware applied at mount point)
 */
export async function getPatientDashboard(req, res) {
  try {
    const { phone } = req.query;

    if (!phone) {
      return res.status(400).json({ success: false, error: 'phone query parameter is required' });
    }

    // --- 1. Get patient name ---
    const userResult = await db.query(
      'SELECT name FROM users WHERE phone = $1',
      [phone]
    );

    // Allow the request even if the user doesn't exist yet (might be first login)
    const name = userResult.rows[0]?.name || null;

    // --- 2. Last appointment (past) ---
    const lastAppointmentResult = await db.query(
      `SELECT * FROM appointments
       WHERE phone = $1 AND date < NOW()
       ORDER BY date DESC
       LIMIT 1`,
      [phone]
    );
    const lastAppointment = lastAppointmentResult.rows[0] || null;

    // --- 3. Next upcoming appointment ---
    const nextAppointmentResult = await db.query(
      `SELECT * FROM appointments
       WHERE phone = $1 AND date >= NOW()
       ORDER BY date ASC
       LIMIT 1`,
      [phone]
    );
    const nextAppointment = nextAppointmentResult.rows[0] || null;

    // --- 4. Total upcoming count ---
    const upcomingCountResult = await db.query(
      `SELECT COUNT(*) FROM appointments
       WHERE phone = $1 AND date >= NOW()`,
      [phone]
    );
    const upcomingCount = parseInt(upcomingCountResult.rows[0]?.count || '0', 10);

    logger.info(`📊 Dashboard fetched for phone: ${phone}`);

    return success(res, {
      name,
      lastAppointment,
      nextAppointment,
      upcomingCount
    }, 'Dashboard data retrieved successfully');

  } catch (err) {
    logger.error('Dashboard Controller Error:', err.stack || err.toString());
    return error(res, 'Failed to fetch dashboard data');
  }
}
