import express from 'express';
import crypto from 'crypto';
import db from '../../config/database.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';

const router = express.Router();

// Badge types and their display info
const BADGE_INFO = {
  'first_sync':        { label: 'First Steps',        emoji: '🚶', desc: 'First step logged' },
  'day_10k':           { label: '10K Day',             emoji: '🔥', desc: 'Walked 10,000 steps in one day' },
  'streak_7':          { label: '7-Day Streak',        emoji: '📅', desc: '7 consecutive days logged' },
  'distance_100km':    { label: '100km Total',         emoji: '🌟', desc: 'Total distance reached 100km' },
  'monthly_top3':      { label: 'Monthly Top 3',       emoji: '🏆', desc: 'Finished in top 3 for the month' },
  'monthly_champion':  { label: 'Monthly Champion',    emoji: '👑', desc: '#1 for the month' },
};

// ── Helper: award badge if not already earned ─────────────────────────────────
async function awardBadge(patientUid, badgeType) {
  try {
    await db.query(`
      INSERT INTO step_badges (patient_uid, badge_type)
      VALUES ($1, $2)
      ON CONFLICT (patient_uid, badge_type) DO NOTHING
    `, [patientUid, badgeType]);
    return true;
  } catch (err) {
    logger.warn(`Badge award failed: ${err.message}`);
    return false;
  }
}

