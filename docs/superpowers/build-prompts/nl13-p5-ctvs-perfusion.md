# BUILD: NL-13 P5 — CTVS & perfusion seam (overlays, perfusion records, device links, sign-offs)

You are implementing **NL-13 P5** for the VH Health Platform. The approved design is on `github/main`: `docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md` — read it in full; your scope is **`## Suite 5 - CTVS And Perfusion Seam`** (spec:221-257) exactly — the MINIMAL CTVS/perfusion record seam linked to existing theatre cases + anesthesia charts, NOT a full CTVS workflow (spec:233-235) — plus the shared Non-Negotiable Boundaries (spec:14-20). Also read `_worker-common.md` in this directory, `docs/CANONICAL_CLINICAL_TIMELINE.md`, and `apps/backend/CLAUDE.md`.

**Parallel-safety:** touches new backend tables + services/routes (theatre/perfusion seam) only; overlaps sibling NL-13 slices ONLY in `prisma/schema.prisma` and `src/docs/openapi.json` = parallel-safe.

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-13 Quaternary Specialty Suites Design Survey" github/main -- docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl13-p5"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl13-p5-ctvs-perfusion github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install
```
All work happens inside `$WT`. Push with `git push github feat/nl13-p5-ctvs-perfusion`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need the dev Postgres on `:5433` — start it per `apps/backend/CLAUDE.md` if down.

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared checkout — contamination incident history). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `openapi:generate` + `openapi:check`, commit `openapi.json`.
- Migrations: apply, then regenerate `schema.prisma` from a disposable scratch DB built from YOUR OWN worktree's migrations (see `_worker-common.md` — never from the shared QA/dev DB), commit `schema.prisma` with the `.sql`; then `node apps/backend/scripts/check-phi-tenant-id.mjs` + `node apps/backend/scripts/check-schema-drift.mjs`.
- **Your reserved migration numbers: 542–545** (use in order, leave unused untaken). Numbers come only from playbook §5.

## Scope (deliver all — spec Suite 5, spec:221-257)

**Cross-cutting invariants (apply to every table):** All four tables are PHI and tenant-scoped — copy the **mig-356 RLS boilerplate** verbatim on each: `tenant_id UUID NOT NULL` with the GUC-aware default, `ENABLE` + `FORCE ROW LEVEL SECURITY`, the `tenant_isolation` policy, FK to `tenants`; service writes go through `setTenantTx` with an EXPLICIT `tenant_id` on every insert (spec:14-20). Build a MINIMAL seam that LINKS existing theatre cases + anesthesia charts (spec:233-235; apps/backend/src/migrations/116_surgical_clinical_entities.sql:17-43, :118-255, 163_anesthesia_chart_and_microbiology.sql:23-56) — do NOT re-model theatre. **Canonical timeline invariant** (`docs/CANONICAL_CLINICAL_TIMELINE.md`, spec:18): perfusion records + sign-offs are patient-facing clinical writes — detail row + `clinical_timeline_events` + `clinical_audit_events` in ONE transaction, reusing the theatre/surgical-documentation canonical emit pattern (apps/backend/src/services/theatre/theatreService.js:454-474, surgicalDocumentationService.js:208). **Privilege gates** use the N6-5 credentialing pattern — `hasActivePrivilege` / `enforcePrivilegeGate` (apps/backend/src/services/staff/credentialingService.js:685-725), never inline role checks. **Owner-decision handling:** perfusion record policy, perfusionist sign-off policy, device/vendor source documents, and (if hybrid-OR radiation is in scope) AERB-adjacent evidence are owner-sourced (spec:255-257, spec:313) — ship them as evidence-owner fields + source/version metadata slots + attachment slots that stay INERT until the operator supplies content; NEVER encode regulatory text or a privilege key from model memory. **Wire-shaping:** ACT/temperature/bypass-time columns are NUMERIC — apply the Decimal→`toNumber()` guard from `_worker-common.md` before serializing.

1. **`ctvs_case_overlays`** (mig **542**) per spec:239 — theatre case link, procedure category, bypass expected, blood-product readiness, implant/device readiness.
2. **`perfusion_records`** (mig **543**) per spec:240 — theatre case, perfusionist, bypass start/end, cross-clamp start/end, ACT/temperature summaries, fluids/products summary, complications. Patient-facing write → canonical triple; validate bypass/cross-clamp time ordering.
3. **`perfusion_signoffs`** (SAME mig **543** as `perfusion_records` — ONE migration file `543_*.sql` creates both tables, per the spec's "perfusion records/signoffs" bundling; do NOT create a second 543 file) per spec:242 — perfusionist sign-off, surgeon review, anesthesia review, canonical event; sign-off gates enforce the required reviews before finalize.
4. **`perfusion_device_links`** (mig **544**) per spec:241 — NL-7 association reference, vendor document reference, summary import status. **Device-data contract: `perfusion_device_links` require an ACTIVE NL-7 `device_patient_associations` row** (apps/backend/src/migrations/372_device_patient_associations.sql:35-51); enforce with the contract test (spec:252). Do NOT implement pump-specific protocol ingestion in CTVS code — NL-7 owns device registry + ingest (spec:233-235; apps/backend/src/migrations/371_device_registry.sql:27-40).
5. **Privilege/catalog seed** (mig **545**) — perfusionist sign-off privilege key catalog row on the N6-5 seed pattern (apps/backend/src/migrations/380_privilege_catalog_seed_and_approval_indexes.sql:5-15), with the key name as an INERT owner-supplied slot; gate stays off until the owner confirms it (spec:255-257, spec:313).
6. **Backend services + routes** — CTVS-overlay / perfusion-record / sign-off / device-link services + REST routes. `success()`/`error()` helpers, `phiAccessLogger` on PHI routes, parameterized SQL. Route changes ⇒ regenerate + commit `openapi.json`.

## Tests (spec Suite 5 Test Strategy, spec:248-253)
- Unit: bypass/cross-clamp time validation, sign-off gates, theatre-case linkage.
- Deep: theatre case → perfusion summary → anesthesia link → canonical timeline/audit evidence.
- Contract: perfusion device links require active NL-7 associations (apps/backend/src/migrations/372_device_patient_associations.sql:35-51).
- Regression: theatre documentation unchanged — perfusion additions must not disturb existing surgical/anesthesia flows (apps/backend/src/services/theatre/theatreService.js:454-474, surgicalDocumentationService.js:208).

## Deliverable
Branch `feat/nl13-p5-ctvs-perfusion`, PR titled `NL-13 P5: CTVS & perfusion seam (overlays, perfusion records, device links, sign-offs)`. PR body = build ledger: scope delivered · invariants held (RLS, canonical triple, device-link contract, INERT owner slots, theatre regression) · migration numbers used (542–545) · exact test commands + pass counts · anything deferred and why. ALL checks green (re-query `gh pr checks`; `--watch` lies). **STOP after the PR** — coordinator verifies and merges.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl13-p5-ctvs-perfusion.md` and `_worker-common.md` beside it, plus the spec `docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md`; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: 542–545. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
