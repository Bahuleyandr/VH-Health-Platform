-- NL9-P3: teleconsult follow-up loops, steps, and closure audit.
--
-- Follow-up rows are tenant-scoped PHI records keyed to approved completion
-- facts. Patient outreach is represented as a gated step; staff work reuses
-- the existing generic tasks table.

BEGIN;

CREATE TABLE IF NOT EXISTS engagement_follow_up_loops (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  source_type VARCHAR(40) NOT NULL
    CHECK (source_type IN ('teleconsultation', 'appointment', 'rpm_enrollment', 'feedback_task')),
  source_ref VARCHAR(120) NOT NULL,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL,
  owner_uid UUID,
  loop_type VARCHAR(60) NOT NULL
    CHECK (loop_type IN (
      'clinician_follow_up_due_date',
      'investigation_ordered',
      'prescription_created',
      'secure_message_fallback',
      'teleconsult_completed'
    )),
  status VARCHAR(30) NOT NULL DEFAULT 'open'
    CHECK (status IN (
      'open', 'scheduled', 'waiting_patient', 'staff_review',
      'completed', 'cancelled', 'suppressed'
    )),
  consent_type VARCHAR(80) NOT NULL DEFAULT 'teleconsult_followup',
  due_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  due_at TIMESTAMPTZ,
  safe_link_path VARCHAR(160) NOT NULL DEFAULT '/appointments',
  close_reason VARCHAR(120),
  closed_at TIMESTAMPTZ,
  closed_by UUID,
  created_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT engagement_follow_up_loops_due_policy_object
    CHECK (jsonb_typeof(due_policy) = 'object'),
  CONSTRAINT engagement_follow_up_loops_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT engagement_follow_up_loops_safe_link_path
    CHECK (safe_link_path LIKE '/%')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_follow_up_loop_open_source
  ON engagement_follow_up_loops (tenant_id, source_type, source_ref, loop_type)
  WHERE status IN ('open', 'scheduled', 'waiting_patient', 'staff_review');

CREATE INDEX IF NOT EXISTS idx_follow_up_loops_tenant_due
  ON engagement_follow_up_loops (tenant_id, status, due_at)
  WHERE due_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_follow_up_loops_patient
  ON engagement_follow_up_loops (tenant_id, patient_uid, status, due_at DESC);

CREATE INDEX IF NOT EXISTS idx_follow_up_loops_owner
  ON engagement_follow_up_loops (tenant_id, owner_uid, status, due_at)
  WHERE owner_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS engagement_follow_up_steps (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  loop_id BIGINT NOT NULL REFERENCES engagement_follow_up_loops(id) ON DELETE CASCADE,
  step_kind VARCHAR(40) NOT NULL
    CHECK (step_kind IN ('patient_outreach', 'staff_task', 'secure_message_fallback', 'closure_audit')),
  status VARCHAR(30) NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'queued', 'suppressed', 'completed', 'cancelled', 'failed')),
  scheduled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  template_key VARCHAR(120),
  campaign_recipient_id BIGINT,
  outbox_id INTEGER,
  staff_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  suppression_reason VARCHAR(120),
  safe_link_path VARCHAR(160),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT engagement_follow_up_steps_result_object
    CHECK (jsonb_typeof(result) = 'object'),
  CONSTRAINT engagement_follow_up_steps_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT engagement_follow_up_steps_safe_link_path
    CHECK (safe_link_path IS NULL OR safe_link_path LIKE '/%')
);

CREATE INDEX IF NOT EXISTS idx_follow_up_steps_loop
  ON engagement_follow_up_steps (loop_id, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_follow_up_steps_task
  ON engagement_follow_up_steps (tenant_id, staff_task_id)
  WHERE staff_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_follow_up_steps_due
  ON engagement_follow_up_steps (tenant_id, status, scheduled_at)
  WHERE scheduled_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS engagement_follow_up_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  loop_id BIGINT NOT NULL REFERENCES engagement_follow_up_loops(id) ON DELETE CASCADE,
  event_kind VARCHAR(40) NOT NULL
    CHECK (event_kind IN (
      'created', 'step_scheduled', 'step_suppressed',
      'task_created', 'status_changed', 'closed'
    )),
  previous_status VARCHAR(30),
  next_status VARCHAR(30),
  actor_uid UUID,
  reason VARCHAR(160),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT engagement_follow_up_events_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_follow_up_events_loop
  ON engagement_follow_up_events (loop_id, created_at);

CREATE INDEX IF NOT EXISTS idx_follow_up_events_tenant_kind
  ON engagement_follow_up_events (tenant_id, event_kind, created_at DESC);

ALTER TABLE engagement_follow_up_loops ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_follow_up_loops FORCE ROW LEVEL SECURITY;
ALTER TABLE engagement_follow_up_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_follow_up_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE engagement_follow_up_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_follow_up_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON engagement_follow_up_loops;
CREATE POLICY tenant_isolation ON engagement_follow_up_loops
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

DROP POLICY IF EXISTS tenant_isolation ON engagement_follow_up_steps;
CREATE POLICY tenant_isolation ON engagement_follow_up_steps
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

DROP POLICY IF EXISTS tenant_isolation ON engagement_follow_up_events;
CREATE POLICY tenant_isolation ON engagement_follow_up_events
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
