-- NL-14 P2: durable code-blue / resuscitation event header + per-tenant settings.
--
-- Code Blue stops being only a realtime alert. resuscitation_events is the
-- single durable source of truth for code-blue / rapid-response episodes; the
-- staff:code-blue WS channel stays NOTIFICATION-ONLY and at-most-once
-- (spec 2026-07-08-nl14-critical-care-emergency-design.md §4.3).
--
-- Location (ward/bed/reason) is captured as a SNAPSHOT at event time, never a
-- live pointer — the pre-existing live-only banner loses that context on
-- reconnect (2026-06-29-realtime-dashboards-clinical-alerts-design.md:25).
--
-- resuscitation_settings is the per-tenant fail-closed enable gate
-- (mig-351 composition_search_settings / mig-495 icu_chart_settings pattern):
-- the feature ships inert; unsupplied operator policy FAILS CLOSED.

BEGIN;

CREATE TABLE IF NOT EXISTS resuscitation_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  charting_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  trigger_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_source VARCHAR(80) NOT NULL DEFAULT 'unavailable',
  enabled_at TIMESTAMPTZ(6),
  enabled_by UUID,
  acceptance_snapshot JSONB,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT resuscitation_settings_policy_source_check
    CHECK (policy_source IN ('nl5_content_studio', 'operator_supplied', 'unavailable')),
  CONSTRAINT resuscitation_settings_enable_gate_check
    CHECK (
      enabled = FALSE
      OR (acceptance_snapshot IS NOT NULL AND enabled_at IS NOT NULL AND enabled_by IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS resuscitation_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  encounter_id UUID REFERENCES patient_encounters(id) ON DELETE SET NULL,
  admission_id INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
  emergency_visit_id INTEGER REFERENCES emergency_visits(id) ON DELETE SET NULL,
  event_kind VARCHAR(30) NOT NULL DEFAULT 'code_blue',
  trigger_source VARCHAR(30) NOT NULL,
  trigger_clinical_alert_id INTEGER REFERENCES clinical_alerts(id) ON DELETE SET NULL,
  trigger_vitals_chart_id INTEGER REFERENCES vitals_chart(id) ON DELETE SET NULL,
  triggered_by UUID,
  ward_snapshot VARCHAR(120),
  bed_snapshot VARCHAR(60),
  reason TEXT,
  is_drill BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ(6),
  outcome VARCHAR(30),
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  team_leader_uid UUID,
  team_leader_name VARCHAR(160),
  recorder_uid UUID,
  recorder_name VARCHAR(160),
  post_event_note_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  finalized_at TIMESTAMPTZ(6),
  finalized_by UUID,
  last_notified_at TIMESTAMPTZ(6),
  created_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT resuscitation_events_kind_check
    CHECK (event_kind IN ('code_blue', 'rapid_response')),
  CONSTRAINT resuscitation_events_trigger_source_check
    CHECK (trigger_source IN ('explicit_staff', 'critical_vital')),
  CONSTRAINT resuscitation_events_status_check
    CHECK (status IN ('active', 'ended', 'finalized', 'cancelled_misfire')),
  CONSTRAINT resuscitation_events_outcome_check
    CHECK (
      outcome IS NULL
      OR outcome IN ('rosc', 'death', 'transferred', 'stopped_futility', 'misfire')
    ),
  CONSTRAINT resuscitation_events_time_check
    CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- Ending an event requires the stop time and a documented outcome.
  CONSTRAINT resuscitation_events_ended_gate_check
    CHECK (
      status NOT IN ('ended', 'finalized')
      OR (ended_at IS NOT NULL AND outcome IS NOT NULL)
    ),
  -- Finalization is BLOCKED unless a team leader AND a recorder are on record
  -- (spec §4.3: "missing team leader/recorder blocks finalization").
  CONSTRAINT resuscitation_events_finalize_gate_check
    CHECK (
      status <> 'finalized'
      OR (
        team_leader_uid IS NOT NULL
        AND recorder_uid IS NOT NULL
        AND finalized_at IS NOT NULL
        AND finalized_by IS NOT NULL
      )
    ),
  CONSTRAINT fk_resuscitation_events_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_resuscitation_events_tenant_started
  ON resuscitation_events (tenant_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_resuscitation_events_patient
  ON resuscitation_events (tenant_id, patient_uid, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_resuscitation_events_active
  ON resuscitation_events (tenant_id, patient_uid)
  WHERE status = 'active';

-- One durable event per triggering clinical alert: the critical-vital fan-out
-- path is idempotent against alert re-processing.
CREATE UNIQUE INDEX IF NOT EXISTS ux_resuscitation_events_trigger_alert
  ON resuscitation_events (tenant_id, trigger_clinical_alert_id)
  WHERE trigger_clinical_alert_id IS NOT NULL;

ALTER TABLE resuscitation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE resuscitation_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON resuscitation_settings;
CREATE POLICY tenant_isolation ON resuscitation_settings
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

ALTER TABLE resuscitation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE resuscitation_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON resuscitation_events;
CREATE POLICY tenant_isolation ON resuscitation_events
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
