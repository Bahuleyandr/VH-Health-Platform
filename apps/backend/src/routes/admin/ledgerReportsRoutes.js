// apps/backend/src/routes/admin/ledgerReportsRoutes.js
//
// Read-only General-Ledger reports (T2 ledger Phase 5a). Finance-gated; reads
// only, tenant-scoped in the service via setTenant.
import express from 'express';
import logger from '../../logging/logger.js';
import { error, success } from '../../utils/responseHelper.js';
import {
  trialBalance, arAging, insurerAging, cashPosition, dailyCollection,
} from '../../services/billing/ledger/ledgerReportsService.js';

const router = express.Router();

const FINANCE_ROLES = new Set(['FINANCE_INCHARGE', 'ADMIN', 'SUPER_ADMIN']);

// Inline finance-role gate (same pattern as databaseRoutes.js' SUPER_ADMIN gate).
router.use((req, res, next) => {
  const role = String(req.user?.rawRole || req.user?.role || '').toUpperCase();
  if (!FINANCE_ROLES.has(role)) {
    return error(res, 'Finance role required', 403, { safe: true });
  }
  return next();
});

function tid(req) {
  return req.tenantId || req.user?.tenant_id || null;
}

router.get('/trial-balance', async (req, res) => {
  try { success(res, await trialBalance(tid(req)), 'Trial balance'); }
  catch (err) { logger.error('GL trial-balance error:', err); error(res, 'Failed to load trial balance', 500, { safe: true }); }
});

router.get('/ar-aging', async (req, res) => {
  try { success(res, await arAging(tid(req)), 'AR aging'); }
  catch (err) { logger.error('GL ar-aging error:', err); error(res, 'Failed to load AR aging', 500, { safe: true }); }
});

router.get('/insurer-aging', async (req, res) => {
  try { success(res, await insurerAging(tid(req)), 'Insurer AR aging'); }
  catch (err) { logger.error('GL insurer-aging error:', err); error(res, 'Failed to load insurer aging', 500, { safe: true }); }
});

router.get('/cash-position', async (req, res) => {
  try { success(res, await cashPosition(tid(req)), 'Cash position'); }
  catch (err) { logger.error('GL cash-position error:', err); error(res, 'Failed to load cash position', 500, { safe: true }); }
});

router.get('/daily-collection', async (req, res) => {
  try { success(res, await dailyCollection(tid(req), { from: req.query.from || null, to: req.query.to || null }), 'Daily collection'); }
  catch (err) { logger.error('GL daily-collection error:', err); error(res, 'Failed to load daily collection', 500, { safe: true }); }
});

export default router;
