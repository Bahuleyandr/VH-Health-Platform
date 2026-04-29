import express from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

// Badge types and their display info
const BADGE_INFO = {
  TOP1_MONTH:       { label: 'Monthly Champion',    emoji: '👑', desc: '#1 on the monthly leaderboard' },
  TOP2_3_MONTH:     { label: 'Monthly Top 3',       emoji: '🏆', desc: 'Top 3 on the monthly leaderboard' },
  TOP10PCT_MONTH:   { label: 'Top 10%',             emoji: '🌟', desc: 'Top 10% on the monthly leaderboard' },
  STREAK_7:         { label: '7-Day Streak',        emoji: '📅', desc: '7 consecutive days with a walk session' },
  STREAK_30:        { label: '30-Day Streak',       emoji: '🔥', desc: '30 consecutive days with a walk session' },
  STREAK_90:        { label: '90-Day Streak',       emoji: '💎', desc: '90 consecutive days with a walk session' },
  DIST_100KM:       { label: '100km Total',         emoji: '🛣️',  desc: 'Total distance reached 100km' },
  DIST_500KM:       { label: '500km Total',         emoji: '🚀', desc: 'Total distance reached 500km' },
  DIST_1000KM:      { label: '1000km Total',        emoji: '🌍', desc: 'Total distance reached 1000km' },
  CONSISTENCY_MONTH:{ label: 'Consistent Walker',   emoji: '✅', desc: 'Active on 20+ days this month' },
};

// ── Helper: award badge if not already earned ─────────────────────────────────
async function awardBadge(userUid, badgeType) {
  try {
    // step_rewards table is the canonical badge store (Prisma model)
    const existing = await prisma.step_rewards.findFirst({
      where: { user_uid: userUid, reward_type: badgeType },
    });
    if (existing) return false; // already awarded

    await prisma.step_rewards.create({
      data: {
        user_uid: userUid,
        reward_type: badgeType,
        description: BADGE_INFO[badgeType]?.desc ?? badgeType,
        discount_pct: 0,
        is_applied: false,
      },
    });
    return true;
  } catch (err) {
    logger.warn(`Badge award failed: ${err.message}`);
    return false;
  }
}

