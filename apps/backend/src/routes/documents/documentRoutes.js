// src/routes/documents/documentRoutes.js
// Document export and import routes: C-CDA XML, clinical PDFs, FHIR Bundle, data import.

import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import {
  ACCESS_POLICY_CODES,
  authorizePatientAccessRequest,
  deriveTenantIdFromRequest,
  patientAccessErrorPayload,
} from '../../services/security/accessDecisionService.js';
import {
  CARE_TEAM_ENFORCEMENT_MODES,
  resolveEnforcementModeForRequest,
} from '../../services/security/careTeamEnforcement.js';
import { AppError } from '../../utils/AppError.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Async route wrapper
// ---------------------------------------------------------------------------
function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Care-team-governed (GO_LIVE): shadow by default (audit-only, never blocks),
// real 403 only once the tenant flips care_team_enforcement_mode to 'enforce'.
// Brings the clinical-document exports under the same per-tenant care-team ABAC
// rollout as the FHIR / nursing-assessments / encounters mounts. Audit finding #5.
const guardPatientDocumentExport = patientAccessGuard('CLINICAL_DOCUMENT', {
  requirePatientContext: true,
  careTeamModeGoverned: true,
});

const guardDischargeSummaryExport = patientAccessGuardForResource('CLINICAL_DOCUMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_ADMISSION_VIEW,
  resourceType: 'admission',
  idParam: 'admissionId',
  careTeamModeGoverned: true,
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
  const investigationId = Number.parseInt(req.params.investigationId, 10);
  if (!Number.isInteger(investigationId) || investigationId <= 0) {
    return res.status(400).json({
      success: false,
      message: 'investigationId must be a positive integer',
    });
  }

  // Care-team-governed (GO_LIVE), matching the other document export guards.
  // `shadow` defaults to true so any failure resolving the mode fails OPEN.
  let shadow = true;
  try {
    const mode = await resolveEnforcementModeForRequest(req);
    if (mode === CARE_TEAM_ENFORCEMENT_MODES.OFF) return next();
    shadow = mode === CARE_TEAM_ENFORCEMENT_MODES.SHADOW;

    const patient = await resolveInvestigationPatient(req);
    const decision = await authorizePatientAccessRequest(req, {
      recordType: 'CLINICAL_DOCUMENT',
      patient,
      resourceContext: {
        resourceType: 'investigation',
        resourceId: req.params.investigationId,
      },
      requireResolvedPatient: true,
      shadowMode: shadow,
    });

    // Shadow coerces a would-be denial to allowed:true (after writing the deny
    // audit row); a still-false decision only blocks in enforce mode. Shadow
    // must NEVER block — including the requireResolvedPatient unresolved deny.
    if (!shadow && !decision.allowed) {
      return res.status(403).json(patientAccessErrorPayload(decision));
    }
    return next();
  } catch (err) {
    // Non-breaking guarantee: shadow fails OPEN; enforce keeps fail-closed 500.
    if (shadow) {
      logger.error('SECURITY ALERT: lab report patient access guard failed OPEN in shadow mode (allowing request)', {
        path: req.originalUrl || req.url,
        error: err?.message,
      });
      return next();
    }
    logger.error('Lab report patient access guard failed:', err);
    return res.status(500).json({
      success: false,
      message: 'Patient access check failed',
      code: 'PATIENT_ACCESS_CHECK_FAILED',
    });
  }
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
      res.json({ success: true, data: result });
    } catch (err) {
      const status = err.statusCode || 500;
      res.status(status).json({
        success: false,
        message: err.message,
        code: err.code,
      });
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

    const importedBy = req.user?.uid || 'system';
    const tenantId = deriveTenantIdFromRequest(req);

    logPhiAccess({
      userId: importedBy,
      patientId: 'bulk-import',
      recordType: 'fhir_bundle_import',
      action: 'IMPORT',
      ip: req.ip,
      requestId: req.id,
    });

    const { importFhirBundle } = await import('../../services/import/patientDataImport.js');
    const results = await importFhirBundle(bundle, importedBy, { tenantId });

    logger.info(`FHIR Bundle imported by ${importedBy}: ${results.imported} resources`);
    return success(res, results, 'FHIR Bundle imported successfully');
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

    const importedBy = req.user?.uid || 'system';
    const tenantId = deriveTenantIdFromRequest(req);

    logPhiAccess({
      userId: importedBy,
      patientId: 'bulk-import',
      recordType: 'ccda_import',
      action: 'IMPORT',
      ip: req.ip,
      requestId: req.id,
    });

    const { importCCDA } = await import('../../services/import/patientDataImport.js');
    const results = await importCCDA(xmlString, importedBy, { tenantId });

    logger.info(`C-CDA imported by ${importedBy}: ${results.imported} items`);
    return success(res, results, 'C-CDA document imported successfully');
  })
);

export default router;
