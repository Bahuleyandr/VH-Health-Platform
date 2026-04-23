-- Document intelligence / OCR intake.
--
-- Text-first foundation for external clinical documents. Actual OCR/PDF
-- extraction can be supplied by a sidecar later; this table stores the raw
-- extracted text, normalized facts, citations, safety flags, and review state.

CREATE TABLE IF NOT EXISTS clinical_document_intake (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID,
  admission_id INTEGER,
  source_type VARCHAR(80) NOT NULL DEFAULT 'other',
  title TEXT,
  file_name TEXT,
  mime_type VARCHAR(120),
  storage_key TEXT,
  uploaded_by UUID,
  raw_text TEXT,
  extraction_status VARCHAR(40) NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'completed', 'failed', 'needs_review')),
  document_type VARCHAR(80) NOT NULL DEFAULT 'other',
  extracted_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  normalized_sections JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  reviewer_decision VARCHAR(40) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'rejected', 'needs_revision')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_document_intake_tenant_created
  ON clinical_document_intake (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_document_intake_patient_created
  ON clinical_document_intake (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_document_intake_status_type
  ON clinical_document_intake (tenant_id, extraction_status, source_type);
CREATE INDEX IF NOT EXISTS idx_clinical_document_intake_review
  ON clinical_document_intake (tenant_id, reviewer_decision, created_at DESC);

CREATE TABLE IF NOT EXISTS clinical_document_extraction_events (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  intake_id INTEGER NOT NULL REFERENCES clinical_document_intake(id) ON DELETE CASCADE,
  event_type VARCHAR(80) NOT NULL,
  actor_uid UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_document_events_intake
  ON clinical_document_extraction_events (tenant_id, intake_id, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('document_intelligence_ocr',
   'Document Intelligence / OCR',
   'Extracts structured clinical facts from uploaded PDFs/photos/text or externally OCRed documents. Draft-only; medical-records or clinician review required before importing into the chart.',
   false,
   '{"surface":"medical_records","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["MEDICAL_RECORDS","DOCTOR","NURSING_STAFF"],"approvalPolicy":"clinical_document_review","outputSchema":{"type":"object","required":["document_type","extracted_fields","normalized_sections"]},"uploadPipeline":true,"ocrAdapters":{"nativeText":true,"nativePdfText":true,"localTesseract":true,"localPdfText":true},"retentionDays":3650}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();

INSERT INTO clinical_ai_prompts
  (tenant_id, module_key, version, title, system_prompt, user_prompt_template, output_schema, status, active, activated_at)
VALUES
  (
    '00000000-0000-4000-8000-000000000001',
    'document_intelligence_ocr',
    'v1',
    'Document Intelligence / OCR v1',
    'You extract structured clinical facts from OCR text. Use only the supplied document text. Return JSON only. Preserve uncertainty. Do not invent diagnoses, medications, dates, or identifiers. Every clinically meaningful field must be traceable to source_citations.',
    'Document metadata and OCR text are supplied as JSON. Return keys: document_type, extracted_fields, normalized_sections, confidence, source_citations, safety_flags.',
    '{"type":"object","required":["document_type","extracted_fields","normalized_sections"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
