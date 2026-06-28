// src/controllers/gamification/gamificationController.js

import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as pointService from '../../services/gamification/pointService.js';
import * as wellnessService from '../../services/gamification/wellnessService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { success, error } from '../../utils/responseHelper.js';

/**
 * GET /summary — gamification summary for the authenticated user
 */
export async function getSummary(req, res) {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const summary = await pointService.getUserPointSummary(uid, resolveTenantOrThrow(req)); // CAN-012: tenant-scope

    return success(res, summary, 'Health points summary retrieved');
  } catch (err) {
    logger.error('Gamification getSummary error', { error: err.message });
    return error(res, 'Failed to retrieve gamification summary', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * GET /history — paginated point ledger history
 */
export async function getHistory(req, res) {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const { page, limit, offset } = parseListQuery(req.query, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'earned_at',
    });

    const countRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total FROM health_point_ledger WHERE user_uid = $1::uuid`,
      uid
    );
    const total = countRows[0]?.total || 0;

    const entries = await prisma.$queryRawUnsafe(
      `SELECT id, points, activity_type, activity_ref_id, description, earned_at
       FROM health_point_ledger
       WHERE user_uid = $1::uuid
       ORDER BY earned_at DESC
       LIMIT $2 OFFSET $3`,
      uid, limit, offset
    );

    return success(res, {
      entries,
      pagination: buildPagination(total, page, limit),
    }, 'Point history retrieved');
  } catch (err) {
    logger.error('Gamification getHistory error', { error: err.message });
    return error(res, 'Failed to retrieve point history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * GET /milestones — all active milestones with user's claim status
 */
export async function getMilestones(req, res) {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    // Get total points
    const totalRows = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(points), 0)::int AS total_points
       FROM health_point_ledger WHERE user_uid = $1::uuid`,
      uid
    );
    const totalPoints = totalRows[0]?.total_points || 0;

    // Get all active milestones with claim status
    const milestones = await prisma.$queryRawUnsafe(
      `SELECT hm.id, hm.name, hm.points_required, hm.reward_type, hm.reward_value,
              hm.reward_description, hm.icon_name, hm.color_hex, hm.sort_order,
              hmc.id AS claim_id, hmc.voucher_code, hmc.claimed_at,
              hmc.is_redeemed, hmc.expires_at AS claim_expires_at
       FROM health_milestones hm
       LEFT JOIN health_milestone_claims hmc
         ON hmc.milestone_id = hm.id AND hmc.user_uid = $1::uuid
       WHERE hm.is_active = true
       ORDER BY hm.sort_order ASC, hm.points_required ASC`,
      uid
    );

    const result = milestones.map((m) => ({
      id: m.id,
      name: m.name,
      pointsRequired: m.points_required,
      rewardType: m.reward_type,
      rewardValue: m.reward_value,
      rewardDescription: m.reward_description,
      iconName: m.icon_name,
      colorHex: m.color_hex,
      isUnlocked: totalPoints >= m.points_required,
      isClaimed: !!m.claim_id,
      claim: m.claim_id ? {
        id: m.claim_id,
        voucherCode: m.voucher_code,
        claimedAt: m.claimed_at,
        isRedeemed: m.is_redeemed,
        expiresAt: m.claim_expires_at,
      } : null,
    }));

    return success(res, { totalPoints, milestones: result }, 'Milestones retrieved');
  } catch (err) {
    logger.error('Gamification getMilestones error', { error: err.message });
    return error(res, 'Failed to retrieve milestones', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * POST /milestones/:id/claim — claim a milestone reward
 */
export async function claimMilestone(req, res) {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const milestoneId = parseInt(req.params.id, 10);
    if (isNaN(milestoneId)) {
      return error(res, 'Invalid milestone ID', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await pointService.claimMilestone(uid, milestoneId, resolveTenantOrThrow(req)); // CAN-012: tenant-scope

    if (result.error) {
      return error(res, result.error, result.status || HTTP_STATUS.BAD_REQUEST);
    }

    return success(res, result, 'Milestone claimed successfully');
  } catch (err) {
    logger.error('Gamification claimMilestone error', { error: err.message });
    return error(res, 'Failed to claim milestone', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * GET /wellness-score — 0-100 score with per-dimension breakdown
 */
export async function getWellnessScore(req, res) {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const result = await wellnessService.computeWellnessScore(uid, resolveTenantOrThrow(req)); // CAN-019/012: tenant-scope
    return success(res, result, 'Wellness score computed');
  } catch (err) {
    logger.error('Gamification getWellnessScore error', { error: err.message });
    return error(res, 'Failed to compute wellness score', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * GET /insights — prioritised smart health insight cards for dashboard
 */
export async function getInsights(req, res) {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const limit = Math.min(5, Math.max(1, parseInt(req.query.limit, 10) || 3));
    const insights = await wellnessService.computeHealthInsights(uid, limit, resolveTenantOrThrow(req)); // CAN-019/012: tenant-scope
    return success(res, { insights }, 'Health insights retrieved');
  } catch (err) {
    logger.error('Gamification getInsights error', { error: err.message });
    return error(res, 'Failed to retrieve insights', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * GET /checkin/status — whether the user has already checked in today + streak
 */
export async function getCheckInStatus(req, res) {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const tenantId = resolveTenantOrThrow(req); // CAN-012: tenant-scope check-in reads
    const [done, streak] = await Promise.all([
      wellnessService.hasCheckedInToday(uid, tenantId),
      wellnessService.getCheckInStreak(uid, tenantId),
    ]);
    return success(res, { checkedInToday: done, streak }, 'Check-in status');
  } catch (err) {
    logger.error('Gamification getCheckInStatus error', { error: err.message });
    return error(res, 'Failed to retrieve check-in status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * POST /checkin — record a daily mood check-in and award points (10).
 * Idempotent per day via health_point_ledger's (user_uid, activity_type, activity_ref_id) unique key.
 */
export async function recordCheckIn(req, res) {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const { mood } = req.body || {};
    const allowedMoods = ['great', 'good', 'okay', 'poor', 'bad'];
    if (!mood || !allowedMoods.includes(String(mood).toLowerCase())) {
      return error(res, 'mood must be one of: great, good, okay, poor, bad', HTTP_STATUS.BAD_REQUEST);
    }

    const today = new Date().toISOString().split('T')[0];
    const tenantId = resolveTenantOrThrow(req); // CAN-012: tenant-scope + stamp
    const awarded = await pointService.awardPoints(uid, {
      activityType: 'DAILY_CHECKIN',
      activityRefId: today,
      points: 10,
      description: `Daily check-in (${String(mood).toLowerCase()})`,
    }, tenantId);

    const streak = await wellnessService.getCheckInStreak(uid, tenantId);
    return success(res, {
      alreadyCheckedIn: awarded === null,
      pointsAwarded: awarded ? 10 : 0,
      streak,
    }, awarded ? 'Check-in recorded' : 'Already checked in today');
  } catch (err) {
    logger.error('Gamification recordCheckIn error', { error: err.message });
    return error(res, 'Failed to record check-in', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}
