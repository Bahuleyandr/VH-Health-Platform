# BUILD: N6-6 — Infection-control depth (isolation orders, HAI, outbreaks, hand hygiene)

**Plan:** `docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md` §4.5. Read fully, plus `_worker-common.md`. Workbench v1 (mig 296: isolation board, contact tracing, antibiogram) + micro model (mig 163) exist. Prefer landing after N6-5 so ICO privilege gates are available (optional-use, not blocking).

## Start gate
```
git fetch github
git grep -q "infection_control_workbench" github/main -- apps/backend/src/migrations
```

## Workspace
Worktree `VH-Health-Platform-nl6-6`, branch `feat/nl6-6-infection-depth`. Backend + admin.

## Scope (plan §4.5, in its ranked order)
~4 migrations, tenant RLS: 1) `isolation_orders` (order → auto bed/command-board flag → precaution checklist riding the surgical-checklist item pattern → housekeeping terminal-clean task hook on discharge). 2) `device_presence_logs` (per admission: catheter/central-line/ventilator start/stop — thin table, big payoff) → HAI denominators + `hai_cases` (CAUTI/CLABSI/VAP/SSI typed over `infection_cases`) → rates into `nabh_indicator_snapshots` (mig 286). 3) `outbreak_episodes` + episode-case linking (line list, suspected→confirmed→closed) + cluster-suggestion query (same organism + ward overlap ≤14d — generalize the existing contact-tracing SQL) + epi-curve data endpoint (render client-side). 4) `hand_hygiene_audits` (observation sessions + moments + compliance %). **IDSP/IHIP export stays deferred** (owner must source the current format) — land only the notifiable-disease flag on diagnoses.

HAI/outbreak case writes are patient-linked → canonical timeline events with `visible_to_patient=false` default. Roles: INFECTION_CONTROL_OFFICER + QUALITY_OFFICER (both exist). Aggregations stay tenant-scoped (the mig-296 RLS lesson).

## Tests
Deep: isolation order → board flag → terminal-clean task; device-days → HAI rate math (fixed seeds via `hospitalToday`); outbreak grouping (seeded cluster found, singleton not). Unit: denominators, compliance %, cluster query. Extend `infection-control.deep.test.js`.

## Deliverable
PR `N6-6: infection-control depth (isolation, HAI, outbreaks, hand hygiene)` + ledger. Stop after PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl6-06-infection-depth.md` and `_worker-common.md`; execute EXACTLY. Your migration block: <ASSIGN>. STOP after the PR; report PR number + ledger.
