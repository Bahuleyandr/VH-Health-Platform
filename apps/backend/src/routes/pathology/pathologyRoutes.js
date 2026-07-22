// src/routes/pathology/pathologyRoutes.js

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import pathologyService from '../../services/pathology/pathologyService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { paramId, requiredUUID } from '../../validators/sharedValidators.js';
import { emitPathologyEvent } from '../../utils/websocket/realtimeEmitter.js';
import { canSignApReport } from '../../utils/roleHelpers.js';

const router = Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const requireApSigner = (req, res, next) => {
  const candidates = [
    req.user?.rawRole,
    req.user?.role,
    ...(Array.isArray(req.user?.roles) ? req.user.roles : []),
  ];
  const allowed = candidates.some((role) => canSignApReport(String(role || '').trim().toUpperCase()));
  if (allowed) return next();
  return error(res, 'Anatomic pathology report submission and sign-off require a pathologist role', 403, {
    code: 'AP_SIGNER_REQUIRED',
  });
};

function actorRole(req) {
  return req.user?.rawRole || req.user?.role || null;
}

function actorUid(req) {
  return req.user?.uid || null;
}

function handleOperationalError(res, err) {
  return relayAppError(res, err, 'Pathology error');
}

router.get('/worklist', async (req, res, next) => {
  try {
    const result = await pathologyService.getWorklist({
      tenantId: resolveTenantOrThrow(req),
      status: req.query.status,
      case_kind: req.query.case_kind || req.query.caseKind,
      priority: req.query.priority,
      page: req.query.page,
      limit: req.query.limit,
      sortBy: req.query.sortBy,
      sortOrder: req.query.sortOrder,
    });
    return success(res, result.cases, 'Pathology worklist retrieved', 200, {
      pagination: result.pagination,
    });
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to get pathology worklist:', { error: err.message });
    next(err);
  }
});

router.get('/tat-metrics', async (req, res, next) => {
  try {
    const result = await pathologyService.getTatMetrics({
      tenantId: resolveTenantOrThrow(req),
      case_kind: req.query.case_kind || req.query.caseKind,
      priority: req.query.priority,
      breached: req.query.breached,
      page: req.query.page,
      limit: req.query.limit,
      sortBy: req.query.sortBy,
      sortOrder: req.query.sortOrder,
    });
    return success(res, result.metrics, 'Pathology TAT metrics retrieved', 200, {
      pagination: result.pagination,
    });
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to get pathology TAT metrics:', { error: err.message });
    next(err);
  }
});

router.post('/cases', requiredUUID('patient_uid'), validate, async (req, res, next) => {
  try {
    const detail = await pathologyService.createCase({
      ...req.body,
      accessioned_by: actorUid(req),
    }, {
      tenantId: resolveTenantOrThrow(req),
      actorUid: actorUid(req),
      actorRole: actorRole(req),
    });
    emitPathologyEvent('case-accessioned', { tenantId: req.tenantId });
    return success(res, detail, 'Pathology case accessioned', 201);
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to accession pathology case:', { error: err.message });
    next(err);
  }
});

router.get('/cases/:id', paramId(), validate, async (req, res, next) => {
  try {
    const detail = await pathologyService.getCaseDetail(req.params.id, {
      tenantId: resolveTenantOrThrow(req),
    });
    return success(res, detail, 'Pathology case retrieved');
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to get pathology case:', { caseId: req.params.id, error: err.message });
    next(err);
  }
});

router.post('/cases/:id/gross', paramId(), validate, async (req, res, next) => {
  try {
    const row = await pathologyService.recordGross(req.params.id, {
      ...req.body,
      recorded_by: actorUid(req),
    }, {
      tenantId: resolveTenantOrThrow(req),
      actorUid: actorUid(req),
      actorRole: actorRole(req),
    });
    emitPathologyEvent('gross-recorded', { tenantId: req.tenantId });
    return success(res, row, 'Pathology gross record saved', 201);
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to save pathology gross record:', { caseId: req.params.id, error: err.message });
    next(err);
  }
});

router.post('/cases/:id/blocks', paramId(), validate, async (req, res, next) => {
  try {
    const row = await pathologyService.createBlock(req.params.id, {
      ...req.body,
      created_by: actorUid(req),
    }, {
      tenantId: resolveTenantOrThrow(req),
      actorUid: actorUid(req),
      actorRole: actorRole(req),
    });
    emitPathologyEvent('block-created', { tenantId: req.tenantId });
    return success(res, row, 'Pathology block created', 201);
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to create pathology block:', { caseId: req.params.id, error: err.message });
    next(err);
  }
});

router.post('/blocks/:id/slides', paramId(), validate, async (req, res, next) => {
  try {
    const row = await pathologyService.createSlide(req.params.id, {
      ...req.body,
      created_by: actorUid(req),
    }, {
      tenantId: resolveTenantOrThrow(req),
      actorUid: actorUid(req),
      actorRole: actorRole(req),
    });
    emitPathologyEvent('slide-created', { tenantId: req.tenantId });
    return success(res, row, 'Pathology slide created', 201);
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to create pathology slide:', { blockId: req.params.id, error: err.message });
    next(err);
  }
});

router.put('/cases/:id/report', requireApSigner, paramId(), validate, async (req, res, next) => {
  try {
    const row = await pathologyService.draftReport(req.params.id, {
      ...req.body,
      report_author_uid: actorUid(req),
    }, {
      tenantId: resolveTenantOrThrow(req),
      actorUid: actorUid(req),
      actorRole: actorRole(req),
    });
    emitPathologyEvent(row.report_status === 'preliminary' ? 'report-preliminary' : 'report-drafted', {
      tenantId: req.tenantId,
    });
    return success(res, row, 'Pathology report saved');
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to save pathology report:', { caseId: req.params.id, error: err.message });
    next(err);
  }
});

router.post('/reports/:id/sign-off', requireApSigner, paramId(), validate, async (req, res, next) => {
  try {
    const row = await pathologyService.signOffReport(req.params.id, {
      ...req.body,
      signed_by: actorUid(req),
      idempotencyKey: req.get('Idempotency-Key'),
    }, {
      tenantId: resolveTenantOrThrow(req),
      actorUid: actorUid(req),
      actorRole: actorRole(req),
    });
    if (row.diagnostic_generation?.replayed !== true) {
      emitPathologyEvent('report-signed-off', { tenantId: req.tenantId });
    }
    return success(res, row, 'Pathology report signed off');
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to sign pathology report:', { reportId: req.params.id, error: err.message });
    next(err);
  }
});

router.post('/reports/:id/addenda', requireApSigner, paramId(), validate, async (req, res, next) => {
  try {
    const row = await pathologyService.appendAddendum(req.params.id, {
      ...req.body,
      addendum_by: actorUid(req),
      idempotencyKey: req.get('Idempotency-Key'),
    }, {
      tenantId: resolveTenantOrThrow(req),
      actorUid: actorUid(req),
      actorRole: actorRole(req),
    });
    if (row.diagnostic_generation?.replayed !== true) {
      emitPathologyEvent('report-addendum', { tenantId: req.tenantId });
    }
    return success(res, row, 'Pathology addendum appended', 201);
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to append pathology addendum:', { reportId: req.params.id, error: err.message });
    next(err);
  }
});

export default router;
