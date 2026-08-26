import { Router } from 'express';
import cathSchedulingRoutes from './cathSchedulingRoutes.js';
import {
  addContrastRadiationRecord,
  addDeviceLink,
  addHemodynamicSummary,
  addPostProcedureOrder,
  createCase,
  getCase,
  listCatalogBatches,
  listCases,
  listCaseConsumableUsage,
  listConsumableCatalog,
  recordConsumableUsage,
  recordProcedureLog,
  transitionCaseStatus,
  updateReadinessCheck
} from '../../services/clinical/cathLabService.js';
import {
  applyCathOrderSetSlot,
  getCaseQuickWins,
  refreshReadinessEvidence
} from '../../services/clinical/cathQuickWinsService.js';
import {
  addReportAddendum,
  createReport,
  getReport,
  getSignedReportForPdf,
  listReports,
  listReportTemplates,
  markReportPreliminary,
  resolveCaseViewerLink,
  signReport,
  supersedeReportTemplate,
  updateReport
} from '../../services/clinical/cathReportService.js';
import { renderCathReportPdf } from '../../services/documents/cathReportPdfService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import {
  canEditCathReport,
  canOpenCathViewer,
  canSignCathReport,
  canUseCathWorkflow,
  canViewCathReport
} from '../../utils/roleHelpers.js';
import {
  cathCaseCreateGuard,
  cathCaseGuard,
  cathReportGuard
} from './cathLabAccessGuards.js';

const router = Router();

// Re-audit M: per-route patient access guards (CLINICAL_WORKFLOW) — the mount
// guard could never resolve a patient (empty req.params before route match);
// see cathLabAccessGuards.js. Deliberately NOT guarded (no single patient
// subject — role gate only): GET /report-templates,
// POST /report-templates/:id/supersede (template governance),
// GET /consumables/catalog, GET /consumables/catalog/:id/batches (catalog),
// and GET /cases (day list).
const guardCathCaseById = cathCaseGuard('id');
const guardCathCaseByCaseId = cathCaseGuard('caseId');
const guardCathReport = cathReportGuard();
const guardCathCaseCreate = cathCaseCreateGuard();

// NL13-P1f: scheduling strip + case booking + manual complication entries
// (same /api/v1/cath-lab family; role guards live inside the subrouter).
router.use('/', cathSchedulingRoutes);

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function contextOf(req) {
  return {
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || req.user?.rawRole || null,
    rawRole: req.user?.rawRole || null,
    actorRoles: Array.isArray(req.user?.roles) ? req.user.roles : [],
    requestId: req.id || null,
    ipAddress: req.ip || null,
    userAgent: req.get?.('user-agent') || null,
    idempotencyKey: req.get?.('idempotency-key') || null
  };
}

function hasRole(req, predicate) {
  return [
    req.user?.rawRole,
    req.user?.role,
    ...(Array.isArray(req.user?.roles) ? req.user.roles : [])
  ].some(role => predicate(role));
}

function roleGuard(predicate, message, code) {
  return (req, res, next) => {
    if (hasRole(req, predicate)) return next();
    return error(res, message, HTTP_STATUS.FORBIDDEN, { code });
  };
}

const requireCathWorkflow = roleGuard(
  canUseCathWorkflow,
  'Cath-lab workflow access is required',
  'CATH_LAB_WORKFLOW_FORBIDDEN'
);
const requireReportRead = roleGuard(
  canViewCathReport,
  'Cath report read access is required',
  'CATH_REPORT_READ_FORBIDDEN'
);
const requireReportEdit = roleGuard(
  canEditCathReport,
  'Cath report draft/edit access is required',
  'CATH_REPORT_EDIT_FORBIDDEN'
);
const requireReportSign = roleGuard(
  canSignCathReport,
  'Cath report sign-off requires a doctor role',
  'CATH_REPORT_SIGNER_REQUIRED'
);
const requireViewerAccess = roleGuard(
  canOpenCathViewer,
  'Cath image viewer access is required',
  'CATH_REPORT_VIEWER_FORBIDDEN'
);

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

router.get('/report-templates', requireReportRead, async (req, res) => {
  try {
    const templates = await listReportTemplates({
      tenantId: tenantOf(req),
      report_type: req.query.report_type || req.query.reportType || null
    }, contextOf(req));
    return success(res, { templates, count: templates.length }, 'Cath report templates');
  } catch (err) {
    return handleFailure(res, err, 'list report templates');
  }
});

