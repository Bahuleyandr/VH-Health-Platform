# BUILD: N6-8 — Dental completion (odontogram UI, seeds, billing linkage)

**Plan:** `docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md` §4.7. Read fully, plus `_worker-common.md`. Backend is COMPLETE (mig 292: FDI findings + procedures + canonical events + deep test). This slice is UI-heavy: there is zero dental UI anywhere. Safe filler batch any time after N6-1.

## Start gate
```
git fetch github
git grep -q "dental_charting" github/main -- apps/backend/src/migrations
```

## Workspace
Worktree `VH-Health-Platform-nl6-8`, branch `feat/nl6-8-dental-ui`. Staff app (primary) + backend seeds (`dart pub get`; i18n all 5 arb files).

## Scope (plan §4.7)
0–1 migrations (seeds only): staff-app dental module — odontogram grid (custom painter over FDI quadrants; data already shaped per tooth by `getChart`, `dentalService.js:158–195`), finding entry (FDI 11–48/51–85, surfaces, severity), procedure plan/complete flows (completion auto-resolves the linked finding — backend already does this), patient dental history · department + dentist seeds (`seed-departments-doctors-local.mjs` lists 20 departments, none dental) · dental procedure-code catalog seed + linkage to billing service items · optional: multi-visit treatment-plan surface reusing `care_plans` (`plan_kind` extension) — mini-design call, drop if it bloats the slice.

Verify FIRST that the generated Dart client (`melos codegen`) already covers the `/api/v1/dental` endpoints before building UI — regenerate if not.

## Tests
Flutter widget tests: odontogram FDI → grid-position mapping (permanent + deciduous ranges), finding-entry state, API-service tests per staff-app convention. Backend already covered; add one deep-test extension only if billing linkage lands.

## Deliverable
PR `N6-8: dental UI (odontogram, seeds, billing linkage)` + ledger. Stop after PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl6-08-dental-ui.md` and `_worker-common.md`; execute EXACTLY. Your migration block: <ASSIGN or none>. STOP after the PR; report PR number + ledger.
