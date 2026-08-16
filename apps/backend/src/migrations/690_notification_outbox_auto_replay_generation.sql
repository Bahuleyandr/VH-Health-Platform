-- 690_notification_outbox_auto_replay_generation.sql
--
-- Bounded auto-replay for notification_outbox RECONCILIATION_REQUIRED rows
-- (audit MEDIUM follow-up to F7/F11 + R3). The mig-609/658 contract stands:
-- the provider outcome of the ORIGINAL send is unknowable, so the row itself
-- is never re-sent. The new notification-outbox-auto-replay sweep reuses the
-- audited operator requeue-as-new-intent mechanism (a NEW outbox row with an
-- `:auto-replay:` source-event-key suffix; the original is stamped
-- failure_reason='operator_replay_superseded' so the strict per-channel
-- ordering predicates stop treating it as an unresolved gap).
--
-- replay_generation is the bound on that chain: each requeued replacement
-- (operator or sweep) inherits its original's generation + 1, and the sweep
-- refuses rows at generation >= 2 — those are terminal dead letters that only
-- the operator endpoints can resolve. The column is set at INSERT only and is
-- never updated afterwards, so the validate_notification_outbox_transition
-- immutability list needs no change. CHECK 0..8 is a backstop against a
-- runaway replay chain (operator replays keep inheriting the counter and are
-- clamped in the service well before 8).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.notification_outbox
  ADD COLUMN replay_generation smallint NOT NULL DEFAULT 0
    CONSTRAINT chk_notification_outbox_replay_generation
      CHECK (replay_generation BETWEEN 0 AND 8);

COMMENT ON COLUMN public.notification_outbox.replay_generation IS
  'Requeue-as-new-intent chain depth (0 = original intent). Set at INSERT only; the auto-replay sweep refuses rows at generation >= 2.';

COMMIT;
