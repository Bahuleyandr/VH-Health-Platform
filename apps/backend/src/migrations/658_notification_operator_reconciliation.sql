BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.notification_provider_receipts
  DROP CONSTRAINT chk_notification_provider_receipt_source,
  ADD CONSTRAINT chk_notification_provider_receipt_source
    CHECK (receipt_source IN (
      'provider_response', 'transport_failure', 'lease_expiry',
      'owner_reconciliation', 'operator_reconciliation'
    )),
  DROP CONSTRAINT chk_notification_provider_receipt_owner_shape,
  ADD CONSTRAINT chk_notification_provider_receipt_owner_shape
    CHECK (
      (
        receipt_source = 'owner_reconciliation'
        AND recovery_inbox_id IS NOT NULL
        AND recovery_interface_family = 'I17'
        AND owner_actor_uid IS NOT NULL
        AND owner_reason IS NOT NULL
        AND BTRIM(owner_reason) <> ''
      )
      OR (
        receipt_source = 'operator_reconciliation'
        AND recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND owner_actor_uid IS NOT NULL
        AND owner_reason IS NOT NULL
        AND BTRIM(owner_reason) <> ''
      )
      OR (
        receipt_source NOT IN ('owner_reconciliation', 'operator_reconciliation')
        AND recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND owner_actor_uid IS NULL
        AND owner_reason IS NULL
      )
    );

CREATE OR REPLACE FUNCTION public.validate_notification_outbox_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.type IS DISTINCT FROM NEW.type
     OR OLD.recipient_id IS DISTINCT FROM NEW.recipient_id
     OR OLD.recipient_phone IS DISTINCT FROM NEW.recipient_phone
     OR OLD.title IS DISTINCT FROM NEW.title
     OR OLD.body IS DISTINCT FROM NEW.body
     OR OLD.payload IS DISTINCT FROM NEW.payload
     OR OLD.channel IS DISTINCT FROM NEW.channel
     OR OLD.source_event_key IS DISTINCT FROM NEW.source_event_key
     OR OLD.recipient_key IS DISTINCT FROM NEW.recipient_key
     OR OLD.template_version IS DISTINCT FROM NEW.template_version
     OR OLD.rendered_intent_hash IS DISTINCT FROM NEW.rendered_intent_hash
     OR OLD.ledger_version IS DISTINCT FROM NEW.ledger_version
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_notification_outbox_intent_immutable',
      MESSAGE = 'Notification outbox rendered intent is immutable';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status IN ('PENDING', 'FAILED') AND NEW.status IN ('CLAIMED', 'SUPPRESSED') THEN
      NULL;
    ELSIF OLD.status = 'CLAIMED'
      AND NEW.status IN ('PENDING', 'SENT', 'FAILED', 'RECONCILIATION_REQUIRED') THEN
      NULL;
    ELSIF OLD.status = 'RECONCILIATION_REQUIRED' AND NEW.status = 'SENT' THEN
      NULL;
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_notification_outbox_state_transition',
        MESSAGE = FORMAT('Notification outbox transition %s -> %s is not allowed', OLD.status, NEW.status);
    END IF;
  END IF;

  IF NEW.status = 'SENT'
     AND NOT EXISTS (
       SELECT 1
         FROM public.notification_provider_receipts AS receipt
        WHERE receipt.tenant_id = NEW.tenant_id
          AND receipt.notification_outbox_id = NEW.id
          AND receipt.outcome = 'acknowledged'
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_notification_outbox_sent_provider_acceptance',
      MESSAGE = 'Notification outbox cannot be sent without provider acceptance';
  END IF;

  IF NEW.status = 'SENT'
     AND EXISTS (
       SELECT 1
         FROM public.notification_delivery_attempts AS attempt
        WHERE attempt.tenant_id = NEW.tenant_id
          AND attempt.notification_outbox_id = NEW.id
          AND attempt.attempt_number = (
            SELECT MAX(newest.attempt_number)
              FROM public.notification_delivery_attempts AS newest
             WHERE newest.tenant_id = attempt.tenant_id
               AND newest.notification_outbox_id = attempt.notification_outbox_id
               AND newest.channel = attempt.channel
          )
          AND NOT EXISTS (
            SELECT 1
              FROM public.notification_provider_receipts AS receipt
             WHERE receipt.tenant_id = attempt.tenant_id
               AND receipt.attempt_id = attempt.attempt_id
               AND receipt.outcome = 'acknowledged'
          )
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_notification_outbox_sent_all_current_attempts_accepted',
      MESSAGE = 'Notification outbox cannot be sent while a current provider attempt lacks acceptance';
  END IF;

  IF NEW.status = 'SUPPRESSED' AND OLD.status = 'SUPPRESSED' THEN
    RETURN NEW;
  END IF;

  RETURN NEW;
END
$$;

COMMIT;
