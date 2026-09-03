// src/routes/documents/documentRoutes.js
// Document export and import routes: C-CDA XML, clinical PDFs, FHIR Bundle, data import.

import express from 'express';
import { createHash } from 'node:crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { markRouterDomain } from '../../config/openapiDomain.js';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { getRateLimiter } from '../../middleware/rateLimitMiddleware.js';
import { sanitizeBody } from '../../middleware/sanitizeMiddleware.js';
import {
  ACCESS_POLICY_CODES,
  authorizeClinicalImportReconciliationAccessBatchRequest,
  authorizePatientAccessRequest,
  deriveTenantIdFromRequest,
  patientAccessErrorPayload,
} from '../../services/security/accessDecisionService.js';
import { AppError } from '../../utils/AppError.js';
import { logPhiAccess, logPhiAccessBatch } from '../../utils/hipaaAudit.js';
import { logSecurityEvent } from '../../utils/securityAuditLogger.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const sanitizeClinicalImportReconciliationReason = sanitizeBody('reason');
const clinicalImportRateLimiter = getRateLimiter('clinicalImport');
const captureClinicalImportRawBody = (req, _res, body) => {
  req.clinicalImportRawBody = Buffer.from(body);
};
const parseClinicalImportJson = express.json({
  type: ['application/json', 'application/fhir+json'],
  limit: '5mb',
  inflate: false,
  verify: captureClinicalImportRawBody,
});
const parseClinicalImportXml = express.text({
  type: ['application/xml', 'text/xml', 'application/hl7-v3+xml'],
  limit: '5mb',
  inflate: false,
  verify: captureClinicalImportRawBody,
});

function requireClinicalImportMediaType(...allowedTypes) {
  const allowed = new Set(allowedTypes);
  return (req, _res, next) => {
    const mediaType = String(req.get('Content-Type') || '')
      .split(';', 1)[0].trim().toLowerCase();
    if (!allowed.has(mediaType)) {
      return next(new AppError(
        'Clinical import Content-Type is not supported',
        415,
        'IMPORT_CONTENT_TYPE_UNSUPPORTED',
      ));
    }
    return next();
  };
}

const requireFhirImportMediaType = requireClinicalImportMediaType(
  'application/json',
  'application/fhir+json',
);
const requireCcdaImportMediaType = requireClinicalImportMediaType(
  'application/json',
  'application/xml',
  'text/xml',
  'application/hl7-v3+xml',
);

function logClinicalImportAuthorityDenial(req, tenantId, reason) {
  logSecurityEvent('CLINICAL_IMPORT_AUTHORITY_DENIED', {
    userId: req.user?.uid || req.user?.id || null,
    userRole: req.user?.role || null,
    tenantId,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    path: req.originalUrl || req.path,
    method: req.method,
    statusCode: 403,
    reason,
  });
}

// ---------------------------------------------------------------------------
// Async route wrapper
// ---------------------------------------------------------------------------
function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const guardPatientDocumentExport = patientAccessGuard('CLINICAL_DOCUMENT', {
  requirePatientContext: true,
});

const guardDischargeSummaryExport = patientAccessGuardForResource('CLINICAL_DOCUMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_ADMISSION_VIEW,
  resourceType: 'admission',
  idParam: 'admissionId',
});

