// src/services/gamification/wellnessService.js
// Computes the 0-100 Personal Wellness Score and the Smart Health Insights
// shown on the patient app dashboard. Aggregates data from vitals,
// appointments, prescriptions, steps, and the health-point ledger.
//
// Each wellness dimension is scored 0-20, for a total of 100.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { istDateString } from '../../utils/dateUtils.js';
import { epochMsOrNull } from '../../utils/dbInstant.js';

const DIMENSION_MAX = 20;
const STEP_DEFAULT_GOAL = 8000;
const WALKING_STEP_LENGTH_METERS = 0.75;

// ── Individual dimension scorers ─────────────────────────────────────────────

/**
 * Vitals regularity: awards up to 20 points for logging vitals on distinct
 * days during the last 7 days (e.g. 5 days logged → ~14 points).
 */
async function scoreVitalsRegularity(userUid, tenantId = null) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(DISTINCT DATE(recorded_at AT TIME ZONE 'UTC'))::int AS days
       FROM patient_vitals
      WHERE patient_uid = $1::uuid
        AND recorded_at >= NOW() - INTERVAL '7 days'${tenantId ? ' AND tenant_id = $2::uuid' : ''}`,
    ...(tenantId ? [userUid, tenantId] : [userUid])
  );
  const days = rows[0]?.days || 0;
  const score = Math.min(DIMENSION_MAX, Math.round((days / 7) * DIMENSION_MAX));
  return { score, detail: { loggedDays: days, windowDays: 7 } };
}

/**
 * Appointment adherence: % of appointments the user completed (vs missed) in
 * the last 90 days. If the user has no appointments, returns a neutral score.
 */
async function scoreAppointmentAdherence(userUid, tenantId = null) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
        COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
        COUNT(*) FILTER (WHERE status IN ('COMPLETED','NO_SHOW','CANCELLED'))::int AS decided
       FROM appointments
      WHERE phone = (SELECT phone FROM users WHERE uid = $1::uuid${tenantId ? ' AND tenant_id = $2::uuid' : ''} LIMIT 1)
        AND appointment_date >= CURRENT_DATE - INTERVAL '90 days'${tenantId ? ' AND tenant_id = $2::uuid' : ''}`,
    ...(tenantId ? [userUid, tenantId] : [userUid])
  );
  const completed = rows[0]?.completed || 0;
  const decided = rows[0]?.decided || 0;
  if (decided === 0) {
    return { score: Math.round(DIMENSION_MAX * 0.6), detail: { completed, decided } };
  }
  const ratio = completed / decided;
  return {
    score: Math.round(ratio * DIMENSION_MAX),
    detail: { completed, decided, ratio: Number(ratio.toFixed(2)) },
  };
}

/**
 * Medication compliance: ratio of active prescriptions that are not yet
 * expired (issued_at + duration_days still in future). No active
 * prescriptions → neutral full score (nothing to adhere to).
 */
