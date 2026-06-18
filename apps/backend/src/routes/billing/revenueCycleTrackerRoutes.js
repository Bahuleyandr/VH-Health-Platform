// src/routes/billing/revenueCycleTrackerRoutes.js
//
// Revenue-cycle standing-queue endpoints. Billing read-only.
// Mounted under /api/v1/billing/revenue-cycle via app.js (BILLING_ROUTE_ROLES).

import express from 'express';
import { success, error } from '../../utils/responseHelper.js';
import logger from '../../logging/logger.js';
import {
  listRevenueCycleRuns,
  getRevenueCycleRun,
} from '../../services/billing/revenueCycleTrackerService.js';

const router = express.Router();

function parseTenantId(req) {
  return req.user?.tenantId || req.query.tenantId || null;
}

/**
 * GET /api/v1/billing/revenue-cycle/runs
 * List revenue-cycle runs (billing standing queue).
 * Query params: status, stage, limit (max 500).
 */
router.get('/runs', async (req, res) => {
  try {
    const tenantId = parseTenantId(req);
    const { status, stage, limit } = req.query;
    const result = await listRevenueCycleRuns({ tenantId, status, stage, limit });
    return success(res, result, 'Revenue-cycle runs');
  } catch (err) {
    logger.error('GET /billing/revenue-cycle/runs error:', err);
    return error(res, 'Failed to list revenue-cycle runs', 500);
  }
});

/**
 * GET /api/v1/billing/revenue-cycle/runs/:id
 * Get a single revenue-cycle run by numeric id.
 */
router.get('/runs/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return error(res, 'Invalid run id', 400);
    const tenantId = parseTenantId(req);
    const run = await getRevenueCycleRun({ tenantId, id });
    if (!run) return error(res, 'Revenue-cycle run not found', 404);
    return success(res, run, 'Revenue-cycle run');
  } catch (err) {
    logger.error('GET /billing/revenue-cycle/runs/:id error:', err);
    return error(res, 'Failed to get revenue-cycle run', 500);
  }
});

export default router;
