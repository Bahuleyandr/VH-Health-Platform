-- Clinical AI decision memory.
--
-- Captures the supervision signal from human review of AI drafts so that
-- subsequent generations on the same patient or the same module+context
-- shape can be primed with what reviewers previously accepted, edited, or
-- rejected. This is the cross-run memory analog of the per-ticker decision
-- log in TauricResearch/TradingAgents — adapted for healthcare:
--
--   * Tenant-scoped (one tenant cannot see another tenant's lessons).
--   * Cross-patient retrieval is restricted to module-level lessons, never
--     identifying narrative — services strip PHI before storing the lesson
--     text. Same-patient retrieval can carry richer context.
--   * Authoritative source of decisions remains clinical_ai_reviews; this
--     table is a denormalized projection optimised for retrieval and
--     discoverability. It does not replace the review record.
--
-- Insert path: decisionMemoryService.recordDecision() is called from
-- clinicalAiWorkflowService.updateReview() after a final decision is set.
-- Read path: decisionMemoryService.retrieveRelevantDecisions() is called
-- from clinicalAiWorkflowService.generateAdmissionAiDraft() before the LLM
-- call, and the retrieved entries are added to the chart packet under the
-- key prior_decisions.

CREATE TABLE IF NOT EXISTS clinical_ai_decision_memory (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  module_key VARCHAR(80) NOT NULL,
  patient_uid UUID,
  admission_id INTEGER,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  review_id INTEGER REFERENCES clinical_ai_reviews(id) ON DELETE SET NULL,

  -- One of: accepted, rejected, edited, needs_revision, deferred. Mirrors
  -- the canonical clinical_ai_reviews.decision enum-like field.
  decision VARCHAR(40) NOT NULL,

  -- Free-form short string ("80-200 chars") describing what was drafted.
  -- For PHI safety, services derive this from the draft's high-level shape
  -- (e.g. "discharge dx: COPD exacerbation; 5-line course; 3 follow-ups")
  -- rather than the raw narrative.
  draft_summary TEXT,

  -- For decision='edited': a short structured summary of what the reviewer
  -- changed, computed by buildEditDiffSummary(originalDraft, editedDraft).
  -- For decision='rejected': the rejection_reason text.
  -- For accepted: NULL.
  edit_diff_summary TEXT,
  rejection_reason TEXT,

  -- Optional distilled lesson, written by the AI safety reviewer or by an
  -- admin annotating the case. Free-form. Cross-patient retrieval prefers
  -- entries that have a non-null lesson so it pulls "advice" not "facts".
  lesson TEXT,

  -- The retrieval key. JSON object containing module-specific signature
  -- fields (e.g. for discharge_summary: { primary_dx, age_band, los_days,
  -- has_readmission_risk }). Designed so retrieval can do GIN containment
  -- queries (jsonb @>) for cross-patient lessons.
  context_signature JSONB NOT NULL DEFAULT '{}'::jsonb,

  reviewer_role VARCHAR(50),
  reviewer_uid UUID,

  -- Tracks whether this entry is safe to surface for cross-patient retrieval.
  -- When false, only same-patient retrieval will consider it (it may carry
  -- residual PHI in lesson/edit_diff_summary that has not been scrubbed).
  -- Default true; services can flip it false at insert time when in doubt.
  cross_patient_safe BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_decision_memory_tenant_module_patient
  ON clinical_ai_decision_memory (tenant_id, module_key, patient_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_decision_memory_tenant_module_xpatient
  ON clinical_ai_decision_memory (tenant_id, module_key, created_at DESC)
  WHERE cross_patient_safe = true;

-- GIN index for context_signature retrieval. Used for the cross-patient
-- "lessons that match this context shape" query. Same-patient retrieval
-- doesn't need this — it filters by patient_uid which the b-tree above
-- already covers.
CREATE INDEX IF NOT EXISTS idx_clinical_ai_decision_memory_signature_gin
  ON clinical_ai_decision_memory USING GIN (context_signature);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_decision_memory_review
  ON clinical_ai_decision_memory (review_id);

-- Tenant RLS: same pattern as the rest of the clinical_ai_* tables (see
-- migration 075_tenant_rls_policies.sql). Permissive when the GUC is unset
-- so non-tenant code paths (CI seeds, test fixtures) keep working; strict
-- when setTenant() has been called for a request.
ALTER TABLE clinical_ai_decision_memory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clinical_ai_decision_memory_tenant_isolation ON clinical_ai_decision_memory;
CREATE POLICY clinical_ai_decision_memory_tenant_isolation
  ON clinical_ai_decision_memory
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

COMMENT ON TABLE clinical_ai_decision_memory IS
  'Per-decision projection of clinical_ai_reviews used to retrieve prior reviewer behaviour into new AI drafts. Populated by decisionMemoryService.recordDecision; consumed by retrieveRelevantDecisions.';
