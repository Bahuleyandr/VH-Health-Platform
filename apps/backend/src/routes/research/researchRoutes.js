// src/routes/research/researchRoutes.js
//
// Roadmap D6 — research/registry capture (RDC-lite). Mounted at
// /api/v1/research (app.js) behind clinical-staff RBAC + PHI logging.
// Registry/form management is investigator/leadership-gated; capture is
// open to clinical staff; export defaults to de-identified and only
// admin/leadership may include PHI.

import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  createRegistry,
  listRegistries,
  createCrfForm,
  publishCrfForm,
  listForms,
  enrollPatient,
  withdrawEnrollment,
  listEnrollments,
  captureCrfResponse,
  submitCrfResponse,
  verifyCrfResponse,
  exportRegistry,
} from '../../services/research/researchRegistryService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { ROLES, isAdmin, isLeadership, isDoctor } from '../../utils/roleHelpers.js';
import {
  authorizePatientAccessRequest,
  deriveTenantIdFromRequest,
  patientAccessErrorPayload,
} from '../../services/security/accessDecisionService.js';

const router = express.Router();

const canManage = (role) =>
  isAdmin(role) || isLeadership(role) || isDoctor(role)
  || role === ROLES.QUALITY_OFFICER || role === 'SUPER_ADMIN';

const canExportPhi = (role) => isAdmin(role) || isLeadership(role) || role === 'SUPER_ADMIN';

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Research ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

function positiveIntOrNull(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function authorizeResearchPatient(req, res, patientUid, resourceContext = {}) {
  const decision = await authorizePatientAccessRequest(req, {
    recordType: 'RESEARCH',
    patient: { uid: patientUid },
    resourceContext,
    requireResolvedPatient: true,
  });

  if (!decision.allowed) {
    res.status(403).json(patientAccessErrorPayload(decision));
    return false;
  }
  return true;
}

function researchPatientGuard(resolvePatientUid, resourceType) {
  return async (req, res, next) => {
    try {
      const patientUid = await resolvePatientUid(req);
      if (!patientUid) {
        return res.status(403).json({
          success: false,
          message: 'Patient context is required for this research operation',
          code: 'PATIENT_CONTEXT_REQUIRED',
        });
      }
      if (!(await authorizeResearchPatient(req, res, patientUid, {
        resourceType,
        resourceId: req.params.id || req.body?.enrollment_id || req.body?.enrollmentId || null,
      }))) {
        return;
      }
      return next();
    } catch (err) {
      logger.error('Research patient access guard failed:', err);
      return res.status(500).json({
        success: false,
        message: 'Patient access check failed',
        code: 'PATIENT_ACCESS_CHECK_FAILED',
      });
    }
  };
}

const guardEnrollmentCreate = researchPatientGuard(
  async (req) => req.body?.patient_uid || req.body?.patientUid || null,
  'research_enrollment',
);

const guardEnrollmentByParam = researchPatientGuard(async (req) => {
  const id = positiveIntOrNull(req.params.id);
  if (!id) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid
       FROM research_enrollments
      WHERE id = $1
        AND tenant_id = $2::uuid
      LIMIT 1`,
    id,
    deriveTenantIdFromRequest(req),
  );
  return rows[0]?.patient_uid || null;
}, 'research_enrollment');

const guardCrfCapture = researchPatientGuard(async (req) => {
  const enrollmentId = positiveIntOrNull(req.body?.enrollment_id || req.body?.enrollmentId);
  const formId = positiveIntOrNull(req.params.id);
  if (!enrollmentId || !formId) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT e.patient_uid
       FROM research_enrollments e
       JOIN research_crf_forms f
         ON f.registry_id = e.registry_id
        AND f.tenant_id = e.tenant_id
      WHERE e.id = $1
        AND f.id = $2
        AND e.tenant_id = $3::uuid
      LIMIT 1`,
    enrollmentId,
    formId,
    deriveTenantIdFromRequest(req),
  );
  return rows[0]?.patient_uid || null;
}, 'research_crf_response');

