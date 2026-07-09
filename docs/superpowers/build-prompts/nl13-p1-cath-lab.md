# BUILD: NL-13 P1 — Invasive cardiology & cath-lab workflow (cases, readiness, procedure logs, dose/contrast, device links)

You are implementing **NL-13 P1** for the VH Health Platform. The approved design is on `github/main`: `docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md` — read it in full; your scope is **`## Suite 1 - Invasive Cardiology And Cath-Lab Workflow`** (spec:58-98) exactly, plus the shared Non-Negotiable Boundaries (spec:14-20). Cath-lab is the highest-reuse first slice (spec:300). Also read `_worker-common.md` in this directory, `docs/CANONICAL_CLINICAL_TIMELINE.md`, `apps/backend/CLAUDE.md`, and `apps/staff/CLAUDE.md`.

**Parallel-safety:** touches new backend tables + services/routes and the staff-app cath-lab screen + `intl_*.arb`; overlaps sibling NL-13 slices ONLY in `prisma/schema.prisma` and `src/docs/openapi.json` = parallel-safe.

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-13 Quaternary Specialty Suites Design Survey" github/main -- docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl13-p1"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl13-p1-cath-lab github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install
dart pub get   # Flutter workspace (staff-app cath-lab screen)
```
All work happens inside `$WT`. Push with `git push github feat/nl13-p1-cath-lab`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need the dev Postgres on `:5433` — start it per `apps/backend/CLAUDE.md` if down. Staff-app gate is `melos run analyze && melos run test`.

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared checkout — contamination incident history). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `openapi:generate` + `openapi:check`, commit `openapi.json`. Staff-app changes ⇒ `melos run analyze && melos run test`; ALL user-facing strings through the 5-language `intl_*.arb` sweep (i18n guard enforces).
- Migrations: apply, then regenerate `schema.prisma` from a disposable scratch DB built from YOUR OWN worktree's migrations (see `_worker-common.md` — never from the shared QA/dev DB), commit `schema.prisma` with the `.sql`; then `node apps/backend/scripts/check-phi-tenant-id.mjs` + `node apps/backend/scripts/check-schema-drift.mjs`.
- **Your reserved migration numbers: 482–488** (use in order, leave unused untaken). Numbers come only from playbook §5.

## Scope (deliver all — spec Suite 1, spec:58-98)

**Cross-cutting invariants (apply to every table):** All seven tables are PHI and tenant-scoped — copy the **mig-356 RLS boilerplate** verbatim on each: `tenant_id UUID NOT NULL` with the GUC-aware default, `ENABLE` + `FORCE ROW LEVEL SECURITY`, the `tenant_isolation` policy, FK to `tenants`; service writes go through `setTenantTx` with an EXPLICIT `tenant_id` on every insert (spec:14-20). **Canonical timeline invariant** (`docs/CANONICAL_CLINICAL_TIMELINE.md`, spec:18): cath cases and procedure logs are patient-facing clinical writes — each such write persists the detail row + `clinical_timeline_events` + `clinical_audit_events` in ONE transaction (+ `workflow_sla_instances` where a door-to-balloon/SLA applies, spec:92). **Privilege gates** use the N6-5 credentialing pattern — `hasActivePrivilege` / `enforcePrivilegeGate` (apps/backend/src/services/staff/credentialingService.js:685-725), never inline role checks. **Owner-decision handling:** the AERB dose evidence and the cath-specific privilege KEY are owner-sourced (spec:69, spec:96-98, spec:309) — ship them as evidence-owner fields + source/version metadata slots + attachment slots that stay INERT until the operator supplies content; NEVER encode regulatory text or a privilege key from model memory. **Wire-shaping:** dose/contrast/fluoro-time columns are NUMERIC — apply the Decimal→`toNumber()` guard from `_worker-common.md` before serializing.

1. **`cath_lab_cases`** (mig **482**, with readiness) per spec:77 — patient, encounter, requested procedure, indication, urgency, lab room, status, planned/actual start/end, team, canonical timeline references. Case create + status-transition writes emit the canonical timeline+audit triple.
2. **`cath_lab_readiness_checks`** (mig **482**) per spec:78 — consent, labs, allergy/renal-risk, anticoagulation, blood-bank readiness, equipment, implants/device rep, timeout. Readiness-gate enforcement blocks procedure start until required checks pass.
3. **`cath_procedure_logs`** (mig **483**) per spec:79 — procedure type, access site, operators, sedation/anesthesia link, devices, findings summary, complications. Patient-facing write → canonical triple.
4. **`cath_hemodynamic_summaries`** (mig **484**) per spec:80 — summary observations + file/device references only; NO raw waveform storage.
5. **`cath_contrast_radiation_records`** (mig **485**) per spec:81 — contrast volume, fluoroscopy time, dose fields, dose document links, **AERB evidence attachment slot**. The AERB/dose-evidence fields are the owner-sourced substrate (evidence-owner field + source/version metadata slot + attachment slot), INERT until the operator supplies content (spec:96-98).
6. **`cath_post_procedure_orders`** (mig **486**) per spec:82 — recovery location, sheath/vascular closure, vitals frequency, antiplatelet/anticoagulation, complication watch.
7. **`cath_device_links`** (mig **487**) per spec:83 — NL-7 device association references, external system accession IDs, inbound document IDs. **Device-data contract: `cath_device_links` attach ONLY to an ACTIVE NL-7 `device_patient_associations` row** (apps/backend/src/migrations/372_device_patient_associations.sql:35-51); enforce with the contract test (spec:93). Do NOT build a device protocol stack in cath-lab code — NL-7 owns registry + ingest (spec:71-73; apps/backend/src/migrations/371_device_registry.sql:27-40, 373_device_ingest_policy.sql:46-73).
8. **Privilege/catalog seed** (mig **488**) — cath-specific privilege key catalog row on the N6-5 seed pattern (apps/backend/src/migrations/380_privilege_catalog_seed_and_approval_indexes.sql:5-15), with the key name as an INERT owner-supplied slot; gate stays off until the owner confirms it (spec:69, spec:87, spec:309).
9. **Backend services + routes** — cath-lab case / readiness / procedure / hemodynamic / dose-contrast / post-order / device-link services + REST routes behind the existing cath-lab role gates (`CATH_LAB_STAFF`, `CATH_LAB_INCHARGE`, `canAccessCathLab`; apps/backend/src/utils/roleHelpers.js:21-22, :294-306) and role-policy permissions (apps/backend/src/config/rolePolicyGraph.js:135-138, :825-876, :1042-1087). `success()`/`error()` helpers, `phiAccessLogger` on PHI routes, parameterized SQL. Route changes ⇒ regenerate + commit `openapi.json`.
10. **Staff app** — turn the placeholder `apps/staff/lib/features/cath_lab/screens/cath_lab_screen.dart` (currently schedule/readiness shells only, spec:63) into a first-class workflow: schedule, readiness, procedure state, dose/contrast summary, post-procedure orders, with empty/error/loading states. Every user-facing string added to ALL FIVE `intl_*.arb` files (i18n guard fails CI otherwise).

## Tests (spec Suite 1 Test Strategy, spec:89-94)
- Unit: readiness gating, cath case state transitions, contrast/radiation summary validation, privilege-gate enforcement, canonical event payloads.
- Deep integration: order/request → readiness → procedure log → dose/contrast summary → post-order → timeline/audit/SLA evidence.
- Contract: cath-device links attach only to active NL-7 device-patient associations (apps/backend/src/migrations/372_device_patient_associations.sql:35-51).
- Staff widget/screen: schedule, readiness, procedure state, empty/error states — the current UI is a placeholder shell (apps/staff/lib/features/cath_lab/screens/cath_lab_screen.dart:45-132).

## Deliverable
Branch `feat/nl13-p1-cath-lab`, PR titled `NL-13 P1: invasive cardiology & cath-lab workflow (cases, readiness, procedure logs, dose/contrast, device links)`. PR body = build ledger: scope delivered · invariants held (RLS, canonical triple, device-link contract, INERT owner/AERB/privilege slots) · migration numbers used (482–488) · exact test commands + pass counts · anything deferred and why. ALL checks green (re-query `gh pr checks`; `--watch` lies). **STOP after the PR** — coordinator verifies and merges.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl13-p1-cath-lab.md` and `_worker-common.md` beside it, plus the spec `docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md`; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: 482–488. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
