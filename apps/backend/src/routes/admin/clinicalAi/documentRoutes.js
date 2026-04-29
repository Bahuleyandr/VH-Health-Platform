import express from 'express';
import multer from 'multer';
import { validateFileContent } from '../../../middleware/uploadMiddleware.js';
import { error, success } from '../../../utils/responseHelper.js';
import {
  decideClinicalDocumentIntake,
  ingestClinicalDocument,
  ingestClinicalDocumentUpload,
  listClinicalDocumentIntakes,
} from '../../../services/ai/documentIntelligenceService.js';
import { logClinicalAiAudit } from './audit.js';

const router = express.Router();

const DOCUMENT_UPLOAD_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/bmp',
  'text/plain',
  'text/csv',
  'text/rtf',
  'application/json',
  'application/fhir+json',
  'application/hl7-v2+er7',
]);
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 1,
    fields: 12,
    fieldSize: 64 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const mimeType = String(file.mimetype || '').toLowerCase();
    if (!DOCUMENT_UPLOAD_MIME_TYPES.has(mimeType)) {
      cb(new Error(`Document intelligence upload does not support ${mimeType}`));
      return;
    }
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// Document intelligence / OCR intake
// ---------------------------------------------------------------------------
router.post('/documents/intake', async (req, res, next) => {
  try {
    const result = await ingestClinicalDocument({
      req,
      patientUid: req.body?.patient_uid || null,
      admissionId: req.body?.admission_id || null,
      sourceType: req.body?.source_type || 'other',
      title: req.body?.title || null,
      fileName: req.body?.file_name || null,
      mimeType: req.body?.mime_type || null,
      storageKey: req.body?.storage_key || null,
      rawText: req.body?.raw_text || '',
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_DOCUMENT_INTELLIGENCE_INGESTED',
      String(result.intake_id || result.generation_id || 'inline'),
      null,
      {
        intake_id: result.intake_id,
        generation_id: result.generation_id,
        extraction_status: result.extraction_status,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Document intelligence intake complete', 201);
  } catch (err) {
    return next(err);
  }
});

router.post(
  '/documents/intake/upload',
  documentUpload.single('file'),
  validateFileContent,
  async (req, res, next) => {
    try {
      if (!req.file) return error(res, 'file is required', 400);
      const result = await ingestClinicalDocumentUpload({
        req,
        file: req.file,
        patientUid: req.body?.patient_uid || null,
        admissionId: req.body?.admission_id || null,
        sourceType: req.body?.source_type || 'other',
        title: req.body?.title || null,
        storageKey: req.body?.storage_key || null,
        rawTextHint: req.body?.raw_text || '',
      });
      await logClinicalAiAudit(
        req,
        'CLINICAL_AI_DOCUMENT_INTELLIGENCE_FILE_UPLOADED',
        String(result.intake_id || result.generation_id || result.ocr?.file_hash || 'inline'),
        null,
        {
          intake_id: result.intake_id,
          generation_id: result.generation_id,
          extraction_status: result.extraction_status,
          ocr_provider: result.ocr?.provider || null,
          ocr_status: result.ocr?.status || null,
          file_name: req.file.originalname,
          mime_type: result.ocr?.mime_type || req.file.mimetype,
          text_char_count: result.ocr?.text_char_count || 0,
          safety_flag_count: result.safety_flags?.length || 0,
        }
      );
      return success(res, result, 'Document intelligence file upload complete', 201);
    } catch (err) {
      return next(err);
    }
  }
);

router.get('/documents/intake', async (req, res, next) => {
  try {
    const result = await listClinicalDocumentIntakes({
      tenantId: req.tenantId,
      sourceType: req.query?.source_type || null,
      status: req.query?.status || null,
      patientUid: req.query?.patient_uid || null,
      decision: req.query?.decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Document intelligence intakes retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/documents/intake/:id', async (req, res, next) => {
  try {
    const result = await decideClinicalDocumentIntake({
      tenantId: req.tenantId,
      intakeId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_DOCUMENT_INTELLIGENCE_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Document intake reviewed');
  } catch (err) {
    return next(err);
  }
});

export default router;
