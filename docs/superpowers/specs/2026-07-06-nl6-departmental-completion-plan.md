# NL-6 Departmental Completion — Grounded Gap Inventory and Slice Plan

**Date:** 2026-07-06 (survey executed 2026-07-07 against main `123977a1`)
**Status:** Survey + slice sequencing for owner sign-off; design/survey only — no code
**Program:** NL-6 departmental completion (`docs/NEXT_LEVEL_ROADMAP.md` §5)
**Surface:** backend + admin portal + staff app, per department

## 1. Non-Goals and Program Boundaries

This document proposes no application code, migrations, generated clients, or UI
changes. It is the grounded inventory that turns the roadmap's one-line NL-6 entry
into a sequence of buildable batches, each with its own mini-design at build time.

Boundaries with sibling programs, so slices do not bleed:

- **NL-7 owns device bridges.** Anything that talks to a physical machine
  (HL7v2/ASTM/proprietary framing, LAN listeners, device authentication) is NL-7.
  The dialysis slice here ends at the already-shipped JSON ingest seam
  (`apps/backend/src/routes/clinical/dialysisRoutes.js:186`); §4.6 documents that
  boundary precisely. Cold-chain IoT, RTLS, and CMMS depth are NL-7 as per the
  roadmap.
- **NL-5 owns terminology and clinical content.** Histopath/cytology and radiology
  slices ship template *structure* (sections, statuses, discrete fields), not
  licensed content packs (Bethesda text, BI-RADS lexicons, SNOMED bindings). Where
  a slice needs codes today it uses the free-text-plus-code-column convention the
  repo already uses (`organism_code` in
  `apps/backend/src/migrations/163_anesthesia_chart_and_microbiology.sql:106`).
- **NL-8 owns porter/transport and scheduling 2.0.** The mortuary slice ends at
  custody/release records, not transport task dispatch.
- **NL-12 owns the NABH indicator exporter and the general statutory
  register/report PACK.** Department-specific statutory registers (blood-bank donor
  and component registers, dialyzer reuse register) are in-slice here because they
  are inseparable from the department workflow; the cross-department printable
  register pack (OPD/IPD/birth/death/MLC) stays NL-12/NL-11 territory.

## 2. Headline Survey Finding

The roadmap §3.E one-liners undersell what exists. Migrations **286–296** were a
backend-only "pillar D" foundations batch that already landed API-complete modules
for six of the NL-6 departments:

| Mig | Module | State found in survey |
|---|---|---|
| 286 | NABH indicator snapshots | table + RLS, reusable for HAI indicators |
| 287 | **Staff credentialing** | table + service + routes + one live privilege consumer |
| 290 | **Oncology chemo** | protocols/plans/cycles/BSA dosing/two-person verify + tests |
| 291 | **Dialysis depth** | prescriptions, structured events, device-source obs |
| 292 | **Dental charting** | FDI findings + procedures + canonical events + tests |
| 293 | **Ophthalmology exams** | per-eye VA/IOP/refractions + glaucoma alert + tests |
| 296 | **Infection-control workbench** | isolation board, contact tracing, antibiogram |

None of these has a staff-app UI, and several lack admin UI. So NL-6 splits into
three kinds of work, and the slice plan reflects it:

1. **Completion slices** — UI, workflow wiring, and depth on pillar-D foundations
   (dental, ophthalmology, dialysis, credentialing, infection control, oncology
   chairs).
2. **True greenfields** — blood-bank donor cycle, histopath/cytology, physio/rehab,
   CSSD, linen, mortuary body chain. Zero schema exists for these.
3. **Additive layers on complete substrate** — radiology structured reporting +
   peer review on the finished order/report/sign-off lifecycle.

Every claim below was verified by reading the code on 2026-07-07; citations are
`path:line` against main `123977a1`.

## 3. Binding Invariants Every Slice Inherits

These are restated per-department only where a department has a twist; otherwise
each build batch inherits all of them.

1. **Canonical timeline event per clinical write.** Table
   `clinical_timeline_events` with idempotency keys
   (`apps/backend/src/migrations/269_canonical_clinical_platform.sql:55`); writer
   helper in `apps/backend/src/services/clinical/canonicalClinicalPlatformService.js`.
   Live examples to copy: `dental.finding_recorded`
   (`apps/backend/src/services/clinical/dentalService.js:87`),
   `ophtho.exam_recorded` + `ophtho.exam_recorded_iop_alert`
   (`apps/backend/src/services/clinical/ophthalmologyService.js:107`),
   `dialysis.completed` / `dialysis.prescribed` / `dialysis.complication`
   (`apps/backend/src/services/clinical/dialysisService.js`), and the transfusion
   loop (`apps/backend/src/services/bloodbank/transfusionSafetyService.js:80`).
2. **RBAC via roleHelpers.** All role constants and group arrays live in
   `apps/backend/src/utils/roleHelpers.js:8–184`. Relevant pre-existing roles:
   `BLOOD_BANK_TECHNICIAN`, `PATHOLOGIST`, `LAB_INCHARGE`, `RADIOLOGIST`,
   `RADIOLOGY_STAFF`, `INFECTION_CONTROL_OFFICER`, `PHYSIOTHERAPIST`,
   `QUALITY_OFFICER` — no new top-level roles are needed for any slice below.
   Signer-gate precedents: `PATHOLOGIST_SIGN_ROLES` (roleHelpers.js:246),
   `RADIOLOGY_REPORT_SIGN_ROLES` = `[RADIOLOGIST]` with deliberately no ADMIN
   override (roleHelpers.js:253), `DISCHARGE_SUMMARY_SIGN_ROLES` excluding
   RESIDENT (roleHelpers.js:211). Route mounts gate via `requireRole` +
   capability groups (`apps/backend/src/config/routeRolePolicy.js`; e.g. dental
   mount `apps/backend/src/app.js:962`).
3. **Per-tenant RLS on every new PHI table.** Follow the mig-356 boilerplate
   exactly: `tenant_id UUID NOT NULL` with the GUC-aware default, `ENABLE` +
   `FORCE ROW LEVEL SECURITY`, the `tenant_isolation` policy, FK to `tenants`
   (`apps/backend/src/migrations/356_consent_signatures.sql:15–69`). Services set
   context via `setTenant`(`apps/backend/src/lib/prisma.js:37`). Remember the
   known caveat: non-default-tenant inserts must pass explicit `tenant_id` or the
   literal default bites (see memory/lessons; verified pattern in recent
   migrations).
