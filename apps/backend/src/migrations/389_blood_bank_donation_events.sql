-- NL-6 N6-2 BB-A: donor collection events with barcode evidence.

BEGIN;

CREATE TABLE IF NOT EXISTS donation_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  donor_id INTEGER NOT NULL,
  screening_id INTEGER,
  donation_code VARCHAR(60) NOT NULL,
  donation_barcode VARCHAR(80) NOT NULL,
  collection_kind VARCHAR(20) NOT NULL DEFAULT 'in_house',
  camp_name VARCHAR(160),
  camp_location TEXT,
  pre_vitals JSONB NOT NULL DEFAULT '{}'::jsonb,
  post_vitals JSONB NOT NULL DEFAULT '{}'::jsonb,
  volume_ml INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'collected',
  collected_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  collected_by UUID,
  barcode_printed_at TIMESTAMPTZ(6),
  barcode_scanned_at TIMESTAMPTZ(6),
  barcode_scan_match BOOLEAN,
  adverse_reaction BOOLEAN NOT NULL DEFAULT false,
  adverse_reaction_type VARCHAR(60),
  adverse_reaction_severity VARCHAR(20),
  adverse_reaction_notes TEXT,
  adverse_reaction_intervention TEXT,
  adverse_reaction_outcome TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_donation_events_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_donation_events_donor
    FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE CASCADE,
  CONSTRAINT fk_donation_events_screening
    FOREIGN KEY (screening_id) REFERENCES donor_screenings(id) ON DELETE SET NULL,
  CONSTRAINT ux_donation_events_code UNIQUE (tenant_id, donation_code),
  CONSTRAINT ux_donation_events_barcode UNIQUE (tenant_id, donation_barcode),
  CONSTRAINT chk_donation_events_kind
    CHECK (collection_kind IN ('in_house', 'camp')),
  CONSTRAINT chk_donation_events_status
    CHECK (status IN ('collected', 'cancelled', 'discarded')),
  CONSTRAINT chk_donation_events_volume
    CHECK (volume_ml BETWEEN 100 AND 650),
  CONSTRAINT chk_donation_events_reaction_severity
    CHECK (adverse_reaction_severity IS NULL OR adverse_reaction_severity IN ('mild', 'moderate', 'severe', 'life_threatening'))
);

CREATE INDEX IF NOT EXISTS idx_donation_events_donor_time
  ON donation_events (tenant_id, donor_id, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_donation_events_collection
  ON donation_events (tenant_id, collection_kind, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_donation_events_reactions
  ON donation_events (tenant_id, adverse_reaction, collected_at DESC)
  WHERE adverse_reaction = true;

ALTER TABLE donation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE donation_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON donation_events;
CREATE POLICY tenant_isolation ON donation_events
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
