-- 704_facility_asset_register.sql
--
-- Remainder feature R-1 — general facility (non-biomedical) asset register.
--
-- Gap: the platform tracks BIOMEDICAL devices only (clinical_ai_biomed_devices,
-- migration 053, + the CMMS layer in 394-396: schedules, work orders,
-- calibration certificates). General facility assets — furniture, HVAC,
-- electrical/plumbing plant, IT equipment, generators, vehicles, kitchen and
-- laundry machinery — have no register at all: no ownership, no location
-- history, no condemnation/disposal evidence. A hospital cannot answer
-- "where is generator G-02, who holds it, and when was it last serviced".
--
-- Deliberately DISJOINT from the biomed CMMS: a facility asset is general
-- equipment/furniture/infrastructure. The `category` CHECK excludes
-- biomedical device classes — ventilators, monitors, imaging etc. stay in
-- clinical_ai_biomed_devices and their 394-396 CMMS workflow. This register
-- is operational master data, not clinical: mutations write ordinary audit
-- rows, never clinical_timeline_events (root CLAUDE.md invariant covers
-- patient-facing clinical writes only — there is no patient linkage here).
--
-- 1. `facility_assets` — tenant-scoped master. UNIQUE (tenant_id, asset_tag)
--    is the physical label identity. Status machine (service-guarded; the DB
--    pins the terminal evidence):
--      active ⇄ under_repair → condemned → disposed
--      active → condemned → disposed
--    `disposed` is terminal and requires disposal evidence (reason/at/by) —
--    two-directional CHECK so evidence can never exist on a live asset.
--    Soft lifecycle only: rows are never hard-deleted once events reference
--    them (events FK is SET NULL + snapshots, so history survives even a
--    hard delete by an operator).
--
-- 2. `facility_asset_events` — append-only history (write-once by
--    convention, like ambulance_position_events 683 / biomed_work_order_updates
--    395): one row per status/location/custodian/condition transition and
--    per maintenance/disposal action, written in the SAME transaction as the
--    master-row mutation. Asset FK follows the 686/689 audit-survival idiom:
--    ON DELETE SET NULL + asset_tag/name snapshot columns, so the trail
--    outlives the asset row.
--
-- RLS follows the 680/683 request-path pattern: permissive tenant_isolation
-- + FORCE; the service always writes tenant_id explicitly from request
-- context (dev/QA/CI run with the GUC unset — explicit predicates required).

BEGIN;

