-- N6-1: structured report persistence and radiology peer review.
-- The existing radiology_orders.report text column remains the compatibility
-- report consumed by portals, PDFs, and dashboards.

ALTER TABLE radiology_orders
  ADD COLUMN IF NOT EXISTS template_id BIGINT,
  ADD COLUMN IF NOT EXISTS structured_report JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_radiology_orders_template'
  ) THEN
    ALTER TABLE radiology_orders
      ADD CONSTRAINT fk_radiology_orders_template
      FOREIGN KEY (template_id) REFERENCES radiology_report_templates(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_radiology_orders_template
  ON radiology_orders (tenant_id, template_id)
  WHERE template_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS radiology_peer_review_settings (
  tenant_id UUID PRIMARY KEY DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  sampling_rate NUMERIC(5,4) NOT NULL DEFAULT 0.0200,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_radiology_peer_review_settings_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT radiology_peer_review_settings_rate
    CHECK (sampling_rate >= 0 AND sampling_rate <= 1)
);

CREATE TABLE IF NOT EXISTS radiology_peer_reviews (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  radiology_order_id INTEGER NOT NULL,
  reviewer_uid UUID NOT NULL,
  report_author_uid UUID NOT NULL,
  discrepancy_score INTEGER NOT NULL,
  outcome VARCHAR(40) NOT NULL DEFAULT 'no_change',
  comments TEXT,
  addendum_recommendation TEXT,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_radiology_peer_reviews_order
    FOREIGN KEY (radiology_order_id) REFERENCES radiology_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_radiology_peer_reviews_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT radiology_peer_reviews_distinct_human
    CHECK (reviewer_uid <> report_author_uid),
  CONSTRAINT radiology_peer_reviews_score
    CHECK (discrepancy_score BETWEEN 1 AND 4),
  CONSTRAINT radiology_peer_reviews_outcome
    CHECK (outcome IN ('no_change', 'minor_addendum', 'major_addendum', 'learning_case', 'quality_discussion'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_radiology_peer_reviews_reviewer
  ON radiology_peer_reviews (tenant_id, radiology_order_id, reviewer_uid);

CREATE INDEX IF NOT EXISTS idx_radiology_peer_reviews_order
  ON radiology_peer_reviews (tenant_id, radiology_order_id, reviewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_radiology_peer_reviews_reviewer
  ON radiology_peer_reviews (tenant_id, reviewer_uid, reviewed_at DESC);

ALTER TABLE radiology_peer_review_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE radiology_peer_review_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE radiology_peer_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE radiology_peer_reviews FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON radiology_peer_review_settings;
CREATE POLICY tenant_isolation ON radiology_peer_review_settings
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

DROP POLICY IF EXISTS tenant_isolation ON radiology_peer_reviews;
CREATE POLICY tenant_isolation ON radiology_peer_reviews
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

INSERT INTO radiology_peer_review_settings (tenant_id, sampling_rate, metadata)
VALUES (
  '00000000-0000-4000-8000-000000000001'::uuid,
  0.0200,
  '{"default_reason":"N6-1 owner default: 2 percent of signed reports"}'::jsonb
)
ON CONFLICT (tenant_id) DO NOTHING;
