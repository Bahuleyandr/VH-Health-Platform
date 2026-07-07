# BUILD: N6-13 — CSSD instrument tracking (sets, loads, issue loop)

**Plan:** `docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md` §4.9 (CSSD paragraph). Read fully, plus `_worker-common.md`. Only theatre instrument COUNTS exist (OT-close gate); `ward_indents` already has a `'sterile_supplies'` type; surgical implant docs capture `sterilization_lot`. This is a greenfield with theatre hooks.

## Start gate
```
git fetch github
git grep -q "CSSD" github/main -- docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md
```

## Workspace
Worktree `VH-Health-Platform-nl6-13`, branch `feat/nl6-13-cssd`. Backend + admin.

## Scope
~2–3 migrations, tenant RLS: `instrument_sets` (set/tray registry: contents JSONB, barcode via existing label pattern) · `sterilization_loads` (cycle parameters, biological/chemical indicator results, load contents, operator) · `set_issue_log` (issue → theatre-use (keyed to `ot_schedules`) → return → decontaminate → sterilize loop; state machine) · theatre linkage **warn-only at first** — surface "set not from a passed load" on the OT screen; hard-gating OT on CSSD data is a LATER flip (per-gate env flag, ship inert; if the privilege catalog from N6-5 is on main, an optional CSSD-supervisor gate may use it). Admin: CSSD board (loads, sets in circulation, overdue returns).

Non-clinical operational data: audit trail, no patient timeline events. Indicator-fail handling: load marked failed → all its sets flagged unusable until reprocessed (deterministic cascade, audited — but no auto-action beyond flagging).

## Tests
Deep: load → issue → theatre-use → return → decontaminate → re-sterilize cycle; indicator-fail cascade flags sets; warn-only surfacing (flag-off inertness proof). Unit: state machine transitions, set-contents validation.

## Deliverable
PR `N6-13: CSSD instrument tracking` + ledger. Stop after PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl6-13-cssd.md` and `_worker-common.md`; execute EXACTLY. Your migration block: <ASSIGN>. STOP after the PR; report PR number + ledger.
