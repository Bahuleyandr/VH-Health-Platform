-- NL-14 P2: post-event resuscitation QA / debrief reviews.
--
-- QA/debrief TEMPLATES are clinical-governance-owned content (spec §6.5):
-- this table stores evidence-owner fields, version/source metadata, and
-- reviewer-signoff slots. It is INERT until the operator supplies approved
-- content — with no approved template the row cannot progress past
-- 'template_unavailable' (FAILS CLOSED; no fallback content).

BEGIN;

CREATE TABLE IF NOT EXISTS resuscitation_qa_reviews (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  resuscitation_event_id BIGINT NOT NULL REFERENCES resuscitation_events(id) ON DELETE RESTRICT,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  review_status VARCHAR(30) NOT NULL DEFAULT 'template_unavailable',
  template_source VARCHAR(40) NOT NULL DEFAULT 'unavailable',
  template_version VARCHAR(80),
  template_reference_uri TEXT,
  template_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_owner_uid UUID,
  responses JSONB NOT NULL DEFAULT '{}'::jsonb,
  findings TEXT,
  action_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  debrief_held_at TIMESTAMPTZ(6),
  debrief_lead_uid UUID,
  reviewer_uid UUID,
  reviewer_signed_at TIMESTAMPTZ(6),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT resuscitation_qa_reviews_status_check
    CHECK (review_status IN ('template_unavailable', 'draft', 'submitted', 'signed_off')),
  CONSTRAINT resuscitation_qa_reviews_source_check
    CHECK (template_source IN ('nl5_content_studio', 'operator_supplied', 'unavailable')),
  -- FAIL CLOSED: no approved template content → the review cannot progress.
  CONSTRAINT resuscitation_qa_reviews_content_gate_check
    CHECK (
      review_status = 'template_unavailable'
      OR (template_source <> 'unavailable' AND template_version IS NOT NULL)
    ),
  -- Sign-off requires a named reviewer and a signature timestamp.
  CONSTRAINT resuscitation_qa_reviews_signoff_gate_check
    CHECK (
      review_status <> 'signed_off'
      OR (reviewer_uid IS NOT NULL AND reviewer_signed_at IS NOT NULL)
    ),
  CONSTRAINT fk_resuscitation_qa_reviews_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

-- One QA/debrief review per event.
CREATE UNIQUE INDEX IF NOT EXISTS ux_resuscitation_qa_reviews_event
  ON resuscitation_qa_reviews (tenant_id, resuscitation_event_id);

CREATE INDEX IF NOT EXISTS idx_resuscitation_qa_reviews_status
  ON resuscitation_qa_reviews (tenant_id, review_status, created_at DESC);

ALTER TABLE resuscitation_qa_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE resuscitation_qa_reviews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON resuscitation_qa_reviews;
CREATE POLICY tenant_isolation ON resuscitation_qa_reviews
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

COMMIT;