4. **tz-safe seeds.** Anything seeding or asserting "today" uses the IST-safe
   date: `istDateString` (`apps/backend/src/utils/dateUtils.js:20`) in services,
   the `hospitalToday` Intl pattern in tests
   (`apps/backend/src/tests/clinical-mar-contract.deep.test.js`, journeys
   `follow-up-opd` / `obstetric-anc`).
5. **OpenAPI gate.** Any route change requires `npm run openapi:generate` and a
   committed `apps/backend/src/docs/openapi.json`; CI enforces via
   `apps/backend/scripts/check-openapi-drift.mjs`. Flutter-facing surfaces then
   regenerate the Dart client (`melos codegen` → `packages/vhhealth_core`).
6. **Migration mechanics.** Raw SQL in `apps/backend/src/migrations/NNN_*.sql` is
   the source of truth; runner tolerates numbering gaps
   (`apps/backend/src/utils/migrations/runMigrations.js`). As of this survey the
   max applied number is **367**; **368 is reserved** for the in-flight NL-1 P4
   SAML batch. Each NL-6 batch must re-verify the next free number via
   `ls apps/backend/src/migrations` at start (the 358/360/362–365 gaps are
   released reservations, safe to reuse but cleaner to continue from the top).
   After writing SQL: apply locally, `npx prisma db pull`, commit `.sql` +
   `schema.prisma` together.
7. **Realtime pattern.** Department dashboards ride the outbox → drain → WS
   fan-out fabric with PHI-free `{kind, at}` events and per-channel RBAC —
   precedents: `staff:blood-bank`, `staff:radiology`, `staff:micro`,
   `staff:dialysis-board` (design docs under `docs/superpowers/specs/2026-06-29-*`,
   emitters in the respective route files). New boards copy that shape; do not
   invent new transport.
8. **Statutory/export machinery.** PDF via pdfkit
   (`apps/backend/src/services/documents/clinicalPdfGenerator.js`), Excel/CSV via
   exceljs (`apps/backend/src/services/record/exportService.js:54`). The
   register-table precedent is `pharmacy_schedule_register`
   (`apps/backend/src/migrations/150_pharmacy_schedule_register.sql`).
9. **Test tiers.** Pure logic → `src/tests/unit/*.test.js`; workflow →
   `*-deep.test.js` (DB-gated via `DB_CONFIGURED`); cross-department flows →
   `src/tests/journeys/` (11 exist; `_journeyHarness.js` shared). Runner chunks
   via `apps/backend/scripts/run-ci-jest.mjs`. Realtime channels get emitter +
   channel-RBAC unit tests (precedent: `unit/bloodBankRealtimeChannel.test.js`).
10. **Feature gating.** Per-tenant module toggles copy the tenant-scoped
    settings-table pattern (`composition_search_settings`, migration 351 +
    `compositionFeatureService.js` — per-tenant cache, fail-closed); the global
    `feature_flags` table (`featureFlagService.js`) is NOT tenant-scoped and
    must not carry per-tenant state. Enforcement flips follow the
    `REQUIRE_ADMIN_PRIVILEGE()`-style env-flag
    pattern already used by the chemo privilege gate
    (`apps/backend/src/services/oncology/chemoService.js:571`): ship inert,
    flip per tenant with evidence.

## 4. Department Surveys

Format per department: **Exists** (cited) → **Gaps** → **Scope sketch** →
**Migrations** (count estimate) → **Test strategy** → **Invariant notes**.

---

### 4.1 Blood bank — the missing donor cycle

**Exists (transfusion side — complete and production-shaped).**
- `blood_units` registry with unit number, group, component enum
  (whole_blood/prbc/ffp/platelets/cryoprecipitate), status lifecycle
  (available→…→transfused/discarded/expired/returned), expiry — and only two
  donor-adjacent columns: free-text `donor_ref` and `source_blood_bank`
  (`apps/backend/src/migrations/280_transfusion_closed_loop.sql:29–56`, donor_ref
  at :39). Units enter inventory via `POST /blood-bank/units`
  (`apps/backend/src/routes/bloodbank/bloodBankRoutes.js:150–167`) — i.e. the
  system today models a **blood storage centre** receiving labelled units from an
  external licensed bank.
- Request → unit-level crossmatch with ABO/Rh compatibility matrix and audited
  override (`apps/backend/src/services/bloodbank/transfusionSafetyService.js:31–77,
  162–231`), two-person bedside verification with scan evidence and
  different-human enforcement (:238–368), start/complete transfusion (:416–486),
  structured hemovigilance reactions
  (`280_transfusion_closed_loop.sql:89–113`).
- Canonical events in-transaction for every step
  (`transfusionSafetyService.js:80–103`); realtime channel `staff:blood-bank`
  (spec `docs/superpowers/specs/2026-06-29-realtime-dashboards-blood-bank-design.md`);
  staff app screens (`apps/staff/lib/features/bloodbank/screens/blood_bank_screen.dart`)
  and admin page (`apps/admin/src/app/(with-auth)/dashboard/blood-bank/page.tsx`);
  deep test `apps/backend/src/tests/transfusion-loop.deep.test.js`; AI demand
  forecast module (mig 050, decision-support only).

**Gaps (donor cycle — entirely absent; every item below verified missing).**
- No donor registry of any kind (no `donors` table; `donor_ref` is free text with
  no FK).
- No donor screening questionnaire, no deferral registry (temporary/permanent,
  reasons, reactivation), no donor eligibility lifecycle.
- No collection/phlebotomy records (collection event, donor vitals pre/post,
  adverse donor reactions, volumes/timing).
- No TTI (transfusion-transmissible infection) testing workflow — order, result,
  approval, positive-result deferral + unit quarantine/discard chain.
- No component preparation/separation (whole blood → PRBC/FFP/platelets with
  parent-unit genealogy and per-component expiry).
- No donor→unit traceability (given a transfused unit, find donor and sibling
  components).
- No blood-bank statutory registers (donor, collection, TTI, component
  preparation, deferral, discard); the register table pattern exists only for
  pharmacy (mig 150).
- No donor recruitment/camp constructs.

**Scope sketch.** Two batches.
- *BB-A Donor intake:* `donors` (demographics + ABO/Rh + status lifecycle),
  `donor_screenings` (questionnaire JSONB + verdict + auto-deferral rules),
  `donor_deferrals` (reason codes, until-date, permanent flag, reactivation),
  `donation_events` (camp/in-house, pre/post vitals, volume, adverse donor
  reactions), donor consent riding `consent_signatures`-style immutable capture
  (mig 356 pattern; new `donor_consents` or a `subject_kind` generalization —
  decide at design time), barcode on donation via the mig-354 scan pattern.
  Admin UI: donor registry + screening + deferral board. Reuses: EMPI-style
  dedupe at donor registration (NL-4 front-desk pattern).
