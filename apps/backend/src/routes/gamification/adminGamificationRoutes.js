// src/routes/gamification/adminGamificationRoutes.js
// Admin gamification routes — milestone CRUD, voucher redemption
//
// ★ NO CLIENT CALLS THIS ROUTER. It is reachable only by hand (curl/Postman)
// from an allowlisted admin IP. Verified 2026-08-24: the admin portal has no
// gamification page, no `lib/api` client and no `proxyPermissions` entry for
// `/admin/gamification`; and the mount
// (`app.js` -> `/api/v1/admin/gamification`) gates on ADMIN_ROUTE_ROLES
// = SUPER_ADMIN|ADMIN plus `requireSuperAdminStepUp` and `adminIpAllowlist`,
// so the staff app — whose pharmacy/front-desk roles are the ones that would
// actually redeem a voucher at a counter — cannot reach it at any URL.
//
// Consequence, and why it matters more than "an unused endpoint": this router
// is the ONLY write path to `health_milestones`, and no migration seeds that
// table (grep `INSERT INTO health_milestones` — zero hits outside tests). So
// every tenant starts with an empty reward catalog, the patient app's
// Milestones tab renders nothing, and `POST /gamification/milestones/:id/claim`
// has nothing to claim. At the other end, `POST /vouchers/:code/redeem` is the
// only way to burn a voucher minted by `pointService.claimMilestone`, and it
// is equally unreachable. The patient rewards loop can therefore neither start
// nor close.
//
// This is PARKED, not forgotten — the decision and what closing the loop would
// require are written up in docs/ROADMAP.md ("Patient gamification / step
// rewards loop"). The routes are left in place, working and tenant-scoped,
// because they are the correct server half; do not delete them and do not
// build a speculative admin console for them without the product decision the
// ROADMAP entry asks for.

import { Router } from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success, error } from '../../utils/responseHelper.js';
import { epochMsOrNull } from '../../utils/dbInstant.js';

const router = Router();

