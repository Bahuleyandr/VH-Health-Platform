# BUILD: N6-10 — Oncology day-care infusion chair scheduling

**Plan:** `docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md` §4.9 (oncology paragraph). Read fully, plus `_worker-common.md`. Chemo substrate is complete (mig 290: protocols/plans/cycles/BSA/two-person verify); `day_care` beds seeded (mig 258). Verified missing: any infusion chair/slot resource constructs.

## Start gate
```
git fetch github
git grep -q "oncology_foundations" github/main -- apps/backend/src/migrations
```

## Workspace
Worktree `VH-Health-Platform-nl6-10`, branch `feat/nl6-10-infusion-chairs`. Backend + admin.

## Scope
1–2 migrations, tenant RLS: `infusion_chairs` (chair resource per unit; status) + `chair_bookings` keyed to `chemo_cycles.scheduled_date` (start/end slot, conflict-checked; cancellation frees the slot) · day-care infusion board tab (admin; realtime per the proven board recipe if cheap, else poll) · conflict checks server-side (no double-booking a chair; warn on patient double-booking). Scheduling stays slot-based against chairs — do NOT build generic resource-calendar machinery (that is NL-8 scheduling-2.0 territory).

## Tests
Deep: extend `chemo-loop.deep.test.js` with a booked chair through cycle administration; double-booking rejected; cancel frees slot. Unit: conflict window math.

## Deliverable
PR `N6-10: oncology infusion chair scheduling` + ledger. Stop after PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl6-10-infusion-chairs.md` and `_worker-common.md`; execute EXACTLY. Your migration block: <ASSIGN>. STOP after the PR; report PR number + ledger.
