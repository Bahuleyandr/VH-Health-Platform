import express from 'express';
import logger from '../../logging/logger.js';
import { getTenantEntitlementSummary } from '../../services/entitlements/entitlementService.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

router.get('/capabilities', async (req, res) => {
  try {
    const summary = await getTenantEntitlementSummary(req.tenantId);
    return success(res, summary, 'Entitlement capabilities retrieved');
  } catch (err) {
    logger.error(`Entitlement capability manifest error: ${err.message}`);
    return error(res, 'Failed to retrieve entitlement capabilities', 500);
  }
});

export default router;
