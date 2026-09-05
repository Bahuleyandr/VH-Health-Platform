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
  ITEM_CODES,
  orderMissingLabs,
  recordExternalLabResult,
  refreshCaseLabReadiness,
  unwaiveLabItem,
  waiveLabItem
} from '../../services/clinical/cathLabReadinessService.js';
import {
  projectLabReadinessForRole,
  projectReadinessChecksForRole
} from '../../services/clinical/cathLabReadinessProjection.js';
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
import {
  decorateConsumablesWithReuse,
  deviceForCaseLookup,
  projectReuseRestrictionForRole,
  recordPostUse,
  roleSeesSerologyDetail
} from '../../services/clinical/cathDeviceReuseService.js';
import cathDeviceHistoryHandler from './cathDeviceHistoryHandler.js';
import logger from '../../logging/logger.js';
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
  cathCaseQueryGuard,
  cathReportGuard
} from './cathLabAccessGuards.js';

const router = Router();

// Re-audit M: per-route patient access guards (CLINICAL_WORKFLOW) — the mount
// guard could never resolve a patient (empty req.params before route match);
// see cathLabAccessGuards.js. Deliberately NOT guarded (no single patient
// subject — role gate only): GET /report-templates,
// POST /report-templates/:id/supersede (template governance),
// GET /cases (day list). Cath catalog and batch reads are case-scoped below so
// their patient authority and pinned facility identity are both enforced.
const guardCathCaseById = cathCaseGuard('id');
const guardCathCaseByCaseId = cathCaseGuard('caseId');
const guardCathReport = cathReportGuard();
const guardCathCaseCreate = cathCaseCreateGuard();
const guardCathCatalogCase = cathCaseQueryGuard('case_id');

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
    // `idempotencyKey` is the CLAIMED key (idempotencyMiddleware.js sets
    // req.idempotencyClaim to { id, requestKey, requestBodyHash, scope }, plus
    // a completedReplay / recoveringInFlight marker on its two recovery
    // paths), never a body field — a caller-supplied identity would let a
    // corrected value replay as the original. requestKey IS the header value,
    // so the header stays the fallback for the routes that carry no claim.
    //
    // The claim's ROW ID and body hash are deliberately NOT forwarded. The one
    // service on this router that would read them —
    // cathLabReadinessService.recordExternalLabResult, into
    // labResultsService.recordExternalLabResultRow — hands them to
    // finaliseHttpIdempotencyInTx, which marks THIS route's HTTP claim
    // complete/200 with the LAB layer's payload from inside the lab
    // transaction. Two things then break: a replay answers 200 with the lab
    // service's {result, alerts} (a whole lab row) instead of this route's
    // published 201 {lab_result_id, item, readiness}; and a 5xx raised AFTER
    // that transaction commits — the blood-borne marker write, the audit, the
    // readiness refresh all still to come — can neither release the claim nor
    // re-finalise it, so the retry replays a success for work that never
    // happened. The middleware owns the claim on this router, exactly as the
    // post-use route's `retainOnServerError` comment below reasons about its
    // own retry path; the lab rail keeps its OWN content-derived fingerprint
    // (case_id + item + value + …) as the command body hash.
    //
    // The key handed DOWN to that rail is this one with the item code appended
    // (see cathLabReadinessService.recordExternalLabResult), which is what makes
    // an hiv, an hbsag and an hcv entry sent under one Idempotency-Key three
    // distinct lab commands instead of one — the rail keys on
    // (tenant_id, actor_uid, command_scope, command_key), so the bare header
    // would make the second item collide with the first and answer
    // LAB_RESULT_COMMAND_BODY_MISMATCH. A retry of the SAME item under the same
    // header still replays, because its suffixed key and its fingerprint are
    // both unchanged.
    idempotencyKey: req.idempotencyClaim?.requestKey || req.get?.('idempotency-key') || null
  };
}

function rolesOf(req) {
  return [
    req.user?.rawRole,
    req.user?.role,
    ...(Array.isArray(req.user?.roles) ? req.user.roles : [])
  ];
}

function hasRole(req, predicate) {
  return rolesOf(req).some(role => predicate(role));
}

// The role the serology projection is judged on. A user can carry several role
// claims and the gates above already accept ANY of them, so the projection has
// to as well — otherwise a doctor whose clinical role sits in `roles` would be
// shown the redacted strip while passing a gate that read the same claim.
function serologyRoleOf(req) {
  return rolesOf(req).find(role => role && roleSeesSerologyDetail(role))
    ?? req.user?.role
    ?? req.user?.rawRole
    ?? null;
}

