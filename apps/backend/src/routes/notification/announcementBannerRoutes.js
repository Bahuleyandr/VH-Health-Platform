// src/routes/notification/announcementBannerRoutes.js
//
// ADM-2 (review 2026-08-10): the admin portal's "hospital-wide" announcement
// banner previously lived in each browser's localStorage, so it was never
// hospital-wide. Persist it in the existing per-tenant settings storage
// (`tenants.settings.announcementBanner` jsonb key) so every portal user of
// the tenant sees the same banner.
//
// Mounted at /api/v1/notifications/announcement-banner (see ./index.js):
//   GET / — ADMIN | SUPER_ADMIN (the admin dashboard chrome renders it)
//   PUT / — notificationManagement ADMIN | SUPER_ADMIN
//
// Not a clinical write — no canonical timeline pair; the PUT is audited via
// logAudit like the other admin notification actions.
import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error } from '../../utils/responseHelper.js';
import { stripHtml } from '../../utils/sanitize.js';

const router = express.Router();

const BANNER_TYPES = ['info', 'warning', 'critical', 'success'];
const BANNER_TEXT_MAX = 300;

function requireAdminPermission(permission) {
  return async (req, res, next) => {
    try {
      const role = String(req.user?.rawRole || req.user?.role || '').toUpperCase();
      if (role === 'SUPER_ADMIN') return next();
      if (!req.tenantId) return next();

      const admin = await prisma.admins.findUnique({
        where: { uid: String(req.user?.uid || req.user?.id || '') },
        select: {
          permissions: true,
          is_active: true,
          status: true,
          tenant_id: true,
        },
      });
      const tenantMatches = admin?.tenant_id == null
        || String(admin.tenant_id) === String(req.tenantId);
      const permissions = Array.isArray(admin?.permissions) ? admin.permissions : [];
      if (
        admin?.is_active === true
        && admin?.status === 'active'
        && tenantMatches
        && (permissions.includes('*') || permissions.includes(permission))
      ) {
        return next();
      }
      return error(res, `Forbidden: missing ${permission} permission`, 403);
    } catch (err) {
      return next(err);
    }
  };
}

function normalizeBanner(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  const type = BANNER_TYPES.includes(raw.type) ? raw.type : 'info';
  return {
    text,
    type,
    enabled: raw.enabled === true && text.length > 0,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
  };
}

router.get('/', requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return success(res, { banner: null }, 'Announcement banner');
    }
    // Read fresh (not through the 60s tenant cache) so a just-saved banner is
    // visible to other admins immediately.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT settings -> 'announcementBanner' AS banner
         FROM tenants
        WHERE id = $1::uuid`,
      String(tenantId)
    );
    return success(res, { banner: normalizeBanner(rows?.[0]?.banner) }, 'Announcement banner');
  } catch (err) {
    logger.error('Announcement banner read error:', err);
    return error(res, 'Failed to load announcement banner', 500);
  }
});

router.put(
  '/',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requireAdminPermission('notificationManagement'),
  async (req, res) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return error(res, 'Tenant context unavailable', 404);
    }

    const body = req.body || {};
    const text = stripHtml(String(body.text ?? '')).trim().slice(0, BANNER_TEXT_MAX);
    const type = BANNER_TYPES.includes(body.type) ? body.type : null;
    if (!type) {
      return error(res, `Banner type must be one of: ${BANNER_TYPES.join(', ')}`, 400);
    }
    if (typeof body.enabled !== 'boolean') {
      return error(res, 'Banner enabled flag must be a boolean', 400);
    }

    const banner = {
      text,
      type,
      enabled: body.enabled === true && text.length > 0,
      updated_at: new Date().toISOString(),
    };

    await prisma.$executeRawUnsafe(
      `UPDATE tenants
          SET settings = jsonb_set(
                COALESCE(settings, '{}'::jsonb),
                '{announcementBanner}',
                $2::jsonb,
                true
              ),
              updated_at = NOW()
        WHERE id = $1::uuid`,
      String(tenantId),
      JSON.stringify(banner)
    );

    await logAudit(req, 'announcement-banner-updated', {
      enabled: banner.enabled,
      type: banner.type,
      textLength: banner.text.length,
    });

    return success(res, { banner }, 'Announcement banner saved');
  } catch (err) {
    logger.error('Announcement banner save error:', err);
    return error(res, 'Failed to save announcement banner', 500);
  }
  }
);

export default router;
