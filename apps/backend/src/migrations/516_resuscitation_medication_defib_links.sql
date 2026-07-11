-- NL-14 P2: resuscitation medication/MAR and defibrillator/device links.
--
-- MAR safety boundary (spec §3): resus medication rows REFERENCE MAR
-- administrations — they are never a parallel med-admin lane. The partial
-- unique index on mar_administration_id is the no-double-count backstop: one
-- MAR administration can be claimed by exactly ONE resus link, ever. The MAR
-- duplicate-dose guard itself stays mig 327 (uniq_mar_administered_dose);
-- nothing here writes medication_administrations.
--
-- Emergency doses pushed before a MAR order exists are documented as
-- link_kind 'unlinked_emergency' and carry a pending-reconciliation status the
-- post-event workflow must clear.
--
-- resuscitation_device_links carries defib/monitor/alert/vitals evidence
-- references (NL-7 stays the transport owner — mirrors mig 499's link-only
-- posture; targets may be deleted, so rows keep an evidence snapshot).

BEGIN;

CREATE TABLE IF NOT EXISTS resuscitation_medication_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  resuscitation_event_id BIGINT NOT NULL REFERENCES resuscitation_events(id) ON DELETE RESTRICT,
  timeline_entry_id BIGINT REFERENCES resuscitation_event_timeline(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  link_kind VARCHAR(30) NOT NULL,
  mar_administration_id INTEGER REFERENCES medication_administrations(id) ON DELETE SET NULL,
  medication_kind VARCHAR(30) NOT NULL DEFAULT 'medication',
  medication_name VARCHAR(255) NOT NULL,
  dose VARCHAR(100),
  route VARCHAR(50),
  reconciliation_status VARCHAR(40) NOT NULL DEFAULT 'not_required',
  recorded_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT resuscitation_med_links_kind_check
    CHECK (link_kind IN ('mar_administration', 'unlinked_emergency')),
  CONSTRAINT resuscitation_med_links_medication_kind_check
    CHECK (medication_kind IN ('medication', 'fluid', 'blood_product')),
  -- A MAR link must actually reference a MAR administration…
  CONSTRAINT resuscitation_med_links_mar_ref_check
    CHECK (link_kind <> 'mar_administration' OR mar_administration_id IS NOT NULL),
  -- …and an unlinked emergency dose must not claim one.
  CONSTRAINT resuscitation_med_links_unlinked_check
    CHECK (link_kind <> 'unlinked_emergency' OR mar_administration_id IS NULL),
  CONSTRAINT resuscitation_med_links_reconciliation_check
    CHECK (
      reconciliation_status IN ('not_required', 'pending_mar_reconciliation', 'reconciled')
    ),
  -- Unlinked emergency doses always enter the reconciliation workflow.
  CONSTRAINT resuscitation_med_links_unlinked_reconciliation_check
    CHECK (
      link_kind <> 'unlinked_emergency'
      OR reconciliation_status IN ('pending_mar_reconciliation', 'reconciled')
    ),
  CONSTRAINT fk_resuscitation_medication_links_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

-- No double-administration accounting: one MAR administration row can back at
-- most one resus medication link, across ALL events.
CREATE UNIQUE INDEX IF NOT EXISTS ux_resuscitation_med_links_mar
  ON resuscitation_medication_links (tenant_id, mar_administration_id)
  WHERE mar_administration_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_resuscitation_med_links_event
  ON resuscitation_medication_links (tenant_id, resuscitation_event_id, created_at);

CREATE INDEX IF NOT EXISTS idx_resuscitation_med_links_pending
  ON resuscitation_medication_links (tenant_id, reconciliation_status)
  WHERE reconciliation_status = 'pending_mar_reconciliation';

CREATE TABLE IF NOT EXISTS resuscitation_device_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  resuscitation_event_id BIGINT NOT NULL REFERENCES resuscitation_events(id) ON DELETE RESTRICT,
  timeline_entry_id BIGINT REFERENCES resuscitation_event_timeline(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  link_kind VARCHAR(40) NOT NULL,
  device_registry_id INTEGER REFERENCES device_registry(id) ON DELETE SET NULL,
  device_association_id INTEGER REFERENCES device_patient_associations(id) ON DELETE SET NULL,
  clinical_alert_id INTEGER REFERENCES clinical_alerts(id) ON DELETE SET NULL,
  vitals_chart_id INTEGER REFERENCES vitals_chart(id) ON DELETE SET NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  linked_by UUID,
  linked_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT resuscitation_device_links_kind_check
    CHECK (link_kind IN ('defibrillator', 'monitor', 'clinical_alert', 'vitals_chart')),
  -- Each kind requires its reference AT CREATION; SET NULL deletes may later
  -- orphan the pointer, in which case the evidence snapshot remains the record.
  CONSTRAINT resuscitation_device_links_target_check
    CHECK (
      num_nonnulls(device_registry_id, device_association_id, clinical_alert_id, vitals_chart_id) >= 1
      OR evidence <> '{}'::jsonb
    ),
  CONSTRAINT fk_resuscitation_device_links_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

-- A given clinical alert links into an event once.
CREATE UNIQUE INDEX IF NOT EXISTS ux_resuscitation_device_links_alert
  ON resuscitation_device_links (tenant_id, resuscitation_event_id, clinical_alert_id)
  WHERE clinical_alert_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_resuscitation_device_links_event
  ON resuscitation_device_links (tenant_id, resuscitation_event_id, linked_at);

ALTER TABLE resuscitation_medication_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE resuscitation_medication_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON resuscitation_medication_links;
CREATE POLICY tenant_isolation ON resuscitation_medication_links
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

ALTER TABLE resuscitation_device_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE resuscitation_device_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON resuscitation_device_links;
CREATE POLICY tenant_isolation ON resuscitation_device_links
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