async function scoreMedicationCompliance(userUid, tenantId = null) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE status = 'active'
            AND (duration_days IS NULL
              OR issued_at + (duration_days || ' days')::interval >= NOW())
        )::int AS on_track
       FROM prescriptions
      WHERE patient_uid = $1::uuid${tenantId ? ' AND tenant_id = $2::uuid' : ''}`,
    ...(tenantId ? [userUid, tenantId] : [userUid])
  );
  const total = rows[0]?.total || 0;
  const onTrack = rows[0]?.on_track || 0;
  if (total === 0) {
    return { score: DIMENSION_MAX, detail: { active: 0, total: 0 } };
  }
  const ratio = onTrack / total;
  return {
    score: Math.round(ratio * DIMENSION_MAX),
    detail: { active: onTrack, total, ratio: Number(ratio.toFixed(2)) },
  };
}

/**
 * Activity level: average 7-day progress toward the user's step goal. This
 * reads the same step_sessions rows populated by manual walk sessions,
 * Health Connect, HealthKit, Strava, and future wearable connectors. Distance
 * is converted to an equivalent step count when a source provides distance
 * without reliable steps.
 */
async function scoreActivityLevel(userUid, tenantId = null) {
  const profile = await prisma.step_profiles.findUnique({
    where: { user_uid: userUid },
    select: { daily_goal: true },
  });
  const goalSteps = Math.max(1000, Number(profile?.daily_goal || STEP_DEFAULT_GOAL));

  const rows = await prisma.$queryRawUnsafe(
    `SELECT
        DATE(started_at AT TIME ZONE 'UTC') AS day,
        COALESCE(SUM(steps), 0)::int AS steps,
        COALESCE(SUM(distance_meters), 0)::float AS "distanceMeters",
        COALESCE(SUM(active_energy_kcal), 0)::float AS "activeEnergyKcal",
        BOOL_OR(source <> 'manual') AS "hasSyncedSource"
       FROM step_sessions
      WHERE user_uid = $1::uuid
        AND is_active = false
        AND DATE(started_at AT TIME ZONE 'UTC') >= CURRENT_DATE - INTERVAL '6 days'${tenantId ? ' AND tenant_id = $2::uuid' : ''}
      GROUP BY DATE(started_at AT TIME ZONE 'UTC')`,
    ...(tenantId ? [userUid, tenantId] : [userUid])
  );

  let progressTotal = 0;
  let activeDays = 0;
  let goalDaysMet = 0;
  let totalSteps = 0;
  let totalDistanceMeters = 0;
  let syncedDays = 0;

  for (const row of rows) {
    const steps = Math.max(0, Number(row.steps || 0));
    const distanceMeters = Math.max(0, Number(row.distanceMeters || 0));
    const distanceEquivalentSteps = Math.round(distanceMeters / WALKING_STEP_LENGTH_METERS);
    const effectiveSteps = Math.max(steps, distanceEquivalentSteps);
    const progress = Math.min(1, effectiveSteps / goalSteps);

    progressTotal += progress;
    totalSteps += steps;
    totalDistanceMeters += distanceMeters;
    if (effectiveSteps > 0) activeDays += 1;
    if (progress >= 1) goalDaysMet += 1;
    if (row.hasSyncedSource) syncedDays += 1;
  }

  const score = Math.min(DIMENSION_MAX, Math.round((progressTotal / 7) * DIMENSION_MAX));

  return {
    score,
    detail: {
      activeDays,
      goalDaysMet,
      syncedDays,
      windowDays: 7,
      goalSteps,
      averageSteps: Math.round(totalSteps / 7),
      averageDistanceMeters: Math.round(totalDistanceMeters / 7),
      totalDistanceMeters: Math.round(totalDistanceMeters),
      source: 'step_sessions',
    },
  };
}

/**
 * Health engagement: scales points earned this calendar month.
 * 200+ points → full 20, linear below.
 */
async function scoreHealthEngagement(userUid, tenantId = null) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM(points), 0)::int AS points
       FROM health_point_ledger
      WHERE user_uid = $1::uuid
        AND earned_at >= DATE_TRUNC('month', NOW())${tenantId ? ' AND tenant_id = $2::uuid' : ''}`,
    ...(tenantId ? [userUid, tenantId] : [userUid])
  );
  const points = rows[0]?.points || 0;
  const score = Math.min(DIMENSION_MAX, Math.round((points / 200) * DIMENSION_MAX));
  return { score, detail: { pointsThisMonth: points, target: 200 } };
}

// ── Public: wellness score ───────────────────────────────────────────────────

export async function computeWellnessScore(userUid, tenantId = null) {
  // CAN-019/012: thread the caller's tenant into every dimension scorer so the
  // wellness score reads only this tenant's rows (defense-in-depth alongside RLS;
  // a phone is unique only per tenant — mig 333).
  const [vitals, adherence, meds, activity, engagement] = await Promise.all([
    scoreVitalsRegularity(userUid, tenantId),
    scoreAppointmentAdherence(userUid, tenantId),
    scoreMedicationCompliance(userUid, tenantId),
    scoreActivityLevel(userUid, tenantId),
    scoreHealthEngagement(userUid, tenantId),
  ]);

  const total = vitals.score + adherence.score + meds.score + activity.score + engagement.score;
  let band = 'needs_attention';
  if (total >= 80) band = 'excellent';
  else if (total >= 60) band = 'good';

  return {
    score: total,
    band,
    dimensions: [
      { key: 'vitals',     label: 'Vitals regularity',      score: vitals.score,     max: DIMENSION_MAX, detail: vitals.detail },
      { key: 'adherence',  label: 'Appointment adherence',  score: adherence.score,  max: DIMENSION_MAX, detail: adherence.detail },
      { key: 'medication', label: 'Medication compliance',  score: meds.score,       max: DIMENSION_MAX, detail: meds.detail },
      { key: 'activity',   label: 'Activity level',         score: activity.score,   max: DIMENSION_MAX, detail: activity.detail },
      { key: 'engagement', label: 'Health engagement',      score: engagement.score, max: DIMENSION_MAX, detail: engagement.detail },
    ],
  };
}

