-- Migration 119: Phase B3 — Payer / TPA / Tariff / Package master data.
--
-- HEALTHCARE_AI_SPEC_AUDIT.md §16 + top-10 gap #8: today the claims
-- module has rows but no master data. Setting up billing for a new
-- hospital is a 100% manual config task. clinical_ai_payer_contracts
-- exists for AI variance analysis only; it isn't a master record.
--
-- Tables:
--   1. payers              — insurer master (Star Health, ICICI Lombard,
--                              CGHS, Ayushman Bharat, etc.)
--   2. tpas                — TPA master (FHPL, Medi Assist, Vidal
--                              Health, etc.) optionally linked to a
--                              parent payer
--   3. tariff_plans        — named price list per (tenant, payer/TPA)
--                              with default + override tracks
--   4. tariff_items        — per-service price rows under a plan
--   5. packages            — bundled-procedure SKU (e.g. "knee
--                              replacement, 3-day stay")
--   6. package_items       — line items inside a package (room rent,
--                              implant, surgeon fee, OT charges)
--   7. payer_tariff_links  — many-to-many (payer/TPA, tariff_plan)
--                              with effective windows + status

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. payers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payers (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payer_code                  VARCHAR(80) NOT NULL,
  display_name                VARCHAR(255) NOT NULL,
  payer_kind                  VARCHAR(40) NOT NULL DEFAULT 'private_insurance'
    CHECK (payer_kind IN (
      'private_insurance', 'government_scheme', 'corporate', 'self_pay',
      'international_insurance', 'cash_advance', 'other'
    )),
  registration_number         VARCHAR(120),
  contact_email               VARCHAR(255),
  contact_phone               VARCHAR(40),
  address                     TEXT,
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  ehr_external_id             VARCHAR(120),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, payer_code)
);

CREATE INDEX IF NOT EXISTS idx_payers_tenant_kind
  ON payers (tenant_id, payer_kind, status);
CREATE INDEX IF NOT EXISTS idx_payers_tenant_status
  ON payers (tenant_id, status, display_name);

-- ---------------------------------------------------------------------------
-- 2. tpas
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tpas (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tpa_code                    VARCHAR(80) NOT NULL,
  display_name                VARCHAR(255) NOT NULL,
  parent_payer_id             INTEGER REFERENCES payers(id) ON DELETE SET NULL,
  irda_license_number         VARCHAR(120),
  contact_email               VARCHAR(255),
  contact_phone               VARCHAR(40),
  address                     TEXT,
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  ehr_external_id             VARCHAR(120),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, tpa_code)
);

CREATE INDEX IF NOT EXISTS idx_tpas_tenant_status
  ON tpas (tenant_id, status, display_name);
CREATE INDEX IF NOT EXISTS idx_tpas_payer
  ON tpas (parent_payer_id) WHERE parent_payer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. tariff_plans
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tariff_plans (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_code                   VARCHAR(80) NOT NULL,
  display_name                VARCHAR(255) NOT NULL,
  description                 TEXT,
  is_default                  BOOLEAN NOT NULL DEFAULT false,
  currency                    VARCHAR(8) NOT NULL DEFAULT 'INR',
  effective_from              DATE,
  effective_to                DATE,
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, plan_code),
  CONSTRAINT chk_tariff_window CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tariff_plan_default
  ON tariff_plans (tenant_id) WHERE is_default = true AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_tariff_plans_tenant_status
  ON tariff_plans (tenant_id, status, effective_from DESC);

-- ---------------------------------------------------------------------------
-- 4. tariff_items
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tariff_items (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tariff_plan_id              INTEGER NOT NULL REFERENCES tariff_plans(id) ON DELETE CASCADE,
  service_code                VARCHAR(120) NOT NULL,
  service_kind                VARCHAR(40) NOT NULL DEFAULT 'service'
    CHECK (service_kind IN (
      'service', 'consultation', 'procedure', 'investigation', 'medication',
      'consumable', 'room', 'package', 'discount', 'other'
    )),
  display_name                VARCHAR(255) NOT NULL,
  unit_price_minor            BIGINT NOT NULL,
  unit_label                  VARCHAR(40) NOT NULL DEFAULT 'each',
  taxable                     BOOLEAN NOT NULL DEFAULT false,
  tax_rate_pct                NUMERIC(5,2),
  effective_from              DATE,
  effective_to                DATE,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tariff_plan_id, service_code),
  CONSTRAINT chk_tariff_item_window CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_tariff_items_tenant_plan
  ON tariff_items (tenant_id, tariff_plan_id, service_kind);
CREATE INDEX IF NOT EXISTS idx_tariff_items_service_code
  ON tariff_items (tenant_id, service_code);

-- ---------------------------------------------------------------------------
-- 5. packages
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS packages (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  package_code                VARCHAR(120) NOT NULL,
  display_name                VARCHAR(255) NOT NULL,
  description                 TEXT,
  base_specialty              VARCHAR(120),
  base_procedure_code         VARCHAR(120),
  duration_days               INTEGER,
  fixed_price_minor           BIGINT,
  currency                    VARCHAR(8) NOT NULL DEFAULT 'INR',
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  exclusion_notes             TEXT,
  inclusion_notes             TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, package_code)
);

CREATE INDEX IF NOT EXISTS idx_packages_tenant_status
  ON packages (tenant_id, status, display_name);
CREATE INDEX IF NOT EXISTS idx_packages_specialty
  ON packages (tenant_id, base_specialty)
  WHERE base_specialty IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. package_items
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS package_items (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  package_id                  INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  service_code                VARCHAR(120) NOT NULL,
  service_kind                VARCHAR(40) NOT NULL DEFAULT 'service'
    CHECK (service_kind IN (
      'service', 'consultation', 'procedure', 'investigation', 'medication',
      'consumable', 'room', 'package', 'discount', 'other'
    )),
  display_name                VARCHAR(255) NOT NULL,
  quantity                    NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price_minor            BIGINT,
  is_included                 BOOLEAN NOT NULL DEFAULT true,
  notes                       TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_package_items_tenant_package
  ON package_items (tenant_id, package_id);
CREATE INDEX IF NOT EXISTS idx_package_items_service_code
  ON package_items (tenant_id, service_code);

-- ---------------------------------------------------------------------------
-- 7. payer_tariff_links
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payer_tariff_links (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payer_id                    INTEGER REFERENCES payers(id) ON DELETE CASCADE,
  tpa_id                      INTEGER REFERENCES tpas(id) ON DELETE CASCADE,
  tariff_plan_id              INTEGER NOT NULL REFERENCES tariff_plans(id) ON DELETE CASCADE,
  is_primary                  BOOLEAN NOT NULL DEFAULT false,
  effective_from              DATE,
  effective_to                DATE,
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_payer_tariff_subject CHECK (
    (payer_id IS NOT NULL) OR (tpa_id IS NOT NULL)
  ),
  CONSTRAINT chk_payer_tariff_window CHECK (
    effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from
  )
);

CREATE INDEX IF NOT EXISTS idx_payer_tariff_links_tenant_status
  ON payer_tariff_links (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_payer_tariff_links_payer
  ON payer_tariff_links (tenant_id, payer_id, status)
  WHERE payer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payer_tariff_links_tpa
  ON payer_tariff_links (tenant_id, tpa_id, status)
  WHERE tpa_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payer_tariff_links_plan
  ON payer_tariff_links (tariff_plan_id);

COMMIT;
