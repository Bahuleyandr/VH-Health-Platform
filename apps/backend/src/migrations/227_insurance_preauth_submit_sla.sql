-- 227_insurance_preauth_submit_sla.sql
--
-- Stage-5 fix — TPA pre-auth submission SLA tracking.
--
-- Closes finding:
--   2026-05-09-tpa-insurance-claim-admission-preauth-draft-not-auto-submitted
--
-- Background: createPreauth inserts the row in 'draft' and leaves it
-- there until a staff member manually calls POST /preauth/:id/submit.
-- There was no submission deadline, no overdue flag, and no nudge — a
-- forgotten cashless pre-auth means the patient is billed cash despite
-- valid TPA cover (cashless TPA pre-auth has a hard TAT, typically
-- 6-12h of admission).
--
-- Fix: a lightweight SLA surface (deliberately NOT a full SLA engine):
--   * submit_due_at TIMESTAMPTZ     — when the draft must be submitted to
--                                     the insurer by. Set at create time
--                                     from a per-request-type window
--                                     (emergency 6h, enhancement 12h,
--                                     planned 48h — see claimsService
--                                     PREAUTH_SUBMIT_SLA_HOURS).
--   * submit_reminder_sent BOOLEAN  — guard so a reminder job (or the
--                                     create-time outbox nudge) doesn't
--                                     double-notify.
--
-- Both nullable / defaulted so the column add is a no-op for reads.
-- Existing 'draft' rows get submit_due_at backfilled from
-- created_at + 48h (the conservative planned window) so the overdue
-- flag is meaningful for pre-existing drafts too.

BEGIN;

ALTER TABLE insurance_preauth
  ADD COLUMN IF NOT EXISTS submit_due_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submit_reminder_sent  BOOLEAN NOT NULL DEFAULT false;

UPDATE insurance_preauth
   SET submit_due_at = created_at + INTERVAL '48 hours'
 WHERE submit_due_at IS NULL
   AND status = 'draft';

CREATE INDEX IF NOT EXISTS idx_insurance_preauth_submit_due
  ON insurance_preauth (submit_due_at)
  WHERE status = 'draft' AND submit_due_at IS NOT NULL;

COMMIT;