const guardResponseByParam = researchPatientGuard(async (req) => {
  const id = positiveIntOrNull(req.params.id);
  if (!id) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT e.patient_uid
       FROM research_crf_responses r
       JOIN research_enrollments e
         ON e.id = r.enrollment_id
        AND e.tenant_id = r.tenant_id
      WHERE r.id = $1
        AND r.tenant_id = $2::uuid
      LIMIT 1`,
    id,
    deriveTenantIdFromRequest(req),
  );
  return rows[0]?.patient_uid || null;
}, 'research_crf_response');

// ── registries ──────────────────────────────────────────────────────────

router.post('/registries', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only investigators/leadership manage registries', HTTP_STATUS.FORBIDDEN);
    const tenantId = deriveTenantIdFromRequest(req);
    const registry = await createRegistry({
      code: req.body.code,
      title: req.body.title,
      kind: req.body.kind || 'registry',
      trialId: req.body.trial_id || null,
      description: req.body.description || null,
      principalInvestigatorUid: req.body.principal_investigator_uid || null,
    }, { actorUid: req.user?.uid || null, tenantId });
    return success(res, { registry }, 'Registry created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create registry');
  }
});

router.get('/registries', async (req, res) => {
  try {
    const registries = await listRegistries({
      status: req.query.status || null,
      tenantId: deriveTenantIdFromRequest(req),
    });
    return success(res, { registries, count: registries.length }, 'Registries');
  } catch (err) {
    return handleFailure(res, err, 'list registries');
  }
});

// ── CRF forms ───────────────────────────────────────────────────────────

router.post('/registries/:id/forms', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only investigators/leadership manage CRF forms', HTTP_STATUS.FORBIDDEN);
    const form = await createCrfForm(req.params.id, {
      name: req.body.name,
      fields: req.body.fields,
    }, { actorUid: req.user?.uid || null, tenantId: deriveTenantIdFromRequest(req) });
    return success(res, { form }, 'CRF form created (draft)', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create CRF form');
  }
});

router.get('/registries/:id/forms', async (req, res) => {
  try {
    const forms = await listForms(req.params.id, {
      status: req.query.status || null,
      tenantId: deriveTenantIdFromRequest(req),
    });
    return success(res, { forms, count: forms.length }, 'CRF forms');
  } catch (err) {
    return handleFailure(res, err, 'list CRF forms');
  }
});

router.post('/forms/:id/publish', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only investigators/leadership publish CRF forms', HTTP_STATUS.FORBIDDEN);
    const form = await publishCrfForm(req.params.id, { tenantId: deriveTenantIdFromRequest(req) });
    return success(res, { form }, 'CRF form published');
  } catch (err) {
    return handleFailure(res, err, 'publish CRF form');
  }
});

// ── enrollments ─────────────────────────────────────────────────────────

router.post('/registries/:id/enrollments', guardEnrollmentCreate, async (req, res) => {
  try {
    const enrollment = await enrollPatient(req.params.id, {
      patientUid: req.body.patient_uid,
      subjectCode: req.body.subject_code || null,
      matchId: req.body.match_id || null,
      consentRef: req.body.consent_ref || null,
      status: req.body.status || 'enrolled',
    }, {
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
      tenantId: deriveTenantIdFromRequest(req),
    });
    return success(res, { enrollment }, 'Patient enrolled', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'enroll patient');
  }
});

router.get('/registries/:id/enrollments', async (req, res) => {
  try {
    const enrollments = await listEnrollments(req.params.id, {
      status: req.query.status || null,
      tenantId: deriveTenantIdFromRequest(req),
    });
    return success(res, { enrollments, count: enrollments.length }, 'Enrollments');
  } catch (err) {
    return handleFailure(res, err, 'list enrollments');
  }
});

router.post('/enrollments/:id/withdraw', guardEnrollmentByParam, async (req, res) => {
  try {
    const enrollment = await withdrawEnrollment(req.params.id, {
      reason: req.body.reason,
    }, {
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
      tenantId: deriveTenantIdFromRequest(req),
    });
    return success(res, { enrollment }, 'Enrollment withdrawn');
  } catch (err) {
    return handleFailure(res, err, 'withdraw enrollment');
  }
});

// ── responses ───────────────────────────────────────────────────────────

router.put('/forms/:id/responses', guardCrfCapture, async (req, res) => {
  try {
    const response = await captureCrfResponse(req.params.id, {
      enrollmentId: req.body.enrollment_id,
      visitLabel: req.body.visit_label || 'baseline',
      data: req.body.data || {},
      autofill: req.body.autofill !== false,
    }, { actorUid: req.user?.uid || null, tenantId: deriveTenantIdFromRequest(req) });
    return success(res, { response }, 'CRF response saved (draft)');
  } catch (err) {
    return handleFailure(res, err, 'capture CRF response');
  }
});

router.post('/responses/:id/submit', guardResponseByParam, async (req, res) => {
  try {
    const response = await submitCrfResponse(req.params.id, {
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
      tenantId: deriveTenantIdFromRequest(req),
    });
    return success(res, { response }, 'CRF response submitted');
  } catch (err) {
    return handleFailure(res, err, 'submit CRF response');
  }
});

router.post('/responses/:id/verify', guardResponseByParam, async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only investigators/leadership verify responses', HTTP_STATUS.FORBIDDEN);
    const response = await verifyCrfResponse(req.params.id, {
      actorUid: req.user?.uid || null,
      tenantId: deriveTenantIdFromRequest(req),
    });
    return success(res, { response }, 'CRF response verified');
  } catch (err) {
    return handleFailure(res, err, 'verify CRF response');
  }
});

// ── export ──────────────────────────────────────────────────────────────

router.get('/registries/:id/export', async (req, res) => {
  try {
    const includePhi = String(req.query.include_phi || 'false') === 'true';
    if (includePhi && !canExportPhi(req.user?.role)) {
      return error(res, 'Only admin/leadership may export identified data', HTTP_STATUS.FORBIDDEN);
    }
    const { filename, contentType, buffer, rowCount } = await exportRegistry(req.params.id, {
      format: req.query.format || 'csv',
      includePhi,
      tenantId: deriveTenantIdFromRequest(req),
    });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Row-Count', String(rowCount));
    return res.send(buffer);
  } catch (err) {
    return handleFailure(res, err, 'export registry');
  }
});

export default router;