- *BB-B Processing + traceability + registers:* `tti_tests` (panel, results,
  approver, repeat logic; positive → auto permanent deferral + unit
  quarantine/discard), `component_preparations` (parent unit → child units with
  genealogy; child rows insert into existing `blood_units` so the transfusion
  loop is untouched), donor_id FK added to `blood_units` (nullable — external
  units keep `source_blood_bank`), traceability lookups, statutory register
  exports (pdfkit/exceljs over the new tables per the mig-150 pattern), donor
  camp records (thin). Realtime: extend `staff:blood-bank` emitters.

**Migrations.** BB-A ≈ 4 (donors, screenings+deferrals, donation_events,
consent/barcode columns); BB-B ≈ 4 (tti_tests, component_preparations +
blood_units FK + genealogy, registers/discard, camp). All with mig-356 RLS
boilerplate.

**Test strategy.** Unit: deferral rule engine, TTI-positive cascade, component
expiry derivation. Deep: donor-to-transfusion loop test extending
`transfusion-loop.deep.test.js` seed path (register donor → screen → collect →
TTI pass → separate → crossmatch existing flow). Journey candidate: extend the
existing transfusion coverage rather than a new journey. Realtime emitter/channel
unit tests per precedent.

**Invariant notes.** Donor events are *donor*-subject, not patient-subject —
canonical timeline is patient-keyed (`patient_uid`,
`269_canonical_clinical_platform.sql:55`), so donor-cycle writes log to
audit/register trails instead, and only transfusion-side writes (already done)
emit patient timeline events. Walk-in donors who are also patients stay separate
subjects unless the owner decides to link. RBAC: `BLOOD_BANK_TECHNICIAN` +
`canAccessBloodBank` (roleHelpers.js:261–311) cover the new routes; TTI result
approval should gate on lab signer roles (`PATHOLOGIST_SIGN_ROLES`).

---

### 4.2 Histopathology & cytology

**Exists (general lab rails — deep; anatomic pathology — zero).**
- Specimen lifecycle with accession numbers, `tissue` as a first-class
  specimen_type, status machine, rejection reasons
  (`apps/backend/src/migrations/260_care_team_patient_access_lab_specimen_qc.sql:334–490`,
  tissue at :343); barcode labels + print tracking (mig 281), bedside collection
  scan proof (mig 354).
- Result infrastructure: per-analyte `lab_results` with abnormal flags, critical
  thresholds + acknowledged critical alerts, **pathologist sign-offs with council
  registration number capture** (`apps/backend/src/migrations/151_lab_results_and_alerts.sql`),
  panels + reference ranges (mig 175), analyzer registry/QC + HL7/ASTM interface
  inbox (migs 260/281).
- Sign-off role gates exist: `canSignOffLabResults` / `PATHOLOGIST_SIGN_ROLES`
  (`apps/backend/src/utils/roleHelpers.js:238–247`). Amendment precedent: the
  radiology addendum flow (append-only over signed reports, audit-logged —
  `apps/backend/src/services/radiology/radiologyService.js:517–569`).
- Histopathology presence in the entire backend: **one string** — a
  surgical-package billing note
  (`apps/backend/src/migrations/195_seed_surgical_packages.sql:108`). The
  investigation catalog (mig 102) seeds 8 categories, none anatomic-pathology.

**Gaps.** The whole AP workflow: specimen sub-typing for AP, grossing record,
block/cassette registry, slide registry + stains (H&E/special/IHC), microscopy
worklist, structured report (gross / microscopy / diagnosis sections; synoptic
fields later), pathologist sign-off + addendum on the AP report object, frozen
section (intra-op) fast path, cytology variants (FNAC, fluid, PAP), AP-specific
TAT, malignancy flag → oncology linkage.

**Scope sketch (one batch, L).** New tables: `ap_cases` (accessioned case over
one or more `lab_specimens` rows — reuse specimen accessioning rather than
duplicate it), `ap_gross_records`, `ap_blocks`, `ap_slides` (+ stain enum,
barcode via existing label pattern), `ap_reports` (sectioned body: gross_text,
micro_text, diagnosis_text + `report_status` draft→preliminary→final→amended
copying the radiology status set, signer gate mirroring the radiology no-ADMIN stance for medico-legal
diagnosis via a new `AP_REPORT_SIGN_ROLES = [PATHOLOGIST]` constant — the existing
`PATHOLOGIST_SIGN_ROLES` includes ADMIN/LAB_INCHARGE and cannot be reused as-is),
`ap_report_addenda` (copy radiology addendum semantics). Catalog: seed AP test
codes (HISTO-BIOPSY, FROZEN, FNAC, PAP, FLUID-CYTO) into the investigation
catalog so ordering rides the existing order path
(`investigationService` canonical events come free). Malignancy flag on ap_reports
as a typed column for later oncology/registry linkage. Admin UI: AP worklist
(accession → grossing → blocks/slides → report → sign-off), TAT columns. Staff
app: read-only report view first (entry is a desktop activity). Frozen-section
priority rides specimen `priority='stat'`.

**Migrations.** ≈ 4 (ap_cases+gross, blocks+slides, ap_reports+addenda+signoff,
catalog seeds + TAT view).

**Test strategy.** Deep test: specimen → accession → gross → block → slide →
report draft → non-pathologist sign-off rejected → pathologist sign-off →
addendum append → timeline events asserted (copy the shape of
`transfusion-loop.deep.test.js` and radiology signoff tests). Unit: block/slide
ID derivation, status machine, TAT computation. Cytology variant covered by the
same deep test parameterized on case kind.

**Invariant notes.** Every AP state change emits canonical events
(`investigation.event` family or new `pathology.*` subtypes — decide in
mini-design; the registry is source-table driven,
`canonicalClinicalPlatformService.js:256–289`). RLS boilerplate on all new
tables. OpenAPI + Dart regen (patient app later shows released AP reports through
the existing results-release path, mig 294).

---

### 4.3 Radiology — structured reporting + peer review

**Exists (complete lifecycle — the strongest substrate of all).**
- Orders with modality/priority validation, worklist, patient history
  (`apps/backend/src/services/radiology/radiologyService.js:253–315`); tech
  acquisition step with license capture + PACS study UID + acquisition evidence
  (migs 246–247; `radiologyService.js:466–506`); report submit → sign-off →
  addendum with immutable-after-signoff semantics
  (`radiologyService.js:376–419, 574–597, 517–569`).
- **RADIOLOGIST-only signer gate**: `RADIOLOGY_REPORT_SIGN_ROLES = [RADIOLOGIST]`
  (`apps/backend/src/utils/roleHelpers.js:253`), enforced by
  `requireRadiologySigner` on report/sign-off/addendum routes
  (`apps/backend/src/routes/radiology/radiologyRoutes.js:23–36`); unsigned
  reports stay visible as prelim (deliberate divergence recorded in the swarm
  audit).
