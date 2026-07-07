# BUILD: N6-3 — Blood bank donor cycle B: TTI, components, traceability, registers

**Plan:** `docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md` §4.1 (BB-B). Read fully, plus `_worker-common.md`.
**GATES:** (1) N6-2 merged; (2) statutory register formats sourced (playbook Open Decision 3) — if not yet sourced, ship register exports flagged "format pending" per the plan.

## Start gate
```
git fetch github
git grep -qE "CREATE TABLE (IF NOT EXISTS )?donors" github/main -- apps/backend/src/migrations
```

## Workspace
Worktree `VH-Health-Platform-nl6-3`, branch `feat/nl6-3-donor-processing`. Backend + admin.

## Scope (plan §4.1 BB-B)
~4 migrations: `tti_tests` (panel, results, approver gated on lab signer roles — `PATHOLOGIST_SIGN_ROLES`, repeat logic; **positive → auto permanent deferral + unit quarantine/discard chain** — this cascade is the safety heart of the slice) · `component_preparations` (parent unit → child units with genealogy; child rows insert into the EXISTING `blood_units` so the transfusion loop is untouched) · `donor_id` nullable FK added to `blood_units` (external units keep `source_blood_bank`) · traceability lookups (transfused unit → donor + sibling components) · statutory register exports (donor, collection, TTI, component prep, deferral, discard — pdfkit/exceljs over the new tables, mig-150 register pattern) · thin donor-camp records. Extend `staff:blood-bank` realtime emitters.

**Note:** auto-quarantine here acts on UNITS from a TTI-positive DONATION (a lab-driven safety cascade inside the blood bank) — distinct from NL-7's cold-chain rule where environmental excursions must never auto-discard. Keep the cascade audited and reversible (quarantine → human-confirmed discard).

## Tests
TTI-positive cascade deep test (deferral + quarantine of all sibling components); genealogy/expiry derivation unit tests; traceability lookup; donor→transfusion full-loop deep test (register → screen → collect → TTI pass → separate → crossmatch through the EXISTING flow); register export goldens; tenant isolation.

## Deliverable
PR `N6-3: donor processing (TTI, components, traceability, registers)` + ledger. Stop after PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl6-03-donor-processing.md` and `_worker-common.md`; execute EXACTLY (gates first). Your migration block: <ASSIGN>. STOP after the PR; report PR number + ledger.