// `reuse_screen` and `post_use_screen` (migration 765) are the FROZEN copy of
// the same blood-borne restriction `reuse_restriction` carries — spec §7.4 says
// they are evidence and must not be edited, so they are projected on the way
// out, exactly like the live strip, and by the same function so the two can
// never disagree about what a receptionist may read.
//
// cathLabService.CATH_CONSUMABLE_USAGE_SELECT does NOT select either column
// today, so on the current SELECT this is a no-op — and it is deliberately
// written as one: `usage` rows are also published as additionalProperties:false
// (CathCaseConsumableUsage), so a key that is absent must stay absent rather
// than be added back empty. It exists so that adding `u.reuse_screen` to that
// SELECT — a one-line change that reads entirely harmless — cannot hand the
// serology narrative to the RECEPTIONIST and TECHNICIAN that report-read admits.
function projectUsageScreensForRole(rows, role) {
  if (!Array.isArray(rows) || roleSeesSerologyDetail(role)) return rows;
  return rows.map(row => {
    if (!row || typeof row !== 'object') return row;
    const projected = { ...row };
    for (const key of ['reuse_screen', 'post_use_screen']) {
      if (key in projected && projected[key] && typeof projected[key] === 'object') {
        projected[key] = projectReuseRestrictionForRole(projected[key], role);
      }
    }
    return projected;
  });
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

// The service validates :item against ITEM_CODES and answers 400
// CATH_LAB_READINESS_ITEM_UNKNOWN, but that is one layer too late: the
// idempotency claim in front of it would already have written a register row
// for a URL that can never succeed. This is the SAME membership test, run
// before a key is burned — against the service's own exported ITEM_CODES, so
// the two can never disagree about which codes exist, and answering with the
// code at the envelope ROOT so a client reads one shape whichever layer
// refused (relayAppError lifts an AppError's code the same way).
function requireReadinessItemParam(req, res, next) {
  if (ITEM_CODES.includes(String(req.params.item ?? ''))) return next();
  return error(res, 'A lab readiness item code is required', HTTP_STATUS.BAD_REQUEST, {
    topLevel: { code: 'CATH_LAB_READINESS_ITEM_UNKNOWN' }
  });
}

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

router.get('/consumables/catalog', requireReportRead, guardCathCatalogCase, async (req, res) => {
  try {
    const items = await listConsumableCatalog({
      tenantId: tenantOf(req),
      q: req.query.q || null,
      scan: req.query.scan || null,
      category: req.query.category || null,
      status: req.query.status || 'active',
      caseId: req.query.case_id,
      limit: req.query.limit || 100
    });
    return success(res, { items, count: items.length }, 'Cath consumable catalog');
  } catch (err) {
    return handleFailure(res, err, 'list consumable catalog');
  }
});

router.get('/consumables/catalog/:id/batches', requireReportRead, guardCathCatalogCase, async (req, res) => {
  try {
    const batches = await listCatalogBatches(req.params.id, {
      tenantId: tenantOf(req),
      caseId: req.query.case_id
    });
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
    const role = serologyRoleOf(req);
    // The case view carries the same blood-borne restriction strip the
    // consumables view does, so it takes the same role projection — otherwise
    // the narrower surface would simply be the way round the wider one.
    //
    // `lab_readiness` and the `labs` row inside `readiness` are the SAME
    // narrative arriving through the pre-cath checklist: the items carry
    // value_text / value_numeric / abnormal_flag for hiv, hbsag and hcv, and
    // the labs check's metadata.live_evidence is a verbatim copy of them. Both
    // are projected, or the strip beside them is redacted for nothing.
    // undefined survives as undefined (JSON drops the key), so a case row that
    // never carried one of these does not grow it — CathLabCase is
    // additionalProperties:false.
    return success(res, {
      case: {
        ...cathCase,
        lab_readiness: projectLabReadinessForRole(cathCase?.lab_readiness, role),
        readiness: projectReadinessChecksForRole(cathCase?.readiness, role),
        consumable_usage: projectUsageScreensForRole(cathCase?.consumable_usage, role),
        reuse_restriction: projectReuseRestrictionForRole(cathCase?.reuse_restriction, role)
      }
    }, 'Cath-lab case');
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
      const decorated = await decorateConsumablesWithReuse(usage, {
        tenantId: tenantOf(req),
        caseId: req.params.id
      });
      return success(res, {
        usage: projectUsageScreensForRole(decorated.usage, serologyRoleOf(req)),
        count: decorated.usage.length,
        // Serology narrative is projected by role: the capture sheet gets the
        // decision (status / window / evaluated_at) for everyone, the reasons
        // and per-marker results only for clinical staff.
        reuse_restriction: projectReuseRestrictionForRole(
          decorated.reuse_restriction,
          serologyRoleOf(req)
        ),
        reprocessing: decorated.reprocessing
      }, 'Cath consumable usage');
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

router.post(
  '/cases/:id/consumables/:usageId/post-use',
  requireCathWorkflow,
  guardCathCaseById,
  // retainOnServerError is deliberately NOT set: recordPostUse's device
  // transitions ('return', 'discard' in cathDeviceReuseService.js
  // DEVICE_ACTIONS) each have a `from` list that excludes their own `to`
  // state, so a retry after a post-commit 5xx finds the device already landed
  // and 409s with CATH_DEVICE_INVALID_TRANSITION naming the state it is
  // actually in, rather than silently repeating the transition. A route added
  // to this claim layer whose handler is not similarly self-blocking on retry
  // must argue with this comment before leaving retainOnServerError unset.
  requireIdempotencyKey({ required: true, scope: 'cath_consumable_post_use' }),
  async (req, res) => {
    try {
      const result = await recordPostUse(
        req.params.id,
        req.params.usageId,
        { ...req.body, tenantId: tenantOf(req) },
        contextOf(req)
      );
      return success(res, result, 'Cath consumable post-use recorded', HTTP_STATUS.CREATED);
    } catch (err) {
      return handleFailure(res, err, 'record consumable post-use');
    }
  }
);

// Device state for the capture sheet. No patient data in the response; the
// route is case-pinned so the facility identity is enforced exactly like the
// catalogue reads (guardCathCatalogCase resolves req.query.case_id).
router.get('/devices/lookup', requireReportRead, guardCathCatalogCase, async (req, res) => {
  try {
    const result = await deviceForCaseLookup({
      tenantId: tenantOf(req),
      caseId: req.query.case_id,
      tag: req.query.tag
    });
    // exposure_markers names WHICH bloodborne marker came back reactive on the
    // device — the same serology narrative projectReuseRestrictionForRole
    // redacts elsewhere. Report-read admits RECEPTIONIST/TECHNICIAN, who need
    // exposure_flag/blocked/requires_acknowledgement to run the capture sheet
    // but have no business reading the marker. Blank it, don't drop it, so the
    // published shape holds for everyone.
    if (!roleSeesSerologyDetail(serologyRoleOf(req))) {
      result.device = { ...result.device, exposure_markers: [] };
    }
    return success(res, result, 'Reprocessable device');
  } catch (err) {
    return handleFailure(res, err, 'lookup device');
  }
});

// Which patients a device touched (infection-control lookback). PHI, but with
// NO single patient subject — a device spans patients, so there is no case or
// report row a per-route patient guard could resolve. The mount's
// phiAccessLogger('CATH_LAB') therefore records ONE row with patient_id = NULL
// (it resolves a patient from the request, and this request carries none), so
// the real per-patient trail is the explicit batch the shared handler writes.
// The gate is the cath WORKFLOW gate, not report-read: report-read admits
// RECEPTIONIST and TECHNICIAN, and a cross-patient exposure lookback is not a
// front-desk or imaging read. Infection control reaches the same handler on
// /api/v1/cath-reprocessing.
router.get('/devices/:deviceId/history', requireCathWorkflow, cathDeviceHistoryHandler);
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
    // The labs refresh is ADDITIVE to this operation, never a precondition of
    // it: the other seven readiness checks have already been re-evidenced by
    // the call above, and losing that work because the lab rail is unhappy
    // would be the wrong trade at the table. A failure therefore answers
    // labs: null and is logged, exactly as refreshOpenCasesForPatient treats
    // its own failures — the next refresh repairs the snapshot.
    let labs = null;
    try {
      labs = await refreshCaseLabReadiness({
        tenantId: tenantOf(req),
        caseId: req.params.id,
        context: contextOf(req)
      });
    } catch (labErr) {
      logger.error('Cath lab readiness refresh failed during evidence refresh', {
        case_id: req.params.id,
        code: labErr?.code || null,
        error: labErr?.message
      });
    }
    return success(res, { ...result, labs }, 'Cath-lab readiness evidence refreshed');
  } catch (err) {
    return handleFailure(res, err, 'refresh readiness evidence');
  }
});

// --- Pre-procedure lab readiness -------------------------------------------
//
// GET is a READ-THROUGH: refreshCaseLabReadiness resolves the seven items from
// the patient's lab rows, persists them and applies the labs-check automation,
// so the answer is the state AFTER the refresh. It is report-read plus the case
// guard because it carries per-item lab VALUES (a potassium, an HIV result) —
// PHI, logged by the mount's phiAccessLogger('CATH_LAB') against the case's
// patient when the care-team guard resolves it.
//
// Report-read admits RECEPTIONIST and TECHNICIAN, who need "labs pending"
// before the case is called but have no business reading WHICH blood-borne
// marker came back reactive, so the three serology items lose their values on
// the way out — the same rule, through the same audience predicate, that
// redacts the reuse strip on the consumables view.
router.get('/cases/:id/readiness/labs', requireReportRead, guardCathCaseById, async (req, res) => {
  try {
    const labs = await refreshCaseLabReadiness({
      tenantId: tenantOf(req),
      caseId: req.params.id,
      // A GET is a read, and the refresh it drives is the system's work, not
      // the reader's: contextOf(req) would stamp whoever opened the checklist
      // onto cath_lab_cases.updated_by and onto the
      // cath_lab.readiness.labs.auto_* audit row, attributing a clearance
      // decision to a person who only looked. requestId is kept so the write
      // is still traceable to the request that provoked it; the POST refresh
      // above IS an act and keeps its full actor.
      context: { requestId: req.id || null, actorUid: null, actorRole: 'SYSTEM' }
    });
    return success(
      res,
      projectLabReadinessForRole(labs, serologyRoleOf(req)),
      'Cath-lab lab readiness'
    );
  } catch (err) {
    return handleFailure(res, err, 'lab readiness');
  }
});

router.post(
  '/cases/:id/readiness/labs/order-missing',
  requireCathWorkflow,
  guardCathCaseById,
  requireIdempotencyKey({ required: true, scope: 'cath_lab_readiness_order' }),
  async (req, res) => {
    try {
      const result = await orderMissingLabs(
        req.params.id,
        { tenantId: tenantOf(req) },
        contextOf(req)
      );
      return success(res, result, 'Missing pre-cath labs ordered', HTTP_STATUS.CREATED);
    } catch (err) {
      return handleFailure(res, err, 'order missing labs');
    }
  }
);

// The ONLY route that may mint an external-origin lab result. The claimed KEY
// reaches recordExternalLabResultRow through contextOf so a retry re-reads the
// same command instead of recording the outside value twice; the claim's ROW ID and
// body hash deliberately do NOT (see contextOf) — the middleware owns this
// route's claim and the ingest rail derives its own fingerprint from the
// content. retainOnServerError stays unset, and unlike the post-use route
// above the argument is not self-blocking transitions but the release itself:
// a 5xx here RELEASES the claim, the retry re-enters, the ingest rail replays
// the lab row by content, and the blood-borne marker write, the audit and the
// readiness refresh that failed the first time complete. Retaining it would
// freeze a half-done write behind a success nobody can retry.
router.post(
  '/cases/:id/readiness/labs/:item/external-result',
  requireCathWorkflow,
  guardCathCaseById,
  requireReadinessItemParam,
  requireIdempotencyKey({ required: true, scope: 'cath_lab_readiness_external' }),
  async (req, res) => {
    try {
      const result = await recordExternalLabResult(
        req.params.id,
        req.params.item,
        { ...req.body, tenantId: tenantOf(req) },
        contextOf(req)
      );
      return success(res, result, 'External lab result recorded', HTTP_STATUS.CREATED);
    } catch (err) {
      return handleFailure(res, err, 'record external lab result');
    }
  }
);

// A waiver is a clinical DECISION written to an append-only item row and an
// audit row, so it claims a key like every other write on this router — the
// plan left it off, which would have let a double-tap record the same override
// twice under two timestamps.
router.post(
  '/cases/:id/readiness/labs/:item/waive',
  requireCathWorkflow,
  guardCathCaseById,
  requireReadinessItemParam,
  requireIdempotencyKey({ required: true, scope: 'cath_lab_readiness_waive' }),
  async (req, res) => {
    try {
      const result = await waiveLabItem(
        req.params.id,
        req.params.item,
        { ...req.body, tenantId: tenantOf(req) },
        contextOf(req)
      );
      return success(res, result, 'Lab readiness item waived');
    } catch (err) {
      return handleFailure(res, err, 'waive lab item');
    }
  }
);

// Lifting a waiver is a second clinical decision over the first, not an undo:
// the item goes back to being resolved from lab evidence and the check can come
// off pass because of it. Same chain, same order, same claim discipline as the
// waive above — the guard before the claim so a request that can never succeed
// (an unknown item, a case the caller may not read) does not burn a key.
router.post(
  '/cases/:id/readiness/labs/:item/unwaive',
  requireCathWorkflow,
  guardCathCaseById,
  requireReadinessItemParam,
  requireIdempotencyKey({ required: true, scope: 'cath_lab_readiness_unwaive' }),
  async (req, res) => {
    try {
      const result = await unwaiveLabItem(
        req.params.id,
        req.params.item,
        { ...req.body, tenantId: tenantOf(req) },
        contextOf(req)
      );
      return success(res, result, 'Lab readiness waiver removed');
    } catch (err) {
      return handleFailure(res, err, 'remove lab item waiver');
    }
  }
);

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
