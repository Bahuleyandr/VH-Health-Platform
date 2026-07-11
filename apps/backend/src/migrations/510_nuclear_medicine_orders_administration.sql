-- NL-13 P4: nuclear-medicine orders + radioisotope administration records (integrate-only).
-- Coordination + order/administration STATUS with owner-supplied isotope/radiopharmaceutical
-- references, preparation instructions, and safety checklist/evidence slots. The product
-- INTEGRATES nuclear-medicine scanners / isotope inventory systems; it never controls
-- hardware, computes dosimetry, or drives delivery. Administered-activity values are
-- owner-supplied summary fields, never calculated here.

BEGIN;

CREATE TABLE IF NOT EXISTS nuclear_medicine_orders (
  id                            BIGSERIAL PRIMARY KEY,
  tenant_id                     UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid                   UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  encounter_id                  UUID REFERENCES patient_encounters(id) ON DELETE SET NULL,
  referral_id                   BIGINT REFERENCES radiation_oncology_referrals(id) ON DELETE SET NULL,
  appointment_id                INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  order_kind                    VARCHAR(30) NOT NULL DEFAULT 'diagnostic',
  study_type                    VARCHAR(160) NOT NULL,
  radiopharmaceutical_ref       VARCHAR(160),
  isotope_ref                   VARCHAR(120),
  external_order_system         VARCHAR(160),
  external_order_id             VARCHAR(160),
  preparation_instructions      TEXT,
  scheduled_at                  TIMESTAMPTZ(6),
  status                        VARCHAR(40) NOT NULL DEFAULT 'draft',
  image_study_instance_uid      VARCHAR(200),
  document_ref                  TEXT,
  document_storage_key          TEXT,
  canonical_timeline_event_id   UUID,
  ordered_by                    UUID,
  created_by                    UUID,
  updated_by                    UUID,
  created_at                    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata                      JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_nuclear_medicine_orders_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_nuclear_medicine_orders_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT chk_nuclear_medicine_orders_kind
    CHECK (order_kind IN ('diagnostic', 'therapy')),
  CONSTRAINT chk_nuclear_medicine_orders_status
    CHECK (status IN ('draft', 'ordered', 'scheduled', 'prepared', 'administered', 'completed', 'cancelled')),
  CONSTRAINT chk_nuclear_medicine_orders_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_nuclear_medicine_orders_patient
  ON nuclear_medicine_orders (tenant_id, patient_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_nuclear_medicine_orders_status
  ON nuclear_medicine_orders (tenant_id, status, scheduled_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_nuclear_medicine_orders_tenant_id
  ON nuclear_medicine_orders (tenant_id, id);

CREATE TABLE IF NOT EXISTS radioisotope_administration_records (
  id                            BIGSERIAL PRIMARY KEY,
  tenant_id                     UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  order_id                      BIGINT NOT NULL REFERENCES nuclear_medicine_orders(id) ON DELETE CASCADE,
  patient_uid                   UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  encounter_id                  UUID REFERENCES patient_encounters(id) ON DELETE SET NULL,
  radiopharmaceutical_ref       VARCHAR(160),
  administered_activity_summary VARCHAR(200),
  administered_activity_mbq     NUMERIC(12,3),
  route                         VARCHAR(80),
  administered_by               UUID,
  administered_at               TIMESTAMPTZ(6),
  safety_checklist              JSONB NOT NULL DEFAULT '{}'::jsonb,
  aerb_evidence_owner           VARCHAR(160),
  aerb_source_name              VARCHAR(160),
  aerb_source_version           VARCHAR(80),
  aerb_evidence_attachment_ref  TEXT,
  document_ref                  TEXT,
  document_storage_key          TEXT,
  canonical_timeline_event_id   UUID,
  created_by                    UUID,
  updated_by                    UUID,
  created_at                    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata                      JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_radioisotope_admin_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_radioisotope_admin_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT chk_radioisotope_admin_nonnegative
    CHECK (administered_activity_mbq IS NULL OR administered_activity_mbq >= 0),
  CONSTRAINT chk_radioisotope_admin_checklist_object
    CHECK (jsonb_typeof(safety_checklist) = 'object'),
  CONSTRAINT chk_radioisotope_admin_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_radioisotope_admin_order
  ON radioisotope_administration_records (tenant_id, order_id, administered_at DESC);

CREATE INDEX IF NOT EXISTS idx_radioisotope_admin_patient
  ON radioisotope_administration_records (tenant_id, patient_uid, administered_at DESC);

ALTER TABLE nuclear_medicine_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE nuclear_medicine_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE radioisotope_administration_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE radioisotope_administration_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON nuclear_medicine_orders;
CREATE POLICY tenant_isolation ON nuclear_medicine_orders
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

DROP POLICY IF EXISTS tenant_isolation ON radioisotope_administration_records;
CREATE POLICY tenant_isolation ON radioisotope_administration_records
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

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'NL13_P4_NUCLEAR_MEDICINE_ORDERS_ADMINISTRATION_APPLIED',
  'nuclear_medicine_orders',
  '510_nuclear_medicine_orders_administration.sql',
  jsonb_build_object(
    'migration', '510_nuclear_medicine_orders_administration.sql',
    'suite', 'NL-13 P4 nuclear medicine & radiotherapy coordination',
    'integrate_only', true,
    'owner_sourced', true
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'NL13_P4_NUCLEAR_MEDICINE_ORDERS_ADMINISTRATION_APPLIED'
    AND resource_id = '510_nuclear_medicine_orders_administration.sql'
);

COMMIT;
