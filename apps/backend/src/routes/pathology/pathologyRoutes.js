// src/routes/pathology/pathologyRoutes.js

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import prisma from '../../lib/prisma.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import pathologyService from '../../services/pathology/pathologyService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { paramId, requiredUUID } from '../../validators/sharedValidators.js';
import { emitPathologyEvent } from '../../utils/websocket/realtimeEmitter.js';
import { canSignApReport } from '../../utils/roleHelpers.js';

const router = Router();

// ── Per-route patient-access guards ─────────────────────────────────────────
// The PATHOLOGY guard used to sit on the /api/v1/pathology mount in app.js. A
// mount-level middleware runs before Express matches the route, so req.params
// was always empty there; every case/block/report route identifies its
// patient through a path-param resource id, so the guard resolved no patient
// and passed as no_patient_context without a policy decision — in shadow AND
// in enforce. The guard now runs per route with selectors that resolve the
// patient behind the exact ap_cases / ap_blocks / ap_reports row the handler
// serves, tenant-scoped (the same id + tenant lookups pathologyService
// performs, including the block→case and report→case joins).
//
// Selector contract: malformed ids return null WITHOUT querying (they bind to
// ::bigint casts); the guard then refuses via requirePatientContext in
// enforce mode and records an unresolved decision in shadow.
// GET /worklist and GET /tat-metrics are tenant-wide queues with no single
// patient subject and are deliberately NOT patient-context-forced.
const pathologyPatientGuard = (patientSelector) => patientAccessGuard('PATHOLOGY', {
  careTeamModeGoverned: true,
  requirePatientContext: true,
  patientSelector,
});

function positiveIdOf(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function apCasePatientOf(req) {
  const caseId = positiveIdOf(req.params?.id);
  if (caseId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM ap_cases
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
      LIMIT 1`,
    resolveTenantOrThrow(req),
    caseId,
  );
  return rows[0] ?? null;
}

async function apBlockPatientOf(req) {
  const blockId = positiveIdOf(req.params?.id);
  if (blockId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.patient_uid AS uid
       FROM ap_blocks b
       JOIN ap_cases c ON c.id = b.ap_case_id AND c.tenant_id = b.tenant_id
      WHERE b.tenant_id = $1::uuid
        AND b.id = $2::bigint
      LIMIT 1`,
    resolveTenantOrThrow(req),
    blockId,
  );
  return rows[0] ?? null;
}

async function apReportPatientOf(req) {
  const reportId = positiveIdOf(req.params?.id);
  if (reportId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.patient_uid AS uid
       FROM ap_reports r
       JOIN ap_cases c ON c.id = r.ap_case_id AND c.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1::uuid
        AND r.id = $2::bigint
      LIMIT 1`,
    resolveTenantOrThrow(req),
    reportId,
  );
  return rows[0] ?? null;
}

// POST /cases — accessioning identifies its subject in the body; mirror the
// exact fallback pathologyService.createCase applies (patient_uid, then
// patientUid). The requiredUUID('patient_uid') validator has already 400'd
// requests without a well-formed snake-case uid by the time the guard runs.
function apCaseCreateBodyPatientOf(req) {
  const uid = req.body?.patient_uid ?? req.body?.patientUid;
  return uid ? { uid } : null;
}

const guardApCase = pathologyPatientGuard(apCasePatientOf);
const guardApBlock = pathologyPatientGuard(apBlockPatientOf);
const guardApReport = pathologyPatientGuard(apReportPatientOf);
const guardApCaseCreate = pathologyPatientGuard(apCaseCreateBodyPatientOf);

// Test surface (labPathologyNursingRouteGuards.test.js) — not a public API.
export const __patientAccessSelectors = {
  apCasePatientOf,
  apBlockPatientOf,
  apReportPatientOf,
  apCaseCreateBodyPatientOf,
};

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

// Tenant-wide accessioning queue — no single patient subject, so no
// patient-access guard (deliberate; forcing patient context here would lock
// the bench out). Same for /tat-metrics below.
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

router.post('/cases', requiredUUID('patient_uid'), validate, guardApCaseCreate, async (req, res, next) => {
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

router.get('/cases/:id', paramId(), validate, guardApCase, async (req, res, next) => {
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

router.post('/cases/:id/gross', paramId(), validate, guardApCase, async (req, res, next) => {
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

router.post('/cases/:id/blocks', paramId(), validate, guardApCase, async (req, res, next) => {
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

router.post('/blocks/:id/slides', paramId(), validate, guardApBlock, async (req, res, next) => {
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

router.put('/cases/:id/report', requireApSigner, paramId(), validate, guardApCase, async (req, res, next) => {
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

router.post('/reports/:id/sign-off', requireApSigner, paramId(), validate, guardApReport, async (req, res, next) => {
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

router.post('/reports/:id/addenda', requireApSigner, paramId(), validate, guardApReport, async (req, res, next) => {
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
