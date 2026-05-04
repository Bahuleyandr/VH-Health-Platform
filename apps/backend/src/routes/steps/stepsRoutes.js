// src/routes/steps/stepsRoutes.js
// Step Challenge — sessions, history (tiered), leaderboard, profile, rewards

import { Router } from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as pointService from '../../services/gamification/pointService.js';
import { success, error } from '../../utils/responseHelper.js';

const router = Router();

// ─── POST /session/start ────────────────────────────────────────────────────
// Creates a new active walk session; closes any existing active session first.
router.post('/session/start', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    // Close any open session
    await prisma.step_sessions.updateMany({
      where: { user_uid: uid, is_active: true },
      data: { is_active: false, ended_at: new Date() },
    });

    const session = await prisma.step_sessions.create({
      data: {
        user_uid: uid,
        started_at: new Date(),
        is_active: true,
      },
    });

    return success(res, { sessionId: session.id, startedAt: session.started_at }, 'Walk session started');
  } catch (err) {
    logger.error('steps/session/start error', { error: err.message });
    return error(res, 'Failed to start session', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ─── POST /session/stop ─────────────────────────────────────────────────────
// Finalises a session with accumulated step/distance data.
router.post('/session/stop', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const { sessionId, steps, distanceMeters, durationSeconds } = req.body;
    if (!sessionId) return error(res, 'sessionId is required', HTTP_STATUS.BAD_REQUEST);

    const existing = await prisma.step_sessions.findFirst({
      where: { id: parseInt(sessionId, 10), user_uid: uid },
    });
    if (!existing) return error(res, 'Session not found', HTTP_STATUS.NOT_FOUND);

    const updated = await prisma.step_sessions.update({
      where: { id: existing.id },
      data: {
        steps: parseInt(steps, 10) || 0,
        distance_meters: parseFloat(distanceMeters) || 0,
        duration_seconds: parseInt(durationSeconds, 10) || 0,
        is_active: false,
        ended_at: new Date(),
      },
    });

    // Gamification: fire-and-forget step goal check
    const profile = await prisma.step_profiles.findUnique({ where: { user_uid: uid } });
    pointService.awardStepPoints(uid, profile?.daily_goal || 8000).catch(err =>
      logger.warn('Gamification: step point award failed', { error: err.message })
    );

    return success(res, { session: updated }, 'Walk session stopped');
  } catch (err) {
    logger.error('steps/session/stop error', { error: err.message });
    return error(res, 'Failed to stop session', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ─── GET /history ────────────────────────────────────────────────────────────
// Tiered: daily (last 30 days), weekly (days 31-90), monthly (days 91+)
router.get('/history', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    // Daily — last 30 days
    const dailyRows = await prisma.$queryRaw`
      SELECT
        DATE(started_at AT TIME ZONE 'UTC') AS date,
        SUM(steps)::int                     AS steps,
        SUM(distance_meters)::float         AS "distanceMeters"
      FROM step_sessions
      WHERE user_uid = ${uid}::uuid
        AND is_active = false
        AND started_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(started_at AT TIME ZONE 'UTC')
      ORDER BY date DESC
    `;

    // Weekly — days 31-90 (aggregate by ISO week start)
    const weeklyRows = await prisma.$queryRaw`
      SELECT
        DATE_TRUNC('week', started_at AT TIME ZONE 'UTC')::date AS "weekStart",
        ROUND(AVG(steps))::int                                  AS "avgSteps",
        AVG(distance_meters)::float                             AS "avgDistanceMeters"
      FROM step_sessions
      WHERE user_uid = ${uid}::uuid
        AND is_active = false
        AND started_at >= NOW() - INTERVAL '90 days'
        AND started_at <  NOW() - INTERVAL '30 days'
      GROUP BY DATE_TRUNC('week', started_at AT TIME ZONE 'UTC')
      ORDER BY "weekStart" DESC
    `;

    // Monthly — days 91+
    const monthlyRows = await prisma.$queryRaw`
      SELECT
        TO_CHAR(started_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
        ROUND(AVG(steps))::int                            AS "avgSteps",
        AVG(distance_meters)::float                       AS "avgDistanceMeters"
      FROM step_sessions
      WHERE user_uid = ${uid}::uuid
        AND is_active = false
        AND started_at < NOW() - INTERVAL '90 days'
      GROUP BY TO_CHAR(started_at AT TIME ZONE 'UTC', 'YYYY-MM')
      ORDER BY month DESC
    `;

    return success(
      res,
      {
        daily: dailyRows.map(r => ({
          date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date),
          steps: Number(r.steps),
          distanceMeters: Number(r.distanceMeters),
        })),
        weekly: weeklyRows.map(r => ({
          weekStart: r.weekStart instanceof Date ? r.weekStart.toISOString().split('T')[0] : String(r.weekStart),
          avgSteps: Number(r.avgSteps),
          avgDistanceMeters: Number(r.avgDistanceMeters),
        })),
        monthly: monthlyRows.map(r => ({
          month: String(r.month),
          avgSteps: Number(r.avgSteps),
          avgDistanceMeters: Number(r.avgDistanceMeters),
        })),
      },
      'History fetched',
    );
  } catch (err) {
    logger.error('steps/history error', { error: err.message });
    return error(res, 'Failed to fetch history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ─── GET /leaderboard ────────────────────────────────────────────────────────
// Current calendar month, hospital-wide, top 20, opted-in only.
router.get('/leaderboard', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const rows = await prisma.$queryRaw`
      SELECT
        ss.user_uid,
        COALESCE(sp.display_name, 'Anonymous')   AS display_name,
        COALESCE(sp.display_color, '#2196F3')     AS display_color,
        SUM(ss.steps)::int                        AS total_steps,
        SUM(ss.distance_meters)::float            AS total_distance_meters,
        RANK() OVER (ORDER BY SUM(ss.steps) DESC) AS rank
      FROM step_sessions ss
      LEFT JOIN step_profiles sp ON sp.user_uid = ss.user_uid
      WHERE ss.is_active = false
        AND DATE_TRUNC('month', ss.started_at) = DATE_TRUNC('month', NOW())
        AND (sp.opted_in IS NULL OR sp.opted_in = true)
      GROUP BY ss.user_uid, sp.display_name, sp.display_color
      ORDER BY total_steps DESC
      LIMIT 20
    `;

    // My rank (may not be in top 20)
    const myRankRows = await prisma.$queryRaw`
      SELECT rank, total_steps, total_distance_meters
      FROM (
        SELECT
          ss.user_uid,
          SUM(ss.steps)::int                        AS total_steps,
          SUM(ss.distance_meters)::float            AS total_distance_meters,
          RANK() OVER (ORDER BY SUM(ss.steps) DESC) AS rank
        FROM step_sessions ss
        LEFT JOIN step_profiles sp ON sp.user_uid = ss.user_uid
        WHERE ss.is_active = false
          AND DATE_TRUNC('month', ss.started_at) = DATE_TRUNC('month', NOW())
          AND (sp.opted_in IS NULL OR sp.opted_in = true)
        GROUP BY ss.user_uid
      ) ranked
      WHERE user_uid = ${uid}::uuid
    `;

    const myRankRow = myRankRows[0] ?? null;

    return success(
      res,
      {
        leaderboard: rows.map(r => ({
          displayName: r.display_name,
          displayColor: r.display_color,
          totalSteps: Number(r.total_steps),
          totalDistanceMeters: Number(r.total_distance_meters),
          rank: Number(r.rank),
          isMe: r.user_uid === uid,
        })),
        myRank: myRankRow
          ? {
              rank: Number(myRankRow.rank),
              totalSteps: Number(myRankRow.total_steps),
              totalDistanceMeters: Number(myRankRow.total_distance_meters),
            }
          : null,
      },
      'Leaderboard fetched',
    );
  } catch (err) {
    logger.error('steps/leaderboard error', { error: err.message });
    return error(res, 'Failed to fetch leaderboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ─── GET /profile ─────────────────────────────────────────────────────────
// Get or auto-create the step profile.
router.get('/profile', async (req, res) => {
  try {
    const uid = req.user?.uid;
    const phone = req.user?.phone ?? '';
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    let profile = await prisma.step_profiles.findUnique({ where: { user_uid: uid } });

    if (!profile) {
      const last4 = phone.length >= 4 ? phone.slice(-4) : phone || 'User';
      profile = await prisma.step_profiles.create({
        data: {
          user_uid: uid,
          display_name: `User${last4}`,
          display_color: '#2196F3',
          daily_goal: 8000,
          opted_in: true,
          updated_at: new Date(),
        },
      });
    }

    return success(res, { profile }, 'Profile fetched');
  } catch (err) {
    logger.error('steps/profile GET error', { error: err.message });
    return error(res, 'Failed to fetch profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ─── PUT /profile ─────────────────────────────────────────────────────────
// Upsert step profile — with input validation.
router.put('/profile', async (req, res) => {
  try {
    const uid = req.user?.uid;
    const phone = req.user?.phone ?? '';
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    let { displayName, dailyGoal } = req.body;
    const { displayColor, optedIn } = req.body;

    // Validate displayName
    if (displayName !== undefined) {
      displayName = String(displayName).trim();
      if (!displayName) return error(res, 'displayName is required', HTTP_STATUS.BAD_REQUEST);
      if (displayName.length > 50) return error(res, 'displayName must be at most 50 characters', HTTP_STATUS.BAD_REQUEST);
      if (displayName.includes('<') || displayName.includes('>')) return error(res, 'displayName contains invalid characters', HTTP_STATUS.BAD_REQUEST);
    }

    // Validate displayColor
    if (displayColor !== undefined) {
      if (!/^#[0-9A-Fa-f]{6}$/.test(displayColor)) {
        return error(res, 'displayColor must be a valid hex color (e.g. #2196F3)', HTTP_STATUS.BAD_REQUEST);
      }
    }

    // Validate dailyGoal
    if (dailyGoal !== undefined) {
      const goal = parseInt(dailyGoal, 10);
      if (isNaN(goal) || !Number.isInteger(goal)) return error(res, 'dailyGoal must be an integer', HTTP_STATUS.BAD_REQUEST);
      if (goal < 1000 || goal > 100000) return error(res, 'dailyGoal must be between 1000 and 100000', HTTP_STATUS.BAD_REQUEST);
      dailyGoal = goal;
    }

    const last4 = phone.length >= 4 ? phone.slice(-4) : phone || 'User';
    const profile = await prisma.step_profiles.upsert({
      where: { user_uid: uid },
      create: {
        user_uid: uid,
        display_name: displayName || `User${last4}`,
        display_color: displayColor || '#2196F3',
        daily_goal: dailyGoal !== undefined ? dailyGoal : 8000,
        opted_in: optedIn !== undefined ? Boolean(optedIn) : true,
      },
      update: {
        ...(displayName !== undefined && { display_name: displayName }),
        ...(displayColor !== undefined && { display_color: displayColor }),
        ...(dailyGoal !== undefined && { daily_goal: dailyGoal }),
        ...(optedIn !== undefined && { opted_in: Boolean(optedIn) }),
        updated_at: new Date(),
      },
    });

    return success(res, { profile }, 'Profile updated');
  } catch (err) {
    logger.error('steps/profile PUT error', { error: err.message });
    return error(res, 'Failed to update profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ─── GET /rewards ─────────────────────────────────────────────────────────
router.get('/rewards', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const rewards = await prisma.step_rewards.findMany({
      where: { user_uid: uid },
      orderBy: { created_at: 'desc' },
    });

    return success(res, { rewards }, 'Rewards fetched');
  } catch (err) {
    logger.error('steps/rewards error', { error: err.message });
    return error(res, 'Failed to fetch rewards', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