async function resolveInvestigationPatient(req) {
  const investigationId = Number.parseInt(req.params.investigationId, 10);
  if (!Number.isInteger(investigationId) || investigationId <= 0) return null;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.id, p.uid
       FROM investigations i
       JOIN users p
         ON p.tenant_id = i.tenant_id
        AND p.role = 'PATIENT'
        AND (
          (i.patient_uid IS NOT NULL AND p.uid = i.patient_uid)
          OR (i.patient_id IS NOT NULL AND p.id = i.patient_id)
        )
      WHERE i.tenant_id = $1::uuid
        AND i.id = $2::int
      LIMIT 1`,
    deriveTenantIdFromRequest(req),
    investigationId,
  );
  return rows[0] || null;
}

async function guardLabReportExport(req, res, next) {
  try {
    const investigationId = Number.parseInt(req.params.investigationId, 10);
    if (!Number.isInteger(investigationId) || investigationId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'investigationId must be a positive integer',
      });
    }
    const patient = await resolveInvestigationPatient(req);
    const decision = await authorizePatientAccessRequest(req, {
      recordType: 'CLINICAL_DOCUMENT',
      patient,
      resourceContext: {
        resourceType: 'investigation',
        resourceId: req.params.investigationId,
      },
      requireResolvedPatient: true,
    });

    if (!decision.allowed) {
      return res.status(403).json(patientAccessErrorPayload(decision));
    }
    return next();
  } catch (err) {
    logger.error('Lab report patient access guard failed:', err);
    return res.status(500).json({
      success: false,
      message: 'Patient access check failed',
      code: 'PATIENT_ACCESS_CHECK_FAILED',
    });
  }
}

function stableImportPayload(value) {
  if (Array.isArray(value)) return value.map(stableImportPayload);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableImportPayload(value[key]);
      return result;
    }, {});
  }
  return value ?? null;
}

function clinicalImportAccessDecisionEvidence(decision) {
  return {
    access_decision: decision.accessDecision,
    access_source: decision.accessSource,
    policy_code: decision.policy_code,
    policy_version: decision.policy_version,
    policy_hash: decision.policy_hash,
    reason: decision.reason || null,
    care_team_id: decision.careTeamId || null,
    break_glass_id: decision.breakGlassId || null,
    referral_id: decision.referralId || null,
    appointment_id: decision.appointmentId || null,
    admission_id: decision.admissionId || null,
    evaluated_at: new Date().toISOString(),
  };
}

export async function resolveClinicalImportAuthority(req, payload, _documentFormat) {
  const tenantId = deriveTenantIdFromRequest(req);
  const actorRole = String(req.user?.role || '').trim().toUpperCase();
  const actorUid = String(req.user?.uid || '').trim().toLowerCase();
  if (actorRole !== 'MEDICAL_RECORDS') {
    logClinicalImportAuthorityDenial(req, tenantId, 'IMPORT_PARTNER_AUTHORITY_NOT_CONFIGURED');
    throw AppError.forbidden(
      'External source activation is not configured; only governed Medical Records intake is available',
      'IMPORT_PARTNER_AUTHORITY_NOT_CONFIGURED',
    );
  }
  const patientUid = String(req.get('X-VH-Import-Patient-Uid') || '').trim().toLowerCase();
  const sourceSystem = String(req.get('X-VH-Import-Source-System') || '').trim();
  const sourceDocumentId = String(req.get('X-VH-Import-Source-Document-Id') || '').trim();
  const sourceFacilityIdHeader = String(
    req.get('X-VH-Import-Source-Facility-Id') || '',
  ).trim();
  const sourceFacilityId = /^(?:[1-9][0-9]{0,9})$/.test(sourceFacilityIdHeader)
    ? Number(sourceFacilityIdHeader)
    : null;
  const authorityGrantId = String(
    req.get('X-VH-Import-Authority-Grant-Id') || '',
  ).trim().toLowerCase();
  const sourceSignatureSha256 = String(
    req.get('X-VH-Import-Source-Signature-Sha256') || '',
  ).trim().toLowerCase();
  const assertedPayloadSha256 = String(
    req.get('X-VH-Import-Payload-Sha256') || '',
  ).trim().toLowerCase();
  const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  const correctionItemId = String(
    req.get('X-VH-Import-Correction-Item-Id') || '',
  ).trim().toLowerCase();
  const correctionManifestIndexHeader = String(
    req.get('X-VH-Import-Correction-Manifest-Index') || '',
  ).trim();
  const hasCorrectionItem = correctionItemId.length > 0;
  const hasCorrectionManifestIndex = correctionManifestIndexHeader.length > 0;
  if (hasCorrectionItem !== hasCorrectionManifestIndex
    || (hasCorrectionItem && !UUID_RE.test(correctionItemId))
    || (hasCorrectionManifestIndex
      && !/^(?:0|[1-9][0-9]{0,3})$/.test(correctionManifestIndexHeader))) {
    throw AppError.badRequest(
      'Correction imports require one reconciliation item UUID and a manifest index from 0 to 9999',
      'IMPORT_CORRECTION_BINDING_INVALID',
    );
  }
  const correctionManifestIndex = hasCorrectionManifestIndex
    ? Number(correctionManifestIndexHeader)
    : null;
  if (!UUID_RE.test(patientUid)) {
    throw AppError.badRequest(
      'X-VH-Import-Patient-Uid must identify one patient UUID',
      'IMPORT_TARGET_PATIENT_REQUIRED',
    );
  }
  if (!sourceSystem || sourceSystem.length > 255
    || !sourceDocumentId || sourceDocumentId.length > 255
    || !Number.isSafeInteger(sourceFacilityId)
    || sourceFacilityId <= 0
    || sourceFacilityId > 2_147_483_647
    || !UUID_RE.test(authorityGrantId)
    || !UUID_RE.test(actorUid)
    || !SHA256_RE.test(sourceSignatureSha256)
    || !idempotencyKey || idempotencyKey.length > 255) {
    throw AppError.badRequest(
      'Clinical import source, facility grant, signature, and idempotency authority headers are required',
      'IMPORT_SOURCE_AUTHORITY_REQUIRED',
    );
  }
  const canonicalPayload = typeof payload === 'string'
    ? payload
    : JSON.stringify(stableImportPayload(payload));
  const sourcePayloadSha256 = createHash('sha256').update(canonicalPayload).digest('hex');
  if (!SHA256_RE.test(assertedPayloadSha256) || assertedPayloadSha256 !== sourcePayloadSha256) {
    throw AppError.conflict(
      'Clinical import payload hash does not match the declared source manifest',
      'IMPORT_PAYLOAD_HASH_MISMATCH',
    );
  }

  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient.id AS patient_id, patient.uid AS patient_uid,
            facility.id AS facility_id
       FROM users patient
       JOIN facilities facility
         ON facility.tenant_id=patient.tenant_id
        AND facility.id=$3::int
        AND facility.status='active'
      WHERE patient.tenant_id=$1::uuid
        AND patient.uid=$2::uuid
        AND patient.role='PATIENT'
        AND patient.is_active=TRUE
        AND patient.status='active'
        AND patient.is_deleted=FALSE
        AND patient.merged_into_uid IS NULL
      LIMIT 1`,
    tenantId,
    patientUid,
    sourceFacilityId,
  );
  if (!rows.length) {
    throw AppError.notFound(
      'Clinical import patient or source facility is unavailable',
      'IMPORT_PATIENT_OR_FACILITY_NOT_FOUND',
    );
  }
  const decision = await authorizePatientAccessRequest(req, {
    policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD,
    recordType: 'MEDICAL_RECORD',
    patient: { id: rows[0].patient_id, uid: rows[0].patient_uid },
    resourceContext: {
      resourceType: 'clinical_document_import',
      resourceId: sourceDocumentId,
      facilityId: sourceFacilityId,
    },
    requireResolvedPatient: true,
  });
  if (!decision.allowed) {
    throw AppError.forbidden(
      patientAccessErrorPayload(decision).message || 'Clinical import is not authorised for this patient',
      decision.safe_reason_code || 'IMPORT_PATIENT_ACCESS_DENIED',
    );
  }
  if (!Buffer.isBuffer(req.clinicalImportRawBody) || req.clinicalImportRawBody.length === 0) {
    throw AppError.internal(
      'Clinical import exact source bytes are unavailable',
      'IMPORT_RAW_SOURCE_REQUIRED',
    );
  }
  return {
    tenantId,
    patientUid,
    patientId: Number(rows[0].patient_id),
    sourceSystem,
    sourceDocumentId,
    sourceFacilityId,
    authorityGrantId,
    sourceSignatureSha256,
    sourcePayloadSha256,
    idempotencyKey,
    correctionItemId: hasCorrectionItem ? correctionItemId : null,
    correctionManifestIndex,
    actorUid,
    actorRole,
    ingestionMode: 'manual_medical_records',
    requestId: req.id || null,
    rawDocument: Buffer.from(req.clinicalImportRawBody),
    rawContentType: String(req.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase(),
    accessDecisionEvidence: clinicalImportAccessDecisionEvidence(decision),
    revalidateAccess: async ({ db, patientId, patientUid: activePatientUid }) => {
      const currentDecision = await authorizePatientAccessRequest(req, {
        db,
        audit: false,
        policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD,
        recordType: 'MEDICAL_RECORD',
        patient: { id: patientId, uid: activePatientUid },
        resourceContext: {
          resourceType: 'clinical_document_import',
          resourceId: sourceDocumentId,
          facilityId: sourceFacilityId,
        },
        requireResolvedPatient: true,
      });
      if (!currentDecision.allowed) {
        throw AppError.forbidden(
          patientAccessErrorPayload(currentDecision).message
            || 'Clinical import is not authorised for this patient',
          currentDecision.safe_reason_code || 'IMPORT_PATIENT_ACCESS_DENIED',
        );
      }
      return clinicalImportAccessDecisionEvidence(currentDecision);
    },
  };
}