// ── Helper: generate voucher code ─────────────────────────────────────────────
function generateVoucherCode(prefix = 'VH') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// ── GET /rewards/badges — list patient's earned badges ─────────────────────────
router.get('/badges', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const result = await db.query(
      `SELECT badge_type, earned_at FROM step_badges WHERE patient_uid = $1 ORDER BY earned_at DESC`,
      [uid]
    );

    const badges = result.rows.map(row => ({
      ...row,
      ...(BADGE_INFO[row.badge_type] || { label: row.badge_type, emoji: '⭐', desc: '' }),
    }));

    success(res, badges, 'Badges');
  } catch (err) {
    logger.error('Error getting badges:', err);
    error(res, 'Failed to get badges', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ── POST /rewards/badges/check — check and award eligible badges ───────────────
// Called after syncing steps to check if new badges were earned
router.post('/badges/check', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const newBadges = [];

    // Check: first_sync (any step log at all)
    const syncCount = await db.query(
      `SELECT COUNT(*) FROM step_logs WHERE patient_uid = $1`,
      [uid]
    );
    if (parseInt(syncCount.rows[0].count) >= 1) {
      const awarded = await awardBadge(uid, 'first_sync');
      if (awarded) newBadges.push('first_sync');
    }

    // Check: day_10k (any day with 10k+ steps)
    const tenK = await db.query(
      `SELECT 1 FROM step_logs WHERE patient_uid = $1 AND steps >= 10000 LIMIT 1`,
      [uid]
    );
    if (tenK.rows.length > 0) {
      const awarded = await awardBadge(uid, 'day_10k');
      if (awarded) newBadges.push('day_10k');
    }

    // Check: streak_7 (7 consecutive days)
    const streakResult = await db.query(`
      WITH numbered AS (
        SELECT log_date,
          ROW_NUMBER() OVER (ORDER BY log_date) -
          EXTRACT(DOY FROM log_date)::int AS grp
        FROM step_logs
        WHERE patient_uid = $1 AND steps > 0
      )
      SELECT COUNT(*) AS streak_len FROM numbered GROUP BY grp ORDER BY streak_len DESC LIMIT 1
    `, [uid]);
    if (streakResult.rows.length > 0 && parseInt(streakResult.rows[0].streak_len) >= 7) {
      const awarded = await awardBadge(uid, 'streak_7');
      if (awarded) newBadges.push('streak_7');
    }

    // Check: distance_100km
    const distResult = await db.query(
      `SELECT SUM(distance_km) AS total FROM step_logs WHERE patient_uid = $1`,
      [uid]
    );
    if (parseFloat(distResult.rows[0]?.total || 0) >= 100) {
      const awarded = await awardBadge(uid, 'distance_100km');
      if (awarded) newBadges.push('distance_100km');
    }

    const enriched = newBadges.map(type => ({
      badge_type: type,
      ...(BADGE_INFO[type] || { label: type, emoji: '⭐', desc: '' }),
    }));

    success(res, { new_badges: enriched }, 'Badge check complete');
  } catch (err) {
    logger.error('Error checking badges:', err);
    error(res, 'Failed to check badges', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ── GET /rewards/vouchers — list patient's active vouchers ─────────────────────
router.get('/vouchers', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const result = await db.query(`
      SELECT id, voucher_code, reward_type, description, discount_pct,
             free_consult, issued_at, expires_at, redeemed_at, month_year
      FROM step_vouchers
      WHERE patient_uid = $1
      ORDER BY issued_at DESC
    `, [uid]);

    success(res, result.rows, 'Vouchers');
  } catch (err) {
    logger.error('Error getting vouchers:', err);
    error(res, 'Failed to get vouchers', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ── GET /rewards/leaderboard/monthly — monthly top 20 ─────────────────────────
router.get('/leaderboard/monthly', async (req, res) => {
  try {
    // Current calendar month
    const monthYear = new Date().toISOString().slice(0, 7); // "2026-03"
    const monthStart = `${monthYear}-01`;

    const result = await db.query(`
      SELECT
        sp.leaderboard_name,
        sp.avatar_color,
        COALESCE(SUM(sl.steps), 0) AS monthly_steps,
        COALESCE(SUM(sl.distance_km), 0) AS monthly_distance_km,
        RANK() OVER (ORDER BY COALESCE(SUM(sl.steps), 0) DESC) AS rank
      FROM step_profile sp
      LEFT JOIN step_logs sl ON sl.patient_uid = sp.patient_uid
        AND sl.log_date >= $1
        AND sl.log_date < ($1::date + INTERVAL '1 month')
      WHERE sp.opt_out_leaderboard = false
      GROUP BY sp.leaderboard_name, sp.avatar_color
      ORDER BY monthly_steps DESC
      LIMIT 20
    `, [monthStart]);

    // Annotate reward tier
    const withRewards = result.rows.map(row => ({
      ...row,
      reward_tier: row.rank === 1
        ? 'Free consultation + 10% off pharmacy & investigations'
        : row.rank <= 3
        ? '10% off pharmacy & investigations'
        : null,
    }));

    success(res, { month_year: monthYear, leaderboard: withRewards }, 'Monthly leaderboard');
  } catch (err) {
    logger.error('Error getting monthly leaderboard:', err);
    error(res, 'Failed to get monthly leaderboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ── GET /rewards/my-monthly-rank — current patient's monthly rank ──────────────
router.get('/my-monthly-rank', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const monthYear = new Date().toISOString().slice(0, 7);
    const monthStart = `${monthYear}-01`;

    const result = await db.query(`
      WITH monthly AS (
        SELECT patient_uid, COALESCE(SUM(steps), 0) AS monthly_steps
        FROM step_logs
        WHERE log_date >= $1 AND log_date < ($1::date + INTERVAL '1 month')
        GROUP BY patient_uid
      ),
      ranked AS (
        SELECT patient_uid, monthly_steps,
          RANK() OVER (ORDER BY monthly_steps DESC) AS rank
        FROM monthly
      )
      SELECT r.rank, r.monthly_steps, sp.leaderboard_name
      FROM ranked r
      JOIN step_profile sp ON sp.patient_uid = r.patient_uid
      WHERE r.patient_uid = $2
    `, [monthStart, uid]);

    const row = result.rows[0] || { rank: null, monthly_steps: 0 };
    const rewardTier = row.rank === 1
      ? 'Free consultation + 10% off pharmacy & investigations'
      : row.rank <= 3
      ? '10% off pharmacy & investigations'
      : null;

    success(res, { ...row, reward_tier: rewardTier, month_year: monthYear }, 'Monthly rank');
  } catch (err) {
    logger.error('Error getting monthly rank:', err);
    error(res, 'Failed to get monthly rank', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ── POST /rewards/issue-monthly — admin: compute and issue monthly rewards ─────
// Called by admin or cron at end of month
router.post('/issue-monthly', async (req, res) => {
  try {
    // This endpoint should be admin-only in production
    // For now it validates the calling user is an admin role
    if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user?.role)) {
      return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);
    }

    const { month_year } = req.body; // e.g. "2026-03"
    if (!month_year || !/^\d{4}-\d{2}$/.test(month_year)) {
      return error(res, 'Invalid month_year format (YYYY-MM)', HTTP_STATUS.BAD_REQUEST);
    }

    const monthStart = `${month_year}-01`;

    // Get top 3 for the month
    const top3 = await db.query(`
      SELECT sp.patient_uid, sp.leaderboard_name, COALESCE(SUM(sl.steps), 0) AS total_steps,
        RANK() OVER (ORDER BY COALESCE(SUM(sl.steps), 0) DESC) AS rank
      FROM step_profile sp
      LEFT JOIN step_logs sl ON sl.patient_uid = sp.patient_uid
        AND sl.log_date >= $1
        AND sl.log_date < ($1::date + INTERVAL '1 month')
      GROUP BY sp.patient_uid, sp.leaderboard_name
      ORDER BY total_steps DESC
      LIMIT 3
    `, [monthStart]);

    const issued = [];
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    for (const winner of top3.rows) {
      const rank = parseInt(winner.rank);
      let rewardType, description, discountPct, freeConsult;

      if (rank === 1) {
        rewardType = 'rank1_monthly';
        description = 'Monthly Champion Reward: Free consultation + 10% off pharmacy & investigations';
        discountPct = 10;
        freeConsult = true;
      } else {
        rewardType = `rank${rank}_monthly`;
        description = `Monthly Top ${rank} Reward: 10% off pharmacy & investigations`;
        discountPct = 10;
        freeConsult = false;
      }

      const code = generateVoucherCode('VH');

      const voucherResult = await db.query(`
        INSERT INTO step_vouchers
          (patient_uid, voucher_code, reward_type, description, discount_pct, free_consult, expires_at, month_year)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [winner.patient_uid, code, rewardType, description, discountPct, freeConsult, expiresAt.toISOString(), month_year]);

      if (voucherResult.rows.length > 0) {
        await db.query(`
          INSERT INTO step_monthly_winners (patient_uid, rank, month_year, total_steps, voucher_id)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (patient_uid, month_year) DO NOTHING
        `, [winner.patient_uid, rank, month_year, winner.total_steps, voucherResult.rows[0].id]);

        // Award monthly badges
        if (rank === 1) {
          await awardBadge(winner.patient_uid, 'monthly_champion');
          await awardBadge(winner.patient_uid, 'monthly_top3');
        } else {
          await awardBadge(winner.patient_uid, 'monthly_top3');
        }

        issued.push({ rank, name: winner.leaderboard_name, voucher_code: code });
      }
    }

    success(res, { month_year, issued }, `Monthly rewards issued for ${month_year}`);
  } catch (err) {
    logger.error('Error issuing monthly rewards:', err);
    error(res, 'Failed to issue monthly rewards', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
