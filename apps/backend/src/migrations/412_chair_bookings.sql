-- 412_chair_bookings.sql
--
-- NL6-10: cycle-linked chair bookings for oncology day-care infusion.
-- Uses a database exclusion constraint so a live chair slot cannot be
-- double-booked under concurrent requests. Cancelled rows are excluded from
-- the constraint, so cancellation frees the slot.

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS chair_bookings (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  chair_id            INTEGER NOT NULL,
  cycle_id            INTEGER NOT NULL,
  patient_uid         UUID NOT NULL,
  start_at            TIMESTAMPTZ(6) NOT NULL,
  end_at              TIMESTAMPTZ(6) NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'booked',
  warning_codes       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  notes               TEXT,
  booked_by           UUID,
  cancelled_by        UUID,
  cancelled_at        TIMESTAMPTZ(6),
  cancellation_reason TEXT,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_chair_bookings_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_chair_bookings_chair
    FOREIGN KEY (chair_id) REFERENCES infusion_chairs(id) ON DELETE RESTRICT,
  CONSTRAINT fk_chair_bookings_cycle
    FOREIGN KEY (cycle_id) REFERENCES chemo_cycles(id) ON DELETE CASCADE,
  CONSTRAINT fk_chair_bookings_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE NO ACTION,
  CONSTRAINT chk_chair_bookings_status
    CHECK (status IN ('booked', 'checked_in', 'completed', 'cancelled', 'no_show')),
  CONSTRAINT chk_chair_bookings_window
    CHECK (end_at > start_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_chair_bookings_active_cycle
  ON chair_bookings (tenant_id, cycle_id)
  WHERE status IN ('booked', 'checked_in', 'completed');

CREATE INDEX IF NOT EXISTS idx_chair_bookings_board
  ON chair_bookings (tenant_id, start_at, status, chair_id);

CREATE INDEX IF NOT EXISTS idx_chair_bookings_patient_window
  ON chair_bookings (tenant_id, patient_uid, start_at, end_at)
  WHERE status <> 'cancelled';

ALTER TABLE chair_bookings
  ADD CONSTRAINT excl_chair_bookings_chair_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    chair_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  )
  WHERE (status <> 'cancelled');

ALTER TABLE chair_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE chair_bookings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON chair_bookings;
CREATE POLICY tenant_isolation ON chair_bookings
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
  'CHAIR_BOOKINGS_APPLIED',
  'chair_bookings',
  'chair_bookings',
  jsonb_build_object(
    'migration', '412_chair_bookings.sql',
    'program', 'NL6-10',
    'reason', 'Chemo cycle-linked infusion chair slots with DB-level no-overlap guard.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'CHAIR_BOOKINGS_APPLIED'
    AND resource = 'chair_bookings'
);

COMMIT;