async function authorizeClinicalImportReconciliationAccess(req, context, {
  db = null,
  audit = true,
} = {}) {
  return authorizePatientAccessRequest(req, {
    db,
    audit,
    policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD,
    recordType: 'MEDICAL_RECORD',
    patient: {
      id: context.activePatientId,
      uid: context.activePatientUid,
    },
    resourceContext: {
      resourceType: 'clinical_import_reconciliation',
      resourceId: context.itemId,
      facilityId: context.facilityId,
    },
    requireResolvedPatient: true,
  });
}

async function authorizeClinicalImportReconciliationAccessBatch(req, entries, { db }) {
  return authorizeClinicalImportReconciliationAccessBatchRequest(req, {
    db,
    policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD,
    recordType: 'MEDICAL_RECORD',
    requireResolvedPatient: true,
    entries: entries.map(({ decisionKey, context }) => ({
      decisionKey,
      patient: {
        id: context.activePatientId,
        uid: context.activePatientUid,
      },
      resourceContext: {
        resourceType: 'clinical_import_reconciliation',
        resourceId: context.itemId,
        facilityId: context.facilityId,
      },
    })),
  });
}

function reconciliationAccessDecisionEvidence(req, context, decision) {
  return {
    contract_version: 'clinical-import-reconciliation-access-decision-v1',
    access_decision: decision.accessDecision,
    access_source: decision.accessSource,
    policy_code: decision.policy_code,
    policy_version: decision.policy_version,
    policy_hash: decision.policy_hash,
    reason: decision.reason || null,
    actor_uid: String(req.user?.uid || '').trim().toLowerCase(),
    patient_uid: context.activePatientUid,
    care_team_id: decision.careTeamId || null,
    break_glass_id: decision.breakGlassId || null,
    referral_id: decision.referralId || null,
    appointment_id: decision.appointmentId || null,
    admission_id: decision.admissionId || null,
    evaluated_at: new Date().toISOString(),
  };
}

