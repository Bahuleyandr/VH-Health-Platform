-- NL-8 P3: per-tenant porter / patient-transport configuration.
-- Role, zone, roster, and SLA defaults are explicit tenant settings so the
-- operator board can enable and tune transport without using global flags.

CREATE TABLE IF NOT EXISTS porter_transport_settings (
  tenant_id              UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled                BOOLEAN NOT NULL DEFAULT FALSE,
  roster_department      VARCHAR(80) NOT NULL DEFAULT 'ambulance',
  roster_target_type     VARCHAR(80) NOT NULL DEFAULT 'porter_transport_zone',
  recipient_role_codes   TEXT[] NOT NULL DEFAULT ARRAY[
    'DRIVER',
    'AMBULANCE_DRIVER',
    'DELIVERY_STAFF',
    'EMERGENCY_RESPONDER',
    'AMBULANCE_COORDINATOR'
  ]::text[],
  escalation_role_codes  TEXT[] NOT NULL DEFAULT ARRAY[
    'RECEPTION_INCHARGE',
    'IP_INCHARGE',
    'MEDICAL_SUPERINTENDENT'
  ]::text[],
  source_sla_minutes     JSONB NOT NULL DEFAULT '{
    "appointment_checkin": 15,
    "admission": 20,
    "discharge": 20,
    "imaging": 20,
    "lab": 20,
    "bed_transfer": 15,
    "transfer": 15,
    "sample": 20,
    "equipment": 45,
    "manual": 30
  }'::jsonb,
  source_priority        JSONB NOT NULL DEFAULT '{
    "appointment_checkin": "normal",
    "admission": "high",
    "discharge": "high",
    "imaging": "normal",
    "lab": "normal",
    "bed_transfer": "high",
    "transfer": "high",
    "sample": "normal",
    "equipment": "normal",
    "manual": "normal"
  }'::jsonb,
  enabled_at             TIMESTAMPTZ(6),
  enabled_by             UUID,
  updated_by             UUID,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT porter_transport_settings_roles_check
    CHECK (cardinality(recipient_role_codes) > 0),
  CONSTRAINT porter_transport_settings_sla_object_check
    CHECK (jsonb_typeof(source_sla_minutes) = 'object'),
  CONSTRAINT porter_transport_settings_priority_object_check
    CHECK (jsonb_typeof(source_priority) = 'object')
);

CREATE TABLE IF NOT EXISTS porter_transport_zones (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  zone_key    VARCHAR(120) NOT NULL,
  zone_name   VARCHAR(160) NOT NULL,
  zone_type   VARCHAR(40) NOT NULL DEFAULT 'other',
  building    VARCHAR(120),
  floor       VARCHAR(80),
  role_codes  TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_porter_transport_zones_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT porter_transport_zones_key_check
    CHECK (zone_key = lower(zone_key) AND zone_key ~ '^[a-z0-9][a-z0-9_-]{0,119}$'),
  CONSTRAINT porter_transport_zones_type_check
    CHECK (zone_type IN ('ward', 'diagnostics', 'lab', 'imaging', 'front_desk', 'equipment', 'command_center', 'other'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_porter_transport_zones_tenant_key
  ON porter_transport_zones (tenant_id, zone_key);

CREATE INDEX IF NOT EXISTS idx_porter_transport_zones_active
  ON porter_transport_zones (tenant_id, is_active, zone_type, sort_order);

CREATE TABLE IF NOT EXISTS porter_transport_zone_assignments (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  zone_id          BIGINT NOT NULL REFERENCES porter_transport_zones(id) ON DELETE CASCADE,
  staff_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  staff_uid        UUID REFERENCES users(uid) ON DELETE SET NULL,
  assignment_kind  VARCHAR(30) NOT NULL DEFAULT 'manual',
  status           VARCHAR(20) NOT NULL DEFAULT 'active',
  effective_from   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  effective_to     TIMESTAMPTZ(6),
  assigned_by      UUID REFERENCES users(uid) ON DELETE SET NULL,
  notes            TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_porter_transport_zone_assignments_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT porter_transport_zone_assignments_kind_check
    CHECK (assignment_kind IN ('manual', 'temporary', 'roster_projection')),
  CONSTRAINT porter_transport_zone_assignments_status_check
    CHECK (status IN ('active', 'ended', 'cancelled')),
  CONSTRAINT porter_transport_zone_assignments_staff_check
    CHECK (staff_id IS NOT NULL OR staff_uid IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_porter_transport_zone_assignments_zone
  ON porter_transport_zone_assignments (tenant_id, zone_id, status, effective_to);

CREATE INDEX IF NOT EXISTS idx_porter_transport_zone_assignments_staff
  ON porter_transport_zone_assignments (tenant_id, staff_id, status, effective_to)
  WHERE staff_id IS NOT NULL;

ALTER TABLE porter_transport_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE porter_transport_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON porter_transport_settings;
CREATE POLICY tenant_isolation ON porter_transport_settings
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

ALTER TABLE porter_transport_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE porter_transport_zones FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON porter_transport_zones;
CREATE POLICY tenant_isolation ON porter_transport_zones
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

ALTER TABLE porter_transport_zone_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE porter_transport_zone_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON porter_transport_zone_assignments;
CREATE POLICY tenant_isolation ON porter_transport_zone_assignments
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