router.get('/consumables/catalog', requireReportRead, async (req, res) => {
  try {
    const items = await listConsumableCatalog({
      tenantId: tenantOf(req),
      q: req.query.q || null,
      scan: req.query.scan || null,
      category: req.query.category || null,
      status: req.query.status || 'active',
      limit: req.query.limit || 100
    });
    return success(res, { items, count: items.length }, 'Cath consumable catalog');
  } catch (err) {
    return handleFailure(res, err, 'list consumable catalog');
  }
});

router.get('/consumables/catalog/:id/batches', requireReportRead, async (req, res) => {
  try {
    const batches = await listCatalogBatches(req.params.id, { tenantId: tenantOf(req) });
    return success(res, { batches, count: batches.length }, 'Cath consumable batches');
  } catch (err) {
    return handleFailure(res, err, 'list consumable batches');
  }
});

router.post('/report-templates/:id/supersede', requireReportEdit, async (req, res) => {
  try {
    const template = await supersedeReportTemplate(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { template }, 'Cath report template superseded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'supersede report template');
  }
});

router.get('/cases/:caseId/reports', requireReportRead, guardCathCaseByCaseId, async (req, res) => {
  try {
    const reports = await listReports(
      req.params.caseId,
      { tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { reports, count: reports.length }, 'Cath reports');
  } catch (err) {
    return handleFailure(res, err, 'list reports');
  }
});

router.post('/cases/:caseId/reports', requireReportEdit, guardCathCaseByCaseId, async (req, res) => {
  try {
    const report = await createReport(
      req.params.caseId,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { report }, 'Cath report draft created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create report draft');
  }
});

router.get('/cases/:caseId/viewer-link', requireViewerAccess, guardCathCaseByCaseId, async (req, res) => {
  try {
    const result = await resolveCaseViewerLink(
      req.params.caseId,
      { tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, result, 'Cath image viewer link');
  } catch (err) {
    return handleFailure(res, err, 'resolve viewer link');
  }
});

router.get('/reports/:id/pdf', requireReportRead, guardCathReport, async (req, res) => {
  try {
    const report = await getSignedReportForPdf(
      req.params.id,
      { tenantId: tenantOf(req) },
      contextOf(req)
    );
    const buffer = await renderCathReportPdf(report);
    const filename = `cath-report-${report.id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    return res.send(buffer);
  } catch (err) {
    return handleFailure(res, err, 'render report PDF');
  }
});

router.get('/reports/:id', requireReportRead, guardCathReport, async (req, res) => {
  try {
    const report = await getReport(
      req.params.id,
      { tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { report }, 'Cath report');
  } catch (err) {
    return handleFailure(res, err, 'get report');
  }
});

router.patch('/reports/:id', requireReportEdit, guardCathReport, async (req, res) => {
  try {
    const report = await updateReport(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { report }, 'Cath report updated');
  } catch (err) {
    return handleFailure(res, err, 'update report');
  }
});

router.post('/reports/:id/preliminary', requireReportEdit, guardCathReport, async (req, res) => {
  try {
    const report = await markReportPreliminary(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { report }, 'Cath report marked preliminary');
  } catch (err) {
    return handleFailure(res, err, 'mark report preliminary');
  }
});

router.post('/reports/:id/sign', requireReportSign, guardCathReport, async (req, res) => {
  try {
    const report = await signReport(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { report }, 'Cath report signed');
  } catch (err) {
    return handleFailure(res, err, 'sign report');
  }
});

router.post('/reports/:id/addenda', requireReportSign, guardCathReport, async (req, res) => {
  try {
    const addendum = await addReportAddendum(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { addendum }, 'Cath report addendum appended', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'append report addendum');
  }
});

router.get('/cases', requireReportRead, async (req, res) => {
  try {
    const cases = await listCases({
      tenantId: tenantOf(req),
      date: req.query.date || null,
      status: req.query.status || null,
      limit: req.query.limit || 100
    });
    return success(res, { cases, count: cases.length }, 'Cath-lab cases');
  } catch (err) {
    return handleFailure(res, err, 'list cases');
  }
});

router.post('/cases', requireCathWorkflow, guardCathCaseCreate, async (req, res) => {
  try {
    const cathCase = await createCase({ ...req.body, tenantId: tenantOf(req) }, contextOf(req));
    return success(res, { case: cathCase }, 'Cath-lab case created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create case');
  }
});

router.get('/cases/:id', requireReportRead, guardCathCaseById, async (req, res) => {
  try {
    const cathCase = await getCase(req.params.id, { tenantId: tenantOf(req) });
    return success(res, { case: cathCase }, 'Cath-lab case');
  } catch (err) {
    return handleFailure(res, err, 'get case');
  }
});

router.get(
  '/cases/:id/consumables',
  requireReportRead,
  guardCathCaseById,
  async (req, res) => {
    try {
      const usage = await listCaseConsumableUsage(req.params.id, { tenantId: tenantOf(req) });
      return success(res, { usage, count: usage.length }, 'Cath consumable usage');
    } catch (err) {
      return handleFailure(res, err, 'list consumable usage');
    }
  }
);

router.post(
  '/cases/:id/consumables',
  requireCathWorkflow,
  guardCathCaseById,
  requireIdempotencyKey({ required: true, scope: 'cath_consumable_usage' }),
  async (req, res) => {
    try {
      const usage = await recordConsumableUsage(
        req.params.id,
        { ...req.body, tenantId: tenantOf(req) },
        contextOf(req)
      );
      return success(res, { usage }, 'Cath consumable usage recorded', HTTP_STATUS.CREATED);
    } catch (err) {
      return handleFailure(res, err, 'record consumable usage');
    }
  }
);
router.get('/cases/:id/quick-wins', requireReportRead, guardCathCaseById, async (req, res) => {
  try {
    const quickWins = await getCaseQuickWins(req.params.id, { tenantId: tenantOf(req) });
    return success(res, { quick_wins: quickWins }, 'Cath-lab quick wins');
  } catch (err) {
    return handleFailure(res, err, 'get quick wins');
  }
});

router.post('/cases/:id/readiness/evidence/refresh', requireCathWorkflow, guardCathCaseById, async (req, res) => {
  try {
    const result = await refreshReadinessEvidence(
      req.params.id,
      { tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, result, 'Cath-lab readiness evidence refreshed');
  } catch (err) {
    return handleFailure(res, err, 'refresh readiness evidence');
  }
});

router.post('/cases/:id/order-sets/:slot/apply', requireCathWorkflow, guardCathCaseById, async (req, res) => {
  try {
    const result = await applyCathOrderSetSlot(
      req.params.id,
      req.params.slot,
      { tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, result, 'Cath order set applied', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'apply order set');
  }
});

router.post('/cases/:id/status', requireCathWorkflow, guardCathCaseById, async (req, res) => {
  try {
    const cathCase = await transitionCaseStatus(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { case: cathCase }, 'Cath-lab case status updated');
  } catch (err) {
    return handleFailure(res, err, 'update case status');
  }
});

router.post('/cases/:id/readiness', requireCathWorkflow, guardCathCaseById, async (req, res) => {
  try {
    const readiness = await updateReadinessCheck(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, readiness, 'Cath-lab readiness updated');
  } catch (err) {
    return handleFailure(res, err, 'update readiness');
  }
});

router.post('/cases/:id/procedure-logs', requireCathWorkflow, guardCathCaseById, async (req, res) => {
  try {
    const procedure = await recordProcedureLog(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { procedure }, 'Cath procedure logged', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record procedure log');
  }
});

router.post('/cases/:id/hemodynamics', requireCathWorkflow, guardCathCaseById, async (req, res) => {
  try {
    const summary = await addHemodynamicSummary(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { summary }, 'Cath hemodynamic summary recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record hemodynamic summary');
  }
});

router.post('/cases/:id/contrast-radiation', requireCathWorkflow, guardCathCaseById, async (req, res) => {
  try {
    const record = await addContrastRadiationRecord(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(
      res,
      { record },
      'Cath contrast and radiation record saved',
      HTTP_STATUS.CREATED
    );
  } catch (err) {
    return handleFailure(res, err, 'record contrast and radiation summary');
  }
});

router.post('/cases/:id/post-orders', requireCathWorkflow, guardCathCaseById, async (req, res) => {
  try {
    const order = await addPostProcedureOrder(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { order }, 'Cath post-procedure orders saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record post-procedure orders');
  }
});

router.post('/cases/:id/device-links', requireCathWorkflow, guardCathCaseById, async (req, res) => {
  try {
    const link = await addDeviceLink(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { link }, 'Cath device link attached', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'attach device link');
  }
});

export default router;
