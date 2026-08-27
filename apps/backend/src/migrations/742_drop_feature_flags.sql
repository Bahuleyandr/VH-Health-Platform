-- Migration 742: retire the inert global feature-flag subsystem (audit
-- disposition 2026-08-27; decision recorded in docs/ROADMAP.md "Feature-flag
-- console + feature_flags table — decision: RETIRE, do not wire").
--
-- `feature_flags` (migration 148) had migrations, CRUD routes and an admin
-- console, but ZERO runtime consumers: featureFlagService.js#isEnabled() had
-- no call sites, WIRED_FEATURE_FLAGS was frozen empty, and no migration ever
-- seeded a row — every flip was a silent no-op. The table was also the wrong
-- shape for the product (no tenant column, process-wide cache); migrations 351
-- and 429 each rejected it by name when they needed a real per-tenant switch.
-- The service dir, routes/admin/featureFlagRoutes.js, featureFlagValidator and
-- the /dashboard/feature-flags console are deleted in the same change set, so
-- nothing references the table at this migration's tip.
--
-- No inbound foreign key from a live table references feature_flags and it
-- feeds no view (it predates the FK-heavy eras and migration 336 lists it
-- among the global-by-design, unscoped tables — no RLS policy was ever added
-- over it). DROP TABLE removes its own indexes (feature_flags_name_key,
-- idx_feature_flags_enabled), its pkey, and the OWNED sequence
-- feature_flags_id_seq with it; the belt-and-braces DROP SEQUENCE below covers
-- a hand-restored copy whose sequence lost its ownership link.
--
-- The entitlement catalog row 'admin.feature_flags' (migration 433) gated
-- exactly one thing — the /api/v1/admin/feature-flags mount being removed —
-- so the packaging catalog retires the key with the console. The delete
-- cascades to product_package_features (ON DELETE CASCADE); the tenant-side
-- ledger in migration 434 references product_features ON DELETE SET NULL, so
-- historical tenant audit rows survive with a nulled key.

DROP TABLE IF EXISTS feature_flags;
DROP SEQUENCE IF EXISTS feature_flags_id_seq;

DELETE FROM product_features WHERE feature_key = 'admin.feature_flags';

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
VALUES (
  'ENTITLEMENT_CATALOG_APPLIED',
  'product_features',
  'retire_admin_feature_flags',
  jsonb_build_object(
    'migration', '742_drop_feature_flags.sql',
    'retired_feature_key', 'admin.feature_flags',
    'dropped_table', 'feature_flags',
    'reason', 'inert subsystem retired per docs/ROADMAP.md'
  ),
  NOW()
);