// ─── GET / ── list all milestones (admin management) ─────────────────────────
router.get('/', async (req, res) => {
  try {
    const milestones = await prisma.$queryRawUnsafe(
      `SELECT id, name, points_required, reward_type, reward_value,
              reward_description, icon_name, color_hex, is_active, sort_order,
              created_at, updated_at
       FROM health_milestones
       ORDER BY sort_order ASC, points_required ASC`
    );

    return success(res, { milestones }, 'Milestones retrieved');
  } catch (err) {
    logger.error('Admin gamification GET / error', { error: err.message });
    return error(res, 'Failed to retrieve milestones', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ─── POST / ── create milestone ──────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      name, pointsRequired, rewardType, rewardValue,
      rewardDescription, iconName, colorHex, isActive, sortOrder,
    } = req.body;

    if (!name || pointsRequired == null || !rewardType || !rewardDescription) {
      return error(res, 'name, pointsRequired, rewardType, and rewardDescription are required', HTTP_STATUS.BAD_REQUEST);
    }

    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO health_milestones
         (name, points_required, reward_type, reward_value, reward_description,
          icon_name, color_hex, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, name, points_required, reward_type, reward_value,
                 reward_description, icon_name, color_hex, is_active, sort_order, created_at`,
      name,
      parseInt(pointsRequired, 10),
      rewardType,
      parseInt(rewardValue, 10) || 0,
      rewardDescription,
      iconName || null,
      colorHex || null,
      isActive !== false,
      parseInt(sortOrder, 10) || 0
    );

    return success(res, { milestone: rows[0] }, 'Milestone created', HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Admin gamification POST / error', { error: err.message });
    return error(res, 'Failed to create milestone', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ─── PUT /:id ── update milestone ────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const milestoneId = parseInt(req.params.id, 10);
    if (isNaN(milestoneId)) {
      return error(res, 'Invalid milestone ID', HTTP_STATUS.BAD_REQUEST);
    }

    const {
      name, pointsRequired, rewardType, rewardValue,
      rewardDescription, iconName, colorHex, isActive, sortOrder,
    } = req.body;

    // Build dynamic SET clause
    const sets = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) { sets.push(`name = $${idx++}`); params.push(name); }
    if (pointsRequired !== undefined) { sets.push(`points_required = $${idx++}`); params.push(parseInt(pointsRequired, 10)); }
    if (rewardType !== undefined) { sets.push(`reward_type = $${idx++}`); params.push(rewardType); }
    if (rewardValue !== undefined) { sets.push(`reward_value = $${idx++}`); params.push(parseInt(rewardValue, 10)); }
    if (rewardDescription !== undefined) { sets.push(`reward_description = $${idx++}`); params.push(rewardDescription); }
    if (iconName !== undefined) { sets.push(`icon_name = $${idx++}`); params.push(iconName); }
    if (colorHex !== undefined) { sets.push(`color_hex = $${idx++}`); params.push(colorHex); }
    if (isActive !== undefined) { sets.push(`is_active = $${idx++}`); params.push(Boolean(isActive)); }
    if (sortOrder !== undefined) { sets.push(`sort_order = $${idx++}`); params.push(parseInt(sortOrder, 10)); }

    if (sets.length === 0) {
      return error(res, 'No fields to update', HTTP_STATUS.BAD_REQUEST);
    }

    sets.push(`updated_at = NOW()`);
    params.push(milestoneId);

    const sql = `UPDATE health_milestones SET ${sets.join(', ')} WHERE id = $${idx}
                 RETURNING id, name, points_required, reward_type, reward_value,
                           reward_description, icon_name, color_hex, is_active, sort_order, updated_at`;

    const rows = await prisma.$queryRawUnsafe(sql, ...params);

    if (rows.length === 0) {
      return error(res, 'Milestone not found', HTTP_STATUS.NOT_FOUND);
    }

    return success(res, { milestone: rows[0] }, 'Milestone updated');
  } catch (err) {
    logger.error('Admin gamification PUT /:id error', { error: err.message });
    return error(res, 'Failed to update milestone', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// ─── POST /vouchers/:code/redeem ── mark voucher as redeemed ─────────────────
router.post('/vouchers/:code/redeem', async (req, res) => {
  try {
    const voucherCode = req.params.code;
    const redeemedBy = req.body.redeemedBy || req.user?.uid || 'admin';
    // CAN-012: scope the voucher lookup to the caller's tenant so an admin can
    // only redeem vouchers issued within their own tenant (defense-in-depth
    // alongside RLS).
    const tenantId = resolveTenantOrThrow(req);

    if (!voucherCode) {
      return error(res, 'Voucher code is required', HTTP_STATUS.BAD_REQUEST);
    }

    // Find the voucher
    const existing = await prisma.$queryRawUnsafe(
      `SELECT hmc.id, hmc.user_uid, hmc.voucher_code, hmc.is_redeemed, hmc.expires_at,
              (EXTRACT(EPOCH FROM hmc.expires_at) * 1000)::bigint AS expires_at_epoch_ms,
              hm.name AS milestone_name, hm.reward_description
       FROM health_milestone_claims hmc
       JOIN health_milestones hm ON hm.id = hmc.milestone_id
       WHERE hmc.voucher_code = $1
         AND hmc.tenant_id = $2::uuid
       LIMIT 1`,
      voucherCode, tenantId
    );

    if (existing.length === 0) {
      return error(res, 'Voucher not found', HTTP_STATUS.NOT_FOUND);
    }

    const voucher = existing[0];

    if (voucher.is_redeemed) {
      return error(res, 'Voucher has already been redeemed', HTTP_STATUS.CONFLICT);
    }

    const voucherExpiry = epochMsOrNull(voucher.expires_at_epoch_ms);
    if (voucherExpiry != null && voucherExpiry < Date.now()) {
      return error(res, 'Voucher has expired', HTTP_STATUS.BAD_REQUEST);
    }

    // Mark as redeemed
    const updated = await prisma.$queryRawUnsafe(
      `UPDATE health_milestone_claims
       SET is_redeemed = true, redeemed_at = NOW(), redeemed_by = $1
       WHERE id = $2
       RETURNING id, voucher_code, is_redeemed, redeemed_at, redeemed_by`,
      String(redeemedBy), voucher.id
    );

    return success(res, {
      voucher: updated[0],
      milestoneName: voucher.milestone_name,
      rewardDescription: voucher.reward_description,
    }, 'Voucher redeemed successfully');
  } catch (err) {
    logger.error('Admin gamification voucher redeem error', { error: err.message });
    return error(res, 'Failed to redeem voucher', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
