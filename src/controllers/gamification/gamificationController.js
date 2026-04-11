// src/controllers/gamification/gamificationController.js

import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as pointService from '../../services/gamification/pointService.js';
import { success, error } from '../../utils/responseHelper.js';

/**
 * GET /summary — gamification summary for the authenticated user
 */
export async function getSummary(req, res) {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const summary = await pointService.getUserPointSummary(uid);

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

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

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
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
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

    const result = await pointService.claimMilestone(uid, milestoneId);

    if (result.error) {
      return error(res, result.error, result.status || HTTP_STATUS.BAD_REQUEST);
    }

    return success(res, result, 'Milestone claimed successfully');
  } catch (err) {
    logger.error('Gamification claimMilestone error', { error: err.message });
    return error(res, 'Failed to claim milestone', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}
