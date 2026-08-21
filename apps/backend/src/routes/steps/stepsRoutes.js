// src/routes/steps/stepsRoutes.js
// Step Challenge — sessions, history (tiered), leaderboard, profile, rewards

import { Router } from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as pointService from '../../services/gamification/pointService.js';
import { requireTenantId } from '../../services/tenant/tenantService.js';
import { success, error } from '../../utils/responseHelper.js';

const router = Router();

const ACTIVITY_SYNC_SOURCES = new Set([
  'health_connect',
  'healthkit',
  'strava',
  'fitbit',
  'garmin',
  'oura',
  'withings',
  'samsung_health',
  'polar',
  'wearable',
]);

const DEFAULT_DAILY_GOAL = 8000;
const WALKING_STEP_LENGTH_METERS = 0.75;
const ACTIVITY_SAMPLE_MAX_FUTURE_MS = 5 * 60 * 1000;
const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeActivitySource(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'google_fit') return 'health_connect';
  return ACTIVITY_SYNC_SOURCES.has(raw) ? raw : 'wearable';
}

function safeLimitedText(value, max = 120) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}

function parseIsoDay(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  const normalized = date.toISOString().split('T')[0];
  return normalized === raw ? normalized : null;
}

function safeNonNegativeNumber(value, { integer = false, max = 1000000 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  const capped = Math.min(parsed, max);
  return integer ? Math.round(capped) : capped;
}

function parseActivitySampleTimestamp(value, sourceDay, nowMs = Date.now()) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if (!RFC3339_TIMESTAMP.test(normalized)) return null;
  const recordedAt = new Date(normalized);
  const recordedAtMs = recordedAt.getTime();
  if (Number.isNaN(recordedAtMs)) return null;

  const sourceDayMs = Date.parse(`${sourceDay}T00:00:00.000Z`);
  if (recordedAtMs > nowMs + ACTIVITY_SAMPLE_MAX_FUTURE_MS) return null;
  const localDay = normalized.slice(0, 10);
  const nextDay = new Date(sourceDayMs + 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];
  const localHour = Number(normalized.slice(11, 13));
  const belongsToSourceDay = localDay === sourceDay;
  const crossesMidnight = localDay === nextDay && localHour < 6;
  if (!belongsToSourceDay && !crossesMidnight) {
    return null;
  }
  return recordedAt;
}

function buildActivityLevel({ steps = 0, distanceMeters = 0, dailyGoal = DEFAULT_DAILY_GOAL } = {}) {
  const safeSteps = Math.max(0, Number(steps) || 0);
  const safeDistance = Math.max(0, Number(distanceMeters) || 0);
  const goalSteps = Math.max(1000, Number(dailyGoal) || DEFAULT_DAILY_GOAL);
  const distanceEquivalentSteps = Math.round(safeDistance / WALKING_STEP_LENGTH_METERS);
  const effectiveSteps = Math.max(safeSteps, distanceEquivalentSteps);
  const progress = Math.min(1, effectiveSteps / goalSteps);

  let key = 'low';
  let label = 'Low';
  if (progress >= 1) {
    key = 'goal_met';
    label = 'Goal met';
  } else if (progress >= 0.75 || effectiveSteps >= 7000) {
    key = 'active';
    label = 'Active';
  } else if (progress >= 0.45 || effectiveSteps >= 4000) {
    key = 'moderate';
    label = 'Moderate';
  } else if (progress >= 0.15 || effectiveSteps >= 1000) {
    key = 'light';
    label = 'Light';
  }

  return {
    key,
    label,
    effectiveSteps,
    progress: Number(progress.toFixed(2)),
    goalSteps,
  };
}

