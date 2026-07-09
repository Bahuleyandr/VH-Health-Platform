-- NL11-S5: white-label brand-kit settings contract.
--
-- P1 keeps the brand kit inside tenants.settings.branding instead of adding a
-- versioned asset table. Runtime code validates uploaded asset storage keys
-- against file_metadata; this database guard prevents non-object/string-shaped
-- branding payloads from being persisted through bulk settings writes.

BEGIN;

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_branding_settings_contract;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_branding_settings_contract
  CHECK (
    jsonb_typeof(settings) <> 'object'
    OR NOT (settings ? 'branding')
    OR (
      jsonb_typeof(settings->'branding') = 'object'
      AND (NOT (settings->'branding' ? 'schemaVersion') OR jsonb_typeof(settings->'branding'->'schemaVersion') = 'number')
      AND (NOT (settings->'branding' ? 'name') OR jsonb_typeof(settings->'branding'->'name') IN ('string', 'null'))
      AND (NOT (settings->'branding' ? 'primaryColor') OR jsonb_typeof(settings->'branding'->'primaryColor') IN ('string', 'null'))
      AND (NOT (settings->'branding' ? 'logoUrl') OR jsonb_typeof(settings->'branding'->'logoUrl') IN ('string', 'null'))
      AND (NOT (settings->'branding' ? 'supportEmail') OR jsonb_typeof(settings->'branding'->'supportEmail') IN ('string', 'null'))
      AND (NOT (settings->'branding' ? 'legalName') OR jsonb_typeof(settings->'branding'->'legalName') IN ('string', 'null'))
      AND (NOT (settings->'branding' ? 'legalFooter') OR jsonb_typeof(settings->'branding'->'legalFooter') IN ('string', 'null'))
      AND (NOT (settings->'branding' ? 'helpCenterUrl') OR jsonb_typeof(settings->'branding'->'helpCenterUrl') IN ('string', 'null'))
      AND (NOT (settings->'branding' ? 'document') OR jsonb_typeof(settings->'branding'->'document') = 'object')
      AND (NOT (settings->'branding' ? 'email') OR jsonb_typeof(settings->'branding'->'email') = 'object')
      AND (NOT (settings->'branding' ? 'assets') OR jsonb_typeof(settings->'branding'->'assets') = 'object')
      AND (NOT ((settings->'branding'->'assets') ? 'logo') OR jsonb_typeof(settings->'branding'->'assets'->'logo') IN ('object', 'null'))
      AND (NOT ((settings->'branding'->'assets') ? 'documentLetterhead') OR jsonb_typeof(settings->'branding'->'assets'->'documentLetterhead') IN ('object', 'null'))
    )
  );

COMMENT ON CONSTRAINT tenants_branding_settings_contract ON tenants IS
  'NL11-S5 brand-kit JSON shape guard; asset storage keys are validated by the tenant brand-kit service against file_metadata.';

COMMIT;

