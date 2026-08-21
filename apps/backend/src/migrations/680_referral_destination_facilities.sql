-- 680_referral_destination_facilities.sql
--
-- Feature wave 3 — structured destination facilities for external referrals.
--
-- Gap: `referrals.referral_type = 'external'` carried its destination only as
-- free text. There is no dedicated destination column: the receiving facility
-- was written into `referred_to_department` (TEXT, e.g. "Cardiology - Apollo
-- Chennai") and sometimes into reason/clinical_summary, and the closed-loop
-- "external_referral_coordination" task (referralClosedLoopService) carried no
-- destination at all — only `{referral_stage: 'external_coordination'}`. A
-- hospital cannot report "how many patients did we refer to facility X" from
-- prose.
--
-- 1. `referral_facilities` — tenant-scoped master of external destination
--    facilities (partner hospitals, clinics, diagnostic centres). Admin-managed
--    CRUD with an `active` soft-delete flag; deactivation blocks new linkage
--    but never orphans historical referrals (FK is RESTRICT, rows are kept).
--    Uniqueness is (tenant, lower(name), lower(city)) so "Apollo" in two
--    cities can coexist while an exact duplicate entry cannot.
--
-- 2. `referrals.destination_facility_id` — nullable structured linkage.
--    NULL for every internal referral and for legacy external rows (their
--    free text stays exactly where it lives today; no backfill is attempted —
--    prose is not reliably parseable into a master row). A CHECK keeps the
--    linkage external-only, and the composite-tenant FK (the
--    fk_referrals_appointment idiom) makes cross-tenant linkage impossible at
--    the DB level.
--
-- RLS follows the queue_display_* / mis_report_schedules request-path
-- config-table pattern: permissive tenant_isolation, service writers supply
-- tenant_id explicitly on every statement.

BEGIN;

-- id is SERIAL (int4), not BIGSERIAL: referral list queries project the raw
-- column and Prisma maps int8 to JS BigInt, which JSON.stringify rejects; a
-- facility master will never approach 2^31 rows.
CREATE TABLE IF NOT EXISTS referral_facilities (
  id             SERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           VARCHAR(200) NOT NULL,
  facility_type  VARCHAR(20) NOT NULL DEFAULT 'hospital'
    CHECK (facility_type IN ('hospital', 'clinic', 'diagnostic', 'specialty_center', 'other')),
  specialties    TEXT[] NOT NULL DEFAULT '{}'::text[],
  address_line1  VARCHAR(300),
  address_line2  VARCHAR(300),
  city           VARCHAR(120),
  state          VARCHAR(120),
  pincode        VARCHAR(10),
  phone          VARCHAR(20),
  email          VARCHAR(320),
  contact_person VARCHAR(120),
  notes          TEXT,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_by     UUID,
  updated_by     UUID,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_referral_facilities_name CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
  CONSTRAINT chk_referral_facilities_pincode CHECK (pincode IS NULL OR pincode ~ '^[0-9]{6}$'),
  -- Composite-tenant FK target (fk_referrals_appointment idiom).
  CONSTRAINT ux_referral_facilities_tenant_id UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_referral_facilities_tenant_name_city
  ON referral_facilities (tenant_id, LOWER(name), LOWER(COALESCE(city, '')));
CREATE INDEX IF NOT EXISTS idx_referral_facilities_tenant_active
  ON referral_facilities (tenant_id, active, name);

ALTER TABLE referral_facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_facilities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON referral_facilities;
CREATE POLICY tenant_isolation ON referral_facilities
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

ALTER TABLE referrals
  ADD COLUMN IF NOT EXISTS destination_facility_id INTEGER;

-- Tenant-safe FK: a referral can only link a facility of its own tenant.
-- RESTRICT so a facility with referral history cannot be hard-deleted
-- (deactivate via `active = FALSE` instead).
ALTER TABLE referrals
  ADD CONSTRAINT fk_referrals_destination_facility
  FOREIGN KEY (tenant_id, destination_facility_id)
  REFERENCES referral_facilities (tenant_id, id) ON DELETE RESTRICT;

-- Structured destination is an external-referral concept only. Legacy rows
-- (all NULL) satisfy this trivially.
ALTER TABLE referrals
  ADD CONSTRAINT chk_referrals_destination_external
  CHECK (destination_facility_id IS NULL OR referral_type = 'external');

CREATE INDEX IF NOT EXISTS idx_referrals_tenant_destination_facility
  ON referrals (tenant_id, destination_facility_id)
  WHERE destination_facility_id IS NOT NULL;

COMMENT ON TABLE referral_facilities IS
  'Tenant-scoped master of external referral destination facilities (partner hospitals, clinics, diagnostic centres). Soft-deleted via active=FALSE; rows with referral history are never hard-deleted.';
COMMENT ON COLUMN referral_facilities.specialties IS
  'Free-form specialty tags (e.g. cardiology, nephrology) used for admin filtering of the facility master.';
COMMENT ON COLUMN referrals.destination_facility_id IS
  'Structured destination for external referrals (referral_facilities). NULL for internal referrals and for legacy external rows whose destination exists only as free text in referred_to_department / reason.';

COMMIT;