// ── GET /rewards/badges — list user's earned badges ────────────────────────────
router.get('/badges', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const rewards = await prisma.step_rewards.findMany({
      where: { user_uid: uid },
      orderBy: { created_at: 'desc' },
    });

    const badges = rewards.map(row => ({
      rewardType: row.reward_type,
      earnedAt: row.created_at,
      ...(BADGE_INFO[row.reward_type] || { label: row.reward_type, emoji: '⭐', desc: '' }),
    }));

    return success(res, badges, 'Badges');
  } catch (err) {
    logger.error('Error getting badges:', err);
    return error(res, 'Failed to get badges', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ── POST /rewards/badges/check — check and award eligible badges ───────────────
// Called after stopping a session to check if new badges were earned.
router.post('/badges/check', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const newBadges = [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // ── Monthly leaderboard rank badges ───────────────────────────────────────
    // Count distinct opted-in users with sessions this month to compute percentile
    const [monthlyRankRows, totalUsersRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT
          ss.user_uid,
          SUM(ss.steps)::bigint AS total_steps,
          RANK() OVER (ORDER BY SUM(ss.steps) DESC) AS rank
        FROM step_sessions ss
        LEFT JOIN step_profiles sp ON sp.user_uid = ss.user_uid
        WHERE ss.is_active = false
          AND ss.started_at >= ${monthStart}
          AND (sp.opted_in IS NULL OR sp.opted_in = true)
        GROUP BY ss.user_uid
      `,
      prisma.$queryRaw`
        SELECT COUNT(DISTINCT ss.user_uid)::int AS total
        FROM step_sessions ss
        LEFT JOIN step_profiles sp ON sp.user_uid = ss.user_uid
        WHERE ss.is_active = false
          AND ss.started_at >= ${monthStart}
          AND (sp.opted_in IS NULL OR sp.opted_in = true)
      `,
    ]);

    const myRankRow = monthlyRankRows.find(r => r.user_uid === uid);
    const totalUsers = Number(totalUsersRows[0]?.total ?? 0);

    if (myRankRow) {
      const rank = Number(myRankRow.rank);
      if (rank === 1) {
        if (await awardBadge(uid, 'TOP1_MONTH')) newBadges.push('TOP1_MONTH');
      }
      if (rank <= 3) {
        if (await awardBadge(uid, 'TOP2_3_MONTH')) newBadges.push('TOP2_3_MONTH');
      }
      if (totalUsers > 0 && rank / totalUsers <= 0.1) {
        if (await awardBadge(uid, 'TOP10PCT_MONTH')) newBadges.push('TOP10PCT_MONTH');
      }
    }

    // ── Consistency badge — 20+ distinct active days this month ───────────────
    const consistencyRows = await prisma.$queryRaw`
      SELECT COUNT(DISTINCT DATE(started_at AT TIME ZONE 'UTC'))::int AS active_days
      FROM step_sessions
      WHERE user_uid = ${uid}::uuid
        AND is_active = false
        AND started_at >= ${monthStart}
    `;
    if (Number(consistencyRows[0]?.active_days ?? 0) >= 20) {
      if (await awardBadge(uid, 'CONSISTENCY_MONTH')) newBadges.push('CONSISTENCY_MONTH');
    }

    // ── Streak badges — consecutive days with at least 1 session ──────────────
    const sessionDaysRows = await prisma.$queryRaw`
      SELECT DISTINCT DATE(started_at AT TIME ZONE 'UTC') AS session_date
      FROM step_sessions
      WHERE user_uid = ${uid}::uuid
        AND is_active = false
      ORDER BY session_date DESC
    `;

    const sessionDates = sessionDaysRows.map(r => {
      const d = r.session_date instanceof Date ? r.session_date : new Date(r.session_date);
      return d.toISOString().split('T')[0];
    });

    // Compute longest streak of consecutive days
    let maxStreak = 0;
    if (sessionDates.length > 0) {
      let streak = 1;
      for (let i = 0; i < sessionDates.length - 1; i++) {
        const curr = new Date(sessionDates[i]);
        const next = new Date(sessionDates[i + 1]);
        const diffDays = Math.round((curr - next) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
          streak++;
        } else {
          maxStreak = Math.max(maxStreak, streak);
          streak = 1;
        }
      }
      maxStreak = Math.max(maxStreak, streak);
    }

    if (maxStreak >= 7)  { if (await awardBadge(uid, 'STREAK_7'))  newBadges.push('STREAK_7'); }
    if (maxStreak >= 30) { if (await awardBadge(uid, 'STREAK_30')) newBadges.push('STREAK_30'); }
    if (maxStreak >= 90) { if (await awardBadge(uid, 'STREAK_90')) newBadges.push('STREAK_90'); }

    // ── Distance milestone badges — total distance_meters from step_sessions ───
    const distRows = await prisma.$queryRaw`
      SELECT COALESCE(SUM(distance_meters), 0)::float AS total_meters
      FROM step_sessions
      WHERE user_uid = ${uid}::uuid
        AND is_active = false
    `;
    const totalMeters = Number(distRows[0]?.total_meters ?? 0);
    const totalKm = totalMeters / 1000;

    if (totalKm >= 100)  { if (await awardBadge(uid, 'DIST_100KM'))  newBadges.push('DIST_100KM'); }
    if (totalKm >= 500)  { if (await awardBadge(uid, 'DIST_500KM'))  newBadges.push('DIST_500KM'); }
    if (totalKm >= 1000) { if (await awardBadge(uid, 'DIST_1000KM')) newBadges.push('DIST_1000KM'); }

    const enriched = newBadges.map(type => ({
      rewardType: type,
      ...(BADGE_INFO[type] || { label: type, emoji: '⭐', desc: '' }),
    }));

    return success(res, { newBadges: enriched }, 'Badge check complete');
  } catch (err) {
    logger.error('Error checking badges:', err);
    return error(res, 'Failed to check badges', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ── GET /rewards/vouchers — list user's active vouchers ────────────────────────
router.get('/vouchers', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const vouchers = await prisma.step_rewards.findMany({
      where: { user_uid: uid, discount_pct: { gt: 0 } },
      orderBy: { created_at: 'desc' },
    });

    return success(res, vouchers, 'Vouchers');
  } catch (err) {
    logger.error('Error getting vouchers:', err);
    return error(res, 'Failed to get vouchers', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ── GET /rewards/leaderboard/monthly — monthly top 20 ─────────────────────────
router.get('/leaderboard/monthly', async (req, res) => {
  try {
    const monthYear = new Date().toISOString().slice(0, 7); // "2026-03"
    const monthStart = new Date(`${monthYear}-01T00:00:00.000Z`);

    const rows = await prisma.$queryRaw`
      SELECT
        COALESCE(sp.display_name, 'Anonymous') AS display_name,
        COALESCE(sp.display_color, '#2196F3')  AS display_color,
        SUM(ss.steps)::int                     AS monthly_steps,
        SUM(ss.distance_meters)::float         AS monthly_distance_meters,
        RANK() OVER (ORDER BY SUM(ss.steps) DESC) AS rank
      FROM step_sessions ss
      LEFT JOIN step_profiles sp ON sp.user_uid = ss.user_uid
      WHERE ss.is_active = false
        AND ss.started_at >= ${monthStart}
        AND (sp.opted_in IS NULL OR sp.opted_in = true)
      GROUP BY sp.display_name, sp.display_color
      ORDER BY monthly_steps DESC
      LIMIT 20
    `;

    const withRewards = rows.map(row => ({
      displayName: row.display_name,
      displayColor: row.display_color,
      monthlySteps: Number(row.monthly_steps),
      monthlyDistanceMeters: Number(row.monthly_distance_meters),
      rank: Number(row.rank),
      rewardTier: row.rank === 1
        ? 'Free consultation + 10% off pharmacy & investigations'
        : row.rank <= 3
        ? '10% off pharmacy & investigations'
        : null,
    }));

    return success(res, { monthYear, leaderboard: withRewards }, 'Monthly leaderboard');
  } catch (err) {
    logger.error('Error getting monthly leaderboard:', err);
    return error(res, 'Failed to get monthly leaderboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ── GET /rewards/my-monthly-rank — current user's monthly rank ─────────────────
router.get('/my-monthly-rank', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const monthYear = new Date().toISOString().slice(0, 7);
    const monthStart = new Date(`${monthYear}-01T00:00:00.000Z`);

    const rankedRows = await prisma.$queryRaw`
      SELECT rank, total_steps, display_name
      FROM (
        SELECT
          ss.user_uid,
          COALESCE(sp.display_name, 'Anonymous') AS display_name,
          SUM(ss.steps)::int AS total_steps,
          RANK() OVER (ORDER BY SUM(ss.steps) DESC) AS rank
        FROM step_sessions ss
        LEFT JOIN step_profiles sp ON sp.user_uid = ss.user_uid
        WHERE ss.is_active = false
          AND ss.started_at >= ${monthStart}
          AND (sp.opted_in IS NULL OR sp.opted_in = true)
        GROUP BY ss.user_uid, sp.display_name
      ) ranked
      WHERE user_uid = ${uid}::uuid
    `;

    const row = rankedRows[0] ?? null;
    const rewardTier = row
      ? (row.rank === 1
          ? 'Free consultation + 10% off pharmacy & investigations'
          : row.rank <= 3
          ? '10% off pharmacy & investigations'
          : null)
      : null;

    return success(
      res,
      row
        ? { rank: Number(row.rank), totalSteps: Number(row.total_steps), displayName: row.display_name, rewardTier, monthYear }
        : { rank: null, totalSteps: 0, rewardTier: null, monthYear },
      'Monthly rank',
    );
  } catch (err) {
    logger.error('Error getting monthly rank:', err);
    return error(res, 'Failed to get monthly rank', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ── POST /rewards/issue-monthly — admin: compute and issue monthly rewards ─────
router.post('/issue-monthly', async (req, res) => {
  try {
    if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user?.role)) {
      return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);
    }

    const { month_year } = req.body;
    if (!month_year || !/^\d{4}-\d{2}$/.test(month_year)) {
      return error(res, 'Invalid month_year format (YYYY-MM)', HTTP_STATUS.BAD_REQUEST);
    }

    const monthStart = new Date(`${month_year}-01T00:00:00.000Z`);

    const top3 = await prisma.$queryRaw`
      SELECT
        ss.user_uid,
        COALESCE(sp.display_name, 'Anonymous') AS display_name,
        SUM(ss.steps)::int AS total_steps,
        RANK() OVER (ORDER BY SUM(ss.steps) DESC) AS rank
      FROM step_sessions ss
      LEFT JOIN step_profiles sp ON sp.user_uid = ss.user_uid
      WHERE ss.is_active = false
        AND ss.started_at >= ${monthStart}
        AND ss.started_at < ${new Date(`${month_year}-01T00:00:00.000Z`).setMonth(new Date(`${month_year}-01`).getMonth() + 1)}
        AND (sp.opted_in IS NULL OR sp.opted_in = true)
      GROUP BY ss.user_uid, sp.display_name
      ORDER BY total_steps DESC
      LIMIT 3
    `;

    const issued = [];
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    for (const winner of top3) {
      const rank = Number(winner.rank);
      let rewardType, description, discountPct;

      if (rank === 1) {
        rewardType = 'TOP1_MONTH';
        description = 'Monthly Champion Reward: Free consultation + 10% off pharmacy & investigations';
        discountPct = 10;
      } else if (rank === 2) {
        rewardType = 'TOP2_3_MONTH';
        description = 'Monthly Top 2 Reward: 10% off pharmacy & investigations';
        discountPct = 10;
      } else {
        rewardType = 'TOP2_3_MONTH';
        description = 'Monthly Top 3 Reward: 10% off pharmacy & investigations';
        discountPct = 10;
      }

      // Check if reward already issued this month
      const existing = await prisma.step_rewards.findFirst({
        where: { user_uid: winner.user_uid, reward_month: month_year, reward_type: rewardType },
      });
      if (existing) continue;

      await prisma.step_rewards.create({
        data: {
          user_uid: winner.user_uid,
          reward_type: rewardType,
          reward_month: month_year,
          discount_pct: discountPct,
          description,
          is_applied: false,
          expires_at: expiresAt,
        },
      });

      // Award badges
      if (rank === 1) {
        await awardBadge(winner.user_uid, 'TOP1_MONTH');
        await awardBadge(winner.user_uid, 'TOP2_3_MONTH');
      } else {
        await awardBadge(winner.user_uid, 'TOP2_3_MONTH');
      }

      issued.push({ rank, displayName: winner.display_name, rewardType });
    }

    return success(res, { month_year, issued }, `Monthly rewards issued for ${month_year}`);
  } catch (err) {
    logger.error('Error issuing monthly rewards:', err);
    return error(res, 'Failed to issue monthly rewards', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
