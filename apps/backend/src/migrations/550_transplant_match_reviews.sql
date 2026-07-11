-- NL-13 P6: transplant match reviews.

CREATE TABLE IF NOT EXISTS transplant_match_reviews (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  candidate_id BIGINT NOT NULL,
  donor_referral_id BIGINT NOT NULL,
  compatibility_summary TEXT NOT NULL,
  crossmatch_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
  chain_of_custody JSONB NOT NULL DEFAULT '{}'::jsonb,
  risk_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  decision VARCHAR(30) NOT NULL DEFAULT 'pending',
  decision_reason TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  timeline_event_id UUID,
  audit_event_id UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT transplant_match_reviews_decision_check
    CHECK (decision IN ('pending', 'accepted', 'declined', 'deferred')),
  CONSTRAINT transplant_match_reviews_docs_check
    CHECK (jsonb_typeof(crossmatch_documents) = 'array'),
  CONSTRAINT fk_transplant_match_reviews_candidate
    FOREIGN KEY (candidate_id) REFERENCES transplant_candidates(id) ON DELETE CASCADE,
  CONSTRAINT fk_transplant_match_reviews_donor
    FOREIGN KEY (donor_referral_id) REFERENCES transplant_donor_referrals(id) ON DELETE RESTRICT,
  CONSTRAINT fk_transplant_match_reviews_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_transplant_match_reviews_candidate
  ON transplant_match_reviews (tenant_id, candidate_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transplant_match_reviews_donor
  ON transplant_match_reviews (tenant_id, donor_referral_id, decision);

ALTER TABLE transplant_match_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE transplant_match_reviews FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON transplant_match_reviews;
CREATE POLICY tenant_isolation ON transplant_match_reviews
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
