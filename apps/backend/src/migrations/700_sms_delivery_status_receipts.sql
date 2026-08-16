-- 700_sms_delivery_status_receipts.sql
--
-- SMS gateway adapter, part 2 of 2 — delivery-status (DLR) callback evidence.
--
-- Deliberately NOT a new receipt store. Migration 609's
-- notification_provider_receipts is the append-only provider-evidence table
-- for every channel, and its unique
-- ux_notification_provider_receipt_source_once (attempt_id, receipt_source, …)
-- already collapses replayed evidence per attempt per source. A DLR from
-- MSG91/Twilio is exactly a second, later piece of provider evidence about an
-- attempt that already carries a 'provider_response' receipt from send time —
-- so all this migration does is:
--
--   1. Widen the receipt_source vocabulary with 'provider_status_callback'.
--      One terminal DLR receipt per attempt (delivered / undelivered /
--      failed / rejected → outcome acknowledged|rejected); intermediate
--      statuses (queued/sent) are acked 200 and not persisted; a replayed
--      or second terminal DLR collapses on the existing unique index.
--   2. Add a correlation index: DLR callbacks identify the message only by
--      the provider reference (MSG91 request id / Twilio MessageSid), which
--      the send-time 'provider_response' receipt already stored in
--      provider_reference. The DLR handler resolves attempt_id through it.
--
-- Contract reminders for the DLR handler (enforced by 609, not here):
--   * These tables carry a RESTRICTIVE fail-closed RLS policy
--     (notification_delivery_explicit_context) — the DLR handler MUST
--     resolve the tenant first (callback URL token → sms_provider_configs
--     row, 699) and insert inside setTenant(tenantId); a bypass/unset GUC
--     write fails. tenant_id is always written explicitly.
--   * A DLR failure after SENT does not rewrite outbox status (SENT is
--     terminal under the 609 transition guard); it lands as append-only
--     evidence surfaced by reconciliation reporting.

BEGIN;

ALTER TABLE public.notification_provider_receipts
  DROP CONSTRAINT IF EXISTS chk_notification_provider_receipt_source;

ALTER TABLE public.notification_provider_receipts
  ADD CONSTRAINT chk_notification_provider_receipt_source
    CHECK (receipt_source IN (
      'provider_response',
      'transport_failure',
      'lease_expiry',
      'owner_reconciliation',
      -- 658's operator surface (notificationOutboxAdminService
      -- reconcileNotificationOutboxAttempt) still writes this source — a
      -- rewrite of this CHECK must always carry the FULL prior vocabulary.
      'operator_reconciliation',
      'provider_status_callback'
    ));

-- DLR correlation lookup: provider reference → attempt. The DLR path filters
-- on channel='sms' today, but the index is channel-generic on purpose —
-- WhatsApp/voice status callbacks would use the same correlation.
CREATE INDEX IF NOT EXISTS idx_notification_provider_receipt_reference
  ON public.notification_provider_receipts (tenant_id, channel, provider_reference)
  WHERE provider_reference IS NOT NULL;

COMMENT ON CONSTRAINT chk_notification_provider_receipt_source
  ON public.notification_provider_receipts IS
  'Widened by 700: provider_status_callback = asynchronous delivery-status (DLR) evidence from SMS providers, correlated to the attempt via the send-time receipt''s provider_reference. One terminal DLR per attempt (ux_notification_provider_receipt_source_once).';

COMMIT;
