-- NL-8 P3: porter / patient-transport task lifecycle.
-- These tables mirror the housekeeping request lifecycle shape but remain a
-- dedicated transport substrate; generic tasks is not the backing table.

CREATE SEQUENCE IF NOT EXISTS porter_transport_task_number_seq;

CREATE TABLE IF NOT EXISTS porter_transport_tasks (
  id                         BIGSERIAL PRIMARY KEY,
  tenant_id                  UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  task_number                VARCHAR(40) NOT NULL DEFAULT (
    'PTT-' || lpad(nextval('porter_transport_task_number_seq')::text, 8, '0')
  ),
  source_type                VARCHAR(40) NOT NULL,
  source_id                  VARCHAR(120),
  patient_uid                UUID,
  admission_id               INTEGER,
  appointment_id             INTEGER,
  pickup_zone_id             BIGINT REFERENCES porter_transport_zones(id) ON DELETE SET NULL,
  destination_zone_id        BIGINT REFERENCES porter_transport_zones(id) ON DELETE SET NULL,
  pickup_location_id         INTEGER,
  destination_location_id    INTEGER,
  pickup_location_text       VARCHAR(255),
  destination_location_text  VARCHAR(255),
  pickup_label               VARCHAR(240) NOT NULL,
  destination_label          VARCHAR(240) NOT NULL,
  priority                   VARCHAR(20) NOT NULL DEFAULT 'normal',
  mobility_flags             JSONB NOT NULL DEFAULT '{}'::jsonb,
  infection_flags            JSONB NOT NULL DEFAULT '{}'::jsonb,
  isolation_flags            JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by               UUID REFERENCES users(uid) ON DELETE SET NULL,
  requester_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  created_by                 UUID REFERENCES users(uid) ON DELETE SET NULL,
  updated_by                 UUID REFERENCES users(uid) ON DELETE SET NULL,
  assigned_porter_uid        UUID REFERENCES users(uid) ON DELETE SET NULL,
  assigned_porter_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at                TIMESTAMPTZ(6),
  accepted_by                UUID REFERENCES users(uid) ON DELETE SET NULL,
  accepted_at                TIMESTAMPTZ(6),
  picked_up_by               UUID REFERENCES users(uid) ON DELETE SET NULL,
  picked_up_at               TIMESTAMPTZ(6),
  completed_by               UUID REFERENCES users(uid) ON DELETE SET NULL,
  completed_at               TIMESTAMPTZ(6),
  cancelled_by               UUID REFERENCES users(uid) ON DELETE SET NULL,
  cancelled_at               TIMESTAMPTZ(6),
  verified_by                UUID REFERENCES users(uid) ON DELETE SET NULL,
  verifier_id                INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancellation_reason        TEXT,
  status                     VARCHAR(30) NOT NULL DEFAULT 'open',
  sla_rule_code              VARCHAR(100) NOT NULL DEFAULT 'porter_transport_general',
  sla_due_at                 TIMESTAMPTZ(6),
  sla_instance_id            UUID REFERENCES workflow_sla_instances(id) ON DELETE SET NULL,
  metadata                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_porter_transport_tasks_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_porter_transport_tasks_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE NO ACTION,
  CONSTRAINT fk_porter_transport_tasks_admission
    FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE SET NULL,
  CONSTRAINT fk_porter_transport_tasks_appointment
    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL,
  CONSTRAINT porter_transport_tasks_source_check
    CHECK (source_type IN (
      'appointment_checkin',
      'admission',
      'discharge',
      'imaging',
      'lab',
      'bed_transfer',
      'transfer',
      'sample',
      'equipment',
      'manual'
    )),
  CONSTRAINT porter_transport_tasks_priority_check
    CHECK (priority IN ('low', 'normal', 'high', 'urgent', 'critical')),
  CONSTRAINT porter_transport_tasks_status_check
    CHECK (status IN ('open', 'assigned', 'accepted', 'picked_up', 'completed', 'cancelled')),
  CONSTRAINT porter_transport_tasks_location_check
    CHECK (length(trim(pickup_label)) > 0 AND length(trim(destination_label)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_porter_transport_tasks_tenant_number
  ON porter_transport_tasks (tenant_id, task_number);

CREATE UNIQUE INDEX IF NOT EXISTS ux_porter_transport_tasks_active_source
  ON porter_transport_tasks (tenant_id, source_type, source_id)
  WHERE source_id IS NOT NULL
    AND status IN ('open', 'assigned', 'accepted', 'picked_up');

CREATE INDEX IF NOT EXISTS idx_porter_transport_tasks_board
  ON porter_transport_tasks (tenant_id, status, priority, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_porter_transport_tasks_patient
  ON porter_transport_tasks (tenant_id, patient_uid, created_at DESC)
  WHERE patient_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_porter_transport_tasks_sla
  ON porter_transport_tasks (tenant_id, status, sla_due_at)
  WHERE sla_due_at IS NOT NULL
    AND status IN ('open', 'assigned', 'accepted', 'picked_up');

CREATE TABLE IF NOT EXISTS porter_transport_task_recipients (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  task_id         BIGINT NOT NULL REFERENCES porter_transport_tasks(id) ON DELETE CASCADE,
  staff_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  staff_uid       UUID REFERENCES users(uid) ON DELETE SET NULL,
  recipient_kind  VARCHAR(30) NOT NULL DEFAULT 'assigned_staff',
  source          VARCHAR(60) NOT NULL DEFAULT 'manual',
  notified_at     TIMESTAMPTZ(6),
  accepted_at     TIMESTAMPTZ(6),
  declined_at     TIMESTAMPTZ(6),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_porter_transport_task_recipients_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT porter_transport_task_recipients_kind_check
    CHECK (recipient_kind IN ('assigned_staff', 'incharge', 'escalation', 'observer')),
  CONSTRAINT porter_transport_task_recipients_staff_check
    CHECK (staff_id IS NOT NULL OR staff_uid IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_porter_transport_task_recipients_staff
  ON porter_transport_task_recipients (tenant_id, task_id, staff_id)
  WHERE staff_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_porter_transport_task_recipients_task
  ON porter_transport_task_recipients (tenant_id, task_id, recipient_kind);

CREATE INDEX IF NOT EXISTS idx_porter_transport_task_recipients_staff
  ON porter_transport_task_recipients (tenant_id, staff_id, accepted_at DESC)
  WHERE staff_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS porter_transport_task_updates (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  task_id       BIGINT NOT NULL REFERENCES porter_transport_tasks(id) ON DELETE CASCADE,
  author_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_uid    UUID REFERENCES users(uid) ON DELETE SET NULL,
  author_role   VARCHAR(80),
  status_from   VARCHAR(30),
  status_to     VARCHAR(30),
  message       TEXT NOT NULL,
  location_text VARCHAR(240),
  is_internal   BOOLEAN NOT NULL DEFAULT FALSE,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_porter_transport_task_updates_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_porter_transport_task_updates_task
  ON porter_transport_task_updates (tenant_id, task_id, created_at DESC);

ALTER TABLE porter_transport_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE porter_transport_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON porter_transport_tasks;
CREATE POLICY tenant_isolation ON porter_transport_tasks
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

ALTER TABLE porter_transport_task_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE porter_transport_task_recipients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON porter_transport_task_recipients;
CREATE POLICY tenant_isolation ON porter_transport_task_recipients
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

ALTER TABLE porter_transport_task_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE porter_transport_task_updates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON porter_transport_task_updates;
CREATE POLICY tenant_isolation ON porter_transport_task_updates
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