- PACS/OHIF: config, study linking, patient studies, modality worklist
  (`apps/backend/src/routes/radiology/pacsRoutes.js`, Orthanc + OHIF under
  `infra/kubernetes/optional/pacs/`).
- Realtime `staff:radiology` channel + admin worklist page (2026-06-29 spec);
  staff-app worklist screen
  (`apps/staff/lib/features/radiology/screens/radiology_screen.dart`); AI QA
  module producing rule-based discrepancy flags
  (`apps/backend/src/services/ai/radiologyReportQaService.js`, mig 056) — QA,
  **not** peer review; solid test coverage (5 deep/RBAC test files + unit tests).

**Gaps (all confirmed absent).**
- Report **templates** — zero template constructs; API accepts
  `{report, findings?, impression?}` but folds everything into the single `report`
  text column (`radiologyService.js:400–406`; schema note at :42–46).
- Discrete/structured fields — no BI-RADS/TI-RADS/LI-RADS or any coded
  assessment anywhere.
- Peer review — no second-read workflow, no discrepancy scoring, no sampling.
- TAT metrics — status timestamps exist but no turnaround computation/alerting.
- Dictation — the platform STT pipeline exists but is not wired to radiology
  reporting.
- **Defect found:** radiology writes do not emit canonical timeline events,
  contrary to `docs/CANONICAL_CLINICAL_TIMELINE.md:178` (see §5).

**Scope sketch (one batch, M).**
- `radiology_report_templates` (per modality/body-part; ordered sections; optional
  coded fields as JSONB schema) + `structured_report` JSONB on `radiology_orders`
  populated at submit; keep rendering the concatenated text into the existing
  `report` column so every consumer (portal, PDFs, dashboards) is untouched.
- Peer review: `radiology_peer_reviews` (report id, reviewer ≠ author enforced
  like the transfusion different-human check
  `transfusionSafetyService.js:238–368`, score on a generic 1–4 discrepancy scale
  + comments, outcome → optional addendum), random-sampling picker over signed
  reports, INFECTION-style read-only board tab. RADPEER is ACR-branded — default
  to a generic scale unless the owner licenses RADPEER (§7).
- TAT: computed columns/view (ordered→acquired→reported→signed) + threshold
  alerting via the existing alert fabric; surfaces on the existing radiology
  dashboard.
- Fix-in-slice: emit canonical events for order/acquire/report/sign-off/addendum.
- Dictation wiring into the report editor is optional stretch (staff app has the
  dictation substrate; radiologist UX is desktop-first — defer unless cheap).

**Migrations.** ≈ 3 (templates, structured_report + peer_reviews, TAT view/alert
seed).

**Test strategy.** Extend existing radiology deep tests: template-driven submit
renders identical text blob (back-compat assertion), peer-review same-author
rejection, sampling determinism (seeded), TAT computation unit tests, canonical
event emission assertions added to `radiology-deep.test.js`.

**Invariant notes.** Peer review must not weaken the signer gate: reviews are
post-sign-off artifacts; only addenda (already RADIOLOGIST-gated) mutate the
report. OpenAPI + Dart regen required (staff worklist consumes the API).

---

### 4.4 Credentialing & privileging

**Exists (foundation shipped in mig 287 — the roadmap "absent" claim is wrong).**
- `staff_credentials`: 5 credential types
  (registration/qualification/privilege/training/immunization), issuing body,
  registration number, validity window, active/suspended/revoked status,
  verified_by/at, document_ref, unique active-privilege-per-name constraint,
  expiry index (`apps/backend/src/migrations/287_staff_credentialing.sql:11–46`).
- Service: add/list/status-update, `listExpiring`, **`hasActivePrivilege`**
  returning `{allowed, reason}` with expiry check
  (`apps/backend/src/services/staff/credentialingService.js:20–123`, gate at
  :108), daily `expiryRadarSweep` notification (:125–147).
- Routes mounted at `/api/v1/credentials` (`apps/backend/src/app.js:944`) with
  HR/leadership manage gate and a `GET /check` privilege probe
  (`apps/backend/src/routes/staff/credentialingRoutes.js:38–102`).
- **One live enforcement consumer:** chemo administration requires the
  `chemo_administration` privilege behind the `REQUIRE_ADMIN_PRIVILEGE()` flag
  (`apps/backend/src/services/oncology/chemoService.js:571–579`).
- Staff substrate: `staff` table with free-text `skills[]`/`certifications[]`
  (`000_baseline.sql:16268`), SCIM provisioning carrying identity fields only
  (`apps/backend/src/services/auth/scimProvisioningService.js:565–640`), HR
  modules (roster/leave/attendance) orthogonal and healthy.

**Gaps.**
- No **privilege catalog** — privilege names are free text; `chemo_administration`
  is a hardcoded string. Catalog + prerequisites are prerequisite to wider
  enforcement.
- No approval workflow — grants are unilateral HR/admin writes; the generic
  `approvals` table (`000_baseline.sql:1410`) exists but is not wired.
- No document-proof upload (document_ref is a bare string; no R2 upload path like
  consent signatures have).
- No renewal workflow, no persistent per-staff expiry alerts (contrast the
  acknowledgeable pharmacy expiry alerts,
  `apps/backend/src/routes/admin/pharmacySupplyRoutes.js:317`).
- Enforcement seams not yet wired (each currently RBAC-only or state-only):
  theatre surgeon assignment and OT-ready (site-mark gate checks state, not
  privilege — `apps/backend/src/services/theatre/theatreService.js:225–255`),
  anesthesia record finalization, controlled-substance prescribing (any DOCTOR
  may prescribe today), ICU allocation (roleHelpers.js:322).
- Revocation has no downstream effect (no session/action re-check besides the
  point-of-action probe).
- No admin UI for credential management.

**Scope sketch (one batch, M).** `privilege_catalog` (name, description,
required credential types, review cadence) + FK from privilege-type
`staff_credentials` rows; grant workflow riding the generic `approvals` table
(request → department-head/leadership approve → active); credential document
upload copying the consent-signature R2 validation path; renewal fields +
persistent `credential_expiry_alerts` (acknowledgeable, pharmacy-pattern) +
per-staff notification; enforcement wiring behind per-gate env flags (pattern:
chemo) at — theatre booking/OT-ready surgeon check, anesthesia finalize
(ANESTHETIST privilege), optional controlled-substance e-Rx check; admin UI
(staff profile credentials tab + expiry board + privilege catalog editor).
SCIM stays identity-only (credentials remain a local clinical-governance record).

