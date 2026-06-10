// src/routes/quality/nabhRoutes.js
//
// Roadmap D4 — NABH indicator pack. Mounted at /api/v1/quality/nabh
// (app.js). Quality officers + leadership + admin territory.

import express from 'express';
import logger from '../../logging/logger.js';
import {
  computeIndicators,
  snapshotIndicators,
  listSnapshots,
  packToCsv,
} from '../../services/quality/nabhIndicatorService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { ROLES, isAdmin, isLeadership } from '../../utils/roleHelpers.js';

const router = express.Router();

const canViewQuality = (role) => isAdmin(role) || isLeadership(role)
  || role === ROLES.QUALITY_OFFICER || role === ROLES.INFECTION_CONTROL_OFFICER || role === 'SUPER_ADMIN';

function gate(req, res) {
  if (!canViewQuality(req.user?.role)) {
    error(res, 'Quality indicators are limited to quality/leadership roles', HTTP_STATUS.FORBIDDEN);
    return false;
  }
  return true;
}

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`NABH ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

router.get('/indicators', async (req, res) => {
  try {
    if (!gate(req, res)) return undefined;
    const pack = await computeIndicators({ from: req.query.from, to: req.query.to });
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="nabh-indicators-${req.query.from}-${req.query.to}.csv"`);
      return res.send(packToCsv(pack));
    }
    return success(res, pack, 'NABH indicators');
  } catch (err) {
    return handleFailure(res, err, 'compute indicators');
  }
});

router.post('/snapshots', async (req, res) => {
  try {
    if (!gate(req, res)) return undefined;
    const pack = await snapshotIndicators(
      { from: req.body.from, to: req.body.to },
      { actorUid: req.user?.uid || null },
    );
    return success(res, pack, 'Indicator snapshot saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'snapshot indicators');
  }
});

router.get('/snapshots', async (req, res) => {
  try {
    if (!gate(req, res)) return undefined;
    const snapshots = await listSnapshots({ from: req.query.from || null, to: req.query.to || null });
    return success(res, { snapshots, count: snapshots.length }, 'Indicator snapshots');
  } catch (err) {
    return handleFailure(res, err, 'list snapshots');
  }
});

export default router;
