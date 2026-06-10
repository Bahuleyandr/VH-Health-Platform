-- 290_oncology_foundations.sql
--
-- Roadmap Pillar D / item D1 (docs/EPIC_LEVEL_ROADMAP.md) — oncology/chemo
-- foundations. Greenfield: protocol templates, per-patient treatment plans,
-- cycle scheduling, BSA-based dosing (Mosteller), cumulative-dose tracking
-- with lifetime ceilings (anthracyclines), and two-person verification on
-- every chemo administration (mirrors the B5 transfusion bedside pattern).
--
-- Deliberate scope notes:
--   * Administration detail lives in chemo_administrations (own table) —
--     the pharmacy/MAR BCMA loop (B1) remains the dispensing path; chemo
--     adds the double-verification + cumulative-dose layer on top.
--   * Protocol content (AC, FOLFOX, ...) is owner/pilot-side data — the
--     tables ship empty; docs/EPIC_LEVEL_ROADMAP.md D1 says scope with the
--     pilot hospital. No starter set is seeded to avoid implying clinical
--     review that has not happened.

BEGIN;

CREATE TABLE IF NOT EXISTS chemo_protocols (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  code              VARCHAR(40) NOT NULL,
  name              VARCHAR(200) NOT NULL,
  indication        TEXT,
  cycle_length_days INTEGER NOT NULL,
  total_cycles      INTEGER NOT NULL DEFAULT 1,
  status            VARCHAR(12) NOT NULL DEFAULT 'draft',
  reference         TEXT,
  created_by        UUID,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_chemo_protocols_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_chemo_protocols_code UNIQUE (tenant_id, code),
  CONSTRAINT chk_chemo_protocols_status CHECK (status IN ('draft', 'active', 'retired')),
  CONSTRAINT chk_chemo_protocols_cycle_length CHECK (cycle_length_days BETWEEN 1 AND 56),
  CONSTRAINT chk_chemo_protocols_total_cycles CHECK (total_cycles BETWEEN 1 AND 24)
);

CREATE TABLE IF NOT EXISTS chemo_protocol_drugs (
  id                       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  protocol_id              INTEGER NOT NULL REFERENCES chemo_protocols(id) ON DELETE CASCADE,
  drug_name                VARCHAR(160) NOT NULL,
  dose_per_m2              NUMERIC(10, 3),
  fixed_dose               NUMERIC(10, 3),
  dose_unit                VARCHAR(20) NOT NULL DEFAULT 'mg',
  route                    VARCHAR(40) NOT NULL DEFAULT 'IV',
  days_of_cycle            INTEGER[] NOT NULL DEFAULT ARRAY[1],
  infusion_duration_min    INTEGER,
  is_vesicant              BOOLEAN NOT NULL DEFAULT false,
  max_lifetime_dose_per_m2 NUMERIC(10, 3),
  sequence                 INTEGER NOT NULL DEFAULT 1,
  notes                    TEXT,
  CONSTRAINT chk_chemo_protocol_drugs_dosing
    CHECK ((dose_per_m2 IS NOT NULL) <> (fixed_dose IS NOT NULL)),
  CONSTRAINT chk_chemo_protocol_drugs_positive
    CHECK (COALESCE(dose_per_m2, fixed_dose) > 0)
);

CREATE INDEX IF NOT EXISTS idx_chemo_protocol_drugs_protocol
  ON chemo_protocol_drugs (protocol_id, sequence);

CREATE TABLE IF NOT EXISTS chemo_treatment_plans (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  patient_uid     UUID NOT NULL,
  protocol_id     INTEGER NOT NULL REFERENCES chemo_protocols(id) ON DELETE RESTRICT,
  indication      TEXT,
  planned_cycles  INTEGER NOT NULL,
  current_cycle   INTEGER NOT NULL DEFAULT 0,
  status          VARCHAR(12) NOT NULL DEFAULT 'planned',
  consent_ref     VARCHAR(200),
  height_cm       NUMERIC(5, 1) NOT NULL,
  weight_kg       NUMERIC(5, 1) NOT NULL,
  bsa_m2          NUMERIC(4, 2) NOT NULL,
  bsa_method      VARCHAR(20) NOT NULL DEFAULT 'mosteller',
  start_date      DATE,
  stopped_reason  TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_chemo_treatment_plans_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_chemo_treatment_plans_status
    CHECK (status IN ('planned', 'active', 'on_hold', 'completed', 'stopped')),
  CONSTRAINT chk_chemo_treatment_plans_cycles CHECK (planned_cycles BETWEEN 1 AND 24),
  CONSTRAINT chk_chemo_treatment_plans_bsa CHECK (bsa_m2 BETWEEN 0.2 AND 3.5)
);

