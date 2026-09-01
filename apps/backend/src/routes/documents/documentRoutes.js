// src/routes/documents/documentRoutes.js
// Document export and import routes: C-CDA XML, clinical PDFs, FHIR Bundle, data import.

import express from 'express';
import { createHash } from 'node:crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { markRouterDomain } from '../../config/openapiDomain.js';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import {
  ACCESS_POLICY_CODES,
  authorizePatientAccessRequest,
  deriveTenantIdFromRequest,
  patientAccessErrorPayload,
} from '../../services/security/accessDecisionService.js';
import { AppError } from '../../utils/AppError.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

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

async function resolveClinicalImportAuthority(req, payload) {
  const tenantId = deriveTenantIdFromRequest(req);
  const actorRole = String(req.user?.role || '').trim().toUpperCase();
  if (actorRole !== 'MEDICAL_RECORDS') {
    throw AppError.forbidden(
      'External source activation is not configured; only governed Medical Records intake is available',
      'IMPORT_PARTNER_AUTHORITY_NOT_CONFIGURED',
    );
  }
  const patientUid = String(req.get('X-VH-Import-Patient-Uid') || '').trim().toLowerCase();
  const sourceSystem = String(req.get('X-VH-Import-Source-System') || '').trim();
  const sourceDocumentId = String(req.get('X-VH-Import-Source-Document-Id') || '').trim();
  const sourceFacilityId = Number.parseInt(req.get('X-VH-Import-Source-Facility-Id'), 10);
  const sourceSignatureSha256 = String(
    req.get('X-VH-Import-Source-Signature-Sha256') || '',
  ).trim().toLowerCase();
  const assertedPayloadSha256 = String(
    req.get('X-VH-Import-Payload-Sha256') || '',
  ).trim().toLowerCase();
  const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  if (!UUID_RE.test(patientUid)) {
    throw AppError.badRequest(
      'X-VH-Import-Patient-Uid must identify one patient UUID',
      'IMPORT_TARGET_PATIENT_REQUIRED',
    );
  }
  if (!sourceSystem || sourceSystem.length > 255
    || !sourceDocumentId || sourceDocumentId.length > 255
    || !Number.isInteger(sourceFacilityId) || sourceFacilityId <= 0
    || !SHA256_RE.test(sourceSignatureSha256)
    || !idempotencyKey || idempotencyKey.length > 255) {
    throw AppError.badRequest(
      'Clinical import source, facility, signature, and idempotency authority headers are required',
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
  return {
    tenantId,
    patientUid,
    patientId: Number(rows[0].patient_id),
    sourceSystem,
    sourceDocumentId,
    sourceFacilityId,
    sourceSignatureSha256,
    sourcePayloadSha256,
    idempotencyKey,
    actorUid: req.user?.uid || null,
    actorRole,
    ingestionMode: 'manual_medical_records',
    requestId: req.id || null,
  };
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
  wrapAsync(async (req, res) => {
    const bundle = req.body;
    if (!bundle || bundle.resourceType !== 'Bundle') {
      throw AppError.badRequest('Request body must be a valid FHIR Bundle');
    }

    const importedBy = req.user?.uid;
    const authority = await resolveClinicalImportAuthority(req, bundle);
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
    const results = await importFhirBundle(bundle, importedBy, { tenantId, authority });

    logger.info(`FHIR Bundle imported by ${importedBy}: ${results.imported} resources`);
    return success(
      res,
      results,
      results.errors.length
        ? 'FHIR Bundle imported with explicit partial failures'
        : 'FHIR Bundle imported successfully',
      results.errors.length ? 207 : 200,
    );
  })
);

/**
 * POST /import/ccd — Import C-CDA XML document
 * Body: { xml: "<ClinicalDocument>..." } or raw XML in body
 */
router.post(
  '/import/ccd',
  wrapAsync(async (req, res) => {
    let xmlString;

    // Support both JSON body with xml field and raw XML content type
    if (req.is('application/xml') || req.is('text/xml')) {
      // Raw XML body — express won't parse this by default,
      // so we check if body is a string (requires text middleware upstream)
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
    const authority = await resolveClinicalImportAuthority(req, xmlString);
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
    const results = await importCCDA(xmlString, importedBy, { tenantId, authority });

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

// This directory bootstrapped `documents` while admin/clinicalAi/documentRoutes.js
// bootstrapped `document` — a plural split across one subject (clinical documents:
// generated, exchanged and ingested). `document` is canonical, matching the
// registry's singular house style for domain nouns.
markRouterDomain(router, 'document');

export default router;