**Migrations.** ≈ 3 (catalog + FK, approvals wiring + renewal columns, alerts
table).

**Test strategy.** Unit: catalog validation, expiry/renewal math, gate verdicts.
Deep: grant → approve → enforce-at-theatre flow; revoke → gate blocks; flag-off →
no behavior change (inertness proof, NL-2 style test naming). Existing
`chemo-loop.deep.test.js` keeps passing untouched.

**Invariant notes.** Enforcement flips are operator/evidence-gated per tenant
(feature-flag substrate). Credential records are staff-subject: no patient
timeline events; audit via existing audit-log pattern. NABH HRM chapter is the
regulatory driver.

---

### 4.5 Infection control / outbreak workbench

**Exists.**
- Workbench v1 (mig 296): **isolation board**, **ADT ward-overlap contact
  tracing**, **antibiogram** with resistance-flag rollup — read-only aggregations,
  RLS retrofit on `infection_cases`
  (`apps/backend/src/migrations/296_infection_control_workbench.sql:19–51`;
  service `apps/backend/src/services/quality/infectionControlWorkbenchService.js:27–150`;
  routes `apps/backend/src/routes/quality/infectionControlRoutes.js:27+`).
- Microbiology model: `micro_orders` / `micro_isolates` (MRSA/ESBL/CRE/VRE/XDR
  flags) / `micro_sensitivities` (S/I/R + MIC)
  (`apps/backend/src/migrations/163_anesthesia_chart_and_microbiology.sql:63–166`)
  + shipped realtime micro dashboard.
- `infection_cases` baseline table with isolation fields; isolation flags surface
  on the patient command board
  (`apps/backend/src/services/emr/patientCommandBoardService.js`).
- Two disabled AI modules: infection-control sentinel (mig 033) and antimicrobial
  stewardship (mig 037) — advisory-only.
- Reusable analogs: `quality_incidents` (has an `infection` type,
  `apps/backend/src/migrations/078_dashboard_tables.sql:54–78`), surgical safety
  checklist structure for bundle checklists, clinical-alerts channel fabric,
  `nabh_indicator_snapshots` (mig 286) for HAI indicators.

**Gaps.** HAI surveillance proper (device-day denominators — no
catheter/line/ventilator device-presence documentation exists anywhere; bundle
compliance checklists; rate computation), outbreak episode management (line
listing, case linking/clustering, epi curve), isolation **order** workflow
(order → bed flag → housekeeping precaution task), hand-hygiene audit capture,
terminal-clean protocol variant in housekeeping, antibiogram time-series export,
IDSP/IHIP notifiable-disease reporting.

**Scope sketch (one batch, M–L; explicitly ranked).**
1. `isolation_orders` (order → auto bed/command-board flag → precaution checklist
   riding the surgical-checklist item pattern → housekeeping task hook on
   discharge for terminal clean).
2. `device_presence_logs` (per admission: catheter/central-line/ventilator
   start/stop; nurses already chart daily — thin table, big payoff) →
   HAI denominators + `hai_cases` (CAUTI/CLABSI/VAP/SSI typed over
   infection_cases) → rates into `nabh_indicator_snapshots`.
3. `outbreak_episodes` + episode-case linking over `infection_cases` (line list,
   status walk suspected→confirmed→closed) + a cluster-suggestion query (same
   organism + ward overlap ≤14d — the contact-tracing SQL generalized); epi-curve
   data endpoint (render client-side).
4. Hand-hygiene audits (observation sessions + moments + compliance %) — small,
   NABH-visible.
5. IDSP export: **deferred** to a follow-up slice pending owner sourcing the
   current IDSP/IHIP format (§7); land the notifiable-disease flag on diagnoses
   only.

**Migrations.** ≈ 4 (isolation_orders + checklist, device_presence + hai_cases,
outbreak_episodes + links, hand_hygiene_audits).

**Test strategy.** Deep: isolation order → board flag → terminal-clean task;
device-days → HAI rate math (fixed seed dates via `hospitalToday`); outbreak
episode grouping (seeded cluster found, singleton not). Unit: denominators,
compliance %, cluster query. Extend `infection-control.deep.test.js`
(`apps/backend/src/tests/infection-control.deep.test.js:33–186`).

**Invariant notes.** HAI/outbreak case writes are patient-linked → canonical
timeline events with `visible_to_patient=false` default (owner may decide
exposure). INFECTION_CONTROL_OFFICER + QUALITY_OFFICER roles gate the workbench
(both exist). Aggregations must stay tenant-scoped (the mig-296 RLS lesson).

---

### 4.6 Dialysis — depth completion + the NL-7 boundary

**Exists (deepest department module in the platform; migs 168 + 291).**
- Roster + serology surveillance with seroconversion → isolation auto-flag
  (`apps/backend/src/migrations/168_dialysis_unit.sql:28–62, 232–251`), vascular
  access registry with abandonment + QA surveillance (:66–108), sessions with
  pre/post vitals, UF targets, **Kt/V (Daugirdas) + URR adequacy**, adverse-event
  booleans, status FSM (:114–180), 30-minute intra-dialysis observations carrying
  both bedside vitals and machine readings (:193–223).
- D7 depth (mig 291): standing `dialysis_prescriptions` (one active per patient,
  sessions inherit params — `291_dialysis_depth.sql:25–66`), structured
  `dialysis_session_events` (typed complications + severity + intervention,
  canonical events, boolean back-sync — :74–96), **machine provenance**
  (`source='staff'|'device'`, `source_device` — :68–72).
- **Device ingest seam already shipped:** `POST /api/v1/dialysis/machines/ingest`
  (`apps/backend/src/routes/clinical/dialysisRoutes.js:186`) → raw JSON persisted
  to the `lab_interface_messages` inbox → `machine_no` matched to the in-progress
  session → observations land through the standard `logObservation` path tagged
  device-source (`apps/backend/src/services/clinical/dialysisMachineService.js:46–131`).
- Admin 3-tab realtime dashboard (today board / roster / session run-chart) on
  `staff:dialysis-board`; canonical events for prescribed/completed/complication;
  unit + deep tests (`dialysis-depth.deep.test.js`).

**NL-7 boundary (crisp).** Dialysis-side anchors are DONE:
`dialysis_sessions.machine_no` (exact-match key), in-progress session resolution,
`dialysis_intra_obs` destination with provenance, replayable
`lab_interface_messages` inbox with typed error codes. NL-7 owns: the physical
bridge (HL7v2/proprietary → JSON), batching, machine-side session discovery, and
**device authentication** — today the ingest endpoint accepts staff/admin JWTs
only; there is no device API key/mTLS identity. That auth seam should be designed
in NL-7 (a device-principal concept serves bedside monitors too), not here.

