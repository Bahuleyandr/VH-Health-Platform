-- 682_shift_swap_and_on_call_roster.sql
--
-- Feature wave 5 — shift-for-shift swaps and a dedicated on-call roster.
--
-- Gap: roster requests (migration 251) know only duty_preference / avoid_duty /
-- coverage_request, and leave-linked replacement_requests. There is no
-- shift-for-shift swap primitive — two staff agreeing to exchange two published
-- roster slots have no request object, no counterparty acceptance step, and no
-- atomic exchange. And "on call" exists only as prose: an `assignment_source`
-- string ('on_call_role') in the STEMI team resolver and escalation recipient
-- rank mappings; there is no table stating who is on call for a department/tier
-- during a time window.
--
-- 1. `staff_shift_swap_requests` — a dedicated two-party request object, NOT an
--    extension of staff_shift_roster_requests. That table's shape is a single
--    staff member + a date window; a swap is two parties, two concrete
--    staff_shift_roster_assignments rows, and a three-actor state machine
--    (requester proposes -> counterparty accepts/declines -> department
--    reviewer approves/rejects; approval atomically exchanges the two roster
--    assignment rows in the service transaction). Status flow:
--      proposed -> counterparty_accepted -> approved | rejected
--      proposed -> counterparty_declined
--      proposed | counterparty_accepted -> cancelled (requester) | expired (sweep)
--    Live swaps (proposed/counterparty_accepted) are unique per assignment on
--    each side; the partial unique indexes use the trailing-(TRUE) expression
--    column (migration-580 idiom) because their columns are FK columns and a
--    bare partial unique there breaks `prisma db pull` relation inference.
--
-- 2. `staff_shift_swap_request_audit` — append-only transition audit,
--    mirroring staff_shift_roster_request_audit (migration 251).
--
-- 3. `staff_on_call_assignments` — the honest on-call roster: who is on call
--    for a tenant + department (+ optional specialty) + tier over a concrete
--    [start_at, end_at) window. A btree_gist exclusion constraint (migration
--    319/412/481/630 precedent) forbids two ACTIVE rows for the same
--    tenant/department/specialty/tier from overlapping in time, which is what
--    makes "who is on call now" deterministic. Ending a stint early is a soft
--    end (is_active = FALSE + ended_* evidence), never a delete.
--
-- RLS follows the referral_facilities (migration 680) request-path pattern:
-- permissive tenant_isolation; service writers stamp tenant_id explicitly.
-- tenant_id keeps the GUC-reading DEFAULT used by the sibling roster tables so
-- pre-existing roster tooling conventions hold, but the new services always
-- write it explicitly from the parent assignment rows / request context.

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- 1. Shift swap requests
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staff_shift_swap_requests (
  id                        SERIAL PRIMARY KEY,
  tenant_id                 UUID NOT NULL
    DEFAULT COALESCE(
      (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    ),
  department                VARCHAR(80) NOT NULL,
  requester_id              INTEGER NOT NULL,
  requester_uid             UUID,
  requester_assignment_id   INTEGER NOT NULL
    REFERENCES staff_shift_roster_assignments(id) ON DELETE CASCADE,
  counterparty_id           INTEGER NOT NULL,
  counterparty_uid          UUID,
  counterparty_assignment_id INTEGER NOT NULL
    REFERENCES staff_shift_roster_assignments(id) ON DELETE CASCADE,
  status                    VARCHAR(30) NOT NULL DEFAULT 'proposed',
  reason                    TEXT,
  counterparty_note         TEXT,
  counterparty_responded_at TIMESTAMPTZ,
  decided_by                INTEGER,
  decided_by_uid            UUID,
  decided_at                TIMESTAMPTZ,
  decision_notes            TEXT,
  -- Latest instant the request is actionable: the earlier of the two shift
  -- start datetimes, computed by the service at proposal time. The expiry
  -- sweep flips still-live requests past this to 'expired'.
  expires_at                TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_staff_shift_swap_requests_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT chk_staff_shift_swap_status
    CHECK (status IN (
      'proposed', 'counterparty_accepted', 'counterparty_declined',
      'approved', 'rejected', 'cancelled', 'expired'
    )),
  CONSTRAINT chk_staff_shift_swap_distinct_assignments
    CHECK (requester_assignment_id <> counterparty_assignment_id),
  CONSTRAINT chk_staff_shift_swap_distinct_parties
    CHECK (requester_id <> counterparty_id),
  -- A final reviewer decision always names the decider.
  CONSTRAINT chk_staff_shift_swap_decided_evidence
    CHECK (
      status NOT IN ('approved', 'rejected')
      OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
    ),
  -- A counterparty response (accept/decline) is always timestamped.
  CONSTRAINT chk_staff_shift_swap_response_evidence
    CHECK (
      status NOT IN ('counterparty_accepted', 'counterparty_declined', 'approved', 'rejected')
      OR counterparty_responded_at IS NOT NULL
    )
);

-- One live swap per roster assignment on either side. Trailing (TRUE)
-- expression column keeps prisma db pull from mis-inferring a one-to-one
-- relation over the FK column (migration-580 idiom).
CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_shift_swap_requester_live
  ON staff_shift_swap_requests (requester_assignment_id, (TRUE))
  WHERE status IN ('proposed', 'counterparty_accepted');
CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_shift_swap_counterparty_live
  ON staff_shift_swap_requests (counterparty_assignment_id, (TRUE))
  WHERE status IN ('proposed', 'counterparty_accepted');

CREATE INDEX IF NOT EXISTS idx_staff_shift_swap_requests_requester
  ON staff_shift_swap_requests (requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_shift_swap_requests_counterparty
  ON staff_shift_swap_requests (counterparty_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_shift_swap_requests_dept_status
  ON staff_shift_swap_requests (department, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_shift_swap_requests_expiry
  ON staff_shift_swap_requests (expires_at)
  WHERE status IN ('proposed', 'counterparty_accepted');
CREATE INDEX IF NOT EXISTS idx_staff_shift_swap_requests_tenant_id
  ON staff_shift_swap_requests (tenant_id);

-- Append-only transition audit (mirrors staff_shift_roster_request_audit).
CREATE TABLE IF NOT EXISTS staff_shift_swap_request_audit (
  id              SERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL
    DEFAULT COALESCE(
      (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    ),
  swap_request_id INTEGER
    REFERENCES staff_shift_swap_requests(id) ON DELETE CASCADE,
  actor_id        INTEGER,
  actor_uid       UUID,
  action          VARCHAR(40) NOT NULL,
  reason          TEXT,
  before_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_staff_shift_swap_request_audit_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_staff_shift_swap_request_audit_request
  ON staff_shift_swap_request_audit (swap_request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_shift_swap_request_audit_tenant_id
  ON staff_shift_swap_request_audit (tenant_id);

-- ---------------------------------------------------------------------------
-- 2. On-call roster
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staff_on_call_assignments (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL
    DEFAULT COALESCE(
      (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    ),
  department    VARCHAR(80) NOT NULL,
  specialty     VARCHAR(120),
  -- 1 = primary on call, 2 = secondary/backup, 3+ = further escalation tiers.
  tier          SMALLINT NOT NULL DEFAULT 1,
  staff_id      INTEGER NOT NULL,
  staff_uid     UUID,
  staff_role    VARCHAR(80),
  start_at      TIMESTAMPTZ NOT NULL,
  end_at        TIMESTAMPTZ NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  notes         TEXT,
  created_by    INTEGER,
  created_by_uid UUID,
  ended_by      INTEGER,
  ended_by_uid  UUID,
  ended_at      TIMESTAMPTZ,
  end_reason    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_staff_on_call_assignments_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT chk_staff_on_call_window CHECK (end_at > start_at),
  CONSTRAINT chk_staff_on_call_tier CHECK (tier BETWEEN 1 AND 5),
  -- Early end is evidence, not erasure: an inactive row must say who/when.
  CONSTRAINT chk_staff_on_call_end_evidence
    CHECK (is_active OR (ended_at IS NOT NULL)),
  -- At most one ACTIVE on-call holder per tenant/department/specialty/tier at
  -- any instant — the invariant that makes "who is on call now" a lookup
  -- rather than a judgement call.
  CONSTRAINT ex_staff_on_call_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    department WITH =,
    (COALESCE(specialty, '')) WITH =,
    tier WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (is_active)
);

CREATE INDEX IF NOT EXISTS idx_staff_on_call_active_window
  ON staff_on_call_assignments (tenant_id, department, tier, start_at, end_at)
  WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_staff_on_call_staff
  ON staff_on_call_assignments (staff_id, start_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_on_call_tenant_id
  ON staff_on_call_assignments (tenant_id);

-- ---------------------------------------------------------------------------
-- 3. RLS (referral_facilities / migration 680 pattern)
-- ---------------------------------------------------------------------------

ALTER TABLE staff_shift_swap_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_shift_swap_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON staff_shift_swap_requests;
CREATE POLICY tenant_isolation ON staff_shift_swap_requests
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

ALTER TABLE staff_shift_swap_request_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_shift_swap_request_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON staff_shift_swap_request_audit;
CREATE POLICY tenant_isolation ON staff_shift_swap_request_audit
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

ALTER TABLE staff_on_call_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_on_call_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON staff_on_call_assignments;
CREATE POLICY tenant_isolation ON staff_on_call_assignments
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

COMMENT ON TABLE staff_shift_swap_requests IS
  'Shift-for-shift swap requests between two staff members over two concrete staff_shift_roster_assignments rows. proposed -> counterparty_accepted -> approved exchanges the two assignment rows atomically in the service transaction; audit lives in staff_shift_swap_request_audit.';
COMMENT ON TABLE staff_on_call_assignments IS
  'Dedicated on-call roster: who is on call for a tenant/department(/specialty)/tier over [start_at, end_at). Active rows cannot overlap per exclusion constraint; ended early via is_active=FALSE with ended_* evidence.';
COMMENT ON COLUMN staff_shift_swap_requests.expires_at IS
  'Earliest of the two shift start datetimes; the scheduler expiry sweep marks still-live requests past this instant as expired.';

COMMIT;