function clinicalImportReconciliationActionInput(req, context, decision) {
  return {
    tenantId: deriveTenantIdFromRequest(req),
    itemId: req.params.itemId,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    reason: req.body?.reason,
    idempotencyKey: req.get('Idempotency-Key'),
    authorityGrantId: req.get('X-VH-Import-Authority-Grant-Id'),
    accessDecisionEvidence: reconciliationAccessDecisionEvidence(req, context, decision),
    revalidateAccess: async ({ db, context: currentContext }) => {
      const activeContext = currentContext || context;
      const currentDecision = await authorizeClinicalImportReconciliationAccess(
        req,
        activeContext,
        { db, audit: false },
      );
      if (!currentDecision.allowed) {
        const denial = patientAccessErrorPayload(currentDecision);
        throw AppError.forbidden(
          denial.message || 'Clinical import reconciliation is not authorised for this patient',
          denial.code || 'IMPORT_RECONCILIATION_PATIENT_ACCESS_DENIED',
        );
      }
      return reconciliationAccessDecisionEvidence(req, activeContext, currentDecision);
    },
  };
}

async function executeClinicalImportReconciliationAction(req, res, {
  commandName,
  auditAction,
  createdMessage,
  replayedMessage,
}) {
  const reconciliationService = await import(
    '../../services/import/clinicalImportReconciliationService.js'
  );
  const tenantId = deriveTenantIdFromRequest(req);
  try {
    await reconciliationService.assertClinicalImportReconciliationActionAuthority({
      tenantId,
      itemId: req.params.itemId,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      authorityGrantId: req.get('X-VH-Import-Authority-Grant-Id'),
    });
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 403) {
      logClinicalImportAuthorityDenial(req, tenantId, error.code);
    }
    throw error;
  }
  const context = await reconciliationService.getClinicalImportReconciliationActionContext({
    tenantId,
    itemId: req.params.itemId,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
  });
  const decision = await authorizeClinicalImportReconciliationAccess(req, context);
  if (!decision.allowed) {
    const denial = patientAccessErrorPayload(decision);
    throw AppError.forbidden(
      denial.message || 'Clinical import reconciliation is not authorised for this patient',
      denial.code || 'IMPORT_RECONCILIATION_PATIENT_ACCESS_DENIED',
    );
  }
  const input = clinicalImportReconciliationActionInput(req, context, decision);
  if (commandName === 'resolveClinicalImportReconciliation') {
    input.replacementResourceReceiptId = req.body?.replacement_resource_receipt_id;
  }
  const result = await reconciliationService[commandName](input);
  logPhiAccess({
    userId: req.user?.uid,
    patientId: context.activePatientUid,
    userRole: req.user?.role,
    tenantId,
    recordType: 'clinical_import_reconciliation',
    action: auditAction,
    ip: req.ip,
    requestId: req.id,
  });
  return success(
    res,
    result,
    result.replayed ? replayedMessage : createdMessage,
    result.replayed ? 200 : 201,
  );
}

