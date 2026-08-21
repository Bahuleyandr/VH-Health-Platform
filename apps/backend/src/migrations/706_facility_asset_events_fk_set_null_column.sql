-- 706_facility_asset_events_fk_set_null_column.sql
--
-- Fix the 704 audit-survival FK: a composite FOREIGN KEY (tenant_id,
-- asset_id) ... ON DELETE SET NULL nulls EVERY referencing column, including
-- tenant_id — which is NOT NULL — so hard-deleting a facility_assets row that
-- has history failed with 23502 instead of orphaning the events with their
-- snapshots (the exact survival behaviour 704's header promises; surfaced by
-- facility-assets.deep.test.js).
--
-- PostgreSQL 15+ supports a column list on SET NULL: only asset_id is
-- nulled, tenant_id stays, and the event row keeps its tenant scoping plus
-- the asset_tag/asset_name snapshots (686/689 audit-survival idiom, now
-- actually reachable).

BEGIN;

ALTER TABLE facility_asset_events
  DROP CONSTRAINT IF EXISTS fk_facility_asset_events_asset;

ALTER TABLE facility_asset_events
  ADD CONSTRAINT fk_facility_asset_events_asset
  FOREIGN KEY (tenant_id, asset_id)
  REFERENCES facility_assets (tenant_id, id)
  ON DELETE SET NULL (asset_id);

COMMENT ON CONSTRAINT fk_facility_asset_events_asset ON facility_asset_events IS
  'Tenant-safe asset linkage. ON DELETE SET NULL (asset_id) — column-targeted so tenant_id (NOT NULL) survives a hard delete and the history row remains tenant-scoped with its snapshots.';

COMMIT;
