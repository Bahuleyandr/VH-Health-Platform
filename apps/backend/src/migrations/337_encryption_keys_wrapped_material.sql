-- 337_encryption_keys_wrapped_material.sql
--
-- W3 (multi-tenancy program) WS5 — per-tenant field-encryption KEK.
--
-- The encryption_keys registry (mig 129) is already per-tenant ((tenant_id,
-- key_id) unique + status/rotation columns) but only stored KEK *metadata* — the
-- actual key material lived in env (FIELD_ENCRYPTION_KEK). For per-tenant KEKs +
-- crypto-shred we store each tenant's KEK wrapped under a single master KEK
-- (FIELD_ENCRYPTION_MASTER_KEK). Envelope: master KEK -> per-tenant KEK -> per-record
-- DEK -> data. Crypto-shred = drop a tenant's wrapped_key_material -> that tenant's
-- ciphertext becomes unrecoverable while every other tenant is untouched.
--
-- wrapped_key_material = base64url(JSON {edek, wiv, wtag}) of the 32-byte tenant
-- KEK encrypted with AES-256-GCM under the master KEK. NULL once shredded.
--
-- Provisioning of the default tenant's KEK + the existing-PHI re-wrap is done by
-- scripts/phi-rewrap-tenant-keks.mjs (needs the master KEK env + JS crypto), not
-- this DDL — so the migration adds only the column and is safe/idempotent.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'encryption_keys'
  ) THEN
    ALTER TABLE encryption_keys ADD COLUMN IF NOT EXISTS wrapped_key_material text;
  ELSE
    RAISE NOTICE 'Skipping: encryption_keys table does not exist';
  END IF;
END
$$;

COMMIT;
