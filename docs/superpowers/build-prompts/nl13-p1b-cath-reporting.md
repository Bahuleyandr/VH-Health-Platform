# BUILD: NL-13 P1b — Cath-lab reporting: templated Angiogram/PTCA/PPI reports, sign-off, addenda, DICOM viewer links

You are implementing **NL-13 P1b (Cath-lab Reporting)** for the VH Health Platform — the follow-up slice to the merged NL-13 P1 cath-lab workflow (migs 482–488, PR #536). Read `_worker-common.md` beside this file, `docs/CANONICAL_CLINICAL_TIMELINE.md`, `apps/backend/CLAUDE.md`, and the NL-13 spec's Suite 1 (`docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md`) for context. **Mirror the radiology reporting pattern** (migs 375–377: `radiology_report_templates` sections/coded-fields shape, report lifecycle, sign-off, addenda, TAT) — do not invent a new reporting architecture.

**Owner access decisions (2026-07-11, binding — playbook §7):**
- **Image/viewer access**: doctor family + `CATH_LAB_INCHARGE` + `CATH_LAB_STAFF` + `NURSING_STAFF` + `TECHNICIAN` + `ADMIN`/`SUPER_ADMIN` only.
- **Report draft/edit**: doctor family + `RECEPTIONIST` (transcription workflow) + `CATH_LAB_INCHARGE`.
- **Report SIGN**: doctors only — and gated through the cath credentialing privilege (mig-488 slot, N6-5 `hasActivePrivilege`/`enforcePrivilegeGate` pattern) so signing tightens to credentialed cardiologists / vascular surgeons / CTVS once the owner enters credential rows. Activate the mig-488 privilege slot for the SIGNING key (flip from `paused` for `cath_report_signing`); fail CLOSED when the gate is enabled and the signer lacks the credential. A separate `CATH_REPORT_SIGN_ROLES` config (doctor family) is the role floor beneath the privilege gate.
- **Audit**: every report view/edit/sign/addendum AND every viewer-link resolution emits a `clinical_audit_events` row (the `/api/v1/cath-lab` mount's `phiAccessLogger` stays, this is additive).

**Parallel-safety:** backend tables/service/routes + staff cath workbench; overlaps siblings only in `prisma/schema.prisma` / `openapi.json` (regenerate, never hand-merge) = parallel-safe.

## Start gate (run before anything)
```
git fetch github
git grep -q "cath_lab_cases" github/main -- apps/backend/src/migrations/482_cath_lab_cases_readiness.sql
git ls-tree --name-only github/main:apps/backend/src/migrations | grep -qE "^48[2-8]_"
```
Exit 0 → proceed. Exit 1 → STOP and report (P1 must be on main).

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl13-p1b"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl13-p1b-cath-reporting github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get
```
All work happens inside `$WT`. Backend tests need dev Postgres on `:5433`.

## Environment & isolation (MANDATORY)
- NEVER touch the shared checkout. Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `openapi:generate` + `openapi:check` + `openapi:sync-core`, commit artifacts. Staff strings through the staff app's `AppStrings`/`app_strings.dart` mechanism (all five locale maps). `melos run analyze && melos run test` + `node scripts/dart-format-check.mjs` before push.
- Migrations: bare DDL at `apps/backend/src/migrations/NNN_*.sql`; regenerate `schema.prisma` ONLY from a disposable scratch DB of your own worktree; commit with the `.sql`; run `check-phi-tenant-id.mjs` + `check-schema-drift.mjs`.
- **Your reserved migration numbers: 555–557** (use in order; leave unused untaken; numbers only from playbook §5).
- All new tables are PHI: mig-356 RLS boilerplate (tenant_id NOT NULL + GUC default, ENABLE+FORCE RLS, tenant_isolation policy, FK to tenants); explicit tenant_id via `setTenantTx` on every insert.

## Scope (deliver all)
1. **`cath_report_templates`** (mig **555**) — mirror `radiology_report_templates` (375): `template_code`, `name`, **`report_type` CHECK IN ('angiogram','ptca','ppi','device_implant','ep_study','procedure_note','other')**, `sections` JSONB (narrative sections), `coded_fields_schema` JSONB (structured fields: vessels/lesions/stents for PTCA, device/lead parameters for PPI, hemodynamic references), versioned (`version`, `is_active`, supersede rather than mutate), created_by/audit columns. Seed one starter template per report_type marked `starter: true` in metadata (content = neutral section scaffolds like "Indication", "Access", "Findings", "Result", "Recommendations" — NO clinical protocol text from model memory).
2. **`cath_procedure_reports` + `cath_report_addenda`** (mig **556**) — report links `case_id` + optional `procedure_log_id` + `patient_uid` + `encounter_id`; `template_id`+`template_version` stamped; `narrative_sections` JSONB + `coded_fields` JSONB; **lifecycle `draft → preliminary → signed` (CHECK)** with `signed_by`/`signed_at`; post-sign edits FORBIDDEN — corrections are append-only `cath_report_addenda` rows (author, reason, narrative, timestamps). `viewer_study_accession` nullable (deep-link seam, see item 5). Partial unique: at most one non-addendum report per (procedure_log_id, report_type) when signed.
3. **Report service + routes** under the existing `/api/v1/cath-lab` mount (`apps/backend/src/services/clinical/cathLabService.js` may grow a sibling `cathReportService.js`): CRUD per the access matrix above — draft/edit gate (`CATH_REPORT_EDIT_ROLES` = doctor family + RECEPTIONIST + CATH_LAB_INCHARGE), sign gate (`CATH_REPORT_SIGN_ROLES` = doctor family) **plus** the mig-488 privilege check via `enforcePrivilegeGate` (activate the `cath_report_signing` key: flip the 488 catalog row from `paused`; gate enforcement fails CLOSED when enabled and uncredentialed). **Canonical timeline invariant**: report signed + addendum added are patient-facing clinical writes → detail row + `clinical_timeline_events` + `clinical_audit_events` in ONE transaction. Draft edits emit audit events (not timeline). Every GET of a signed report emits an audit read event (report-level, additive to phiAccessLogger).
4. **Report TAT metrics** (mig **557**, optional third migration — fold into 556 if trivial): procedure-end → report-signed interval surfaced per case list row (the radiology 377 pattern); no new dashboards, just the columns/index + list-endpoint field.
5. **DICOM viewer deep links** — reuse `apps/backend/src/services/radiology/pacsService.js` (`buildViewerUrl`, `linkStudy`): a cath report/case exposes `viewer_url` resolved from the case's `cath_device_links` row with `link_type='angiography_accession'` (or the report's own `viewer_study_accession`). **Access to the viewer-link endpoint is gated to the owner's image-viewing role list** (doctor family + CATH_LAB_INCHARGE + CATH_LAB_STAFF + NURSING_STAFF + TECHNICIAN + ADMIN/SUPER_ADMIN) and every resolution emits an audit event. If PACS is not configured (`getPacsConfig().enabled === false`), return `viewer_url: null` with `viewer_status: 'pacs_not_configured'` — never a broken link.
6. **Staff app** — extend the cath workbench (`apps/staff/lib/features/cath_lab/`): report list per case, template-driven report editor (narrative sections + coded fields), preliminary/sign actions (sign visible only to signer roles), addendum flow, "Open images" button (viewer deep link, hidden when `pacs_not_configured`), loading/empty/error states, strings in all five locale maps.
7. **Printable artifact** — signed report renders to PDF via the existing backend PDF infrastructure (pdfkit precedent): header (patient/case/procedure), sections, coded-field tables, signer + timestamp, addenda appended chronologically. Endpoint gated like report reads; emits audit event.

## Tests
- Unit: template versioning/supersede; report lifecycle transitions (draft→preliminary→signed; post-sign edit rejected; addendum append-only); edit-gate matrix (receptionist can draft, cannot sign; technician cannot edit); sign privilege gate fail-closed when enabled; viewer-link role matrix + `pacs_not_configured` shape.
- Deep (real DB): case → procedure log → draft report from template → edit → preliminary → sign (canonical timeline+audit rows asserted in-tx) → addendum → PDF render → TAT populated; viewer-link resolution audited; RLS both directions; tenant isolation.
- Staff widget tests: editor render from template sections, sign-button visibility by role, addendum flow, images-button hidden when PACS off.

## Deliverable
Branch `feat/nl13-p1b-cath-reporting`, PR titled `NL-13 P1b: cath-lab reporting (templates, sign-off, addenda, viewer links)`. PR body = build ledger (scope · invariants · migration numbers used · exact test commands + pass counts · deferrals). ALL checks green (re-query; `--watch` lies). **STOP after opening the PR** — the coordinator verifies and merges. One scope = one PR; no force-push after the PR opens; hand post-PR fixes to the coordinator.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl13-p1b-cath-reporting.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: 555–557. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
