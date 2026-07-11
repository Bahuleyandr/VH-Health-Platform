-- NL-14 P3: NICU admission ↔ newborn substrate link.
--
-- Reuses the existing maternity/newborn substrate (maternity_newborns,
-- maternity_apgar_scores from mig 155; newborn_immunisations from mig 160)
-- instead of duplicating birth data onto the NICU chart. One link row binds a
-- NICU icu_admission to its maternity_newborns record; APGAR, resuscitation
-- type, breastfeeding initiation and newborn immunisations are then read live
-- through the link. APGAR remains birth-context only — NICU acuity scores are
-- modelled separately in nicu_picu_scoring_outputs (mig 531).
--
-- Device-observation linking note (the "device links" slot of the spec §4.5
-- estimate): NICU/PICU admissions are icu_admissions rows, so admission-level
-- device evidence REUSES the P1 icu_device_observation_links table (mig 499)
-- unchanged, and row-level evidence lives on each NICU detail table's
-- device_registry_id / sample_observation_id columns (migs 529/530/532/533).
-- Creating a parallel NICU device-links table would fork the P1 substrate.

BEGIN;

CREATE TABLE IF NOT EXISTS nicu_admission_newborn_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  icu_admission_id INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  newborn_id INTEGER NOT NULL REFERENCES maternity_newborns(id) ON DELETE NO ACTION,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  linked_by UUID,
  linked_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  unlinked_at TIMESTAMPTZ(6),
  unlinked_by UUID,
  unlink_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_nicu_newborn_link_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

-- One ACTIVE newborn link per NICU admission (historic unlinked rows retained).
CREATE UNIQUE INDEX IF NOT EXISTS ux_nicu_newborn_link_active
  ON nicu_admission_newborn_links (tenant_id, icu_admission_id)
  WHERE unlinked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_nicu_newborn_link_newborn
  ON nicu_admission_newborn_links (tenant_id, newborn_id);

ALTER TABLE nicu_admission_newborn_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE nicu_admission_newborn_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nicu_admission_newborn_links;
CREATE POLICY tenant_isolation ON nicu_admission_newborn_links
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