// ── Public: smart health insights ────────────────────────────────────────────

/**
 * Returns up to [limit] prioritised insight cards for the dashboard. Each
 * insight has { type, priority, title, message, actionRoute? }.
 * Priority: higher = more important. Callers sort/truncate.
 */
export async function computeHealthInsights(userUid, limit = 3, tenantId = null) {
  const insights = [];

  try {
    // CAN-019/012: every insight read is tenant-scoped when a tenant is resolvable.
    // — Refill nudge: prescriptions ending in ≤7 days —
    const expiring = await prisma.$queryRawUnsafe(
      `SELECT medication_name,
              GREATEST(0, EXTRACT(DAY FROM (issued_at + (duration_days || ' days')::interval - NOW())))::int AS days_left
         FROM prescriptions
        WHERE patient_uid = $1::uuid
          AND status = 'active'
          AND duration_days IS NOT NULL
          AND issued_at + (duration_days || ' days')::interval BETWEEN NOW() AND NOW() + INTERVAL '7 days'${tenantId ? ' AND tenant_id = $2::uuid' : ''}
        ORDER BY days_left ASC
        LIMIT 1`,
      ...(tenantId ? [userUid, tenantId] : [userUid])
    );
    if (expiring.length > 0) {
      const e = expiring[0];
      insights.push({
        type: 'refill_reminder',
        priority: 90,
        title: `Time to refill ${e.medication_name}`,
        message: `${e.days_left} day${e.days_left === 1 ? '' : 's'} remaining on your current prescription.`,
        actionRoute: '/refill',
      });
    }

    // — Vitals logging nudge —
    const lastVitals = await prisma.$queryRawUnsafe(
      `SELECT MAX(recorded_at) AS last_at,
              (EXTRACT(EPOCH FROM MAX(recorded_at)) * 1000)::bigint AS last_at_epoch_ms
         FROM patient_vitals
        WHERE patient_uid = $1::uuid${tenantId ? ' AND tenant_id = $2::uuid' : ''}`,
      ...(tenantId ? [userUid, tenantId] : [userUid])
    );
    const lastAtMs = epochMsOrNull(lastVitals[0]?.last_at_epoch_ms);
    if (lastAtMs == null) {
      insights.push({
        type: 'log_first_vitals',
        priority: 70,
        title: 'Log your first vitals',
        message: 'Track your blood pressure, heart rate and more in 30 seconds.',
        actionRoute: '/vitals',
      });
    } else {
      const daysSince = Math.floor((Date.now() - lastAtMs) / (24 * 3600 * 1000));
      if (daysSince >= 5) {
        insights.push({
          type: 'vitals_nudge',
          priority: 60,
          title: `It's been ${daysSince} days since you logged vitals`,
          message: 'Regular logging helps your care team spot trends early.',
          actionRoute: '/vitals',
        });
      }
    }

    // — Appointment adherence celebration —
    const adherence = await prisma.$queryRawUnsafe(
      `SELECT
          COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'NO_SHOW')::int AS missed
         FROM appointments
        WHERE phone = (SELECT phone FROM users WHERE uid = $1::uuid${tenantId ? ' AND tenant_id = $2::uuid' : ''} LIMIT 1)
          AND appointment_date >= CURRENT_DATE - INTERVAL '90 days'${tenantId ? ' AND tenant_id = $2::uuid' : ''}`,
      ...(tenantId ? [userUid, tenantId] : [userUid])
    );
    const completed = adherence[0]?.completed || 0;
    const missed = adherence[0]?.missed || 0;
    if (completed >= 3 && missed === 0) {
      insights.push({
        type: 'appointment_adherence',
        priority: 40,
        title: `You've attended ${completed}/${completed} appointments this quarter`,
        message: 'Consistent visits keep your care plan on track — great work!',
      });
    }

    // — Check-in streak celebration —
    const streak = await prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT activity_ref_id)::int AS days
         FROM health_point_ledger
        WHERE user_uid = $1::uuid
          AND activity_type = 'DAILY_CHECKIN'
          AND earned_at >= NOW() - INTERVAL '30 days'${tenantId ? ' AND tenant_id = $2::uuid' : ''}`,
      ...(tenantId ? [userUid, tenantId] : [userUid])
    );
    const streakDays = streak[0]?.days || 0;
    if (streakDays >= 7) {
      insights.push({
        type: 'checkin_streak',
        priority: 55,
        title: `${streakDays}-day check-in streak!`,
        message: 'You are building a healthy habit. Keep it going!',
      });
    }

    // — Blood sugar stability (simple: compare latest 5 vs previous 5) —
    const sugars = await prisma.$queryRawUnsafe(
      `SELECT blood_sugar, recorded_at
         FROM patient_vitals
        WHERE patient_uid = $1::uuid
          AND blood_sugar IS NOT NULL${tenantId ? ' AND tenant_id = $2::uuid' : ''}
        ORDER BY recorded_at DESC
        LIMIT 10`,
      ...(tenantId ? [userUid, tenantId] : [userUid])
    );
    if (sugars.length >= 6) {
      const recent = sugars.slice(0, 5).map((r) => r.blood_sugar);
      const older = sugars.slice(5).map((r) => r.blood_sugar);
      const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
      const avgOlder = older.reduce((a, b) => a + b, 0) / older.length;
      const delta = avgOlder > 0 ? ((avgRecent - avgOlder) / avgOlder) * 100 : 0;
      if (Math.abs(delta) < 10) {
        insights.push({
          type: 'sugar_stable',
          priority: 50,
          title: 'Your blood sugar is stable',
          message: `Averaging ${Math.round(avgRecent)} mg/dL — within 10% of prior readings.`,
        });
      } else if (delta < -10) {
        insights.push({
          type: 'sugar_improving',
          priority: 65,
          title: `Blood sugar improved ${Math.abs(Math.round(delta))}%`,
          message: `From ${Math.round(avgOlder)} → ${Math.round(avgRecent)} mg/dL. Keep it up!`,
        });
      }
    }
  } catch (err) {
    logger.warn('computeHealthInsights error', { error: err.message, userUid });
  }

  insights.sort((a, b) => b.priority - a.priority);
  return insights.slice(0, limit);
}

// ── Public: daily check-in ───────────────────────────────────────────────────

/**
 * Returns true if the user has already submitted a check-in today. Used by
 * the dashboard to decide whether to show the check-in prompt.
 */
export async function hasCheckedInToday(userUid, tenantId = null) {
  // P7 fix: the check-in day key is the IST (Asia/Kolkata) calendar day —
  // must match recordCheckIn's activity_ref_id key (gamificationController).
  const today = istDateString();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM health_point_ledger
      WHERE user_uid = $1::uuid
        AND activity_type = 'DAILY_CHECKIN'
        AND activity_ref_id = $2${tenantId ? ' AND tenant_id = $3::uuid' : ''}
      LIMIT 1`,
    ...(tenantId ? [userUid, today, tenantId] : [userUid, today])
  );
  return rows.length > 0;
}

/**
 * Count of consecutive days (including today) the user has checked in.
 */
export async function getCheckInStreak(userUid, tenantId = null) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT activity_ref_id AS day
       FROM health_point_ledger
      WHERE user_uid = $1::uuid
        AND activity_type = 'DAILY_CHECKIN'
        AND earned_at >= NOW() - INTERVAL '120 days'${tenantId ? ' AND tenant_id = $2::uuid' : ''}
      ORDER BY activity_ref_id DESC`,
    ...(tenantId ? [userUid, tenantId] : [userUid])
  );
  if (rows.length === 0) return 0;

  // P7 fix: walk consecutive IST (Asia/Kolkata) calendar days, matching the
  // IST activity_ref_id day keys. IST has no DST, so stepping back in exact
  // 24h increments and re-deriving the IST date string is always correct.
  // Historical (pre-fix) keys were UTC days; for entries written between
  // 00:00 and 05:29 IST that is the previous calendar day, so one legacy
  // early-morning entry can read as a one-day gap — accepted one-time skew.
  let streak = 0;
  const nowMs = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const expectedStr = istDateString(new Date(nowMs - i * 86400000));
    if (rows[i].day === expectedStr) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}
