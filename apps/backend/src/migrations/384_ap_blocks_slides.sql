-- N6-4: anatomic pathology blocks and slides.

CREATE TABLE IF NOT EXISTS ap_blocks (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  ap_case_id BIGINT NOT NULL,
  gross_record_id BIGINT,
  block_code VARCHAR(120) NOT NULL,
  sequence_no INTEGER NOT NULL,
  tissue_site VARCHAR(160),
  cassette_label VARCHAR(120),
  status VARCHAR(40) NOT NULL DEFAULT 'planned',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_ap_blocks_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_ap_blocks_case
    FOREIGN KEY (ap_case_id) REFERENCES ap_cases(id) ON DELETE CASCADE,
  CONSTRAINT fk_ap_blocks_gross_record
    FOREIGN KEY (gross_record_id) REFERENCES ap_gross_records(id) ON DELETE SET NULL,
  CONSTRAINT ap_blocks_sequence_check
    CHECK (sequence_no > 0),
  CONSTRAINT ap_blocks_status_check
    CHECK (status IN ('planned', 'processed', 'embedded', 'cut', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_blocks_code
  ON ap_blocks (tenant_id, block_code);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_blocks_case_sequence
  ON ap_blocks (tenant_id, ap_case_id, sequence_no);

CREATE INDEX IF NOT EXISTS idx_ap_blocks_case
  ON ap_blocks (tenant_id, ap_case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ap_slides (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  ap_case_id BIGINT NOT NULL,
  block_id BIGINT NOT NULL,
  slide_code VARCHAR(140) NOT NULL,
  barcode VARCHAR(160) NOT NULL,
  sequence_no INTEGER NOT NULL,
  stain_type VARCHAR(40) NOT NULL DEFAULT 'h_and_e',
  stain_name VARCHAR(120),
  status VARCHAR(40) NOT NULL DEFAULT 'planned',
  label_printed_at TIMESTAMPTZ,
  label_printed_by UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_ap_slides_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_ap_slides_case
    FOREIGN KEY (ap_case_id) REFERENCES ap_cases(id) ON DELETE CASCADE,
  CONSTRAINT fk_ap_slides_block
    FOREIGN KEY (block_id) REFERENCES ap_blocks(id) ON DELETE CASCADE,
  CONSTRAINT ap_slides_sequence_check
    CHECK (sequence_no > 0),
  CONSTRAINT ap_slides_stain_type_check
    CHECK (stain_type IN ('h_and_e', 'special', 'ihc', 'cytology')),
  CONSTRAINT ap_slides_status_check
    CHECK (status IN ('planned', 'cut', 'stained', 'review_ready', 'reported', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_slides_code
  ON ap_slides (tenant_id, slide_code);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_slides_barcode
  ON ap_slides (tenant_id, barcode);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_slides_block_sequence
  ON ap_slides (tenant_id, block_id, sequence_no);

CREATE INDEX IF NOT EXISTS idx_ap_slides_case
  ON ap_slides (tenant_id, ap_case_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ap_slides_block
  ON ap_slides (tenant_id, block_id, created_at DESC);

ALTER TABLE ap_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_blocks FORCE ROW LEVEL SECURITY;
ALTER TABLE ap_slides ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_slides FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ap_blocks;
CREATE POLICY tenant_isolation ON ap_blocks
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

DROP POLICY IF EXISTS tenant_isolation ON ap_slides;
CREATE POLICY tenant_isolation ON ap_slides
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
