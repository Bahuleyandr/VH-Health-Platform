-- Migration 121: Phase C1 — multi-facility under tenant + Location / Room
-- + ServiceCatalog.
--
-- HEALTHCARE_AI_SPEC_AUDIT.md §2 + top-10 gap #5: today a tenant ≈ a
-- hospital. Real chains (Apollo, Manipal, Fortis) have multiple
-- facilities under one legal-entity tenant. Today the `hospitals`
-- table treats hospital and tenant as 1:1, and Wards live directly
-- under tenant — there is no Location / Room granularity below Ward.
--
-- This migration adds a four-level org tree under tenant:
--   tenant -> facility -> location -> room (-> bed via existing beds)
--
-- It is purely additive. The existing `hospitals` and `wards` rows are
-- untouched; a backfill helper in `facilityService` will seed one
-- default facility per tenant from `tenants.name` so existing FK
-- references keep working. New entities reference `facility_id` going
-- forward.
--
-- Tables:
--   1. facilities          — the actual brick-and-mortar location of a
--                              hospital (Apollo Bangalore Sheshadripuram,
--                              Apollo Bangalore Bannerghatta, etc.).
--                              One per tenant initially; multiples allowed.
--   2. facility_locations  — generic "place inside a facility": OPD,
--                              ICU, OT block, lab, pharmacy, basement
--                              parking. Hierarchical via parent_id so
--                              "ICU > Bay A" can be expressed.
--   3. facility_rooms      — rooms / cubicles / cabins under a location.
--                              Sits between Location and the existing
--                              `beds` table.
--   4. service_catalog     — first-class catalog of services a facility
--                              offers. Decouples "what we do" from
--                              "how we price" (tariff_items, B3) and
--                              "what specialty owns it" (departments).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. facilities
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS facilities (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_code               VARCHAR(80) NOT NULL,
  display_name                VARCHAR(255) NOT NULL,
  facility_kind               VARCHAR(40) NOT NULL DEFAULT 'hospital'
    CHECK (facility_kind IN (
      'hospital', 'clinic', 'diagnostic_center', 'pharmacy',
      'tele_hub', 'corporate_office', 'satellite_unit', 'other'
    )),
  legal_entity_name           VARCHAR(255),
  registration_number         VARCHAR(120),
  address_line1               VARCHAR(255),
  address_line2               VARCHAR(255),
  city                        VARCHAR(120),
  state                       VARCHAR(120),
  country                     VARCHAR(80) NOT NULL DEFAULT 'IN',
  postal_code                 VARCHAR(20),
  timezone                    VARCHAR(60) NOT NULL DEFAULT 'Asia/Kolkata',
  phone                       VARCHAR(40),
  email                       VARCHAR(255),
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  is_default                  BOOLEAN NOT NULL DEFAULT false,
  geo_lat                     NUMERIC(10, 6),
  geo_lng                     NUMERIC(10, 6),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, facility_code)
);

CREATE INDEX IF NOT EXISTS idx_facilities_tenant_status
  ON facilities (tenant_id, status, display_name);
CREATE INDEX IF NOT EXISTS idx_facilities_tenant_kind
  ON facilities (tenant_id, facility_kind, status);
-- Only one default facility per tenant (active or otherwise).
CREATE UNIQUE INDEX IF NOT EXISTS uq_facility_default
  ON facilities (tenant_id) WHERE is_default = true;

-- ---------------------------------------------------------------------------
-- 2. facility_locations (hierarchical)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS facility_locations (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id                 INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  parent_id                   INTEGER REFERENCES facility_locations(id) ON DELETE SET NULL,
  location_code               VARCHAR(120) NOT NULL,
  display_name                VARCHAR(255) NOT NULL,
  location_kind               VARCHAR(40) NOT NULL DEFAULT 'general'
    CHECK (location_kind IN (
      'general', 'opd', 'ipd', 'icu', 'hdu', 'er', 'ot_block',
      'lab', 'radiology', 'pharmacy', 'reception', 'admin',
      'pacu', 'ward', 'isolation', 'bay', 'cabin', 'corridor', 'other'
    )),
  floor                       VARCHAR(40),
  building                    VARCHAR(120),
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  capacity_hint               INTEGER,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (facility_id, location_code),
  CONSTRAINT chk_location_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_facility_locations_tenant_facility
  ON facility_locations (tenant_id, facility_id, status);
CREATE INDEX IF NOT EXISTS idx_facility_locations_kind
  ON facility_locations (tenant_id, location_kind, status);
CREATE INDEX IF NOT EXISTS idx_facility_locations_parent
  ON facility_locations (parent_id) WHERE parent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. facility_rooms
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS facility_rooms (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id                 INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  location_id                 INTEGER NOT NULL REFERENCES facility_locations(id) ON DELETE CASCADE,
  room_code                   VARCHAR(120) NOT NULL,
  display_name                VARCHAR(255) NOT NULL,
  room_kind                   VARCHAR(40) NOT NULL DEFAULT 'general'
    CHECK (room_kind IN (
      'general', 'private', 'semi_private', 'shared',
      'icu', 'isolation', 'ot', 'consulting', 'examination',
      'procedure', 'recovery', 'storage', 'other'
    )),
  bed_capacity                INTEGER,
  floor                       VARCHAR(40),
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'closed_for_cleaning', 'maintenance', 'archived')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (facility_id, room_code)
);

CREATE INDEX IF NOT EXISTS idx_facility_rooms_tenant_facility
  ON facility_rooms (tenant_id, facility_id, status);
CREATE INDEX IF NOT EXISTS idx_facility_rooms_location
  ON facility_rooms (location_id, status);
CREATE INDEX IF NOT EXISTS idx_facility_rooms_kind
  ON facility_rooms (tenant_id, room_kind, status);

-- ---------------------------------------------------------------------------
-- 4. service_catalog
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS service_catalog (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id                 INTEGER REFERENCES facilities(id) ON DELETE CASCADE,
  service_code                VARCHAR(120) NOT NULL,
  display_name                VARCHAR(255) NOT NULL,
  description                 TEXT,
  service_kind                VARCHAR(40) NOT NULL DEFAULT 'service'
    CHECK (service_kind IN (
      'consultation', 'procedure', 'investigation', 'imaging',
      'pharmacy_dispense', 'package', 'room', 'admission',
      'home_visit', 'teleconsult', 'service', 'other'
    )),
  specialty                   VARCHAR(120),
  department_id               INTEGER,
  default_duration_minutes    INTEGER,
  requires_appointment        BOOLEAN NOT NULL DEFAULT false,
  is_telehealth_eligible      BOOLEAN NOT NULL DEFAULT false,
  default_tariff_item_code    VARCHAR(120),
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, service_code)
);

CREATE INDEX IF NOT EXISTS idx_service_catalog_tenant_status
  ON service_catalog (tenant_id, status, service_kind);
CREATE INDEX IF NOT EXISTS idx_service_catalog_specialty
  ON service_catalog (tenant_id, specialty)
  WHERE specialty IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_catalog_facility
  ON service_catalog (tenant_id, facility_id, status)
  WHERE facility_id IS NOT NULL;

COMMIT;