async function getTodayActivity(uid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
        COALESCE(SUM(steps), 0)::int AS steps,
        COALESCE(SUM(distance_meters), 0)::float AS "distanceMeters",
        COALESCE(SUM(sleep_minutes), 0)::int AS "sleepMinutes",
        COALESCE(SUM(active_energy_kcal), 0)::float AS "activeEnergyKcal",
        MAX(recorded_at_source) AS "recordedAtSource",
        BOOL_OR(source <> 'manual') AS "hasSyncedSource"
      FROM step_sessions
     WHERE user_uid = $1::uuid
       AND is_active = false
       AND DATE(started_at AT TIME ZONE 'UTC') = CURRENT_DATE`,
    uid,
  );

  const today = rows[0] || {};
  return {
    steps: Number(today.steps || 0),
    distanceMeters: Number(today.distanceMeters || 0),
    sleepMinutes: Number(today.sleepMinutes || 0),
    activeEnergyKcal: Number(today.activeEnergyKcal || 0),
    recordedAtSource: today.recordedAtSource || null,
    hasSyncedSource: Boolean(today.hasSyncedSource),
  };
}

// ─── POST /session/start ────────────────────────────────────────────────────
// Creates a new active walk session or resumes the caller's existing one.
router.post('/session/start', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    // Stamp tenant_id explicitly: this create runs under a bare
    // prisma.$transaction where the app.current_tenant_id GUC is unset, so the
    // column DEFAULT would misfile the session on the default tenant.
    const tenantId = requireTenantId(
      req.tenantId || req.user?.tenant_id || req.user?.tenantId,
    );

    const result = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(
        // ::text cast for uniformity with every other advisory site: through
        // $executeRaw the void column is discarded (row-count path), but one
        // refactor to $queryRaw would hit Prisma 7's P2010 void-deserialize
        // crash (the staffAuthService register-device incident, 2026-08-21).
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))::text AS lock_acquired',
        `step-session:${uid}`,
      );
      const active = await tx.step_sessions.findFirst({
        where: { user_uid: uid, is_active: true },
        orderBy: { started_at: 'desc' },
      });
      if (active) return { session: active, resumed: true };

      const session = await tx.step_sessions.create({
        data: {
          tenant_id: tenantId,
          user_uid: uid,
          started_at: new Date(),
          is_active: true,
          // CAN-012: the in-app pedometer walk is device-measured (the phone's
          // step sensor) → attested reward_eligible=true. A future user-typed
          // step entry must leave reward_eligible at its fail-safe default (false).
          reward_eligible: true,
        },
      });
      return { session, resumed: false };
    });

    return success(
      res,
      {
        sessionId: result.session.id,
        startedAt: result.session.started_at,
        resumed: result.resumed,
      },
      result.resumed ? 'Walk session resumed' : 'Walk session started',
    );
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
    const parsedSessionId = Number(sessionId);
    if (!Number.isSafeInteger(parsedSessionId) || parsedSessionId <= 0) {
      return error(res, 'sessionId must be a positive integer', HTTP_STATUS.BAD_REQUEST);
    }

    const existing = await prisma.step_sessions.findFirst({
      where: { id: parsedSessionId, user_uid: uid },
    });
    if (!existing) return error(res, 'Session not found', HTTP_STATUS.NOT_FOUND);
    if (!existing.is_active) {
      return success(res, { session: existing, duplicate: true }, 'Walk session already stopped');
    }

    const updated = await prisma.step_sessions.update({
      where: { id: existing.id },
      data: {
        steps: safeNonNegativeNumber(steps, { integer: true, max: 200000 }),
        distance_meters: safeNonNegativeNumber(distanceMeters, { max: 500000 }),
        duration_seconds: safeNonNegativeNumber(durationSeconds, { integer: true, max: 7 * 24 * 60 * 60 }),
        is_active: false,
        ended_at: new Date(),
      },
    });

    // Gamification: fire-and-forget step goal check
    const profile = await prisma.step_profiles.findUnique({ where: { user_uid: uid } });
    pointService.awardStepPoints(uid, profile?.daily_goal || DEFAULT_DAILY_GOAL, req.tenantId || req.user?.tenant_id || req.user?.tenantId || null).catch(err =>
      logger.warn('Gamification: step point award failed', { error: err.message })
    );

    return success(res, { session: updated, duplicate: false }, 'Walk session stopped');
  } catch (err) {
    logger.error('steps/session/stop error', { error: err.message });
    return error(res, 'Failed to stop session', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ─── POST /health-sync ──────────────────────────────────────────────────────
// Upserts patient-generated daily activity summaries from Health Connect,
// HealthKit, Strava, or future wearable connectors. One row is kept per
// user/source/day so repeated syncs update totals rather than duplicating them.
router.post('/health-sync', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const source = normalizeActivitySource(req.body?.source);
    const sourceApp = safeLimitedText(req.body?.sourceApp || req.body?.source_app);
    const sourceDevice = safeLimitedText(req.body?.sourceDevice || req.body?.source_device);
    const days = Array.isArray(req.body?.days) ? req.body.days : [];

    if (days.length === 0) {
      return error(res, 'days is required', HTTP_STATUS.BAD_REQUEST);
    }
    if (days.length > 31) {
      return error(res, 'days must contain 31 entries or fewer', HTTP_STATUS.BAD_REQUEST);
    }

    const now = Date.now();
    const normalizedDays = [];
    for (const day of days) {
      const date = parseIsoDay(day?.date);
      if (!date) {
        return error(res, 'date must be a valid ISO calendar date', HTTP_STATUS.BAD_REQUEST);
      }

      const steps = safeNonNegativeNumber(day?.steps, { integer: true, max: 200000 });
      const distanceMeters = safeNonNegativeNumber(day?.distanceMeters, { max: 500000 });
      const sleepMinutes = safeNonNegativeNumber(day?.sleepMinutes, { integer: true, max: 1440 });
      const activeEnergyKcal = safeNonNegativeNumber(day?.activeEnergyKcal, { max: 20000 });
      if (steps === 0 && distanceMeters === 0 && sleepMinutes === 0 && activeEnergyKcal === 0) {
        continue;
      }

      const recordedAt = parseActivitySampleTimestamp(day?.lastSampleAt, date, now);
      if (!recordedAt) {
        return error(
          res,
          'lastSampleAt must be an RFC 3339 timestamp within its source-day window and not in the future',
          HTTP_STATUS.BAD_REQUEST,
        );
      }
      normalizedDays.push({
        date,
        steps,
        distanceMeters,
        sleepMinutes,
        activeEnergyKcal,
        recordedAt,
      });
    }

    const today = new Date(now).toISOString().split('T')[0];
    const rows = [];
    for (const day of normalizedDays) {
      const inserted = await prisma.$queryRawUnsafe(
        // CAN-012: health-platform syncs are device/app-measured → attested
        // reward_eligible=true (re-syncs keep it true).
        `INSERT INTO step_sessions (
            user_uid, started_at, ended_at, steps, distance_meters,
            duration_seconds, is_active, source, source_day, sleep_minutes,
            active_energy_kcal, source_device, source_app, recorded_at_source,
            reward_eligible
          )
          VALUES (
            $1::uuid,
            ($3::date)::timestamp,
            ($3::date + INTERVAL '1 day')::timestamp,
            $4::int,
            $5::float,
            86400,
            false,
            $2::varchar,
            $3::date,
            $6::int,
            $7::numeric,
            $8::varchar,
            $9::varchar,
            $10::timestamptz,
            true
          )
          ON CONFLICT (user_uid, source, source_day)
          WHERE source_day IS NOT NULL
          DO UPDATE SET
            steps = EXCLUDED.steps,
            distance_meters = EXCLUDED.distance_meters,
            sleep_minutes = EXCLUDED.sleep_minutes,
            active_energy_kcal = EXCLUDED.active_energy_kcal,
            source_device = COALESCE(EXCLUDED.source_device, step_sessions.source_device),
            source_app = COALESCE(EXCLUDED.source_app, step_sessions.source_app),
            recorded_at_source = EXCLUDED.recorded_at_source,
            ended_at = EXCLUDED.ended_at,
            duration_seconds = EXCLUDED.duration_seconds,
            is_active = false,
            reward_eligible = true
          WHERE EXCLUDED.recorded_at_source > COALESCE(
                  step_sessions.recorded_at_source,
                  '-infinity'::timestamptz
                )
             OR (
                  EXCLUDED.recorded_at_source = step_sessions.recorded_at_source
                  AND EXCLUDED.steps IS NOT DISTINCT FROM step_sessions.steps
                  AND EXCLUDED.distance_meters IS NOT DISTINCT FROM step_sessions.distance_meters
                  AND EXCLUDED.sleep_minutes IS NOT DISTINCT FROM step_sessions.sleep_minutes
                  AND EXCLUDED.active_energy_kcal IS NOT DISTINCT FROM step_sessions.active_energy_kcal
                  AND EXCLUDED.source_device IS NOT DISTINCT FROM step_sessions.source_device
                  AND EXCLUDED.source_app IS NOT DISTINCT FROM step_sessions.source_app
                )
          RETURNING id, source_day, steps, distance_meters, sleep_minutes, active_energy_kcal`,
        uid,
        source,
        day.date,
        day.steps,
        day.distanceMeters,
        day.sleepMinutes,
        day.activeEnergyKcal,
        sourceDevice,
        sourceApp,
        day.recordedAt,
      );
      if (inserted[0]) rows.push(inserted[0]);
    }

    if (rows.length > 0 && rows.some(r => {
      const day = r.source_day instanceof Date
        ? r.source_day.toISOString().split('T')[0]
        : String(r.source_day);
      return day === today;
    })) {
      const profile = await prisma.step_profiles.findUnique({ where: { user_uid: uid } });
      pointService.awardStepPoints(uid, profile?.daily_goal || DEFAULT_DAILY_GOAL, req.tenantId || req.user?.tenant_id || req.user?.tenantId || null).catch(err =>
        logger.warn('Gamification: health-sync step point award failed', { error: err.message })
      );
    }

    return success(
      res,
      {
        source,
        syncedDays: rows.length,
        latestDay: rows[0]?.source_day instanceof Date
          ? rows[0].source_day.toISOString().split('T')[0]
          : rows[0]?.source_day || null,
      },
      rows.length > 0 ? 'Activity synced' : 'No activity samples to sync',
    );
  } catch (err) {
    logger.error('steps/health-sync error', { error: err.message });
    return error(res, 'Failed to sync activity', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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

// ─── GET /sync-status ───────────────────────────────────────────────────────
// Latest patient-generated activity snapshot, labelled by source.
router.get('/sync-status', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const latestRows = await prisma.$queryRawUnsafe(
      `SELECT
          source,
          source_app AS "sourceApp",
          source_device AS "sourceDevice",
          source_day AS date,
          steps,
          distance_meters AS "distanceMeters",
          sleep_minutes AS "sleepMinutes",
          active_energy_kcal::float AS "activeEnergyKcal",
          recorded_at_source AS "recordedAtSource"
        FROM step_sessions
       WHERE user_uid = $1::uuid
         AND is_active = false
         AND source <> 'manual'
         AND source_day IS NOT NULL
       ORDER BY recorded_at_source DESC NULLS LAST, source_day DESC
       LIMIT 1`,
      uid,
    );

    const todayRows = await prisma.$queryRawUnsafe(
      `SELECT
          COALESCE(SUM(steps), 0)::int AS steps,
          COALESCE(SUM(distance_meters), 0)::float AS "distanceMeters",
          COALESCE(SUM(sleep_minutes), 0)::int AS "sleepMinutes",
          COALESCE(SUM(active_energy_kcal), 0)::float AS "activeEnergyKcal",
          MAX(recorded_at_source) AS "recordedAtSource"
        FROM step_sessions
       WHERE user_uid = $1::uuid
         AND is_active = false
         AND source <> 'manual'
         AND source_day = CURRENT_DATE`,
      uid,
    );

    const sourceRows = await prisma.$queryRawUnsafe(
      `SELECT
          source,
          MAX(recorded_at_source) AS "lastSyncedAt",
          MAX(source_day) AS "latestDay"
        FROM step_sessions
       WHERE user_uid = $1::uuid
         AND is_active = false
         AND source <> 'manual'
         AND source_day IS NOT NULL
       GROUP BY source
       ORDER BY "lastSyncedAt" DESC NULLS LAST`,
      uid,
    );

    const latest = latestRows[0] || null;
    const today = todayRows[0] || {};
    const profile = await prisma.step_profiles.findUnique({
      where: { user_uid: uid },
      select: { daily_goal: true },
    });
    const dailyGoal = Number(profile?.daily_goal || DEFAULT_DAILY_GOAL);
    const todayPayload = {
      steps: Number(today.steps || 0),
      distanceMeters: Number(today.distanceMeters || 0),
      sleepMinutes: Number(today.sleepMinutes || 0),
      activeEnergyKcal: Number(today.activeEnergyKcal || 0),
      recordedAtSource: today.recordedAtSource || null,
    };

    return success(
      res,
      {
        latest: latest
          ? {
              source: latest.source,
              sourceApp: latest.sourceApp,
              sourceDevice: latest.sourceDevice,
              date: latest.date instanceof Date ? latest.date.toISOString().split('T')[0] : String(latest.date),
              steps: Number(latest.steps || 0),
              distanceMeters: Number(latest.distanceMeters || 0),
              sleepMinutes: Number(latest.sleepMinutes || 0),
              activeEnergyKcal: Number(latest.activeEnergyKcal || 0),
              recordedAtSource: latest.recordedAtSource,
            }
          : null,
        today: {
          ...todayPayload,
          activityLevel: buildActivityLevel({
            steps: todayPayload.steps,
            distanceMeters: todayPayload.distanceMeters,
            dailyGoal,
          }),
        },
        sources: sourceRows.map(row => ({
          source: row.source,
          lastSyncedAt: row.lastSyncedAt,
          latestDay: row.latestDay instanceof Date ? row.latestDay.toISOString().split('T')[0] : String(row.latestDay),
        })),
      },
      'Activity sync status fetched',
    );
  } catch (err) {
    logger.error('steps/sync-status error', { error: err.message });
    return error(res, 'Failed to fetch sync status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ─── GET /leaderboard ────────────────────────────────────────────────────────
// Current calendar month, hospital-wide, top 20, opted-in only.
router.get('/leaderboard', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);
    const tenantId = req.tenantId;

    const rows = await prisma.$queryRaw`
      SELECT
        ss.user_uid,
        COALESCE(sp.display_name, 'Anonymous')   AS display_name,
        COALESCE(sp.display_color, '#2196F3')     AS display_color,
        SUM(ss.steps)::int                        AS total_steps,
        SUM(ss.distance_meters)::float            AS total_distance_meters,
        RANK() OVER (ORDER BY SUM(ss.steps) DESC) AS rank
      FROM step_sessions ss
      JOIN users u ON u.uid = ss.user_uid
      LEFT JOIN step_profiles sp ON sp.user_uid = ss.user_uid
      WHERE ss.is_active = false
        AND u.tenant_id = ${tenantId}::uuid
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
        JOIN users u ON u.uid = ss.user_uid
        LEFT JOIN step_profiles sp ON sp.user_uid = ss.user_uid
        WHERE ss.is_active = false
          AND u.tenant_id = ${tenantId}::uuid
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
          daily_goal: DEFAULT_DAILY_GOAL,
          opted_in: true,
          updated_at: new Date(),
        },
      });
    }

    const dailyGoal = Number(profile.daily_goal || DEFAULT_DAILY_GOAL);
    const todayActivity = await getTodayActivity(uid);
    const activityLevel = buildActivityLevel({
      steps: todayActivity.steps,
      distanceMeters: todayActivity.distanceMeters,
      dailyGoal,
    });

    return success(
      res,
      {
        profile,
        steps_today: todayActivity.steps,
        stepsToday: todayActivity.steps,
        today: todayActivity.steps,
        daily_goal: dailyGoal,
        dailyGoal,
        distance_today_meters: todayActivity.distanceMeters,
        distanceTodayMeters: todayActivity.distanceMeters,
        activityLevel,
        todayActivity: {
          ...todayActivity,
          activityLevel,
        },
      },
      'Profile fetched',
    );
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
        daily_goal: dailyGoal !== undefined ? dailyGoal : DEFAULT_DAILY_GOAL,
        opted_in: optedIn !== undefined ? Boolean(optedIn) : true,
        updated_at: new Date(),
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