**Gaps (dialysis-side, this program).**
- Billing linkage: no per-session package/charge wiring.
- Dialyzer reuse register: `reuse_count` column exists
  (`168_dialysis_unit.sql:124`) but no serial-tracked reuse/discard register
  (statutory-ish in India).
- Machine QA/disinfection log per session/day (biomed registry mig 053 covers
  hardware health, not operational QA).
- PD dwell tracking (PD modalities enumerated but no dwell observations).
- No staff-app screens (all entry via admin today).

**Scope sketch (one batch, S–M).** `dialyzer_reuse_register` (dialyzer serial ↔
patient, cycle count, integrity test, discard reason), `dialysis_machine_qa_logs`
(disinfection/turnaround per machine_no), per-session charge hook into billing
line items behind a tariff config, optional PD dwell obs table, staff-app bedside
screen (session start/obs/event) if capacity allows — else admin-only remains
acceptable.

**Migrations.** ≈ 2–3 (reuse register, QA log, billing hook/PD dwell).

**Test strategy.** Deep: reuse-count vs register consistency, QA-log gating
(warn-only), billing line emission on complete (flag-gated inert first). Unit:
reuse-cycle rules. Extend `dialysis-depth.deep.test.js`.

**Invariant notes.** Money touches the ledger — any charge emission follows the
shadow-first discipline from the money-ledger program (inert flag until finance
review). Machine QA logs are non-clinical (no timeline events).

---

### 4.7 Dental

**Exists (backend complete, mig 292 — roadmap "absent" claim is wrong).**
- `dental_tooth_findings` (FDI notation validated 11–48/51–85, 19 finding types,
  9 surfaces, active/resolved lifecycle) + `dental_procedures`
  (planned→completed/cancelled, completion auto-resolves the linked finding),
  RLS on both (`apps/backend/src/migrations/292_dental_charting.sql:18–81`).
- Full service with canonical events (`dental.finding_recorded/_resolved`,
  `dental.procedure_planned/_completed` —
  `apps/backend/src/services/clinical/dentalService.js:56–343`), routes mounted
  `/api/v1/dental` behind clinical RBAC + care-team guard + PHI logging
  (`apps/backend/src/app.js:962`), deep test
  (`apps/backend/src/tests/dental-charting.deep.test.js`).

**Gaps.** **No UI anywhere** (zero dental Dart files in either Flutter app; no
admin page). No Dental/Dentistry department or dentist seeds
(`apps/backend/scripts/seed-departments-doctors-local.mjs:8–14` lists 20
departments, none dental). No odontogram rendering substrate (no generic canvas
widget exists — signature pads are the closest). No multi-visit dental treatment
plan UX (generic `care_plans`/`follow_up_plans` exist, mig 122), no lab-work
loop (crown/denture external lab orders), no procedure-to-billing linkage
convention for dental codes.

**Scope sketch (one batch, S–M; UI-heavy).** Staff-app dental module: odontogram
grid (custom painter over FDI quadrants — data already shaped per tooth by
`getChart`, `dentalService.js:158–195`), finding entry, procedure plan/complete
flows, patient dental history; department + speciality seeds; procedure-code
linkage to billing service items; optional treatment-plan surface reusing
`care_plans` with `plan_kind` extension. Backend deltas are minimal (perhaps a
procedure-catalog seed for common dental codes).

**Migrations.** 0–1 (seeds only; possibly a dental procedure catalog seed).

**Test strategy.** Backend already covered; add Flutter widget tests for the
odontogram mapping (FDI → grid position) and API-service tests per staff-app
convention; one deep-test extension if billing linkage lands.

**Invariant notes.** OpenAPI/Dart codegen already exposes the endpoints — verify
the generated client covers them before building UI. i18n: staff app is
5-language — all new strings through the intl_*.arb sweep discipline (staff S3/S4
program).

---

### 4.8 Ophthalmology

**Exists (backend exams shipped, mig 293 + theatre eye-fields — the "find them"
answer).**
- `ophthalmic_exams`: per-eye VA (unaided/pinhole/corrected, Snellen/CF/HM/PL/NPL
  validated), per-eye IOP with method enum and **>21 mmHg glaucoma alert emitting
  a distinct timeline event**, anterior/posterior segment text, lens-status enums
  (`apps/backend/src/migrations/293_ophthalmology_exams.sql:23–61`;
  `apps/backend/src/services/clinical/ophthalmologyService.js:107`).
- `ophthalmic_refractions`: per-eye sphere/cyl/axis/add with optical validation;
  `final_glasses` rows are dispensable spectacle prescriptions
  (`293_ophthalmology_exams.sql:67–94`). Routes `/api/v1/ophthalmology` mounted
  behind clinical RBAC (`apps/backend/src/app.js:965`).
- **Theatre eye-fields:** `preop_checklists.site_marked_side` (normalized
  right/left/bilateral via `normalizeMarkedSide`,
  `apps/backend/src/services/theatre/theatreService.js:62–83`) with the
  OT-ready gate matching marked side against procedure laterality (:225–255) —
  the PR #434 ported site-mark gate; `eye_drops_given/…/eye_drops_schedule`
  pre/post-op fields (schema.prisma preop_checklists model); day-care admission
  type + seeded DC beds (`apps/backend/src/services/emr/admissionService.js:59–70`);
  **DAYCARE_OPHTHALMOLOGY_V1 discharge template** with "Eye Operated (RE/LE)" and
  eye-drop-schedule sections, clinical placeholders pending review
  (`apps/backend/src/migrations/230_daycare_ophthalmology_template_and_readmission_link.sql:40–63`)
  + re-admission continuity link (:65–77).

**Gaps.** Exams float free of visits (no appointment/encounter FK on
`ophthalmic_exams`); no eye investigations in the catalog (no biometry,
keratometry, visual fields, OCT); no biometry/IOL power records or cataract
pre-op workup bundle; no ophthalmic imaging attachments (AI imaging tables are
decision-support only, mig 025); no optical dispensing/shop; **no UI** (zero
ophtho Dart files); discharge-template placeholder text still awaiting clinical
review (flagged in mig 230).

**Scope sketch (one batch, M).** Link exams to encounters/appointments
(nullable FK + backfill-free), eye-test catalog seeds, `ophthalmic_biometry`
(K-readings, axial length, IOL power/formula/selection — calculation can be
recorded-not-computed in v1), cataract pre-op bundle as an order-set instance +
theatre-booking readiness check (biometry present before OT-ready for
cataract-coded procedures — soft warn first), imaging attachments via the R2
upload pattern keyed to exams, spectacles Rx print (pdfkit) from
`final_glasses`, staff-app ophtho exam screen (per-eye entry) + patient history.
Optical shop/dispensing inventory is **out** unless the owner pulls it in (§7).

