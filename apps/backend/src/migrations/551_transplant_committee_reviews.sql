-- NL-13 P6: transplant committee reviews.

CREATE TABLE IF NOT EXISTS transplant_committee_reviews (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  program_id BIGINT NOT NULL,
  candidate_id BIGINT,
  review_date DATE NOT NULL DEFAULT CURRENT_DATE,
  attendees JSONB NOT NULL DEFAULT '[]'::jsonb,
  quorum_policy_reference TEXT NOT NULL,
  decision VARCHAR(30) NOT NULL DEFAULT 'pending',
  recommendations TEXT,
  deferral_reason TEXT,
  affects_candidate BOOLEAN NOT NULL DEFAULT TRUE,
  timeline_event_id UUID,
  audit_event_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT transplant_committee_reviews_decision_check
    CHECK (decision IN ('pending', 'approved', 'deferred', 'declined', 'listed', 'removed')),
  CONSTRAINT transplant_committee_reviews_attendees_check
    CHECK (jsonb_typeof(attendees) = 'array'),
  CONSTRAINT fk_transplant_committee_reviews_program
    FOREIGN KEY (program_id) REFERENCES transplant_programs(id) ON DELETE RESTRICT,
  CONSTRAINT fk_transplant_committee_reviews_candidate
    FOREIGN KEY (candidate_id) REFERENCES transplant_candidates(id) ON DELETE CASCADE,
  CONSTRAINT fk_transplant_committee_reviews_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_transplant_committee_reviews_candidate
  ON transplant_committee_reviews (tenant_id, candidate_id, review_date DESC)
  WHERE candidate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transplant_committee_reviews_program
  ON transplant_committee_reviews (tenant_id, program_id, review_date DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_transplant_waitlist_committee_review'
  ) THEN
    ALTER TABLE transplant_waitlist_status_history
      ADD CONSTRAINT fk_transplant_waitlist_committee_review
      FOREIGN KEY (committee_review_id) REFERENCES transplant_committee_reviews(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE transplant_committee_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE transplant_committee_reviews FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON transplant_committee_reviews;
CREATE POLICY tenant_isolation ON transplant_committee_reviews
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
