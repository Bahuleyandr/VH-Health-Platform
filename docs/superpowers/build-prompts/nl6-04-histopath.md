# BUILD: N6-4 — Histopathology & cytology reporting (anatomic pathology)

**Plan:** `docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md` §4.2. Read fully, plus `_worker-common.md`. General lab rails are deep (specimens w/ `tissue` type, barcodes, sign-off roles, addendum precedent); anatomic pathology is zero — this is a greenfield on strong rails.

## Start gate (N6-1 merged — reuse its template pattern rather than inventing one)
```
git fetch github
git grep -q "radiology_report_templates" github/main -- apps/backend/src/migrations
```

## Workspace
Worktree `VH-Health-Platform-nl6-4`, branch `feat/nl6-4-histopath`. Backend + admin (staff app read-only view later).

## Scope (plan §4.2)
~4 migrations, tenant RLS: `ap_cases` (accessioned case over one or more EXISTING `lab_specimens` rows — reuse specimen accessioning, don't duplicate) · `ap_gross_records` · `ap_blocks` · `ap_slides` (stain enum H&E/special/IHC; barcode via existing label pattern) · `ap_reports` (sectioned: gross_text/micro_text/diagnosis_text; `report_status` draft→preliminary→final→amended copying the radiology status set; **signer gate = NEW constant `AP_REPORT_SIGN_ROLES = [PATHOLOGIST]`** — mirrors radiology's no-ADMIN stance; the existing `PATHOLOGIST_SIGN_ROLES` includes ADMIN/LAB_INCHARGE and must NOT be reused; typed `malignancy_flag` for later oncology linkage) · `ap_report_addenda` (copy radiology addendum semantics). Catalog: seed AP test codes (HISTO-BIOPSY, FROZEN, FNAC, PAP, FLUID-CYTO) into the investigation catalog so ordering rides the existing order path (canonical events come free from `investigationService`). Frozen-section priority rides specimen `priority='stat'`. Admin AP worklist (accession → grossing → blocks/slides → report → sign-off) with TAT columns.

Every AP state change emits canonical events (`pathology.*` subtypes or the `investigation.event` family — mini-design call, registry is source-table driven per `canonicalClinicalPlatformService.js`).

## Tests
Deep: specimen → accession → gross → block → slide → draft report → **non-pathologist sign-off rejected** → pathologist sign-off → addendum append → timeline events asserted (copy `transfusion-loop.deep.test.js` shape). Cytology variant = same test parameterized on case kind. Unit: block/slide ID derivation, status machine, TAT.

## Deliverable
PR `N6-4: histopathology & cytology reporting` + ledger. Stop after PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl6-04-histopath.md` and `_worker-common.md`; execute EXACTLY. Your migration block: <ASSIGN>. STOP after the PR; report PR number + ledger.