**Migrations.** ≈ 2–3 (exam linkage + catalog seeds, biometry, imaging
attachments).

**Test strategy.** Extend the mig-293 exam deep tests: encounter linkage,
IOP-alert regression, biometry record, cataract readiness warn. Widget tests for
per-eye entry mapping. Journey candidate: a cataract day-care variant asserting
site-mark laterality + eye-drops schedule + DAYCARE_OPHTHALMOLOGY_V1 discharge —
extends `surgical-day-care.journey.test.js` patterns.

**Invariant notes.** IOP alert already emits a distinct canonical subtype — new
writes follow that precedent. The discharge-template placeholders need clinician
sign-off before demo use (owner action, §7).

---

### 4.9 Minor areas (lighter treatment; one paragraph each)

**Oncology day-care infusion chairs (S).** Chemo substrate is complete — mig 290
protocols/plans/cycles with Mosteller BSA, lifetime-ceiling gates, two-person
verification, routes + `chemo-loop.deep.test.js`
(`apps/backend/src/services/oncology/chemoService.js:31–71, 499–642`). `day_care`
beds are seeded (mig 258). Missing: an infusion chair/slot resource and cycle →
chair booking (verified: no `infusion_chair`/`chair_slot` constructs). Slice:
`infusion_chairs` + `chair_bookings` keyed to `chemo_cycles.scheduled_date`, a
day-care infusion board tab, conflict checks. ≈ 1–2 migrations; deep test extends
chemo-loop with a booked chair.

**Physio/rehab (M, greenfield).** Nothing exists (no tables/routes/screens;
verified) though the `PHYSIOTHERAPIST` role is already defined
(roleHelpers.js) and "Physiotherapy & Rehabilitation" is a seeded department
(`seed-departments-doctors-local.mjs:8–14`). Slice: referral (from consult/
discharge via `follow_up_plans.origin`), assessment, therapy plan (reuse
`care_plans` `plan_kind='rehab'` — already an enum value, mig 122), session logs
with structured measures, simple outcome scores; staff-app therapist worklist.
≈ 2–3 migrations; deep test referral→plan→sessions→discharge-summary linkage.

**Mortuary chain (S).** Death certification is solid — MCCD Form-4 fields,
medicolegal gates (release blocked without police clearance), M&M reviews,
per-tenant MCCD serials, admin page + tests (mig 167;
`apps/backend/src/services/clinical/deathCertificationService.js:87–299`;
`apps/admin/src/app/(with-auth)/dashboard/death-certification/page.tsx`). Missing:
body storage/custody (cooler slot registry, receive/store/release custody log
with witness chain, unclaimed-body escalation timers). Slice: `mortuary_slots` +
`body_custody_events` append-only chain hooked to `death_records`
(release fields already exist — `recordBodyRelease`,
deathCertificationService.js:249–282). ≈ 1–2 migrations; deep test
certify→store→release with medicolegal block asserted.

**CSSD (M, greenfield).** Only theatre instrument *counts* exist (sign-out gate
blocks OT-case close until sponge/sharp/instrument counts confirmed —
`theatreService.js` close gate; mig 116 checklists). Missing: instrument
sets/trays, sterilization cycles/loads with parameters + biological indicators,
issue→use→return→decontaminate→sterilize loop keyed to `ot_schedules`. Slice:
`instrument_sets`, `sterilization_loads`, `set_issue_log`; theatre linkage
warn-only at first (hard-gating OT on CSSD data is a later flip). ≈ 2–3
migrations; deep test load→issue→theatre-use→return cycle.

**Linen/laundry (S, lowest priority).** Absent; nearest analogs are the
housekeeping task fabric (migs 052/249/250 + admin UI + tests) and
`ward_indents` which already has a `linen` indent type
(`apps/backend/src/migrations/174_ipd_support_tables.sql:101–146`) — that flow is
supply-requisition, not laundry ops. Slice (when pulled): par-level stock per
ward + soiled/clean cycle counts riding the housekeeping request pattern. ≈ 1–2
migrations. Recommend deferring to the NL-6 tail.

## 5. Cross-Cutting Defects Found During Survey (fix-in-slice)

1. **Radiology emits no canonical timeline events** despite the platform contract
   (`docs/CANONICAL_CLINICAL_TIMELINE.md:178`; no
   `recordCanonicalClinicalEvent` call in `radiologyService.js`). Fix inside
   slice N6-1.
2. **Radiology findings/impression are folded into one text blob**
   (`radiologyService.js:400–406`) — clients cannot parse sections. The
   structured-report work in N6-1 supersedes this rather than patching it.
3. **Dialysis machine-ingest has no device identity** (staff/admin JWT only,
   `dialysisRoutes.js:186`). Deliberately deferred to NL-7's device-principal
   design; noted here so it is not lost.
4. **Free-text privilege names** (`staff_credentials.name`) will proliferate as
   hardcoded strings if more consumers land before the catalog. N6-5 should land
   before any slice adds a second privilege consumer.
5. **DAYCARE_OPHTHALMOLOGY_V1 template ships placeholder clinical text** flagged
   for clinical review (mig 230:48–58) — an owner/clinician action, not code.

## 6. Recommended Slice Order

Each slice = one Codex build batch (own branch → PR → CI → merge), with its own
mini-design refined from the sketches above. Sizing: S ≈ ≤1.5k LOC diff, M ≈
1.5–4k, L ≈ 4k+ (staff-program batch calibration).

