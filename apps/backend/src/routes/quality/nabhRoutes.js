// src/routes/quality/nabhRoutes.js
//
// Roadmap D4 — NABH indicator pack. Mounted at /api/v1/quality/nabh
// (app.js). Quality officers + leadership + admin territory.

import express from 'express';
import {
  computeIndicators,
  snapshotIndicators,
  listSnapshots,
  freezePeriodPack,
  getFrozenPeriodPack,
  packToCsv,
  packToPdfBuffer,
} from '../../services/quality/nabhIndicatorService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
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
  return relayAppError(res, err, `Failed to ${context}`);
}

function periodPackFilename(from, to, extension) {
  return `nabh-period-pack-${from}-${to}.${extension}`;
}

router.get('/indicators', async (req, res) => {
  try {
    if (!gate(req, res)) return undefined;
    const pack = await computeIndicators({ from: req.query.from, to: req.query.to, tenantId: req.tenantId });
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

router.post('/period-pack', async (req, res) => {
  try {
    if (!gate(req, res)) return undefined;
    const pack = await freezePeriodPack(
      { from: req.body.from, to: req.body.to },
      { actorUid: req.user?.uid || null, tenantId: req.tenantId },
    );
    return success(res, pack, 'NABH period pack frozen', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'freeze period pack');
  }
});

router.get('/period-pack', async (req, res) => {
  try {
    if (!gate(req, res)) return undefined;
    const pack = await getFrozenPeriodPack({
      from: req.query.from,
      to: req.query.to,
      tenantId: req.tenantId,
    });
    const format = String(req.query.format || 'json').toLowerCase();
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${periodPackFilename(req.query.from, req.query.to, 'csv')}"`);
      return res.send(packToCsv(pack));
    }
    if (format === 'pdf') {
      const pdf = await packToPdfBuffer(pack);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${periodPackFilename(req.query.from, req.query.to, 'pdf')}"`);
      return res.send(pdf);
    }
    if (format && format !== 'json') {
      throw AppError.badRequest('format must be one of json, csv, pdf', 'NABH_EXPORT_FORMAT_UNSUPPORTED');
    }
    return success(res, pack, 'Frozen NABH period pack');
  } catch (err) {
    return handleFailure(res, err, 'export period pack');
  }
});

router.post('/snapshots', async (req, res) => {
  try {
    if (!gate(req, res)) return undefined;
    const pack = await snapshotIndicators(
      { from: req.body.from, to: req.body.to },
      { actorUid: req.user?.uid || null, tenantId: req.tenantId },
    );
    return success(res, pack, 'Indicator snapshot saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'snapshot indicators');
  }
});

router.get('/snapshots', async (req, res) => {
  try {
    if (!gate(req, res)) return undefined;
    const snapshots = await listSnapshots({
      from: req.query.from || null,
      to: req.query.to || null,
      tenantId: req.tenantId,
    });
    return success(res, { snapshots, count: snapshots.length }, 'Indicator snapshots');
  } catch (err) {
    return handleFailure(res, err, 'list snapshots');
  }
});

export default router;
