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

// GET /steps/history/tiered — tiered history: day/week/month resolution
router.get('/history/tiered', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);
    const ninetyDaysAgo = new Date(now);
    ninetyDaysAgo.setDate(now.getDate() - 90);

    // Last 30 days: day-by-day
    const dailyResult = await db.query(`
      SELECT
        log_date::text AS period,
        steps,
        ROUND(distance_km::numeric, 3) AS distance_km,
        'day' AS resolution
      FROM step_logs
      WHERE patient_uid = $1 AND log_date >= $2
      ORDER BY log_date DESC
    `, [uid, thirtyDaysAgo.toISOString().split('T')[0]]);

    // 31-90 days: week-by-week average (ISO week)
    const weeklyResult = await db.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('week', log_date), 'YYYY-MM-DD') AS period,
        ROUND(AVG(steps)) AS steps,
        ROUND(AVG(distance_km::numeric), 3) AS distance_km,
        'week' AS resolution
      FROM step_logs
      WHERE patient_uid = $1
        AND log_date >= $2
        AND log_date < $3
      GROUP BY DATE_TRUNC('week', log_date)
      ORDER BY DATE_TRUNC('week', log_date) DESC
    `, [uid, ninetyDaysAgo.toISOString().split('T')[0], thirtyDaysAgo.toISOString().split('T')[0]]);

    // 91+ days: month-by-month average
    const monthlyResult = await db.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', log_date), 'YYYY-MM-DD') AS period,
        ROUND(AVG(steps)) AS steps,
        ROUND(AVG(distance_km::numeric), 3) AS distance_km,
        'month' AS resolution
      FROM step_logs
      WHERE patient_uid = $1
        AND log_date < $2
      GROUP BY DATE_TRUNC('month', log_date)
      ORDER BY DATE_TRUNC('month', log_date) DESC
    `, [uid, ninetyDaysAgo.toISOString().split('T')[0]]);

    success(res, {
      daily: dailyResult.rows,
      weekly: weeklyResult.rows,
      monthly: monthlyResult.rows,
    }, 'Tiered step history');
  } catch (err) {
    logger.error('Error getting tiered step history:', err);
    error(res, 'Failed to get step history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// POST /steps/sessions/start — start a new session
router.post('/sessions/start', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);
    const result = await db.query(`
      INSERT INTO step_sessions (patient_uid, started_at)
      VALUES ($1, NOW())
      RETURNING *
    `, [uid]);
    success(res, result.rows[0], 'Session started', HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Error starting session:', err);
    error(res, 'Failed to start session', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// PUT /steps/sessions/:id/end — end a session with final data
router.put('/sessions/:id/end', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);
    const sessionId = parseInt(req.params.id, 10);
    if (isNaN(sessionId)) return error(res, 'Invalid session ID', HTTP_STATUS.BAD_REQUEST);

    const { steps = 0, distance_km = 0, route_points = [] } = req.body;

    const result = await db.query(`
      UPDATE step_sessions
      SET
        ended_at = NOW(),
        steps = $1,
        distance_km = $2,
        duration_sec = EXTRACT(EPOCH FROM (NOW() - started_at))::int,
        route_points = $3
      WHERE id = $4 AND patient_uid = $5 AND ended_at IS NULL
      RETURNING *
    `, [steps, distance_km, JSON.stringify(route_points), sessionId, uid]);

    if (result.rows.length === 0) {
      return error(res, 'Session not found or already ended', HTTP_STATUS.NOT_FOUND);
    }

    // Also sync these steps to today's step_log
    const today = new Date().toISOString().split('T')[0];
    await db.query(`
      INSERT INTO step_logs (patient_uid, log_date, steps, distance_km)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (patient_uid, log_date)
      DO UPDATE SET
        steps = GREATEST(step_logs.steps, EXCLUDED.steps),
        distance_km = GREATEST(step_logs.distance_km, EXCLUDED.distance_km),
        updated_at = NOW()
    `, [uid, today, steps, distance_km]);

    success(res, result.rows[0], 'Session ended');
  } catch (err) {
    logger.error('Error ending session:', err);
    error(res, 'Failed to end session', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// GET /steps/sessions — list recent sessions for current patient
router.get('/sessions', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);
    const result = await db.query(`
      SELECT id, started_at, ended_at, steps, distance_km, duration_sec
      FROM step_sessions
      WHERE patient_uid = $1
      ORDER BY started_at DESC
      LIMIT 20
    `, [uid]);
    success(res, result.rows, 'Sessions');
  } catch (err) {
    logger.error('Error getting sessions:', err);
    error(res, 'Failed to get sessions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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
