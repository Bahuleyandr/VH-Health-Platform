-- 724_system_settings.sql
--
-- Create the system_settings key/value store that the admin settings surface
-- (GET/PUT /api/v1/system/settings, systemController.js) has queried since the
-- admin-portal era but that no migration ever created. Until now every
-- settings request errored server-side with
--   ERROR: relation "system_settings" does not exist
-- (visible in the smoke-DB Postgres logs on Aug 13 and Aug 20), the
-- controller swallowed the failure, and PUTs fell back to a per-process
-- in-memory object — admin edits silently vanished on every pod restart and
-- never replicated across pods.
--
-- Deliberately PLATFORM-GLOBAL: no tenant_id and no RLS. These are the admin
-- portal's deployment-wide operational settings (appName, maintenanceMode,
-- timezone, ...) behind the admin-only /api/v1/system namespace; they are not
-- per-tenant clinical or PHI data, so the migration-609 tenant-RLS template
-- does not apply. Per-tenant configuration continues to live in the dedicated
-- tenant_* settings tables.
--
-- Values are stored as JSON-encoded text (the controller writes
-- JSON.stringify and parses on read), matching its existing upsert:
--   INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
--   ON CONFLICT (key) DO UPDATE ...
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Keys are code-defined camelCase identifiers (the controller allowlists
  -- them against DEFAULT_SETTINGS before writing); reject anything else.
  CONSTRAINT chk_system_settings_key_shape CHECK (key ~ '^[A-Za-z][A-Za-z0-9_]{0,127}$')
);

COMMENT ON TABLE system_settings IS
  'Platform-global admin-portal settings (key/value, JSON-encoded text values). Deliberately tenant-less: deployment-wide operational toggles, not PHI.';
