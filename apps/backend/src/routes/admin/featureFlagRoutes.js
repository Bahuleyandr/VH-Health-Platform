import express from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { getFlags, setFlag, deleteFlag } from '../../services/featureFlags/featureFlagService.js';
import { success, error } from '../../utils/responseHelper.js';
import { paramId, featureFlagValidator } from '../../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = express.Router();

/**
 * SUPER_ADMIN-only console (in-route gate, same intent as the databaseRoutes.js
 * gate; spelled with the shared `requireRole` so a denied attempt lands in the
 * security audit trail as `PERMISSION_DENIED`).
 *
 * This router is mounted at /api/v1/admin/feature-flags behind an entitlement
 * check (routes/admin/index.js), and the parent `/api/v1/admin` mount gates on
 * ADMIN_ROUTE_ROLES, which resolves to ['SUPER_ADMIN', 'ADMIN']
 * (config/routeRolePolicy.js → platform_admin). `requireSuperAdminStepUp`
 * passes non-supers straight through (rbacMiddleware.js:117), so it narrows
 * nothing for an ADMIN. This router carried NO internal role check at all, so
 * a plain tenant ADMIN could flip, re-target, or delete any feature flag — and
 * `feature_flags` is a PLATFORM-GLOBAL table (services/featureFlags/
 * featureFlagService.js selects, upserts and deletes by `name` alone, with no
 * tenant column and a process-wide cache), so one tenant's ADMIN was editing
 * every tenant's behaviour. The admin portal declares this console
 * SUPER_ADMIN-only (apps/admin/src/lib/routePolicy.ts "feature-flags" →
 * SUPER_ADMIN_ONLY; navConfig.ts "Feature Flags" → requiredRole
 * "SUPER_ADMIN"), and /dashboard/feature-flags is its only client.
 *
 * Router-wide rather than mutation-only on purpose: `GET /` returns the whole
 * flag table, which is the platform's un-shipped-feature and per-role rollout
 * map. Step-up from the parent mount still applies and is unchanged.
 */
router.use(requireRole('SUPER_ADMIN'));

// GET /admin/feature-flags — list all flags
router.get('/', async (req, res) => {
  try {
    const flags = await getFlags();
    return success(res, flags, 'Feature flags retrieved');
  } catch (err) {
    logger.error(`Feature flags list error: ${err.message}`);
    return error(res, 'Failed to retrieve feature flags', 500);
  }
});

// POST /admin/feature-flags — create or update a flag
router.post('/', ...featureFlagValidator, validate, async (req, res) => {
  try {
    const { name, description, enabled, rollout_percentage, allowed_roles } = req.body || {};
    if (!name) {
      return error(res, 'Flag name is required', 400);
    }
    const flag = await setFlag(name, { description, enabled, rollout_percentage, allowed_roles });
    return success(res, flag, 'Feature flag saved', 200);
  } catch (err) {
    logger.error(`Feature flag save error: ${err.message}`);
    return error(res, 'Failed to save feature flag', 500);
  }
});

// DELETE /admin/feature-flags/:name — delete a flag
router.delete('/:name', paramId('name'), validate, async (req, res) => {
  try {
    const deleted = await deleteFlag(req.params.name);
    if (!deleted) {
      return error(res, 'Feature flag not found', 404);
    }
    return success(res, null, 'Feature flag deleted');
  } catch (err) {
    logger.error(`Feature flag delete error: ${err.message}`);
    return error(res, 'Failed to delete feature flag', 500);
  }
});

export default router;
