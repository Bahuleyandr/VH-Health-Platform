import express from 'express';
import db from '../../config/database.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';

const router = express.Router();

// POST /steps/sync — upsert today's step log
router.post('/sync', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const { steps, distance_km = 0, active_min = 0, log_date } = req.body;
    if (typeof steps !== 'number' || steps < 0) {
      return error(res, 'Invalid steps value', HTTP_STATUS.BAD_REQUEST);
    }
    if (steps > 100000) {
      return error(res, 'Steps value exceeds maximum (100,000)', HTTP_STATUS.BAD_REQUEST);
    }

    const date = log_date || new Date().toISOString().split('T')[0];

    // Upsert step log
    const result = await db.query(`
      INSERT INTO step_logs (patient_uid, log_date, steps, distance_km, active_min)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (patient_uid, log_date)
      DO UPDATE SET
        steps = EXCLUDED.steps,
        distance_km = EXCLUDED.distance_km,
        active_min = EXCLUDED.active_min,
        updated_at = NOW()
      RETURNING *
    `, [uid, date, steps, distance_km, active_min]);

    // Update lifetime totals on step_profile
    await db.query(`
      INSERT INTO step_profile (patient_uid, leaderboard_name, total_steps, total_distance_km)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (patient_uid)
      DO UPDATE SET
        total_steps = (SELECT COALESCE(SUM(steps), 0) FROM step_logs WHERE patient_uid = $1),
        total_distance_km = (SELECT COALESCE(SUM(distance_km), 0) FROM step_logs WHERE patient_uid = $1),
        updated_at = NOW()
    `, [uid, 'Walker', steps, distance_km]);

    success(res, result.rows[0], 'Steps synced');
  } catch (err) {
    logger.error('Error syncing steps:', err);
    error(res, 'Failed to sync steps', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// GET /steps/today — get today's step log for current patient
router.get('/today', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const today = new Date().toISOString().split('T')[0];
    const result = await db.query(
      `SELECT * FROM step_logs WHERE patient_uid = $1 AND log_date = $2`,
      [uid, today]
    );

    success(res, result.rows[0] || { steps: 0, distance_km: 0, active_min: 0 }, "Today's steps");
  } catch (err) {
    logger.error('Error getting today steps:', err);
    error(res, 'Failed to get steps', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// GET /steps/history?days=7 — get step history
router.get('/history', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);
    const days = Math.min(parseInt(req.query.days) || 7, 30);

    const result = await db.query(`
      SELECT log_date, steps, distance_km, active_min
      FROM step_logs
      WHERE patient_uid = $1 AND log_date >= CURRENT_DATE - INTERVAL '${days} days'
      ORDER BY log_date DESC
    `, [uid]);

    success(res, result.rows, 'Step history');
  } catch (err) {
    logger.error('Error getting step history:', err);
    error(res, 'Failed to get step history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// GET /steps/leaderboard — weekly top 20
router.get('/leaderboard', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        sp.leaderboard_name,
        sp.avatar_color,
        COALESCE(SUM(sl.steps), 0) AS weekly_steps,
        COALESCE(SUM(sl.distance_km), 0) AS weekly_distance_km,
        RANK() OVER (ORDER BY COALESCE(SUM(sl.steps), 0) DESC) AS rank
      FROM step_profile sp
      LEFT JOIN step_logs sl ON sl.patient_uid = sp.patient_uid
        AND sl.log_date >= DATE_TRUNC('week', CURRENT_DATE)
      WHERE sp.opt_out_leaderboard = false
      GROUP BY sp.leaderboard_name, sp.avatar_color
      ORDER BY weekly_steps DESC
      LIMIT 20
    `);

    success(res, result.rows, 'Leaderboard');
  } catch (err) {
    logger.error('Error getting leaderboard:', err);
    error(res, 'Failed to get leaderboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// GET /steps/my-rank — current patient's weekly rank
router.get('/my-rank', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const result = await db.query(`
      WITH weekly AS (
        SELECT patient_uid, COALESCE(SUM(steps), 0) AS weekly_steps
        FROM step_logs
        WHERE log_date >= DATE_TRUNC('week', CURRENT_DATE)
        GROUP BY patient_uid
      ),
      ranked AS (
        SELECT patient_uid, weekly_steps,
          RANK() OVER (ORDER BY weekly_steps DESC) AS rank
        FROM weekly
      )
      SELECT r.rank, r.weekly_steps, sp.leaderboard_name, sp.total_steps, sp.total_distance_km
      FROM ranked r
      JOIN step_profile sp ON sp.patient_uid = r.patient_uid
      WHERE r.patient_uid = $1
    `, [uid]);

    success(res, result.rows[0] || { rank: null, weekly_steps: 0 }, 'My rank');
  } catch (err) {
    logger.error('Error getting rank:', err);
    error(res, 'Failed to get rank', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// PUT /steps/profile — update leaderboard name & settings
router.put('/profile', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const { leaderboard_name, avatar_color, opt_out_leaderboard } = req.body;

    if (leaderboard_name !== undefined) {
      if (
        typeof leaderboard_name !== 'string' ||
        leaderboard_name.trim().length < 2 ||
        leaderboard_name.trim().length > 30
      ) {
        return error(res, 'Leaderboard name must be 2–30 characters', HTTP_STATUS.BAD_REQUEST);
      }
    }

    const result = await db.query(`
      INSERT INTO step_profile (patient_uid, leaderboard_name, avatar_color, opt_out_leaderboard)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (patient_uid)
      DO UPDATE SET
        leaderboard_name = COALESCE($2, step_profile.leaderboard_name),
        avatar_color = COALESCE($3, step_profile.avatar_color),
        opt_out_leaderboard = COALESCE($4, step_profile.opt_out_leaderboard),
        updated_at = NOW()
      RETURNING *
    `, [
      uid,
      leaderboard_name?.trim() ?? 'Walker',
      avatar_color ?? null,
      opt_out_leaderboard ?? false
    ]);

    success(res, result.rows[0], 'Profile updated');
  } catch (err) {
    logger.error('Error updating step profile:', err);
    error(res, 'Failed to update profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// GET /steps/profile — get current patient's step profile
router.get('/profile', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const result = await db.query(
      `SELECT * FROM step_profile WHERE patient_uid = $1`,
      [uid]
    );

    success(res, result.rows[0] || null, 'Step profile');
  } catch (err) {
    logger.error('Error getting step profile:', err);
    error(res, 'Failed to get profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
