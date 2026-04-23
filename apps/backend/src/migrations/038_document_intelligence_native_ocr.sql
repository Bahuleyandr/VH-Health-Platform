-- Document Intelligence native upload/OCR adapter metadata.
--
-- No table changes are needed because clinical_document_intake.metadata already
-- stores OCR provider/status/file details. This migration keeps existing DBs in
-- sync with the static module catalog after adding the upload pipeline.

UPDATE clinical_ai_modules
SET
  description = 'Extracts structured clinical facts from uploaded PDFs/photos/text or externally OCRed documents. Medical-records or clinician review is required before any chart import.',
  settings = settings || '{
    "uploadPipeline": true,
    "ocrAdapters": {
      "nativeText": true,
      "nativePdfText": true,
      "localTesseract": true,
      "localPdfText": true
    }
  }'::jsonb,
  updated_at = NOW()
WHERE module_key = 'document_intelligence_ocr';
