-- 285_scheduling_optimization.sql
--
-- Roadmap Pillar D / item D2 (docs/EPIC_LEVEL_ROADMAP.md) — Cadence-class
-- scheduling. Slots were generated on the fly from doctors.available_days
-- JSON; nothing modelled recurring templates, leaves, waitlists or
-- bookable rooms/equipment, and the existing AI no-show predictions fed
-- nothing.
--
--   * provider_availability_templates — recurring weekly availability with
--     slot sizing + effective windows.
--   * provider_leaves — approved leave auto-blocks slot generation.
--   * appointment_waitlist — patients waiting for a doctor/date window;
--     the auto-fill sweep offers freed capacity oldest-first.
--   * bookable_resources / resource_bookings — rooms + equipment as
--     first-class bookable things (service-level overlap guard).

BEGIN;

CREATE TABLE IF NOT EXISTS provider_availability_templates (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  doctor_id     INTEGER NOT NULL,
  weekday       SMALLINT NOT NULL,
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  slot_minutes  INTEGER NOT NULL DEFAULT 15,
  location      VARCHAR(120),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to  DATE,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_provider_availability_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_provider_availability_weekday CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT chk_provider_availability_window CHECK (end_time > start_time),
  CONSTRAINT chk_provider_availability_slot CHECK (slot_minutes BETWEEN 5 AND 120)
);

CREATE INDEX IF NOT EXISTS idx_provider_availability_doctor
  ON provider_availability_templates (doctor_id, weekday) WHERE is_active;

CREATE TABLE IF NOT EXISTS provider_leaves (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  doctor_id   INTEGER NOT NULL,
  starts_on   DATE NOT NULL,
  ends_on     DATE NOT NULL,
  reason      VARCHAR(200),
  approved_by UUID,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_provider_leaves_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_provider_leaves_window CHECK (ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS idx_provider_leaves_doctor
  ON provider_leaves (doctor_id, starts_on, ends_on);

CREATE TABLE IF NOT EXISTS appointment_waitlist (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  patient_uid   UUID NOT NULL,
  doctor_id     INTEGER NOT NULL,
  preferred_date DATE,
  preferred_window VARCHAR(10) NOT NULL DEFAULT 'any',
  priority      INTEGER NOT NULL DEFAULT 5,
  status        VARCHAR(20) NOT NULL DEFAULT 'waiting',
  notes         VARCHAR(300),
  offered_slot  JSONB,
  offered_at    TIMESTAMPTZ(6),
  resolved_at   TIMESTAMPTZ(6),
  created_by    UUID,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_appointment_waitlist_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_appointment_waitlist_window
    CHECK (preferred_window IN ('any', 'am', 'pm')),
  CONSTRAINT chk_appointment_waitlist_status
    CHECK (status IN ('waiting', 'offered', 'booked', 'expired', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_appointment_waitlist_doctor
  ON appointment_waitlist (doctor_id, status, priority, created_at)
  WHERE status IN ('waiting', 'offered');

CREATE TABLE IF NOT EXISTS bookable_resources (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  kind       VARCHAR(20) NOT NULL,
  name       VARCHAR(160) NOT NULL,
  location   VARCHAR(160),
  is_active  BOOLEAN NOT NULL DEFAULT true,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_bookable_resources_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_bookable_resources_kind CHECK (kind IN ('room', 'equipment')),
  CONSTRAINT uq_bookable_resources_name UNIQUE (tenant_id, kind, name)
);

CREATE TABLE IF NOT EXISTS resource_bookings (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  resource_id   INTEGER NOT NULL REFERENCES bookable_resources(id) ON DELETE CASCADE,
  starts_at     TIMESTAMPTZ(6) NOT NULL,
  ends_at       TIMESTAMPTZ(6) NOT NULL,
  booked_for_type VARCHAR(30) NOT NULL DEFAULT 'other',
  booked_for_id VARCHAR(60),
  patient_uid   UUID,
  booked_by     UUID,
  status        VARCHAR(20) NOT NULL DEFAULT 'booked',
  notes         VARCHAR(300),
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_resource_bookings_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_resource_bookings_window CHECK (ends_at > starts_at),
  CONSTRAINT chk_resource_bookings_status CHECK (status IN ('booked', 'cancelled')),
  CONSTRAINT chk_resource_bookings_for
    CHECK (booked_for_type IN ('appointment', 'ot_schedule', 'admission', 'other'))
);

CREATE INDEX IF NOT EXISTS idx_resource_bookings_resource_time
  ON resource_bookings (resource_id, starts_at, ends_at) WHERE status = 'booked';

-- Tenant isolation on the PHI-bearing tables (waitlist + bookings carry
-- patient linkage).
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['appointment_waitlist', 'resource_bookings'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
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
SELECT 'SCHEDULING_OPTIMIZATION_APPLIED', 'provider_availability_templates', 'provider_availability_templates',
  jsonb_build_object('migration', '285_scheduling_optimization.sql', 'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#D2',
    'reason', 'Provider availability templates, leave auto-blocking, waitlist auto-fill, bookable rooms/equipment, no-show-fed overbooking.'),
  NOW()
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'audit_logs')
  AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE action = 'SCHEDULING_OPTIMIZATION_APPLIED');

COMMIT;