-- id is SERIAL (int4), not BIGSERIAL: register list queries project the raw
-- column and Prisma maps int8 to JS BigInt, which JSON.stringify rejects
-- (680 precedent); an asset master will never approach 2^31 rows.
CREATE TABLE IF NOT EXISTS facility_assets (
  id                   SERIAL PRIMARY KEY,
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Physical label identity (barcode/QR/engraved tag).
  asset_tag            VARCHAR(64) NOT NULL
    CONSTRAINT chk_facility_asset_tag CHECK (NULLIF(BTRIM(asset_tag), '') IS NOT NULL),
  name                 VARCHAR(200) NOT NULL
    CONSTRAINT chk_facility_asset_name CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
  -- General (non-biomedical) classes only — biomedical devices stay in
  -- clinical_ai_biomed_devices + the 394-396 CMMS.
  category             VARCHAR(30) NOT NULL
    CONSTRAINT chk_facility_asset_category
      CHECK (category IN (
        'furniture', 'hvac', 'electrical', 'plumbing', 'it_equipment',
        'generator', 'vehicle', 'kitchen', 'laundry', 'safety',
        'infrastructure', 'other'
      )),
  description          TEXT,
  -- Location is free text (the referral-facilities 680 choice): departments
  -- are tenant-seeded lookup rows, but assets also live in corridors, plant
  -- rooms and compounds that no department row names.
  location_department  VARCHAR(120),
  location_room        VARCHAR(120),
  -- Current custodian (staff uid); every reassignment logs an event row.
  custodian_uid        UUID,
  vendor               VARCHAR(160),
  purchase_date        DATE,
  purchase_cost        NUMERIC(12, 2)
    CONSTRAINT chk_facility_asset_cost
      CHECK (purchase_cost IS NULL OR purchase_cost >= 0),
  warranty_until       DATE,
  condition            VARCHAR(10) NOT NULL DEFAULT 'good'
    CONSTRAINT chk_facility_asset_condition
      CHECK (condition IN ('good', 'fair', 'poor')),
  status               VARCHAR(20) NOT NULL DEFAULT 'active'
    CONSTRAINT chk_facility_asset_status
      CHECK (status IN ('active', 'under_repair', 'condemned', 'disposed')),
  -- Optimistic-concurrency token for full-form master edits. Status changes
  -- also advance it so an edit opened before a lifecycle transition is stale.
  version              INTEGER NOT NULL DEFAULT 1
    CONSTRAINT chk_facility_asset_version CHECK (version > 0),
  -- Disposal evidence — required by, and exclusive to, the terminal state.
  disposal_reason      VARCHAR(500),
  disposed_at          TIMESTAMPTZ,
  disposed_by          UUID,
  created_by           UUID,
  updated_by           UUID,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Composite-tenant FK target (fk_referrals_appointment / 680 idiom).
  CONSTRAINT ux_facility_assets_tenant_id UNIQUE (tenant_id, id),
  -- A custodian may only be a real user in the asset's own tenant. The
  -- column-targeted action preserves tenant_id when that user is deleted.
  CONSTRAINT fk_facility_assets_custodian
    FOREIGN KEY (tenant_id, custodian_uid)
    REFERENCES users (tenant_id, uid) ON DELETE SET NULL (custodian_uid),
  -- disposed ⇒ full evidence; not-disposed ⇒ no evidence (state machine pin).
  CONSTRAINT chk_facility_asset_disposal_evidence
    CHECK (
      (status = 'disposed'
        AND disposal_reason IS NOT NULL
        AND disposed_at IS NOT NULL
        AND disposed_by IS NOT NULL)
      OR
      (status <> 'disposed'
        AND disposal_reason IS NULL
        AND disposed_at IS NULL
        AND disposed_by IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_facility_assets_tenant_tag
  ON facility_assets (tenant_id, asset_tag);
CREATE INDEX IF NOT EXISTS idx_facility_assets_tenant_status_category
  ON facility_assets (tenant_id, status, category, name);
CREATE INDEX IF NOT EXISTS idx_facility_assets_tenant_custodian
  ON facility_assets (tenant_id, custodian_uid)
  WHERE custodian_uid IS NOT NULL;
-- Warranty-expiry report scan.
CREATE INDEX IF NOT EXISTS idx_facility_assets_tenant_warranty
  ON facility_assets (tenant_id, warranty_until)
  WHERE warranty_until IS NOT NULL AND status <> 'disposed';

-- Append-only history: one row per transition/action, written in the same
-- transaction as the facility_assets mutation. Never UPDATEd or DELETEd by
-- the service (write-once by convention, 683 idiom).
CREATE TABLE IF NOT EXISTS facility_asset_events (
  id                   BIGSERIAL PRIMARY KEY,
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 686/689 audit-survival idiom: nullable FK + snapshots below, so the
  -- history row outlives the asset row.
  asset_id             INTEGER,
  asset_tag_snapshot   VARCHAR(64) NOT NULL,
  asset_name_snapshot  VARCHAR(200) NOT NULL,
  event_type           VARCHAR(30) NOT NULL
    CONSTRAINT chk_facility_asset_event_type
      CHECK (event_type IN (
        'created', 'updated', 'moved', 'custodian_assigned',
        'condition_changed', 'status_changed',
        'repair_opened', 'repair_closed', 'maintenance',
        'condemned', 'disposed'
      )),
  -- Status transition evidence (NULL for non-status events).
  from_status          VARCHAR(20),
  to_status            VARCHAR(20),
  -- Event specifics: {from_location, to_location, from_custodian_uid,
  -- to_custodian_uid, from_condition, to_condition, cost, vendor, ...}.
  details              JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes                VARCHAR(1000),
  actor_uid            UUID,
  actor_role           VARCHAR(60),
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Tenant-safe FK: an event can only reference an asset of its own tenant.
  CONSTRAINT fk_facility_asset_events_asset
    FOREIGN KEY (tenant_id, asset_id)
    REFERENCES facility_assets (tenant_id, id) ON DELETE SET NULL,
  -- Status-machine events carry their transition.
  CONSTRAINT chk_facility_asset_event_transition
    CHECK (
      event_type NOT IN ('status_changed', 'repair_opened', 'repair_closed',
                         'condemned', 'disposed')
      OR to_status IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_facility_asset_events_asset
  ON facility_asset_events (tenant_id, asset_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_facility_asset_events_tenant_type
  ON facility_asset_events (tenant_id, event_type, occurred_at DESC);

ALTER TABLE facility_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON facility_assets;
CREATE POLICY tenant_isolation ON facility_assets
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

ALTER TABLE facility_asset_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_asset_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON facility_asset_events;
CREATE POLICY tenant_isolation ON facility_asset_events
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

COMMENT ON TABLE facility_assets IS
  'Tenant-scoped register of GENERAL (non-biomedical) facility assets — furniture, HVAC, electrical/plumbing plant, IT, generators, vehicles, kitchen/laundry, safety, infrastructure. Biomedical devices stay in clinical_ai_biomed_devices + the 394-396 CMMS. Status machine active ⇄ under_repair → condemned → disposed (disposed terminal, evidence-pinned). Operational master data: ordinary audit rows, no clinical timeline obligation.';
COMMENT ON COLUMN facility_assets.asset_tag IS
  'Physical label identity (barcode/QR/engraved). UNIQUE per tenant via ux_facility_assets_tenant_tag.';
COMMENT ON COLUMN facility_assets.status IS
  'active | under_repair | condemned | disposed. Transitions are service-guarded; chk_facility_asset_disposal_evidence pins disposed to its evidence in both directions.';
COMMENT ON TABLE facility_asset_events IS
  'Append-only facility-asset history: status/location/custodian/condition transitions and maintenance/disposal actions, written in the same transaction as the facility_assets mutation. FK is SET NULL + tag/name snapshots (686/689 audit-survival idiom) so the trail outlives the asset row.';
COMMENT ON COLUMN facility_asset_events.details IS
  'Event specifics (from/to location, from/to custodian uid, from/to condition, maintenance cost/vendor, ...). Shape owned by facilityAssetService.';

COMMIT;
