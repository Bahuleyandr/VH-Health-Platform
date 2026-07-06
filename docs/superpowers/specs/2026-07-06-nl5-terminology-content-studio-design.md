# NL-5 Terminology Spine + Content Studio Design

**Program:** NL-5 (Wave B) per [`docs/NEXT_LEVEL_ROADMAP.md`](../../NEXT_LEVEL_ROADMAP.md) §5,
absorbing prior-roadmap **T2 #2 terminology spine** per §2 ("SNOMED-CT is free in India
via NRCeS; LOINC free; ICD-11 free. Only the drug KB/DDI needs a license").
**Authored:** 2026-07-06 at `main` `123977a1`. **Status:** design for review — no code.

Every claim below is grounded in repo files read at that commit; paths are cited inline.
The single most important framing: **most of the NL-5 substrate already exists and is
tested.** This program is (1) content acquisition + versioned ingestion on an existing
spine, (2) a procurement decision + seams for a licensed drug KB, (3) a governance
lifecycle on an existing order-set substrate, and (4) two India pediatric content packs
for existing pediatric services. It is deliberately **not** a green-field build.

## Scope and Non-Goals

In scope:

- SNOMED-CT (NRCeS), LOINC, ICD-11 content ingestion with release versioning, mapping
  services, per-tenant enablement, and an autocomplete performance posture — all
  extending `apps/backend/src/services/terminology/terminologyService.js`.
- Licensed drug-KB/DDI **option matrix + integration seams** behind
  `apps/backend/src/utils/clinical/prescriptionSafetyCheck.js` and the CDS wrappers.
  The license itself is an owner procurement action.
- Order-set/pathway **content studio**: author → review/approve → version → deploy →
  rollback on top of `clinical_order_sets`/`clinical_order_set_items` (migration 156)
  and the existing CPOE composer.
- IAP growth-chart and UIP/IAP immunization-schedule **content packs** plugged into
  `growthPercentileService` and `vaccine_catalogue`/`patient_immunisations`.

Non-goals (explicit):

- **Building DDI/interaction content.** `docs/NEXT_LEVEL_ROADMAP.md` §7 do-not-build:
  "Own DDI content database (license it — patient-safety liability)". This spec adds
  zero homegrown interaction rows beyond the existing flagged starter set.
- FHIR terminology operations (`CodeSystem/$lookup`, `ValueSet/$expand`,
  `ConceptMap/$translate`) as public FHIR endpoints — that is the NL-11 developer-portal
  scope (`docs/NEXT_LEVEL_ROADMAP.md` §5 NL-11). NL-5 keeps the internal REST surface
  (`/api/v1/terminology/*`) and leaves the FHIR mount as a named seam.
- SNOMED ECL / subsumption / description-logic classification. The RF2 relationship
  file is not loaded in v1; a `terminology_concept_edges` table is a named revisit
  trigger, not a deliverable.
