# BUILD: N6-12 — Mortuary body chain (slots + custody on death records)

**Plan:** `docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md` §4.9 (mortuary paragraph). Read fully, plus `_worker-common.md`. Death certification is SOLID (mig 167: MCCD Form-4, medicolegal release gates, M&M reviews, per-tenant serials, admin page) — do not rebuild any of it. Missing = body storage/custody only. Transport/porter dispatch is NL-8 territory — this slice ends at custody/release records.

## Start gate
```
git fetch github
git grep -q "death_certification" github/main -- apps/backend/src/migrations
```

## Workspace
Worktree `VH-Health-Platform-nl6-12`, branch `feat/nl6-12-mortuary`. Backend + admin.

## Scope
~1–2 migrations, tenant RLS: `mortuary_slots` (cooler slot registry: code, status, location FK) · `body_custody_events` (append-only chain hooked to `death_records`: receive → store(slot) → release, witness fields, timestamps; release step must respect the EXISTING medicolegal gate — `recordBodyRelease` already blocks without police clearance, reuse it) · unclaimed-body escalation timers riding the existing escalation engine (notify → department head → leadership). Admin: mortuary board (occupancy, chain per body, unclaimed list).

Deceased-subject writes: audit trail + custody chain, not patient timeline events (the patient's clinical timeline ended at death certification).

## Tests
Deep: certify → receive → store → release walk with the medicolegal block asserted (release refused without clearance); custody chain append-only (no updates); slot occupancy consistency; unclaimed escalation fires on seeded timer. Unit: chain-integrity validation.

## Deliverable
PR `N6-12: mortuary body chain (slots, custody, unclaimed escalation)` + ledger. Stop after PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl6-12-mortuary.md` and `_worker-common.md`; execute EXACTLY. Your migration block: <ASSIGN>. STOP after the PR; report PR number + ledger.
