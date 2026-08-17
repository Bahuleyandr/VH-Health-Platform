-- 711_sms_twilio_enabled_config_guard.sql
--
-- Forward-only convergence for the published migration 699 SMS schema.
-- Published 699 did not contain callback_token_ciphertext and its enabled-row
-- guard covered only the DLT identity and provider credential. The Twilio send
-- path needs an encrypted copy of the callback bearer to construct the exact
-- statusCallback URL, and signed callbacks also require account_sid.
--
-- A callback plaintext cannot be recovered from callback_token_hash. Retained
-- enabled rows that do not already carry the complete usable shape are
-- therefore disabled, not supplied with invented credential evidence. An
-- administrator can re-enable them through the normal config upsert, which
-- mints and returns a replacement callback token exactly once.

BEGIN;

ALTER TABLE sms_provider_configs
  ADD COLUMN IF NOT EXISTS callback_token_ciphertext TEXT;

-- Fail closed when a retained published-699 row cannot be made operational
-- without minting a new secret. Preserve the row and record why it was
-- disabled so the administrator can deliberately rotate/re-enable it.
UPDATE sms_provider_configs
   SET enabled = false,
       metadata = metadata || jsonb_build_object(
         'disabled_by_migration_711', true,
         'disabled_reason', 'incomplete_enabled_sms_provider_config'
       ),
       updated_at = NOW()
 WHERE enabled IS TRUE
   AND provider <> 'dry_run'
   AND (
     NULLIF(BTRIM(sender_id), '') IS NULL
     OR NULLIF(BTRIM(dlt_entity_id), '') IS NULL
     OR NULLIF(BTRIM(auth_key_ciphertext), '') IS NULL
     OR callback_token_hash IS NULL
     OR NULLIF(BTRIM(callback_token_ciphertext), '') IS NULL
     OR (
       provider = 'twilio'
       AND NULLIF(BTRIM(account_sid), '') IS NULL
     )
   );

ALTER TABLE sms_provider_configs
  DROP CONSTRAINT IF EXISTS chk_sms_provider_config_live_shape;

ALTER TABLE sms_provider_configs
  ADD CONSTRAINT chk_sms_provider_config_live_shape
    CHECK (
      provider = 'dry_run'
      OR NOT enabled
      OR (
        NULLIF(BTRIM(sender_id), '') IS NOT NULL
        AND NULLIF(BTRIM(dlt_entity_id), '') IS NOT NULL
        AND NULLIF(BTRIM(auth_key_ciphertext), '') IS NOT NULL
        AND callback_token_hash IS NOT NULL
        AND NULLIF(BTRIM(callback_token_ciphertext), '') IS NOT NULL
      )
    );

ALTER TABLE sms_provider_configs
  DROP CONSTRAINT IF EXISTS chk_sms_provider_config_twilio_live_account_sid;

ALTER TABLE sms_provider_configs
  ADD CONSTRAINT chk_sms_provider_config_twilio_live_account_sid
    CHECK (
      provider <> 'twilio'
      OR NOT enabled
      OR NULLIF(BTRIM(account_sid), '') IS NOT NULL
    );

COMMENT ON CONSTRAINT chk_sms_provider_config_twilio_live_account_sid
  ON sms_provider_configs IS
  'Enabled Twilio SMS configs require account_sid so sends and signed status callbacks bind to the same provider account.';

COMMENT ON COLUMN sms_provider_configs.callback_token_ciphertext IS
  'Encrypted callback bearer token, decrypted only to construct the provider callback URL; never returned by config reads.';

COMMIT;
