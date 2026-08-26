-- 737_birth_notifications.sql
--
-- Birth notification / birth-certificate register (G4, reaudit 2026-08-25).
--
-- Statutory symmetry with the death side (migration 167 death_records +
-- mccd_serial_counter). Under the Registration of Births and Deaths Act 1969
-- the hospital is a statutory *notifier* of every institutional birth to the
-- local Registrar (Civil Registration System). CRS **Form 1 (Birth Report)**
-- is the prescribed report; the 21-day window (Section 8/13) is the statutory
-- deadline for reporting a birth without a late-registration fee.
--
-- 1. `birth_notifications` — one register row per notifiable birth, sourced
--    from the maternity delivery + newborn records (migration 155
--    maternity_deliveries / maternity_newborns). Status walk mirrors the
--    death record:  draft → certified → notified_to_registrar → registered
--    or → cancelled (only from draft). A per-tenant Form-1 serial is issued
--    on the first `certified` transition (birth_serial_counter, below).
--
-- 2. `birth_notification_serial_counter` — per-tenant Form-1 serial counter,
--    identical shape to mccd_serial_counter (migration 167:106).
--
-- RLS follows the mis_report_schedules (migration 679) request-path
-- config/register-table pattern: permissive tenant_isolation, ENABLE + FORCE,
-- service writers supply tenant_id explicitly on every statement (dev/QA/CI
-- run with the GUC unset — the first OR branch keeps those environments open;
-- prod scopes on app_current_tenant_id_uuid()).

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- BIRTH NOTIFICATION (CRS Form 1)
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS birth_notifications (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Provenance — the maternity records this notification is derived from.
  -- newborn_id is the authoritative source; delivery_id/pregnancy_id are
  -- denormalised snapshots for register queries and print.
  newborn_id                  INTEGER REFERENCES maternity_newborns(id) ON DELETE SET NULL,
  delivery_id                 INTEGER REFERENCES maternity_deliveries(id) ON DELETE SET NULL,
  pregnancy_id                INTEGER REFERENCES maternity_pregnancies(id) ON DELETE SET NULL,

  -- Per-tenant CRS Form-1 serial, issued by the certifier on first certify.
  birth_serial                VARCHAR(40),

  -- ── Child (CRS Form 1 columns 1-6) ─────────────────────────────────
  child_name                  VARCHAR(160),          -- may be blank at notification (named later)
  sex                         VARCHAR(12) NOT NULL DEFAULT 'indeterminate'
    CHECK (sex IN ('male', 'female', 'intersex', 'indeterminate')),
  date_of_birth               DATE NOT NULL,
  time_of_birth               TIME NOT NULL,
  place_of_birth              VARCHAR(40) NOT NULL DEFAULT 'hospital'
    CHECK (place_of_birth IN ('hospital', 'home_transferred_in', 'in_transit', 'other')),
  ward_or_unit                VARCHAR(80),
  birth_weight_g              INTEGER CHECK (birth_weight_g IS NULL OR birth_weight_g BETWEEN 100 AND 9000),
  birth_order                 INTEGER NOT NULL DEFAULT 1,     -- 1,2,3 for multiples
  is_multiple_birth           BOOLEAN NOT NULL DEFAULT false,
  delivery_type               VARCHAR(30),            -- snapshot of maternity_deliveries.delivery_mode
  gestational_age_weeks       NUMERIC(4, 1),
  outcome                     VARCHAR(24) NOT NULL DEFAULT 'live'
    CHECK (outcome IN ('live', 'still_birth')),   -- still births are reported on Form 3, tracked here for the register

  -- ── Mother (CRS Form 1 columns 7-15) ───────────────────────────────
  mother_patient_uid          UUID NOT NULL,
  mother_name                 VARCHAR(160),
  mother_age_years            INTEGER CHECK (mother_age_years IS NULL OR mother_age_years BETWEEN 10 AND 70),
  mother_aadhaar_last4        VARCHAR(8),
  mother_education            VARCHAR(60),
  mother_occupation           VARCHAR(80),

  -- ── Father (CRS Form 1 columns 16-19) ──────────────────────────────
  father_name                 VARCHAR(160),
  father_aadhaar_last4        VARCHAR(8),
  father_education            VARCHAR(60),
  father_occupation           VARCHAR(80),

  -- ── Address (CRS Form 1 columns 20-24) ─────────────────────────────
  permanent_address           TEXT,
  address_at_birth            TEXT,
  informant_name              VARCHAR(160),
  informant_relation          VARCHAR(60),

  -- ── Certification (the medical officer who signs Form 1) ────────────
  certified_by                UUID,
  certified_by_name           VARCHAR(160),
  certifier_registration_no   VARCHAR(60),           -- MCI / state council
  certified_at                TIMESTAMPTZ,

  -- ── Registrar submission ───────────────────────────────────────────
  -- Statutory 21-day window: notification is due within 21 days of birth.
  -- reporting_due_date is a GENERATED column so overdue queries are trivial
  -- and the deadline can never drift from date_of_birth.
  -- date + integer adds days and stays DATE-typed (date + interval would yield
  -- a timestamp and mismatch this column's declared type).
  reporting_due_date          DATE GENERATED ALWAYS AS (date_of_birth + 21) STORED,
  notified_to_registrar_at    TIMESTAMPTZ,
  registrar_office            VARCHAR(160),
  registrar_acknowledgement_no VARCHAR(60),
  registration_no             VARCHAR(60),           -- birth certificate registration number issued by CRS
  registered_at               TIMESTAMPTZ,

  -- ── Workflow ────────────────────────────────────────────────────────
  status                      VARCHAR(24) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'certified', 'notified_to_registrar', 'registered', 'cancelled')),
  cancel_reason               TEXT,

  notes                       TEXT,

  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, birth_serial),
  -- One notification per newborn record (multiples have distinct newborn_id).
  CONSTRAINT ux_birth_notifications_newborn UNIQUE (tenant_id, newborn_id),
  -- A registrar submission needs the office it was sent to.
  CONSTRAINT chk_birth_notification_registrar CHECK (
    notified_to_registrar_at IS NULL OR registrar_office IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_birth_notifications_status
  ON birth_notifications(tenant_id, status, date_of_birth DESC);
CREATE INDEX IF NOT EXISTS idx_birth_notifications_mother
  ON birth_notifications(mother_patient_uid);
-- Overdue radar: notifications not yet submitted to the registrar, ordered by
-- the statutory deadline.
CREATE INDEX IF NOT EXISTS idx_birth_notifications_pending_registrar
  ON birth_notifications(tenant_id, reporting_due_date)
  WHERE notified_to_registrar_at IS NULL AND status <> 'cancelled';

ALTER TABLE birth_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE birth_notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON birth_notifications;
CREATE POLICY tenant_isolation ON birth_notifications
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

-- Per-tenant CRS Form-1 serial counter (mccd_serial_counter shape, 167:106).
CREATE TABLE IF NOT EXISTS birth_notification_serial_counter (
  tenant_id   UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  next_serial INTEGER NOT NULL DEFAULT 1
);

ALTER TABLE birth_notification_serial_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE birth_notification_serial_counter FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON birth_notification_serial_counter;
CREATE POLICY tenant_isolation ON birth_notification_serial_counter
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

COMMENT ON TABLE birth_notifications IS
  'CRS Form 1 birth-notification register — one row per institutional birth, sourced from maternity delivery/newborn records; 21-day statutory reporting window via generated reporting_due_date.';
COMMENT ON COLUMN birth_notifications.reporting_due_date IS
  'Generated: date_of_birth + 21 days — the statutory CRS reporting deadline (Registration of Births and Deaths Act 1969).';

COMMIT;
