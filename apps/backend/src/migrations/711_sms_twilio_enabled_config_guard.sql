-- 711_sms_twilio_enabled_config_guard.sql
--
-- An enabled Twilio SMS row cannot construct or verify provider callbacks
-- without its account SID. Migration 699 required the shared DLT/auth shape
-- but omitted this Twilio-specific identifier, so a row could pass the
-- database gate and only fail at send time. Abort before installing the
-- constraint if retained data contains such an ambiguous live row; an
-- operator must disable it or supply the correct account SID first.

BEGIN;

DO $preflight$
DECLARE
  invalid_live_twilio_rows BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO invalid_live_twilio_rows
    FROM public.sms_provider_configs
   WHERE provider = 'twilio'
     AND enabled = true
     AND NULLIF(BTRIM(account_sid), '') IS NULL;

  IF invalid_live_twilio_rows > 0 THEN
    RAISE EXCEPTION
      'Migration 711 refused: % enabled Twilio SMS config row(s) have no account_sid; disable or repair them before retrying',
      invalid_live_twilio_rows;
  END IF;
END
$preflight$;

ALTER TABLE public.sms_provider_configs
  DROP CONSTRAINT IF EXISTS chk_sms_provider_config_twilio_live_account_sid;

ALTER TABLE public.sms_provider_configs
  ADD CONSTRAINT chk_sms_provider_config_twilio_live_account_sid
    CHECK (
      provider <> 'twilio'
      OR NOT enabled
      OR NULLIF(BTRIM(account_sid), '') IS NOT NULL
    );

COMMENT ON CONSTRAINT chk_sms_provider_config_twilio_live_account_sid
  ON public.sms_provider_configs IS
  'Enabled Twilio SMS configs require account_sid so sends and signed status callbacks bind to the same provider account.';

COMMIT;
