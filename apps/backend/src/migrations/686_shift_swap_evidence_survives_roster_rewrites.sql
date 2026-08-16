-- 686_shift_swap_evidence_survives_roster_rewrites.sql
--
-- Adversarial-review fix (PR #875, fix group 1): a routine roster board
-- re-save (rosterBoardService.saveRosterBoardRecord) deletes and re-inserts
-- every staff_shift_roster_assignments row for the board. Migration 682 gave
-- staff_shift_swap_requests ON DELETE CASCADE FKs to those assignment rows,
-- and staff_shift_swap_request_audit an ON DELETE CASCADE FK to the swap
-- request — so a routine roster save silently destroyed swap requests AND
-- their append-only audit trail. Evidence must survive (683/684 evidence-CHECK
-- precedent: facts are preserved, never cascade-erased).
--
-- The new shape:
--   1. Swap → assignment FKs become nullable ON DELETE SET NULL: a settled
--      swap (approved/rejected/declined/cancelled/expired) keeps its request
--      row when the underlying roster slots are rewritten or removed.
--   2. A live swap (proposed/counterparty_accepted) must keep both assignment
--      references (chk_staff_shift_swap_live_assignment_refs). Because the FK
--      action is SET NULL, deleting an assignment under a LIVE swap now fails
--      that CHECK — fail closed. The roster-save path cancels live swaps
--      (with an audit row) before rewriting assignments.
--   3. Shift snapshots captured at proposal time (what was to be exchanged)
--      survive the referenced rows, so settled requests stay legible after
--      the slot rows are gone.
--   4. Audit rows are append-only evidence: swap_request_id becomes
--      ON DELETE SET NULL so no path can cascade the trail away. The audit
--      rows' before/after snapshots already carry the full request row.

BEGIN;

-- 1. Assignment references become soft (nullable + SET NULL).
ALTER TABLE staff_shift_swap_requests
  ALTER COLUMN requester_assignment_id DROP NOT NULL,
  ALTER COLUMN counterparty_assignment_id DROP NOT NULL;

ALTER TABLE staff_shift_swap_requests
  DROP CONSTRAINT staff_shift_swap_requests_requester_assignment_id_fkey,
  ADD CONSTRAINT staff_shift_swap_requests_requester_assignment_id_fkey
    FOREIGN KEY (requester_assignment_id)
    REFERENCES staff_shift_roster_assignments(id) ON DELETE SET NULL,
  DROP CONSTRAINT staff_shift_swap_requests_counterparty_assignment_id_fkey,
  ADD CONSTRAINT staff_shift_swap_requests_counterparty_assignment_id_fkey
    FOREIGN KEY (counterparty_assignment_id)
    REFERENCES staff_shift_roster_assignments(id) ON DELETE SET NULL;

-- chk_staff_shift_swap_distinct_assignments stays: NULL <> NULL is NULL,
-- which a CHECK treats as pass, so settled rows with nulled refs are fine.

-- 2. Live swaps must keep both references — this is what turns an assignment
--    delete under a live swap into an error instead of silent destruction.
ALTER TABLE staff_shift_swap_requests
  ADD CONSTRAINT chk_staff_shift_swap_live_assignment_refs
    CHECK (
      status NOT IN ('proposed', 'counterparty_accepted')
      OR (requester_assignment_id IS NOT NULL AND counterparty_assignment_id IS NOT NULL)
    );

-- 3. Proposal-time shift snapshots (service fills these; backfill best-effort
--    from rows whose assignments still exist).
ALTER TABLE staff_shift_swap_requests
  ADD COLUMN IF NOT EXISTS requester_shift_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS counterparty_shift_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE staff_shift_swap_requests s
   SET requester_shift_snapshot = COALESCE((
         SELECT jsonb_build_object(
                  'assignment_id', a.id,
                  'roster_id', a.roster_id,
                  'department', b.department,
                  'roster_date', b.roster_date::text,
                  'shift_label', b.shift_label,
                  'shift_start', b.shift_start::text,
                  'shift_end', b.shift_end::text,
                  'staff_id', a.staff_id,
                  'staff_uid', a.staff_uid,
                  'staff_role', a.staff_role)
           FROM staff_shift_roster_assignments a
           JOIN staff_shift_roster_boards b ON b.id = a.roster_id
          WHERE a.id = s.requester_assignment_id), '{}'::jsonb)
 WHERE s.requester_shift_snapshot = '{}'::jsonb;

UPDATE staff_shift_swap_requests s
   SET counterparty_shift_snapshot = COALESCE((
         SELECT jsonb_build_object(
                  'assignment_id', a.id,
                  'roster_id', a.roster_id,
                  'department', b.department,
                  'roster_date', b.roster_date::text,
                  'shift_label', b.shift_label,
                  'shift_start', b.shift_start::text,
                  'shift_end', b.shift_end::text,
                  'staff_id', a.staff_id,
                  'staff_uid', a.staff_uid,
                  'staff_role', a.staff_role)
           FROM staff_shift_roster_assignments a
           JOIN staff_shift_roster_boards b ON b.id = a.roster_id
          WHERE a.id = s.counterparty_assignment_id), '{}'::jsonb)
 WHERE s.counterparty_shift_snapshot = '{}'::jsonb;

-- 4. The audit trail never cascades away with its request.
ALTER TABLE staff_shift_swap_request_audit
  DROP CONSTRAINT staff_shift_swap_request_audit_swap_request_id_fkey,
  ADD CONSTRAINT staff_shift_swap_request_audit_swap_request_id_fkey
    FOREIGN KEY (swap_request_id)
    REFERENCES staff_shift_swap_requests(id) ON DELETE SET NULL;

COMMENT ON COLUMN staff_shift_swap_requests.requester_shift_snapshot IS
  'Proposal-time snapshot of the requester''s offered shift (assignment/board facts + assignee). Survives roster rewrites that null the assignment FK.';
COMMENT ON COLUMN staff_shift_swap_requests.counterparty_shift_snapshot IS
  'Proposal-time snapshot of the counterparty''s shift. Survives roster rewrites that null the assignment FK.';
COMMENT ON CONSTRAINT chk_staff_shift_swap_live_assignment_refs ON staff_shift_swap_requests IS
  'Live swaps must reference both assignment rows; with SET NULL FKs this makes deleting an assignment under a live swap fail closed — the roster-save path cancels live swaps (audited) before rewriting assignments.';

COMMIT;