- A care-pathway *execution* engine (day-by-day protocol automation). Pathways in NL-5
  are content: phase-grouped order sets (§Content Studio). Protocol *documents* keep
  their existing lane (`clinical_protocols`, migration 093, already consumable by the
  AI knowledge-curation importer per migration 311's source list).
- Analyzer/LIS code mapping UI — LOINC bindings reuse the existing curator flow
  (`POST /api/v1/terminology/bindings/suggest`).

## Binding Invariants (restated, honored throughout)

From `docs/NEXT_LEVEL_ROADMAP.md` lines 15–24 and the surfaces this program touches:

1. **Clinical AI/CDS stays decision-support-only and review-gated.** Nothing in NL-5
   auto-substitutes clinician judgment: terminology suggestions are picked by a human
   (`apps/staff/lib/core/widgets/coded_diagnosis_picker.dart` fills a coding payload;
   the clinician still writes the description), KB findings surface as
   warnings/blockers with the existing override-with-reason path, and AI coding
   suggestions remain flagged drafts (`codingValidationService.js` keeps unvalidated
   codes visible with `validated:false` rather than dropping or auto-fixing).
2. **No safety gate is bypassed.** Every save gate stays load-bearing:
   `validatePrescriptionSafety` fails CLOSED (`prescriptionSafetyCheck.js:1338–1352`),
   `runCDSChecks` fails CLOSED for medication orders
   (`orderEntryService.js:267–290`), and order sets already route every item through
   `createOrder` → `runCDSChecks` (`orderEntryService.js:1604–1626`). The content
   studio must keep that path — deployed sets produce composer drafts / createOrder
   calls, never direct `clinical_orders` inserts.
3. **Per-tenant flags.** All new behavior ships dark and per-tenant, following the
   `composition_search_settings` pattern (migration 351;
   `compositionFeatureService.js` per-tenant-keyed cache, fail-closed) — not the
   global `feature_flags` table (`featureFlagService.js`), which is not tenant-scoped.
4. **Deploy HELD.** Per `docs/NEXT_LEVEL_ROADMAP.md` §8, deploy stays held until the
   operator track says otherwise; everything lands inert behind flags/imports that
   only an operator runs. Content (SNOMED RF2, LOINC CSV, vendor KB exports) is
   **never committed to the repo** — `scripts/terminology-import.mjs` header:
   "licenses are free but the content is NOT redistributable in this repo".
5. Governed mode flips remain operator/evidence-gated; migration counter per §8
   ("check `src/migrations/` for the next free number" — tail at authoring time:
   `367_nl1_p3_identity_source_break_glass.sql`, with 368 reserved for NL-1 P4 SAML).

## Existing Substrate (verified)

### Terminology spine (roadmap B8 — already live)

- **Tables** (migration `275_terminology_service.sql`): `terminology_code_systems`
  (registry with `version`, `license_note`, `concept_count`), `terminology_concepts`
  (`UNIQUE (system_key, code)`, status active|inactive|deprecated, JSONB
  `properties`), `terminology_concept_maps` (equivalent|broader|narrower|related,
  reverse-walk supported), `terminology_catalog_bindings`
  (suggested|confirmed|rejected, verified_by/at). All **global reference data — no
  tenant_id, no RLS, no PHI** by design (275 header; reaffirmed in 307's design notes).
- **Indexes** (275:58–77, 307:93–95): display-prefix `varchar_pattern_ops`, `pg_trgm`
  GIN on `lower(display)` (graceful degradation when the extension is absent), code
  index, and a category-faceted partial index.
- **Service** `src/services/terminology/terminologyService.js`: `SYSTEM_KEYS`
  ICD10/ICD11/SNOMED_CT/LOINC/ATC with alias + FHIR-URI normalization (`:30–73`);
  ranked `searchConcepts` (min 2 chars, limit clamp 100); `getConcept` (local-first,
  WHO fallback for ICD-11); `validateCode` with three modes
  catalog/structural/unimported (`:293–329`, LOINC structural fallback preserving HL7
  ingestion behavior); `mapCode`/`upsertConceptMap`; catalog bindings + name-match
  `suggestCatalogBindings`; `coverageReport` (the B8 exit metric). `CATALOG_TARGETS`
  binds `investigation_test_catalog`→LOINC, `pharmacy_catalog`→ATC,
  `medications`→ATC (`:82–98`).
- **Routes** `src/routes/terminology/terminologyRoutes.js`, mounted at
  `/api/v1/terminology` behind `CLINICAL_STAFF_ROLES` (`src/app.js:899`); binding/map
  writes gated to `TERMINOLOGY_CURATOR_ROLES` (admin, pharmacy, lab, pathologist,
  medical records, quality officer — `terminologyRoutes.js:35–46`).
- **ICD-11 live client** `src/services/terminology/whoIcdClient.js`: OAuth2
  client-credentials against `id.who.int` (env `WHO_ICD_CLIENT_ID/SECRET`, default
  release `2026-01`, 8s timeout) **or** a local WHO ICD deployment via
  `WHO_ICD_DISABLE_AUTH=true`; search + codeinfo lookup; results cached-through into
  `terminology_concepts` (`terminologyService.js:132–177`).
- **Importer** `scripts/terminology-import.mjs`: SNOMED RF2 Snapshot two-pass
  (active concepts + FSN, semantic tag split), LOINC `Loinc.csv` (ACTIVE rows), and
  generic code,display[,category] CSV for ICD-10/ICD-11/ATC; `--version` stamps
  `terminology_code_systems.version`; `--dry-run`. **Gap:** upserts in place on
  `(system_key, code)`, does not retire codes missing from a new release, and does
  not write `terminology_import_batches`.
- **Provenance/audit** (migration `307_terminology.sql`): `terminology_import_batches`
  (status pending|running|completed|failed|partial, row counts, release_label) and
  append-only `terminology_audit_events` (deliberately separate from the PHI-bearing
  hash-chained `clinical_audit_events`); ICD-11 offline starter set (10 common codes)
  for WHO-API-unreachable fallback; NRCeS license note: "apply for free license at
  https://www.nrces.in/".
- **EMR consumption:** diagnoses carry legacy `icd10_code` plus unlimited structured
  codings in `clinical_code_bindings` (migration 297; service
  `clinicalCodeBindingService.js` — resource types diagnosis|patient_problem, FHIR
  system URIs, ICD-11 release/linearization metadata). The problem list
  (`problemListService.js`, migration 306) soft-validates ICD-10/SNOMED through
  `validateCode` and emits canonical timeline + audit events per
  `docs/CANONICAL_CLINICAL_TIMELINE.md`. Staff UI picks ICD-11 codes via
  `coded_diagnosis_picker.dart` (350 ms debounce, ≥2 chars,
  `MedicalApiService.searchTerminology`). AI coding drafts are annotated against the
  master by `src/services/ai/codingValidationService.js` (fail-closed, keeps
  unvalidated codes flagged). Tests already exist: `src/tests/terminology.deep.test.js`,
  `src/tests/unit/terminologyService.test.js`, `src/tests/unit/codingValidationService.test.js`.

### Drug safety + KB substrate (roadmap B2 — engine live, content license pending)

- **Safety floor** `src/utils/clinical/prescriptionSafetyCheck.js` (1,362 lines):
  unified allergy stores + free-text note allergy scan, duplicate active e-Rx,
  gated composition allergy/duplicate screen (per-tenant flag), pediatric weight-based
  dose blockers, antithrombotic axis, pregnancy, renal, antibiotic stewardship — and
  **check 8: the DB-backed KB engine** with severity mapping
  contraindicated/major/high → blockers (`:1246–1336`). Fails CLOSED with a
  `SAFETY_CHECK_ERROR` blocker; override remains `override:{reason}` audited to
  `prescription_safety_overrides` (e-Rx path) / `medication_safety_reviews` (CPOE).
- **KB schema** (migration `277_drug_knowledge_base.sql`): `drug_kb_sources`
  (vendor/version/license_note/`is_starter`/`is_active`), `drug_kb_monographs`
  (drug_key + **Indian brand alias arrays** the matcher resolves free text against),
  `drug_kb_interactions` (severity CHECK contraindicated|major|moderate|minor,
  canonical a<b), `drug_kb_allergy_groups` + `drug_kb_allergy_cross_reactivity`,
  `drug_kb_condition_cautions` (keyed **icd10_prefix** against the B7 problem list),
  `drug_kb_dose_ranges` (adult|pediatric|neonatal, flat + mg/kg + eGFR-adjusted),
  `drug_kb_iv_compatibility`. Global reference data, no tenant_id/RLS (same stance
  as B8). A ~90-row **flagged starter set** (`source_key='vh_starter_set'`,
  `is_starter=true`) provides day-one value; its own license_note says the B2
  acceptance bar is a licensed import after which the starter is deactivated.
- **Engine** `src/services/clinical/drugKnowledgeBaseService.js`: 5-min TTL cache,
  loads **all `is_active` sources unioned**, alias-substring matching, five check
  families, schema-tolerant (`kbAvailable:false` on unmigrated envs — never bricks
  prescribing), `drugKbStatus()` reports sources/counts/`starter_only`.
- **Licensed-KB import seam already built:** `scripts/drug-kb-import.mjs` — a
  neutral-CSV importer for all 7 datasets ("any vendor export can be transformed once
  and imported repeatedly"; Medi-Span/FDB/CIMS/CDSCO named as owner-side procurement),
  upsert semantics, dry-run, and the documented starter-deactivation step.
- **CDS wrappers (call sites the KB must stay behind):** CPOE `runCDSChecks`
  (`src/services/emr/orderEntryService.js:176–293` — uid→int resolution, tenantId
  threading, drug-chart duplicate + antithrombotic against active IPD orders,
  fail-CLOSED); e-Rx create/update
  (`src/controllers/prescription/ePrescriptionController.js:966,1432` with
  server-authoritative composition enrichment and `requiresOverride` 409 payload);
  drug chart (`drugChartService.js:146`); medication reconciliation
  (`medicationReconciliationService.js:810`); pharmacist verification before dispense
  (`pharmacistVerificationService.js:137`); polypharmacy AI review
  (`polypharmacyAiService.js:63`). Staff UI: `cds_blocker_modal.dart` (structured
  override categories, supervisor reference for severe allergy blockers).
  Tests: `src/tests/drug-kb.deep.test.js`, `src/tests/cpoe-cds-fail-closed.deep.test.js`,
  `src/tests/unit/drugKnowledgeBase.test.js`.

### Order sets (substrate live; governance missing)

- **Tables** (migration `156_doctor_productivity.sql`): `clinical_order_sets`
  (unique `code`, title, specialty, `condition_codes TEXT[]` (ICD-10), `active`,
  `created_by`, `tenant_id` with tenant_isolation RLS) and
  `clinical_order_set_items` (display_order, `kind` CHECK in
  med|lab|radiology|diet|nursing|vitals|consult|note|monitor|other, per-kind JSONB
  `payload`, `default_selected`). Seed: chest-pain rule-out bundle (migration 187).
- **Service** `src/services/emr/orderEntryService.js`: `applyOrderSet` (`:1575`)
  loads an **active** set and routes every item through `orderRequestFromItem` →
  `createOrder` — i.e. **through the full CDS gate**, partial application allowed;
  `getOrderSets` (`:1642`, active-only, category→specialty match); `createOrderSet`
  (`:1681`, RLS-scoped via `setTenantTx`). Routes live in
  `src/routes/emr/orderRoutes.js` (`:216` apply, `:454` list, `:473` create).
- **Composer** `apps/staff/lib/features/emr/screens/order_composer_screen.dart`:
  catalog type-ahead, basket of typed drafts, one-tap order sets via
  `OrderSetsScreen` picker (items map into drafts client-side), advisory per-draft
  pre-check `POST /emr/cds/check-order`, atomic signing via `POST /emr/orders/bulk`
  with blockers surfaced in `CdsBlockerModal`. Tests:
  `src/tests/unit/orderSetItemRouting.test.js`, `src/tests/unit/orderEntryCdsBlockerRender.test.js`.
- **What's missing** (matches `docs/NEXT_LEVEL_ROADMAP.md` §3.D "the CPOE composer
  exists, the content system does not"): no versioning, no draft→review→approve
  lifecycle, no import format, no deployment/rollback story, no authoring UI. Only
  two seeded sets exist.

### Pediatric surfaces (services live; India content packs missing)

- **Growth:** `src/services/clinical/growthPercentileService.js` — WHO LMS z-score
  math + Abramowitz-Stegun CDF, but reference data is an **embedded approximate
  WHO 0–5 monthly subset** with fixed L/S per metric; the file itself says "replace
  this lookup with the full LMS load" and returns for age >60 months: "load IAP 5-18
  dataset for older cohorts" (`:158–163`). `growth_charts` (migration 131:91–102)
  already CHECKs `reference_dataset IN ('WHO_0_5','IAP_5_18','CDC_2_20','FENTON')`.
  `computeGrowthSnapshot` is wired into vitals recording (`vitalsChartService.js`
  imports it) so percentiles surface inline. Test:
  `src/tests/unit/growthPercentileService.test.js`.
- **Immunization:** `vaccine_catalogue` (migration 160) is per-tenant
  (`UNIQUE (tenant_id, code, dose_number)`) with `recommended_age_days` +
  `window_days`, seeded with the **Indian NIS + IAP common doses for the first 18
  months** (BCG/HepB/OPV/DPT/Hib/PCV/Rota/fIPV/MR/JE/VitA through the 16–24-month
  boosters). Two schedule tables: `newborn_immunisations` (mass-seeded at birth,
  maternity flow) and `patient_immunisations` (migration 179; walk-ins/transfers)
  via `src/services/paediatric/paediatricImmunisationService.js`
  (`ensureScheduleSeededForPatient` computes due dates from DOB +
  `recommended_age_days`; statuses scheduled|given|missed|refused|contraindicated;
  signed `immunisation_review` clinical notes). Admin page exists
  (`apps/admin/src/app/(with-auth)/dashboard/immunisations/`). Tests:
  `src/tests/paediatric-immunisation-deep.test.js`,
  `src/tests/unit/paediatricImmunisationTenantAuthorization.test.js`.
- **Pediatric dosing** stays with the drug KB (`drug_kb_dose_ranges` population
  pediatric|neonatal; plus the hardcoded `PAEDIATRIC_MG_PER_KG` floor in
  `prescriptionSafetyCheck.js:18–28` and the decision-support-only
  `pediatric_dosing_safety` AI module, migration 046). NL-5 adds **no** homegrown
  dosing content beyond what exists; licensed KB is the production dosing source.

### Per-tenant flag + content-governance precedents

- **Canonical per-tenant flag:** `composition_search_settings` (migration 351,
  Pattern-A RLS) + `compositionFeatureService.js` — per-tenant-keyed 60 s cache
  (explicitly never a global refresh: RLS cache-poisoning note in the file header),
  fail-closed reads, `acceptance_snapshot` stored at enable time. NL-5 copies this
  shape for every new flag.
- **Module registry precedent:** `CLINICAL_AI_MODULES`
  (`src/services/ai/clinicalAiModuleService.js:7`), DB catalog `clinical_ai_modules`,
  per-tenant `clinical_ai_tenant_modules` overrides (`readTenantModuleOverrides`,
  `updateClinicalAiTenantModule` `:2783`; admin route
  `src/routes/admin/clinicalAi/governanceRoutes.js:131`).
- **Curation lifecycle precedent:** knowledge curation (migration
  `311_knowledge_curation.sql`) — `curation_status pending|approved|rejected` +
  `reviewed_by/at` on `knowledge_documents`, machine imports land pending/dark,
  domain owner sign-off documented in `docs/CLINICAL_AI_KNOWLEDGE_CURATION.md`,
  tenant-scoped `knowledge_import_batches` provenance, and backend curation routes
  (`src/routes/admin/clinicalAi/knowledgeBaseRoutes.js`,
  `knowledgeGovernanceRoutes.js`).

---

## 1. Terminology Spine — SNOMED-CT (NRCeS), LOINC, ICD-11

### 1.1 Content acquisition (owner actions, documented here as the runbook seed)

None of these files may be committed (importer header; license terms). All are
operator-run imports against the target environment's `DATABASE_URL`.

1. **SNOMED CT via NRCeS (free Indian national license).** Owner enrolment steps:
   (a) apply for the free SNOMED CT Affiliate license on the National Resource
   Centre for EHR Standards portal — https://www.nrces.in/ (the exact URL already
   recorded in migration 307's license note); (b) accept the affiliate license
   agreement and obtain access to SNOMED International's MLDS (Member Licensing and
   Distribution Service) through the India NRC; (c) download the SNOMED CT India
   Edition (or International Edition) **RF2 Snapshot**; (d) run
   `node scripts/terminology-import.mjs --system SNOMED_CT --rf2 <Snapshot/Terminology> --version <release-label>`
   (existing usage, importer header lines 8–9). Named owner + target date = §Owner
   Decisions.
2. **LOINC.** Free Regenstrief license: register at loinc.org, download the release,
   import `--loinc Loinc.csv --version <release>` (existing path). This retires the
   `mode:'structural'` fallback automatically — `validateCode` switches to
   authoritative catalog mode once `concept_count > 0` (`terminologyService.js:311–327`).
3. **ICD-11.** Two supported modes, both already coded in `whoIcdClient.js`:
   cloud WHO ICD-API (register an API client at WHO's ICD-API portal, set
   `WHO_ICD_CLIENT_ID/SECRET`) or a self-hosted WHO ICD-API container with
   `WHO_ICD_DISABLE_AUTH=true` (PHI never leaves either way — only search terms are
   sent; still, self-hosted is the recommended posture for the on-prem cluster).
   Additionally import a **full ICD-11 MMS linearization CSV** via the existing
   generic `--csv` path so search is local-first (§1.4) and offline-safe.
4. **ATC.** Obtain the annual WHOCC ATC/DDD electronic files (WHOCC distributes
   these under its own terms — owner procurement step), import via `--csv`.
   ATC matters because `pharmacy_catalog`/`medications` bindings default to it
   (`CATALOG_TARGETS`) and `drug_kb_monographs.atc_code` aligns the drug KB to it.

### 1.2 Storage + lookup architecture — decision

Options considered:

| Option | Shape | Verdict |
|---|---|---|
| **A. Embedded concept tables (extend what exists)** | `terminology_concepts` + pg_trgm/prefix indexes in the platform Postgres; importer scripts; service-layer ranking | **Recommended** |
| B. Sidecar search index | Separate search engine (Elastic/Meili-class) fed from Postgres | Rejected for v1 |
| C. External terminology server | Snowstorm / Ontoserver / HAPI-FHIR-terminology deployment; platform calls out | Rejected for v1 |

Rationale for A: the embedded spine **already exists, is indexed, is tested, and is
consumed** by diagnosis entry, the problem list, AI coding validation, and lab
validation (§Existing Substrate). Scale fits Postgres comfortably: a SNOMED snapshot
is a few hundred thousand active concepts; migration 275 already ships the trigram
GIN + prefix indexes that make substring/prefix autocomplete index-assisted, and 307
adds the category facet. The platform runs a 3-node on-prem RKE2 cluster with a
CNPG Postgres (root `CLAUDE.md`) — option B adds a new stateful service + sync drift
for no measured need, and option C (Snowstorm-class) brings a JVM+Elasticsearch
footprint whose main payoffs (ECL, classification, FHIR terminology ops) are
explicit non-goals for NL-5. Revisit triggers, recorded here: if ECL/subsumption
becomes a product need (CDS rules keyed to SNOMED hierarchies), or measured p95
search latency at full SNOMED scale cannot meet the §1.4 budget, promote option C
behind the same `/api/v1/terminology` facade — the routes/service layer is the seam,
so clients never change.

### 1.3 Versioned release ingestion (the real gap)

Current state: `terminology_concepts` is `UNIQUE (system_key, code)` — one current
row per code; the importer upserts in place, never retires codes absent from a new
release, and never writes the `terminology_import_batches` provenance table that
migration 307 created for exactly this purpose. Design:

- **Release stamping.** Add `last_seen_release VARCHAR(120)` to
  `terminology_concepts` (1 column, backfilled null). Importer stamps every upserted
  row with `--version`, and writes one `terminology_import_batches` row per run
  (status running→completed/failed/partial, row counts — columns already exist).
- **Retirement sweep.** New importer flag `--full`: after a full-release import,
  concepts of that system whose `last_seen_release <> current` flip
  `status='inactive'` (never DELETE — bindings and `clinical_code_bindings` rows
  reference codes historically). `validateCode` already returns
  `valid:false, reason:'concept_inactive'` for non-active concepts
  (`terminologyService.js:301–308`), and callers already treat that as warn-not-block
  (problem list soft-validation; `codingValidationService` flags), so retired codes
  degrade safely. Partial imports (curated subsets, WHO-API cache-through) never
  sweep.
- **Rollback.** Releases are files: re-running the importer with the prior release’s
  files + `--full --version <prior>` restores the prior active set (upserts are
  idempotent; sweep re-flips statuses). Document this in the runbook; no
  staging-table swap is needed because upserts are online and non-destructive.
  Provenance of every flip lives in `terminology_import_batches` +
  `terminology_audit_events`.
- **Concept-map ingestion.** Extend the importer with `--rf2-map` to load the SNOMED
  RF2 ExtendedMap refset (SNOMED→ICD-10) and a generic map CSV
  (`from_system,from_code,to_system,to_code,relationship`) for WHO's ICD-10↔ICD-11
  mapping tables — both landing in the existing `terminology_concept_maps` via the
  existing `upsertConceptMap` semantics (source stays curator-editable;
  `mapCode` already walks reverse edges so one stored direction serves both).

### 1.4 Search/autocomplete performance posture

Grounded in what clinical UIs do today: `coded_diagnosis_picker.dart` debounces
350 ms and requests 12 items; the order composer type-ahead debounces against
catalog endpoints; `searchConcepts` clamps limit to 100 and requires ≥2 chars.

- **Query plan:** keep `localSearchConcepts`'s rank (exact code → display-prefix →
  substring, shorter-display-first). At SNOMED scale the substring leg must hit the
  pg_trgm GIN index (`idx_terminology_concepts_display_trgm`, migration 275) — add a
  seeded deep test that EXPLAINs the search under a >100k-row synthetic corpus and
  asserts an index scan (regression tripwire for accidental seq-scan rewrites).
- **Budget:** server-side p95 ≤ 150 ms for a 3-char query against full-SNOMED scale
  on the QA cluster, ≤ 50 ms for prefix hits; picker keeps its debounce so at most
  ~3 queries/second/clinician. No new infra; if the budget fails at real scale the
  §1.2 revisit trigger fires.
- **ICD-11 ordering flip:** today `searchConcepts` calls the WHO API **first** for
  ICD-11 when configured (8 s timeout) and falls back local
  (`terminologyService.js:224–249`) — acceptable for a curated-lookup path, wrong
  for type-ahead once a full local ICD-11 import exists. Change: go **local-first
  when `terminology_code_systems.concept_count` for ICD11 exceeds a threshold**
  (i.e., a real import happened; the 10-row starter set stays WHO-first), keeping
  the WHO client for `getConcept` cache-misses (already local-first, `:252–280`)
  and periodic refresh. Behavior is data-driven — no new flag needed.
- **Category facets** (e.g. `semantic_tag='disorder'` for diagnosis pickers) ride
  the existing `(system_key, status, category)` partial index (migration 307).

### 1.5 Mapping services + catalog bindings (extension, not invention)

- `GET /api/v1/terminology/map` + curator `POST /map` already exist; NL-5 adds the
  bulk map ingestion above and a **coverage view**: extend `coverageReport()` to
  also report concept-map coverage per system pair (counts by relationship), since
  ABDM/FHIR export quality depends on ICD↔SNOMED mapping density.
- Catalog bindings: run `POST /bindings/suggest {persist:true}` per catalog after
  LOINC/ATC imports land, then curator confirmation via the existing flow. The
  `investigation_test_catalog` seed (migration 102) ships no LOINC codes — binding
  it is a P1 acceptance metric (`coverageReport` ≥90% confirmed on the seed rows).

### 1.6 Per-tenant enablement

Terminology content stays **global** (no PHI — 275/307 design notes). What is
per-tenant is *which systems the UIs offer and prefer*:

- New table `tenant_terminology_settings` (tenant_id PK, Pattern-A RLS like
  migration 351): `preferred_diagnosis_system` (default `ICD11`),
  `enabled_systems TEXT[]` (default `{ICD10,ICD11,SNOMED_CT,LOINC,ATC}`),
  `snomed_pickers_enabled BOOLEAN default false` (SNOMED problem-list picking goes
  live per tenant only after the RF2 import is verified on that environment).
- New service `terminologySettingsService` copying `compositionFeatureService`
  exactly: per-tenant-keyed 60 s cache, fail-closed to current defaults, flip audit
  via `terminology_audit_events`.
- Consumers: `coded_diagnosis_picker.dart` requests the tenant's preferred system
  (server tells it via an existing-style settings endpoint); `searchConcepts`
  rejects systems not enabled for the requesting tenant with the existing
  `TERMINOLOGY_UNKNOWN_SYSTEM`-class error shape. Default settings row reproduces
  today's behavior exactly — the feature is inert until an operator edits it.

---

## 2. Licensed Drug KB / DDI — procurement decision + seams

**This is a buy, not a build** (`docs/NEXT_LEVEL_ROADMAP.md` §7). The engine, schema,
severity taxonomy, override flow, and importer already exist (§Existing Substrate).
What NL-5 delivers in code is confined to: source-precedence handling, an acceptance
harness, and an admin status surface. The content decision is the owner's.

### 2.1 Option matrix (for the owner decision — not a recommendation to build)

| Option | Class | Strengths for VH Health | Weaknesses / risks | Integration effort against migration 277 |
|---|---|---|---|---|
| **First Databank (FDB)** — MedKnowledge class | Global licensed KB | Deepest DDI/dose/allergy-class/IV content; the explicit competitive bar (`NEXT_LEVEL_ROADMAP.md` §1 names "FDB/Medi-Span DDI" as what global suites win on); severity taxonomies map cleanly onto `contraindicated/major/moderate/minor` | India brand/alias coverage weak (matcher is alias-substring on Indian brands — `drug_kb_monographs.aliases`); enterprise pricing; contract/indemnity negotiation | Medium: vendor export → one-time transform → `drug-kb-import.mjs` neutral CSVs; condition cautions need vendor-condition→ICD-10-prefix mapping |
| **Medi-Span (Wolters Kluwer)** | Global licensed KB | Same class as FDB; screening modules align 1:1 with the five engine check families | Same India-brand weakness; licensing cost | Same as FDB |
| **CIMS / MIMS-class (India-local)** | India drug reference | Strong Indian brand dictionary + composition data (feeds `aliases` and complements `drug_compositions` from the composition-search feature); priced for the Indian market | DDI/dose depth materially shallower than FDB/Medi-Span; severity taxonomy may need mapping; electronic-data licensing terms vary | Low–medium: brand/monograph datasets are the easy part; DDI depth is the gap |
| **Hybrid (recommended to evaluate): India-local brand dictionary + global screening KB** | Both | Brand/alias resolution from the Indian source, interaction/dose/IV screening from the global source — matches how the engine already unions multiple `is_active` sources | Two contracts; needs explicit source-precedence rules (§2.2) | Medium |

Liability/licensing posture (applies to all options): the license must cover
*clinical decision support use* in production; redistribution stays prohibited (no
vendor content in the repo — same rule as terminology releases); vendor
attribution/display requirements must be honored in the CDS modal (finding payloads
already carry `kb_source` — `prescriptionSafetyCheck.js:1316`); update cadence
(typically monthly/quarterly) becomes an operator recurring import with
provenance. Until a license lands, the **starter set + the eight deterministic
floor checks remain the safety posture** — adequate for pilot per the audit trail
those checks carry, but `docs/NEXT_LEVEL_ROADMAP.md` §3.D is explicit that homegrown
KB is "a liability posture for production prescribing": the go-live checklist for
any production-prescribing tenant must therefore require either an active licensed
source or a written owner risk acceptance.

### 2.2 Integration seams (the only code NL-5 builds here)

- **Vendor transform contract.** One documented transform per chosen vendor
  (vendor export → the seven neutral CSVs `drug-kb-import.mjs` already accepts:
  monographs, interactions, allergy-groups, cross-reactivity, condition-cautions,
  dose-ranges, iv-compatibility). The transform is a script under `scripts/`,
  fixture-tested against a synthetic vendor-shaped sample — never against real
  licensed content in CI.
- **Source precedence.** `loadKb()` today unions all `is_active` sources
  (`drugKnowledgeBaseService.js:134–171`); with starter + licensed active
  simultaneously during validation, duplicate pairs are possible. Add
  `drug_kb_sources.priority INTEGER NOT NULL DEFAULT 100` and dedupe per dataset
  key (interaction pair, dose (drug,route,population), caution (drug,icd10_prefix),
  …) keeping the highest-priority row. This preserves the documented cutover drill
  (import licensed → validate → `UPDATE drug_kb_sources SET is_active=false WHERE
  source_key='vh_starter_set'`) while making the overlap window deterministic.
- **Acceptance harness.** Mirror the composition feature's acceptance-gate pattern
  (`composition_search_settings.acceptance_snapshot`, migration 351): a script
  `scripts/drug-kb-acceptance.mjs` that runs a fixed clinical scenario battery
  (known contraindicated pairs, pediatric overdose, CKD NSAID, penicillin
  cross-reactivity, IV ceftriaxone+RL) through `evaluateDrugKb` against the imported
  source and emits a snapshot; the starter-set deactivation step records that
  snapshot into `drug_kb_sources.metadata`. Blockers/warnings behavior itself is
  already covered by `drug-kb.deep.test.js` — the harness validates *content*, not
  code.
- **Admin visibility.** Surface the existing `drugKbStatus()`
  (sources/counts/`starter_only`) on the admin clinical-AI/governance surface so an
  operator can see licensed-vs-starter state per environment. Read-only; no new
  mutation surface (imports stay CLI).
- **What stays homegrown until (and after) a license:** the eight floor checks in
  `prescriptionSafetyCheck.js` (they are patient-context checks, not KB content),
  the antithrombotic axis (deliberately owned in code — `:242–254`), composition
  identity screening, and the starter set as a clearly-flagged fallback. The KB
  dedup guards in check 8 (`:1287–1303`) already prevent double-reporting.

---

## 3. Order-Set / Pathway Content Studio

### 3.1 Design stance

Extend `clinical_order_sets` in place — do not invent a parallel content store. The
apply path (`applyOrderSet` → `createOrder` → `runCDSChecks`) and the composer's
basket flow are the safety-critical assets; the studio only changes **which rows are
eligible to be picked**, never how orders are created. Runtime CDS remains the only
clinical gate; studio approval is a *content-quality* gate layered before
deployment, not a substitute (invariant 2).

### 3.2 Lifecycle + schema

New columns on `clinical_order_sets` (one migration):

- `family_key VARCHAR(80)` — stable identity across versions (backfill = `code`).
- `version INTEGER NOT NULL DEFAULT 1`.
- `status VARCHAR(20) NOT NULL DEFAULT 'approved'` CHECK
  (`draft|in_review|approved|retired`) — default `'approved'` deliberately grandfathers
  the two seeded sets and every `createOrderSet` row (same
  preserve-existing-behavior trick as migration 311's `curation_status DEFAULT
  'approved'`).
- `approved_by UUID`, `approved_at TIMESTAMPTZ`, `review_note TEXT`,
  `superseded_by INTEGER REFERENCES clinical_order_sets(id)`,
  `source VARCHAR(20) DEFAULT 'authored'` CHECK (`authored|imported`),
  `import_batch_id BIGINT`.
- Partial unique index: one non-retired `(tenant_id, family_key)` with
  `status='approved' AND active` — exactly one deployed version per family per
  tenant.

Lifecycle: `draft → in_review → approved (deployed when active=true) → retired`.
Editing an approved set never mutates it — the studio clones a new `version` row
(items copied) into `draft`; approving it retires the predecessor
(`superseded_by` back-link) in the same transaction. **Rollback** = retire the
current version and re-activate its predecessor (still approved, still immutable) —
one admin action, auditable, no content reconstruction.

Companion tables (same migration or its sibling):

- `order_set_review_events` (append-only: set id, action
  submit|approve|reject|retire|deploy|rollback, actor, note, created_at) —
  the `terminology_audit_events` pattern (migration 307), tenant-scoped RLS
  because sets are tenant rows.
- `order_set_import_batches` — clone of `knowledge_import_batches`
  (migration 311: tenant-scoped, Pattern-A RLS, status + row counts + dry_run).

### 3.3 Enforcement changes (small, targeted)

- `getOrderSets` adds `status='approved'` to its existing `active:true` filter
  (`orderEntryService.js:1643`) — draft/in-review/retired sets never reach the
  composer picker.
- `applyOrderSet` gains the same status guard next to the existing
  `active` check (`:1589–1591`) and stamps provenance into each created order's
  JSONB `details` (`order_set_family`, `order_set_version`) alongside the existing
  `notes: 'From order set: <title>'` (`:1540`) — no schema change on
  `clinical_orders`, full traceability of which content version drove an order.
- `createOrderSet` (`:1681`) becomes the *author* entry point: creates
  `status='draft'` when the studio flag is on for the tenant; unchanged (grandfathered
  `approved`) when off — the flag is `content_studio_settings` (tenant_id PK,
  enabled, Pattern-A RLS; `compositionFeatureService` clone). This keeps the studio
  fully inert until enabled per tenant (invariants 3–4).
- Item-payload validation at save/approve time: reuse `orderRequestFromItem`'s kind
  mapping (`:1521`) + `VALID_ORDER_TYPES` to reject payloads that could not become
  orders, and soft-validate coded fields via `terminologyService.validateCode`
  (LOINC on lab items' `test_code`, ATC/monograph alias on med items,
  `condition_codes` as ICD-10) — warnings surface to the approver; only structural
  invalidity blocks approval. Approval never runs patient CDS (there is no patient).

### 3.4 Content governance roles

Follow the named-constant convention (`TERMINOLOGY_CURATOR_ROLES`,
`terminologyRoutes.js:30–46`; `RADIOLOGY_REPORT_SIGN_ROLES` precedent noted in the
NL program memory):

- `ORDER_SET_AUTHOR_ROLES` — DOCTOR + ADMIN/SUPER_ADMIN (authors draft).
- `ORDER_SET_APPROVER_ROLES` — clinical governance: ADMIN/SUPER_ADMIN +
  QUALITY_OFFICER (role already live in curator lists) + a designated senior
  clinician; **med-containing sets additionally require a pharmacy reviewer**
  (PHARMACY_INCHARGE) recorded as a second `order_set_review_events` row before
  approval — the two-person pattern borrowed from clinical-AI approvals. Exact
  role→person assignment is an owner decision (§Owner Decisions); the
  self-approval case (author == approver) is rejected server-side.

Routes: authoring/review under `/api/v1/emr/orders/sets/*` extensions of
`orderRoutes.js` (list-for-studio incl. drafts, submit, approve, reject, retire,
rollback, import) with `wrapAutoRBAC` config; composer-facing read stays exactly
`GET /emr/orders/sets` (unchanged shape via `shapeOrderSetForResponse`,
`orderEntryService.js:1548`). OpenAPI regen + `openapi:check` mandatory (route
change ⇒ pipeline gate).

### 3.5 Import format (defined here)

One JSON document per order set (canonical, versioned by `format`), consumed by a
new `scripts/order-set-import.mjs` (dry-run, per-tenant, batch provenance —
importer conventions from `drug-kb-import.mjs`):

```json
{
  "format": "vh-order-set/1",
  "family_key": "ORDERSET-COMMUNITY-PNEUMONIA-IP",
  "title": "Community-acquired pneumonia — inpatient",
  "specialty": "internal_medicine",
  "condition_codes": ["J18", "J15"],
  "description": "Admission bundle …",
  "phase": null,
  "items": [
    { "kind": "lab", "display_order": 1, "default_selected": true,
      "payload": { "test_code": "CBC", "test_name": "Complete blood count",
                    "urgency": "routine" },
      "codings": [ { "system": "LOINC", "code": "58410-2" } ] },
    { "kind": "med", "display_order": 2, "default_selected": true,
      "payload": { "drug": "Ceftriaxone", "dose": "1 g", "route": "IV",
                    "frequency": "BD", "duration_days": 5 },
      "codings": [ { "system": "ATC", "code": "J01DD04" } ] }
  ]
}
```

Rules: `kind` + `payload` shapes are exactly the migration-156 item contract (the
per-kind payload comments in `clinical_order_set_items` are the schema); optional
`codings[]` are stored in the item payload (JSONB — no schema change) and
soft-validated on import (§3.3); imports always land `status='draft'` (never
auto-deployed — the machine-imports-are-dark rule from migration 311); a
`phases[]` wrapper (same document with `phase` labels on items) covers **pathway**
content — rendered as grouped sections in the picker, still applied through the
same per-item CDS path. Template packs (e.g., a starter specialty library) ship as
JSON files under `docs/content/order-sets/` — reviewable in PRs precisely because
this format contains no licensed content.

---

## 4. India Pediatric Content Packs

### 4.1 IAP growth charts (+ full WHO LMS)

- **New table `growth_reference_lms`** (global reference, no tenant/RLS — the
  275/307 stance): `(dataset CHECK IN ('WHO_0_5','IAP_5_18','CDC_2_20','FENTON'),
  sex CHAR(1), metric, age_days INTEGER, l NUMERIC, m NUMERIC, s NUMERIC,
  source_version, UNIQUE(dataset, sex, metric, age_days))` — the CHECK mirrors
  `growth_charts.reference_dataset` (migration 131:101–102) so recorded snapshots
  and reference data can never disagree on dataset names.
- **Importer** `scripts/growth-lms-import.mjs` (`--dataset WHO_0_5 --csv …`),
  provenance via a batches row (terminology_import_batches pattern). Content
  sources: WHO Child Growth Standards LMS tables (public), IAP 5–18y growth
  references (published by the Indian Academy of Pediatrics; redistribution posture
  = owner confirmation in §Owner Decisions — if cleared, the CSVs live in
  `docs/content/growth/` since they are small and public-standard).
- **Service change:** `computePercentile` looks up the LMS triplet from
  `growth_reference_lms` first (in-memory cache keyed dataset+sex+metric, linear
  interpolation between age points — the interpolation helper already exists,
  `growthPercentileService.js:101–119`), selecting dataset by age
  (≤60 months → WHO_0_5; 5–18 y → IAP_5_18), and **falls back to the embedded
  approximate table** when the DB set is absent (dev/offline behavior unchanged;
  the `source` field distinguishes `'WHO_0_5'` vs `'WHO_0_5_approx'` — the
  approximate marker already exists at `:185`). The >60-month bail-out at
  `:158–163` is replaced by IAP lookup. `computeGrowthSnapshot` (vitals wiring)
  gains head-circumference + BMI once the full tables provide their LMS rows —
  both metrics are already in `VALID_METRICS` and `growth_charts`.
- **Surfaces that light up without further work:** inline percentiles on pediatric
  vitals capture (`vitalsChartService.js` wiring), the nurse "below 5th percentile"
  alert and patient-app trend tile the service header names as its consumers, and
  `growth_charts` rows recorded with `reference_dataset='IAP_5_18'`.

### 4.2 UIP + IAP immunization schedule pack

- **Catalogue versioning columns** on `vaccine_catalogue` (one migration):
  `schedule_source VARCHAR(10) CHECK ('uip','iap','custom') DEFAULT 'custom'`,
  `source_version VARCHAR(40)`, `retired_at TIMESTAMPTZ` — additive; the existing
  `UNIQUE (tenant_id, code, dose_number)` and `active` flag keep their semantics.
- **Importer** `scripts/immunisation-schedule-import.mjs
  --tenant <uuid> --schedule uip|iap|both --version <label>` loading the full
  0–18 y schedules: UIP (MoHFW national schedule — the existing migration-160 seed
  already covers its first-18-months core: BCG/HepB/OPV/fIPV/DPT(pentavalent
  era)/Hib/PCV/Rota/MR/JE/DPT+OPV boosters; the pack completes 5–6 y DPT booster,
  10 y/16 y Td, and endemic JE-2) and IAP 2025/2026 (adds e.g. MMR timing,
  varicella, hepatitis A, typhoid conjugate, annual influenza, Tdap, HPV). Since
  `vaccine_catalogue` is per-tenant, "enablement" is simply which pack(s) a tenant
  imports — no new flag table.
- **Update semantics** (safety-reviewed): the importer upserts on
  `(tenant_id, code, dose_number)`; timing changes update `recommended_age_days`
  going forward only — existing `patient_immunisations`/`newborn_immunisations`
  rows are untouched because due dates are computed **at seed time** from DOB
  (`paediatricImmunisationService.ensureScheduleSeededForPatient`;
  `seedScheduleForNewborn`), so historical schedules never silently shift. Rows
  removed from a schedule version flip `active=false, retired_at=NOW()` (never
  deleted — given doses reference them). Provenance batch row per run.
- **Clinical sign-off:** pack content (which IAP-recommended vaccines a hospital
  actually offers) is a clinical/policy choice — the import is operator-run per
  tenant after a named clinician signs off the pack file (§Owner Decisions), and
  the signed `immunisation_review` note flow already covers the per-patient
  clinical review side.

---

## 5. Per-Tenant Enablement Summary

| Surface | Mechanism | Default |
|---|---|---|
| Terminology systems/pickers | `tenant_terminology_settings` (new, Pattern-A RLS, cached per-tenant) | Current behavior (inert) |
| Licensed drug KB | `drug_kb_sources.is_active` + `priority` (global content, operator cutover; per-tenant gating not applicable — safety content is not a tenant feature) | Starter set active |
| Content studio | `content_studio_settings` per-tenant flag; sets themselves are tenant rows | Off (grandfathered `approved` keeps today's behavior) |
| Growth LMS datasets | Global reference table; service falls back to embedded approximation when absent | Absent (approximation, unchanged) |
| Immunization packs | Per-tenant `vaccine_catalogue` rows via per-tenant import | Migration-160 seed only |

All flags copy `compositionFeatureService.js` (per-tenant cache keyed by tenant id,
never global refresh, fail-closed) — the cache-poisoning rationale documented in
that file's header is the reason this is the mandated shape.

## Phased Plan

Execution conventions per `docs/NEXT_LEVEL_ROADMAP.md` §8: every phase lands via
PRs with checks green; chunked backend gate; `openapi:generate`/`openapi:check`/
`openapi:sync-dart` on any route change; melos gates if Flutter files change
(P1/P3 touch the staff picker/composer only optionally — the design keeps client
changes optional per phase); staff i18n via `app_strings.dart` where staff UI text
is added; migration numbers = next free at branch time (tail today: 367; 368
reserved for NL-1 P4 SAML).

### P1 — Terminology releases, versioning, search posture (M)

Deliver:

- importer: batch provenance writes, `--full` retirement sweep, `--rf2-map` +
  generic map CSV, release stamping (`last_seen_release`)
- `tenant_terminology_settings` + service + settings endpoint (inert defaults)
- ICD-11 local-first search flip keyed on imported `concept_count`
- concept-map coverage added to `coverageReport`; binding-suggest run for the
  migration-102 investigation catalog documented as an operator step
- runbook: NRCeS/LOINC/WHO-ICD/ATC acquisition + import + rollback drill
  (`apps/backend/docs/RUNBOOKS/` — the NL-2/NL-3 runbook precedent)

Migrations: **2** (`terminology_concepts.last_seen_release` + import-batch linkage;
`tenant_terminology_settings`).

Deep tests: synthetic RF2/LOINC/CSV fixtures through the importer (dry-run + real
against the QA DB) asserting batch rows, version stamps, and retirement flips;
`validateCode` inactive-code degradation for a retired code referenced by an
existing `clinical_code_bindings` row; EXPLAIN-asserted trigram plan on a >100k
synthetic corpus (§1.4); tenant-settings fail-closed + per-tenant cache isolation
(the composition-service test shape); extend `terminology.deep.test.js` for
local-first ICD-11 ordering both sides of the threshold.

### P2 — Drug-KB procurement seams (S–M; content = owner)

Deliver:

- `drug_kb_sources.priority` + `loadKb` dedup-by-priority
- `scripts/drug-kb-acceptance.mjs` scenario battery + snapshot into
  `drug_kb_sources.metadata`; starter-deactivation drill documented
- vendor transform contract doc + one fixture-tested transform skeleton for the
  chosen vendor (buildable only after the owner decision)
- `drugKbStatus()` surfaced read-only on the admin governance page
- **no DDI/dose/allergy content authored — none**

Migrations: **1** (priority column).

Deep tests: two active sources with conflicting severities → higher-priority wins,
starter-only reporting intact (`drugKbStatus.starter_only`); acceptance battery
green against a synthetic "licensed-shaped" fixture source; cutover drill test —
starter deactivated ⇒ engine findings switch `kb_source`, floor checks (checks 1–7)
byte-identical before/after (extends `drug-kb.deep.test.js` +
`cpoe-cds-fail-closed.deep.test.js`).

### P3 — Order-set / pathway content studio (M–L)

Deliver:

- governance schema (family/version/status/approvals/supersession) +
  `order_set_review_events` + `order_set_import_batches` + `content_studio_settings`
- lifecycle routes on `orderRoutes.js` (submit/approve/reject/retire/rollback/
  import) with named role constants, two-person med-set approval, self-approval
  rejection; OpenAPI regen
- `getOrderSets`/`applyOrderSet` status guards + order provenance stamping
- `vh-order-set/1` import format + `scripts/order-set-import.mjs` + a small
  reviewable starter pack under `docs/content/order-sets/`
- admin studio UI (apps/admin) for the author/review queue; composer untouched
  except the picker transparently showing only deployed versions

Migrations: **2**.

Deep tests: full lifecycle walk (draft→review→approve→deploy→new version→rollback)
asserting exactly-one-deployed-per-family, immutability of approved rows, and
event-log completeness; `applyOrderSet` refuses draft/retired and stamps
family/version into `clinical_orders.details`; **CDS non-bypass regression** — a
deployed set containing a contraindicated med for a seeded allergic patient still
produces the CDS blocker through apply and through the composer bulk path (extends
`cpoe-cds-fail-closed.deep.test.js` + `orderSetItemRouting.test.js`); import
dry-run/idempotency/dark-landing; tenant isolation on all new tables (the
`paediatricImmunisationTenantAuthorization.test.js` shape).

### P4 — India pediatric content packs (S–M)

Deliver:

- `growth_reference_lms` + importer + `growthPercentileService` DB-first lookup
  with embedded fallback + IAP 5–18 handling replacing the >60-month bail-out
- `vaccine_catalogue` versioning columns + `immunisation-schedule-import.mjs`
  with UIP/IAP packs (pack files under `docs/content/immunisation/` pending the
  redistribution confirmation; otherwise operator-supplied)
- runbook: per-tenant pack import + clinician sign-off step

Migrations: **2** (LMS table; catalogue columns).

Deep tests: LMS lookup vs embedded approximation (source markers distinct;
known-value z-score/percentile fixtures for WHO and IAP points, extending
`growthPercentileService.test.js`); >60-month IAP path produces
`reference_dataset='IAP_5_18'` rows accepted by the migration-131 CHECK; schedule
import upsert/retire semantics; **existing patient schedules unchanged after a
timing update** (seed → re-import with shifted `recommended_age_days` → seeded
due_dates identical; new seeds pick up the new timing) — extends
`paediatric-immunisation-deep.test.js`.

**Total new migrations: ~7** (2+1+2+2), numbered from the next free slot at each
branch time per §8.

## Owner Decisions

1. **Drug-KB vendor** (the procurement decision this spec exists to frame): FDB vs
   Medi-Span vs India-local CIMS/MIMS-class vs the hybrid (§2.1) — including budget
   class, indemnity/CDS-use terms, update cadence, and who signs the contract.
   P2's transform skeleton waits on this.
2. **Starter-set production posture:** confirm the gate that production-prescribing
   tenants require an active licensed source or a written risk acceptance
   (§2.1 liability paragraph).
3. **NRCeS enrolment owner + date** for the SNOMED CT affiliate license
   (steps in §1.1); same owner question for LOINC registration, WHO ICD-API mode
   (cloud client vs self-hosted container — recommendation: self-hosted), and the
   WHOCC ATC/DDD file order.
4. **Storage approach sign-off:** embedded Postgres concept tables (option A,
   §1.2) — sign off or challenge before P1; the revisit triggers are recorded.
5. **Content-governance role assignment:** who holds ORDER_SET_APPROVER (named
   senior clinician per tenant), pharmacy second-reviewer for med sets, and whether
   QUALITY_OFFICER approval is required on every set or only pathway-class sets
   (§3.4).
6. **IAP/UIP pack sign-off + redistribution:** which schedule variant(s) each pilot
   tenant runs (UIP-only vs UIP+IAP), the named clinician who signs pack content,
   and confirmation whether IAP LMS/schedule tables may live in-repo as public
   standards or must stay operator-supplied files (§4).
7. **Terminology release cadence:** how often SNOMED/LOINC/ICD-11/ATC re-imports
   run once live (suggest: on NRCeS/Regenstrief release, minimum annually), and who
   executes the operator imports while deploy is HELD.

## Acceptance Boundary

NL-5 build can start phase-by-phase: P1 immediately (content acquisition can trail —
the importer work is testable on synthetic fixtures); P2 code seams immediately, the
vendor transform only after Owner Decision 1; P3 immediately; P4 immediately with
WHO data, IAP tables after Decision 6. NL-5 is **complete** when: all four phases
shipped through green PRs with the deep tests above; `coverageReport` shows ≥90%
confirmed LOINC bindings on the seeded investigation catalog and concept-map
coverage reported; a full SNOMED+LOINC+ICD-11 import has been executed and rolled
back once on the QA cluster with provenance rows as evidence; the studio lifecycle
has produced, deployed, and rolled back a versioned order set on QA without any CDS
regression; and the pediatric packs have been imported for one QA tenant with the
sign-off trail recorded. Live-tenant enablement (flags, licensed-KB cutover,
production imports) stays on the operator track — deploy remains HELD.
