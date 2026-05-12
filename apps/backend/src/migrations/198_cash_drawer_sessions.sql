-- 198_cash_drawer_sessions.sql
--
-- Wave-2 fix — cashier shift-close / cash-drawer reconciliation.
--
-- Background: billing_v2 already records every payment with mode + shift
-- + collected_by + denominations. What it does NOT do is close out a
-- shift: there is no place for a cashier to declare "I'm done, this is
-- my physical cash count" and have the system compute variance against
-- the system total. Without this, leakage at the counter is invisible
-- even when the payment rows exist. Closes findings:
--   2026-05-09-inpatient-admission-billing-no-cashier-shift-reconciliation
--   2026-05-10-inpatient-admission-billing-cash-drawer-reconciliation-missing
--
-- Workflow:
--   1. Cashier opens a session at shift start (POST .../sessions/open)
--      → row created with opened_at + opening_float (cash on hand at
--      start of shift, e.g. ₹500 carryover).
--   2. Throughout the shift, billing_payments rows accumulate normally
--      with the existing shift label (MORNING / EVENING / NIGHT).
--   3. Cashier closes the session at end of shift (POST .../sessions/:id
--      /close) with the physical denomination breakdown. Server computes
--      counted_total, system_total (sum of CASH billing_payments for
--      that cashier in that shift since opened_at), and the variance.
--   4. A non-zero variance flips short_count (counted < system) or
--      over_count (counted > system) and forces requires_review=true
--      when the absolute variance is above the configured tolerance
--      (default ₹1). FINANCE_INCHARGE / ADMIN reviews via
--      POST .../sessions/:id/review.
--
-- Status enum: 'open' (initial), 'closed' (count submitted),
-- 'reviewed' (variance acknowledged or session was already inside
-- tolerance and auto-reviewed). 'open' is the only state a cashier
-- can re-enter to add a count; once 'closed' the session is
-- immutable except by reviewer.

BEGIN;

CREATE TABLE IF NOT EXISTS cash_drawer_sessions (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  cashier_uid       UUID NOT NULL,
  shift             VARCHAR(20) NOT NULL,
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opening_float     NUMERIC(12,2) NOT NULL DEFAULT 0,
  closed_at         TIMESTAMPTZ,
  counted_total     NUMERIC(12,2),
  counted_denominations JSONB,
  system_total      NUMERIC(12,2),
  variance          NUMERIC(12,2),
  short_count       BOOLEAN NOT NULL DEFAULT FALSE,
  over_count        BOOLEAN NOT NULL DEFAULT FALSE,
  requires_review   BOOLEAN NOT NULL DEFAULT FALSE,
  variance_reason   VARCHAR(500),
  status            VARCHAR(20) NOT NULL DEFAULT 'open',
  reviewed_by       UUID,
  reviewed_at       TIMESTAMPTZ,
  review_notes      VARCHAR(500),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT cash_drawer_sessions_status_check
    CHECK (status IN ('open', 'closed', 'reviewed')),
  CONSTRAINT cash_drawer_sessions_shift_check
    CHECK (shift IN ('MORNING', 'AFTERNOON', 'EVENING', 'NIGHT', 'GENERAL'))
);

-- One open session per cashier per shift. Closed/reviewed sessions can
-- accumulate so the history per cashier per shift stays intact.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_drawer_sessions_open
  ON cash_drawer_sessions (tenant_id, cashier_uid, shift)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_cash_drawer_sessions_cashier
  ON cash_drawer_sessions (tenant_id, cashier_uid, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_drawer_sessions_review
  ON cash_drawer_sessions (tenant_id, requires_review, status)
  WHERE requires_review = TRUE;

COMMIT;