// =============================================================================
// EXPORT ROUTES
// =============================================================================

/**
 * GET /ccd/:patientUid — Download C-CDA XML for a patient
 */
router.get(
  '/ccd/:patientUid',
  guardPatientDocumentExport,
  wrapAsync(async (req, res) => {
    const { patientUid } = req.params;
    const tenantId = deriveTenantIdFromRequest(req);

    logPhiAccess({
      userId: req.user?.uid,
      patientId: patientUid,
      recordType: 'ccd_export',
      action: 'EXPORT',
      ip: req.ip,
      requestId: req.id,
    });

    const { generateCCD } = await import('../../services/documents/ccdaGenerator.js');
    const xml = await generateCCD(patientUid, { tenantId });

    const filename = `CCD_${patientUid}_${new Date().toISOString().slice(0, 10)}.xml`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xml);
  })
);

/**
 * GET /discharge-summary/:admissionId/pdf — Download discharge summary PDF
 */
router.get(
  '/discharge-summary/:admissionId/pdf',
  guardDischargeSummaryExport,
  wrapAsync(async (req, res) => {
    // admissions.id is an int; Prisma's findUnique rejects a string here
    // with PrismaClientValidationError ("Argument `id`: Expected Int,
    // provided String"), which surfaces as a 500. Parse + validate first.
    // Finding: 2026-05-08-tpa-insurance-claim-patient-no-discharge-or-final-bill-download
    // (the upstream backend 500 the patient app was hitting).
    const admissionId = Number.parseInt(req.params.admissionId, 10);
    if (!Number.isFinite(admissionId) || admissionId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'admissionId must be a positive integer',
      });
    }

    logPhiAccess({
      userId: req.user?.uid,
      patientId: `admission-${admissionId}`,
      recordType: 'discharge_summary_pdf',
      action: 'EXPORT',
      ip: req.ip,
      requestId: req.id,
    });

    const { generateDischargeSummaryPDF } = await import('../../services/documents/clinicalPdfGenerator.js');
    const pdfBuffer = await generateDischargeSummaryPDF(admissionId, {
      tenantId: deriveTenantIdFromRequest(req),
    });

    const filename = `Discharge_Summary_${admissionId}_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  })
);

/**
 * B-6 — GET /discharge-summary/:admissionId/pdf/persisted
 *
 * Idempotent persisted-PDF path. Returns the immutable post-signoff
 * snapshot's signed URL. Generates + uploads to R2 on first call;
 * thereafter just returns the signed URL for the existing key.
 * Refuses (409 SUMMARY_NOT_SIGNED) if the summary isn't signed yet —
 * the legal record is the signed version, not the draft.
 */
router.get(
  '/discharge-summary/:admissionId/pdf/persisted',
  guardDischargeSummaryExport,
  wrapAsync(async (req, res) => {
    const admissionId = Number.parseInt(req.params.admissionId, 10);
    if (!Number.isFinite(admissionId) || admissionId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'admissionId must be a positive integer',
      });
    }
    logPhiAccess({
      userId: req.user?.uid,
      patientId: `admission-${admissionId}`,
      recordType: 'discharge_summary_pdf_persisted',
      action: 'EXPORT',
      ip: req.ip,
      requestId: req.id,
    });
    const { getOrGenerateDischargePdfUrl } = await import('../../services/documents/clinicalPdfGenerator.js');
    try {
      const result = await getOrGenerateDischargePdfUrl(admissionId, {
        tenantId: deriveTenantIdFromRequest(req),
      });
      return success(res, result, 'Discharge summary PDF ready');
    } catch (err) {
      // Never leak the raw generator/DB error to the client. Log server-side;
      // the error() helper scrubs internal detail and generalises 5xx in prod.
      const status = err.statusCode || 500;
      logger.error('[documents] discharge PDF generation failed', {
        admissionId,
        message: err.message,
        code: err.code,
      });
      return error(res, err.message || 'Failed to generate discharge summary PDF', status, err.code ? { code: err.code } : null);
    }
  })
);

/**
 * GET /lab-report/:investigationId/pdf — Download lab report PDF
 */
router.get(
  '/lab-report/:investigationId/pdf',
  guardLabReportExport,
  wrapAsync(async (req, res) => {
    const { investigationId } = req.params;

    logPhiAccess({
      userId: req.user?.uid,
      patientId: `investigation-${investigationId}`,
      recordType: 'lab_report_pdf',
      action: 'EXPORT',
      ip: req.ip,
      requestId: req.id,
    });

    const { generateLabReportPDF } = await import('../../services/documents/clinicalPdfGenerator.js');
    const pdfBuffer = await generateLabReportPDF(investigationId, {
      tenantId: deriveTenantIdFromRequest(req),
    });

    const filename = `Lab_Report_${investigationId}_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  })
);