-- One live plan per patient × protocol.
CREATE UNIQUE INDEX IF NOT EXISTS uq_chemo_treatment_plans_live
  ON chemo_treatment_plans (patient_uid, protocol_id)
  WHERE status IN ('planned', 'active', 'on_hold');

CREATE INDEX IF NOT EXISTS idx_chemo_treatment_plans_patient
  ON chemo_treatment_plans (patient_uid, status);

CREATE TABLE IF NOT EXISTS chemo_cycles (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  plan_id        INTEGER NOT NULL REFERENCES chemo_treatment_plans(id) ON DELETE CASCADE,
  cycle_number   INTEGER NOT NULL,
  scheduled_date DATE NOT NULL,
  status         VARCHAR(12) NOT NULL DEFAULT 'scheduled',
  weight_kg      NUMERIC(5, 1) NOT NULL,
  bsa_m2         NUMERIC(4, 2) NOT NULL,
  delay_reason   TEXT,
  notes          TEXT,
  created_by     UUID,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_chemo_cycles_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_chemo_cycles_number UNIQUE (plan_id, cycle_number),
  CONSTRAINT chk_chemo_cycles_status
    CHECK (status IN ('scheduled', 'confirmed', 'administered', 'delayed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS chemo_administrations (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  cycle_id           INTEGER NOT NULL REFERENCES chemo_cycles(id) ON DELETE CASCADE,
  protocol_drug_id   INTEGER NOT NULL REFERENCES chemo_protocol_drugs(id) ON DELETE RESTRICT,
  drug_name          VARCHAR(160) NOT NULL,
  calculated_dose    NUMERIC(10, 2) NOT NULL,
  dose_reduction_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
  final_dose         NUMERIC(10, 2) NOT NULL,
  dose_unit          VARCHAR(20) NOT NULL DEFAULT 'mg',
  route              VARCHAR(40) NOT NULL DEFAULT 'IV',
  status             VARCHAR(16) NOT NULL DEFAULT 'pending',
  ceiling_override_reason TEXT,
  first_verified_by  UUID,
  first_verified_at  TIMESTAMPTZ(6),
  second_verified_by UUID,
  second_verified_at TIMESTAMPTZ(6),
  administered_by    UUID,
  administered_at    TIMESTAMPTZ(6),
  withheld_reason    TEXT,
  notes              TEXT,
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_chemo_administrations_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_chemo_administrations_status
    CHECK (status IN ('pending', 'first_verified', 'double_verified', 'administered', 'withheld')),
  CONSTRAINT chk_chemo_administrations_reduction
    CHECK (dose_reduction_pct BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_chemo_administrations_cycle
  ON chemo_administrations (cycle_id, status);

CREATE TABLE IF NOT EXISTS chemo_cumulative_doses (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id            UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  patient_uid          UUID NOT NULL,
  drug_name            VARCHAR(160) NOT NULL,
  total_dose           NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_dose_per_m2    NUMERIC(10, 2) NOT NULL DEFAULT 0,
  dose_unit            VARCHAR(20) NOT NULL DEFAULT 'mg',
  administration_count INTEGER NOT NULL DEFAULT 0,
  last_administered_at TIMESTAMPTZ(6),
  updated_at           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_chemo_cumulative_doses_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_chemo_cumulative_doses_drug UNIQUE (patient_uid, drug_name)
);

CREATE INDEX IF NOT EXISTS idx_chemo_cumulative_doses_patient
  ON chemo_cumulative_doses (patient_uid);

-- Tenant isolation (262/272 pattern) — plans/cycles/administrations/
-- cumulative doses are PHI; protocols are tenant-scoped templates.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['chemo_protocols', 'chemo_protocol_drugs', 'chemo_treatment_plans',
                         'chemo_cycles', 'chemo_administrations', 'chemo_cumulative_doses'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- chemo_protocol_drugs has no tenant_id (joins through its protocol);
    -- skip RLS there but keep it in the loop list for the audit trail.
    IF t = 'chemo_protocol_drugs' THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
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
        )
    $f$, t);
  END LOOP;
END
$$;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'ONCOLOGY_FOUNDATIONS_APPLIED',
  'chemo_protocols',
  'chemo_protocols',
  jsonb_build_object(
    'migration', '290_oncology_foundations.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#D1',
    'reason', 'Chemo protocol templates, treatment plans with Mosteller BSA, cycle scheduling, two-person administration verification, cumulative-dose ceilings (anthracyclines). Protocol content is pilot-side data.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'ONCOLOGY_FOUNDATIONS_APPLIED'
    AND resource = 'chemo_protocols'
);

COMMIT;