| # | Slice | Size | Regulatory value | Demo value | Substrate readiness |
|---|---|---|---|---|---|
| N6-1 | Radiology structured reporting + peer review + TAT (+timeline fix) | M | Medium (NABH quality) | **High** — flagship differentiator | **Highest** — rides complete lifecycle |
| N6-2 | Blood bank donor cycle A: donors, screening, deferral, collection | L | **Highest** — licensing-grade records | High | High — consent/barcode/register patterns ready |
| N6-3 | Blood bank donor cycle B: TTI, component prep, traceability, statutory registers | M–L | **Highest** | High | Depends on N6-2 |
| N6-4 | Histopathology & cytology reporting | L | High (diagnostic sign-off, TAT) | High — completes the diagnostics triad | High — specimen/sign-off/addendum rails ready |
| N6-5 | Credentialing & privileging completion | M | **High** (NABH HRM) | Medium | High — mig 287 + live consumer |
| N6-6 | Infection-control workbench depth (isolation orders, HAI, outbreak episodes, hand hygiene) | M–L | High (NABH HIC) | Medium | High — mig 296 + micro + incident analogs |
| N6-7 | Ophthalmology completion (linkage, biometry, cataract bundle, UI) | M | Medium | High — day-care cataract story is demo-ready | High — mig 293 + theatre eye-fields |
| N6-8 | Dental completion (odontogram UI, seeds, billing linkage) | S–M | Low | High — visual, cheap | **Very high** — backend done |
| N6-9 | Dialysis completion (reuse register, machine QA, billing hook) | S–M | Medium (reuse register) | Medium | **Very high** — deepest module |
| N6-10 | Oncology infusion chair scheduling | S | Low | Medium | Very high — chemo done |
| N6-11 | Physio/rehab foundation | M | Low | Medium | Medium — greenfield on care-plan rails |
| N6-12 | Mortuary body chain | S | Medium (custody/medicolegal) | Low | High — death cert done |
| N6-13 | CSSD instrument tracking | M | Medium (NABH HIC adjunct) | Low | Medium — greenfield, theatre hooks exist |
| N6-14 | Linen/laundry | S | Low | Low | High — housekeeping pattern |

**Rationale for the order.**
- **N6-1 first**: highest substrate readiness calibrates the batch loop cheaply,
  pays off a named roadmap gap, and fixes a platform-contract defect (§5.1). It
  also produces the template + peer-review patterns that N6-4 reuses.
- **N6-2/N6-3 next**: the donor cycle is the single largest regulatory-value item
  in NL-6 — the transfusion side is already excellent, and "half a blood bank"
  is the worst place to pause. Two batches because donor intake and
  processing/traceability are separable and individually testable. **Blocked on
  Owner Decision 2 (operating model) and 3 (register formats)** — if those
  stall, N6-4/N6-5 slot forward without re-planning.
- **N6-4** completes the diagnostics story (lab + micro + radiology + AP) and is
  the cancer-pathway prerequisite (malignancy flag → oncology linkage).
- **N6-5 before further enforcement consumers appear** (§5.4), and before N6-6/
  N6-13 which would otherwise hardcode more gate strings.
- **N6-6** rides freshly-landed credentialing (ICO privileges optional) and its
  isolation orders benefit dialysis/blood-bank wards immediately.
- **N6-7/N6-8** are the demo-sweeteners; either can be pulled earlier as a
  breather batch between the L slices — N6-8 in particular is safe filler any
  time after N6-1.
- **N6-9 through N6-14** are completion/rounding slices in descending
  value-density; N6-14 only when everything else is done or a tenant asks.

Sequencing is a recommendation, not a dependency graph — hard dependencies are
only: N6-3 after N6-2; N6-5 before any slice that adds privilege enforcement
(N6-6 optional-use, N6-13 optional-use); N6-1's template pattern before N6-4
(soft — AP could invent its own, but shouldn't).

## 7. Owner Decisions

1. **Slice priority sign-off.** Confirm or reshuffle §6 (cheap to reorder now;
   expensive after batches start). Explicit call on whether N6-8 (dental UI)
   jumps the queue for demo purposes.
2. **Blood bank operating model.** Current code models a blood **storage centre**
   (units received from external licensed banks — `source_blood_bank`,
   `280:40`). The donor cycle turns the product into a full **blood centre**
   (donation + processing licence scope under the Drugs & Cosmetics framework).
   Confirm the target: (a) full blood centre — build N6-2+N6-3 as specced; or
   (b) storage centre remains the product posture — then N6-2 shrinks to a donor
   *directory* + camp coordination and N6-3 is dropped. This decision gates the
   two largest batches in the program.
3. **Statutory register formats to source (before N6-3 / N6-9 / N6-6 builds).**
   Authoritative current formats needed for: blood-bank donor register, blood
   collection register, TTI/testing register, component preparation register,
   donor deferral register, unit discard register (Drugs & Cosmetics Rules Part
   XII-B / NBTC-NACO guidance — source the actual current forms, do not trust
   model knowledge); dialyzer reuse register format; IDSP/IHIP notifiable-disease
   reporting format + disease list for the infection-control follow-up. Until
   sourced, slices ship generic register exports flagged "format pending".
4. **Peer-review scale.** Generic 1–4 discrepancy scale (recommended — no
   licensing exposure) vs ACR RADPEER alignment (branded program; requires
   participation/licensing). Also: peer-review sampling rate default (suggest 2%
   of signed reports, configurable per tenant).
5. **Privilege catalog seed list.** Which privileges exist at launch (suggest:
   chemo_administration [exists], primary_surgeon, anesthesia_finalize,
   endoscopy, icu_attending, radiology_subspecialty_*) and which enforcement
   flags flip on for the pilot tenant vs stay inert.
6. **Ophthalmology optical dispensing.** In or out of N6-7 (it is retail
   inventory + sales, closer to pharmacy/stores than clinical ophtho; recommend
   OUT — revisit on tenant pull).
7. **Donor ↔ patient identity linking.** When a blood donor is also a registered
   patient, link identities (richer safety data, consent complexity) or keep
   fully separate subjects (recommended for v1)?
8. **DAYCARE_OPHTHALMOLOGY_V1 clinical review.** Assign a clinician to replace
   the placeholder restriction/drop-schedule text (mig 230) — blocks demo use of
   the cataract story regardless of N6-7 timing.

## 8. Open Questions and Risks

- **UI surface split.** Pillar-D modules are backend-only; NL-6 is therefore
  UI-heavy across two clients. Working rule adopted in the sketches: bedside/
  clinical entry → staff app (Flutter), managerial/worklist/reporting → admin
  (Next.js). Dialysis today violates this (admin-only entry) and survives fine —
  so staff-app screens are scoped pragmatically per slice, not dogmatically.
- **i18n drag.** Every staff-app slice pays the 5-language `intl_*.arb` cost
  (staff-program guard enforces it); budget it in sizing (already reflected).
- **Journey-test growth.** Each L slice adds a deep test; only ophtho (cataract
  day-care variant) and blood bank (donor→transfusion) justify journey-tier
  additions. Keep the journey set lean — CI wall-clock is the constraint.
- **Canonical-timeline subject model.** Donor-cycle and staff-credential writes
  have non-patient subjects; they use audit/register trails, not
  `clinical_timeline_events`. If a future patient-linked need appears (donor who
  is a patient), revisit under Owner Decision 7.
- **Migration numbering contention.** NL-5/NL-7 design programs may reserve
  migration numbers concurrently; every NL-6 batch re-verifies via `ls` at start
  (invariant §3.6) rather than trusting this document's snapshot (max 367, 368
  reserved SAML, as of 2026-07-07).
