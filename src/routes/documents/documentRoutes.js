// src/routes/documents/documentRoutes.js
// Document export and import routes: C-CDA XML, clinical PDFs, FHIR Bundle, data import.

import express from 'express';
import logger from '../../logging/logger.js';
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

// =============================================================================
// EXPORT ROUTES
// =============================================================================

/**
 * GET /ccd/:patientUid — Download C-CDA XML for a patient
 */
router.get(
  '/ccd/:patientUid',
  wrapAsync(async (req, res) => {
    const { patientUid } = req.params;

    logPhiAccess({
      userId: req.user?.uid,
      patientId: patientUid,
      recordType: 'ccd_export',
      action: 'EXPORT',
      ip: req.ip,
      requestId: req.id,
    });

    const { generateCCD } = await import('../../services/documents/ccdaGenerator.js');
    const xml = await generateCCD(patientUid);

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
  wrapAsync(async (req, res) => {
    const { admissionId } = req.params;

    logPhiAccess({
      userId: req.user?.uid,
      patientId: `admission-${admissionId}`,
      recordType: 'discharge_summary_pdf',
      action: 'EXPORT',
      ip: req.ip,
      requestId: req.id,
    });

    const { generateDischargeSummaryPDF } = await import('../../services/documents/clinicalPdfGenerator.js');
    const pdfBuffer = await generateDischargeSummaryPDF(admissionId);

    const filename = `Discharge_Summary_${admissionId}_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  })
);

/**
 * GET /lab-report/:investigationId/pdf — Download lab report PDF
 */
router.get(
  '/lab-report/:investigationId/pdf',
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
    const pdfBuffer = await generateLabReportPDF(investigationId);

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
  wrapAsync(async (req, res) => {
    const { patientUid } = req.params;

    logPhiAccess({
      userId: req.user?.uid,
      patientId: patientUid,
      recordType: 'fhir_bundle_export',
      action: 'EXPORT',
      ip: req.ip,
      requestId: req.id,
    });

    const { generatePatientBundle } = await import('../../services/documents/fhirBundleExport.js');
    const bundle = await generatePatientBundle(patientUid);

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

    logPhiAccess({
      userId: importedBy,
      patientId: 'bulk-import',
      recordType: 'fhir_bundle_import',
      action: 'IMPORT',
      ip: req.ip,
      requestId: req.id,
    });

    const { importFhirBundle } = await import('../../services/import/patientDataImport.js');
    const results = await importFhirBundle(bundle, importedBy);

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

    logPhiAccess({
      userId: importedBy,
      patientId: 'bulk-import',
      recordType: 'ccda_import',
      action: 'IMPORT',
      ip: req.ip,
      requestId: req.id,
    });

    const { importCCDA } = await import('../../services/import/patientDataImport.js');
    const results = await importCCDA(xmlString, importedBy);

    logger.info(`C-CDA imported by ${importedBy}: ${results.imported} items`);
    return success(res, results, 'C-CDA document imported successfully');
  })
);

export default router;
