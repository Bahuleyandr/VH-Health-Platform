import express from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import { getFlags, setFlag, deleteFlag } from '../../services/featureFlags/featureFlagService.js';
import { success, error } from '../../utils/responseHelper.js';
import { paramId, featureFlagValidator } from '../../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = express.Router();

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