/**
 * GET /fhir-bundle/:patientUid — Download complete FHIR Bundle JSON
 */
router.get(
  '/fhir-bundle/:patientUid',
  guardPatientDocumentExport,
  wrapAsync(async (req, res) => {
    const { patientUid } = req.params;
    const tenantId = deriveTenantIdFromRequest(req);

    logPhiAccess({
      userId: req.user?.uid,
      patientId: patientUid,
      recordType: 'fhir_bundle_export',
      action: 'EXPORT',
      ip: req.ip,
      requestId: req.id,
    });

    const { generatePatientBundle } = await import('../../services/documents/fhirBundleExport.js');
    const bundle = await generatePatientBundle(patientUid, { tenantId });

    const filename = `FHIR_Bundle_${patientUid}_${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/fhir+json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(bundle);
  })
);

// =============================================================================
// IMPORT ROUTES
// =============================================================================

/**
 * POST /import/fhir-bundle — Import FHIR Bundle from another hospital
 * Body: FHIR Bundle JSON
 */
router.post(
  '/import/fhir-bundle',
  clinicalImportRateLimiter,
  requireFhirImportMediaType,
  parseClinicalImportJson,
  wrapAsync(async (req, res) => {
    const bundle = req.body;
    if (!bundle || bundle.resourceType !== 'Bundle') {
      throw AppError.badRequest('Request body must be a valid FHIR Bundle');
    }

    const importedBy = req.user?.uid;
    const authority = await resolveClinicalImportAuthority(req, bundle, 'fhir_bundle');
    const tenantId = authority.tenantId;

    logPhiAccess({
      userId: importedBy,
      patientId: authority.patientUid,
      userRole: authority.actorRole,
      tenantId,
      recordType: 'fhir_bundle_import',
      action: 'IMPORT',
      ip: req.ip,
      requestId: req.id,
    });

    const { importFhirBundle } = await import('../../services/import/patientDataImport.js');
    let results;
    try {
      results = await importFhirBundle(bundle, importedBy, { tenantId, authority });
    } catch (importError) {
      if (importError instanceof AppError && importError.statusCode === 403) {
        logClinicalImportAuthorityDenial(req, tenantId, importError.code);
      }
      throw importError;
    }
    const hasIncompleteOutcome = results.errors.length > 0
      || results.observationPartitions.some((partition) => Boolean(partition.error));

    logger.info(`FHIR Bundle imported by ${importedBy}: ${results.imported} resources`);
    return success(
      res,
      results,
      hasIncompleteOutcome
        ? 'FHIR Bundle imported with explicit partial failures or incomplete clinical effects'
        : 'FHIR Bundle imported successfully',
      hasIncompleteOutcome ? 207 : 200,
    );
  })
);

/**
 * POST /import/ccd — Import C-CDA XML document
 * Body: { xml: "<ClinicalDocument>..." } or raw XML in body
 */
router.post(
  '/import/ccd',
  clinicalImportRateLimiter,
  requireCcdaImportMediaType,
  parseClinicalImportJson,
  parseClinicalImportXml,
  wrapAsync(async (req, res) => {
    let xmlString;

    // Support both JSON body with xml field and raw XML content type
    if (req.is('application/xml')
      || req.is('text/xml')
      || req.is('application/hl7-v3+xml')) {
      xmlString = typeof req.body === 'string' ? req.body : null;
    } else {
      xmlString = req.body?.xml;
    }

    if (!xmlString || typeof xmlString !== 'string') {
      throw AppError.badRequest('Request must contain C-CDA XML in body.xml or as raw XML');
    }

    // Basic validation: must contain ClinicalDocument
    if (!xmlString.includes('ClinicalDocument')) {
      throw AppError.badRequest('XML does not appear to be a valid C-CDA document');
    }

    const importedBy = req.user?.uid;
    const authority = await resolveClinicalImportAuthority(req, xmlString, 'ccda');
    const tenantId = authority.tenantId;

    logPhiAccess({
      userId: importedBy,
      patientId: authority.patientUid,
      userRole: authority.actorRole,
      tenantId,
      recordType: 'ccda_import',
      action: 'IMPORT',
      ip: req.ip,
      requestId: req.id,
    });

    const { importCCDA } = await import('../../services/import/patientDataImport.js');
    let results;
    try {
      results = await importCCDA(xmlString, importedBy, { tenantId, authority });
    } catch (importError) {
      if (importError instanceof AppError && importError.statusCode === 403) {
        logClinicalImportAuthorityDenial(req, tenantId, importError.code);
      }
      throw importError;
    }

    logger.info(`C-CDA imported by ${importedBy}: ${results.imported} items`);
    return success(
      res,
      results,
      results.errors.length
        ? 'C-CDA document imported with explicit partial failures'
        : 'C-CDA document imported successfully',
      results.errors.length ? 207 : 200,
    );
  })
);

/**
 * GET /import/reconciliation — Open clinical-import reconciliation worklist.
 */
router.get(
  '/import/reconciliation',
  clinicalImportRateLimiter,
  wrapAsync(async (req, res) => {
    req.suppressSuccessfulPhiAccessLog = true;
    const {
      listClinicalImportReconciliationItems,
    } = await import('../../services/import/clinicalImportReconciliationService.js');
    const tenantId = deriveTenantIdFromRequest(req);
    let page;
    try {
      page = await listClinicalImportReconciliationItems({
        tenantId,
        actorUid: req.user?.uid,
        actorRole: req.user?.role,
        cursor: req.query?.cursor,
        authorizeAccessBatch: async ({ db, entries }) => {
          const decisions = await authorizeClinicalImportReconciliationAccessBatch(
            req,
            entries,
            { db },
          );
          return decisions.map(({ decisionKey, decision }) => ({
            decisionKey,
            allowed: decision.allowed === true,
          }));
        },
        auditReturnedItems: async ({ db, items }) => {
          await logPhiAccessBatch(items.map(item => ({
            userId: req.user?.uid,
            userRole: req.user?.role,
            patientId: item.active_patient_uid,
            tenantId,
            recordType: `clinical_import_reconciliation:${item.id}`,
            action: 'VIEW',
            ip: req.ip,
            requestId: req.id,
          })), { db });
        },
      });
    } catch (listError) {
      if (listError?.statusCode === 429) res.setHeader('Retry-After', '1');
      throw listError;
    }
    return success(res, {
      items: page.items,
      count: page.items.length,
      next_cursor: page.nextCursor,
    }, 'Clinical import reconciliation worklist');
  })
);

/**
 * POST /import/reconciliation/:itemId/retry-request — Append a retry request.
 */
router.post(
  '/import/reconciliation/:itemId/retry-request',
  clinicalImportRateLimiter,
  sanitizeClinicalImportReconciliationReason,
  wrapAsync((req, res) => executeClinicalImportReconciliationAction(req, res, {
    commandName: 'requestClinicalImportRetry',
    auditAction: 'RETRY_REQUEST',
    createdMessage: 'Clinical import retry requested',
    replayedMessage: 'Clinical import retry request replayed',
  }))
);

/**
 * POST /import/reconciliation/:itemId/resolve — Resolve with replacement receipt evidence.
 */
router.post(
  '/import/reconciliation/:itemId/resolve',
  clinicalImportRateLimiter,
  sanitizeClinicalImportReconciliationReason,
  wrapAsync((req, res) => executeClinicalImportReconciliationAction(req, res, {
    commandName: 'resolveClinicalImportReconciliation',
    auditAction: 'RESOLVE',
    createdMessage: 'Clinical import reconciliation resolved',
    replayedMessage: 'Clinical import reconciliation resolution replayed',
  }))
);

// This directory bootstrapped `documents` while admin/clinicalAi/documentRoutes.js
// bootstrapped `document` — a plural split across one subject (clinical documents:
// generated, exchanged and ingested). `document` is canonical, matching the
// registry's singular house style for domain nouns.
markRouterDomain(router, 'document');

export default router;
