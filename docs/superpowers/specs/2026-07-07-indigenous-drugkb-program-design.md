# Indigenous Drug-KB Program Design

Date: 2026-07-07
Status: design gate only
Branch: `docs/indigenous-drugkb-design`

This spec defines the VH-owned indigenous drug knowledge-base program. It is
survey-grounded, docs-only, and intentionally contains no drug facts, drug rows,
example medicines, dose values, interaction pairs, cautions, contraindication
examples, or importable content.

## Non-Goals

- Do not author, infer, copy, transform, or import any drug content in this
  PR.
- Do not add code, migrations, seed data, CSV fixtures, source extracts, PDFs,
  acceptance fixtures, or generated artifacts in this PR.
- Do not use model knowledge for any medication fact. Every future content row
  must come from a verified source or original clinical authoring with recorded
  provenance and review.
- Do not commit vendor content, restricted government content, terminology
  release files, or source tables whose terms do not permit repository storage.

## Survey Grounding

The roadmap owner override on 2026-07-07 replaced the earlier "license a
drug-drug interaction database" direction with a VH-owned indigenous KB that is
evidence-gated, clinically governed, acceptance-tested, and seeded by the
aushadhi brand-to-composition work before any production activation. It also
requires this dedicated design spec before content authoring starts
(`docs/NEXT_LEVEL_ROADMAP.md:249-261`).

The existing KB substrate is migration 277. It creates `drug_kb_sources`,
monographs, interactions, allergy groups, allergy cross-reactivity, condition
cautions, dose ranges, and IV compatibility tables
(`apps/backend/src/migrations/277_drug_knowledge_base.sql:8-23`). The tables are
global reference data with no PHI, no tenant ID, and no row-level security; the
starter set is deliberately conservative and must be deactivated once an
accepted licensed or imported dataset exists
(`apps/backend/src/migrations/277_drug_knowledge_base.sql:25-34`). Sources
already include source key, vendor, version, license note, active/starter flags,
import timestamp, and metadata
(`apps/backend/src/migrations/277_drug_knowledge_base.sql:38-50`).

The existing content shapes are adequate for a first indigenous edition but lack
row-level provenance. Monographs carry the canonical drug key, display name,
ATC code, class, aliases, and properties
(`apps/backend/src/migrations/277_drug_knowledge_base.sql:53-64`).
Interactions carry ordered drug keys, severity, evidence level, mechanism,
recommendation, and metadata
(`apps/backend/src/migrations/277_drug_knowledge_base.sql:69-84`). Allergy
groups and cross-reactivity are normalized
(`apps/backend/src/migrations/277_drug_knowledge_base.sql:89-110`), condition
cautions are keyed by `icd10_prefix`
(`apps/backend/src/migrations/277_drug_knowledge_base.sql:112-123`), dose ranges
include population, route/frequency, max single and daily doses, weight-based
ceilings, and eGFR bands
(`apps/backend/src/migrations/277_drug_knowledge_base.sql:127-145`), and IV
compatibility covers pairwise compatibility status, diluent, concentration,
stability, and recommendation
(`apps/backend/src/migrations/277_drug_knowledge_base.sql:147-161`).

The starter source is explicitly not a licensed database and is not a complete
clinical KB; it exists only to exercise the safety substrate until a real
accepted source replaces it
(`apps/backend/src/migrations/277_drug_knowledge_base.sql:167-170`). Future
program design must keep that distinction visible in source metadata, UI status,
and activation criteria.

The engine already screens five KB-backed safety families and caches active
reference rows for five minutes
(`apps/backend/src/services/clinical/drugKnowledgeBaseService.js:5-20`,
`apps/backend/src/services/clinical/drugKnowledgeBaseService.js:25`). It loads
only active source rows and the seven KB datasets
(`apps/backend/src/services/clinical/drugKnowledgeBaseService.js:131-170`),
reports counts and `starter_only` status
(`apps/backend/src/services/clinical/drugKnowledgeBaseService.js:219-255`), and
emits findings with check, severity, and source key
(`apps/backend/src/services/clinical/drugKnowledgeBaseService.js:294-297`). The
five families are interaction checks, allergy cross-sensitivity checks,
condition caution checks, dose ceiling checks, and IV compatibility checks
(`apps/backend/src/services/clinical/drugKnowledgeBaseService.js:310-515`).

Prescription safety is already the production floor around that KB. It combines
deterministic local checks with check 8, the DB-backed KB engine
(`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:777-790`,
`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:1246-1255`).
Existing deterministic checks include duplicate active prescriptions
(`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:901-928`),
composition-backed allergy and duplicate screens where the composition index is
ready
(`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:930-945`),
pediatric dose blockers
(`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:1140-1203`),
additional medication-safety, pregnancy/lactation-adjacent, renal, and
stewardship floors
(`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:1205-1244`). KB
findings map severe results to blockers and other results to warnings
(`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:1277-1324`).
Local engine failures remain fail-closed
(`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:1338-1351`); the
KB-backed check currently degrades to a warning if the KB layer itself fails
(`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:1326-1335`), so
edition activation must also include health/readiness monitoring rather than
treating import success as sufficient.

The neutral importer is already the right first delivery seam. It accepts seven
CSV datasets, source/vendor/version/license metadata, and a dry-run mode
(`apps/backend/scripts/drug-kb-import.mjs:1-27`,
`apps/backend/scripts/drug-kb-import.mjs:37-118`,
`apps/backend/scripts/drug-kb-import.mjs:126-179`). It reports parsed and
upserted row counts and reminds operators that starter deactivation is a
separate decision
(`apps/backend/scripts/drug-kb-import.mjs:200-207`).

The next-level content-studio survey already identified the need for active
source priority and deterministic deduplication, plus an acceptance harness
before starter deactivation
(`docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:444-454`,
`docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:719-730`).
That same work established an approved-content lifecycle pattern with immutable
approved artifacts, review events, rollback, and role separation
(`docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:500-518`,
`docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:541-554`).
The build prompt for that lifecycle requires author and approver role
separation, pharmacy review for medication-containing content, and rejected
self-approval
(`docs/superpowers/build-prompts/nl5-p3-content-studio.md:14-20`).

The composition spine is also already present. Migration 350 stores global
composition references and tenant catalog composition columns
(`apps/backend/src/migrations/350_drug_compositions.sql:1-30`) plus a
tenant-scoped curation queue
(`apps/backend/src/migrations/350_drug_compositions.sql:36-45`). The aushadhi
reference importer ingests an external artifact into the composition layer,
matches tenant catalog brands, and reports matched, ambiguous, and unmatched
catalog counts
(`apps/backend/scripts/import-drug-reference.mjs:1-7`,
`apps/backend/scripts/import-drug-reference.mjs:42-79`,
`apps/backend/scripts/import-drug-reference.mjs:100-170`). Its per-tenant
feature flag is fail-closed and records an acceptance snapshot on enablement
(`apps/backend/src/migrations/351_composition_search_settings.sql:1-15`,
`apps/backend/src/services/pharmacy/compositionFeatureService.js:4-16`,
`apps/backend/src/services/pharmacy/compositionFeatureService.js:35-64`,
`apps/backend/src/services/pharmacy/compositionFeatureService.js:78-98`).

The terminology spine is global reference data and must be imported rather than
hand-seeded
(`apps/backend/src/migrations/275_terminology_service.sql:12-56`). The
terminology release runbook says release files are operator-supplied and should
not be committed to the repo, including ATC release files under WHOCC terms
(`apps/backend/docs/RUNBOOKS/terminology-releases.md:11-14`,
`apps/backend/docs/RUNBOOKS/terminology-releases.md:27-39`). Terminology import
batches and audit events already provide a model for provenance and release
traceability
(`apps/backend/src/migrations/307_terminology.sql:8-17`).

Clinical AI curation is not the drug KB, but it gives a useful governance
parallel: source material is ingested as pending, carries source/signoff
metadata, is dark until human approval, refreshes create changed pending rows,
and nothing is auto-approved
(`docs/CLINICAL_AI_KNOWLEDGE_CURATION.md:6-14`,
`docs/CLINICAL_AI_KNOWLEDGE_CURATION.md:28-47`,
`docs/CLINICAL_AI_KNOWLEDGE_CURATION.md:53-90`,
`apps/backend/src/migrations/311_knowledge_curation.sql:1-33`,
`apps/backend/src/migrations/311_knowledge_curation.sql:85-108`,
`apps/backend/src/services/ai/knowledgeCurationService.js:1-32`).

## Source Licensing Survey

This survey is a design input, not legal advice. Every future source must still
receive a repository-recorded license review before any row derived from it is
authored, imported, reviewed, or released.

| Source family | Intended role | Licensing finding | Program rule |
| --- | --- | --- | --- |
| VH hospital formulary, pharmacy catalog, and actual prescribing volume | Coverage priority, formulary scope, local aliases, and pilot go-live metrics | Hospital-owned operational data, subject to internal privacy and tenancy controls | Use for prioritization and local mapping only. Do not convert prescribing history into clinical drug facts. Store only non-PHI aggregate coverage metrics in release metadata. |
| PMBI / Jan Aushadhi product list | Brand-to-composition seeding, generic composition matching, and coverage gap measurement | PMBI publishes product-list pages and export flows, but its copyright page says reproduction is free only after permission by email, with accurate reproduction and source acknowledgement. Its disclaimer asks users to verify and seek professional advice before action. | Treat as `permission_required` unless VH has written permission or an operator supplies an artifact under accepted terms. Use for composition and alias coverage only, not as clinical safety authority. |
| Indian government open-data portals under Government Open Data License India | Possible public datasets for non-sensitive metadata and public health reference lists | The Government Open Data License India grants worldwide, royalty-free use, adaptation, publication, and derivatives with attribution, while excluding protected or non-shareable categories. | Use only when the specific dataset explicitly carries compatible open-data terms and passes source review. Record attribution and dataset URL in row provenance. |
| CDSCO public pages, notices, and regulatory material | Regulatory status, alerts, and source citations for reviewer-authored rows | CDSCO copyright policy requires permission for full or partial reproduction and source acknowledgement. | Use as `reference_only` unless permission is recorded. Do not copy tables or notice text into the KB. Clinical reviewers may author original row text that cites the public notice. |
| Indian Pharmacopoeia Commission / National Formulary of India | Authoritative Indian reference for reviewer judgment | IPC describes NFI as an authoritative prescribing reference. NFI PDFs carry copyright and require permission for reproduction. | Use as `reference_only` unless IPC permission is recorded. Do not import, scrape, or reproduce NFI tables or language. |
| WHO ATC/DDD and WHOCC releases | Classification axis and ATC validation | WHO describes ATC/DDD as an international classification and measurement standard; WHOCC annual index files are ordered publications with a searchable index and terms that restrict copying, redistribution, and manipulation. | Follow the terminology runbook. ATC files remain operator-supplied under accepted WHOCC terms and are not committed to the repo. Store ATC identifiers only where allowed. |
| State formularies, standard treatment guidelines, hospital protocols, labels, and open-access literature | Evidence references for original clinical authoring | Terms vary by document and publisher. Some are public but not redistributable; some may permit citation but not transformation. | Every document gets a license status before use. Author original KB row recommendations; do not copy restricted text. |
| Original VH clinical authoring | Primary path for indigenous safety rows when source material is not redistributable | VH owns original row text produced by assigned reviewers, subject to governance and audit controls. | Self-authored content may live in the repo if the owner chooses reviewable in-repo storage, but each row still requires source references, license decision, author, reviewer, and approval trail. |

Required license statuses for future source registry entries:

- `hospital_owned`
- `government_open_data_attribution`
- `permission_recorded`
- `permission_required`
- `operator_supplied_terms`
- `reference_only`
- `prohibited`

The default status is `permission_required`, not "open," whenever terms are
unclear.

## Dataset Sourcing Strategy

Every dataset uses the same rule: content is either original VH clinical
authoring backed by cited evidence, or source-derived content whose license
review permits the exact use. No row may be filled from model memory, clinical
common knowledge, or unlabeled source text.

| Dataset | Existing seam | Primary strategy | Licensing rule | Required row provenance |
| --- | --- | --- | --- | --- |
| `monographs` | Canonical keys, display names, ATC code, class, aliases, and JSON properties already exist (`apps/backend/src/migrations/277_drug_knowledge_base.sql:53-64`) | Start from actual pilot formulary plus aushadhi composition matches. Use ATC from the terminology spine where licensed/operator-supplied. Author display and classification choices through pharmacy review. | Local alias mapping may be hospital-owned. PMBI and ATC material require accepted terms before reuse. | Formulary source, composition source, ATC source, author, reviewer, license status, and mapping rationale. |
| `interactions` | Ordered pair schema with severity and recommendation exists (`apps/backend/src/migrations/277_drug_knowledge_base.sql:69-84`) | Original VH pharmacology authoring from approved references, prioritized by pilot formulary exposure and high-risk medication families selected by the pharmacy committee. | Do not copy restricted KBs, NFI language, or publisher text. If licensed source data is ever used, keep vendor/license fields explicit. | Evidence references, author rationale, severity justification, reviewer signoff, and whether the recommendation is original text. |
| `allergy-groups` | Group and cross-reactivity tables are normalized (`apps/backend/src/migrations/277_drug_knowledge_base.sql:89-110`) | Pharmacy-authored grouping model mapped to pilot formulary items and composition aliases. | Source documents are citations unless their terms permit data extraction. | Group rationale, mapped formulary coverage, evidence references, and reviewer role. |
| `cross-reactivity` | From/to group, risk, rationale, and metadata are available (`apps/backend/src/migrations/277_drug_knowledge_base.sql:100-110`) | Clinical pharmacology-authored risk statements from approved references, with conservative defaults until reviewed. | No copied source language. Restricted references can support original authoring only. | Source references, evidence grade, original rationale, author, reviewer, and effective edition. |
| `condition-cautions` | Rows key to ICD-10 prefix and risk level (`apps/backend/src/migrations/277_drug_knowledge_base.sql:112-123`) | Use the terminology spine for ICD axis validation and author caution rows from approved clinical references and hospital protocols. | ICD/terminology releases remain operator-supplied as required by the terminology runbook. Source recommendations must be original or permitted. | ICD source, condition mapping rationale, evidence references, reviewer, and license decision. |
| `dose-ranges` | Population, route, frequency, max values, weight basis, and eGFR bands exist (`apps/backend/src/migrations/277_drug_knowledge_base.sql:127-145`) | Author only after pilot formulary scope and reviewer appointments are set. Prioritize pediatric, renal, and safety-critical coverage by local use and formulary committee direction. | Numeric dosing content is clinical content and must never come from model knowledge. Source terms must permit extraction or support original authored recommendations. | Source references, calculation basis, population basis, renal basis, author, independent checker, and reviewer signoff. |
| `iv-compatibility` | Pairwise status, diluent, concentration, stability, and recommendation fields exist (`apps/backend/src/migrations/277_drug_knowledge_base.sql:147-161`) | Defer until the pilot IV formulary and source access are explicitly approved. Use only authoritative licensed/operator-approved references or original hospital protocol authoring. | Treat external compatibility tables as restricted unless license review says otherwise. | Source terms, protocol reference, authored recommendation, concentration/diluent basis, checker, and reviewer. |

## Provenance Schema Seam

`drug_kb_sources.metadata` is edition-level metadata; it is not enough for
clinical governance at row level. A future migration should add
`provenance JSONB NOT NULL DEFAULT '{}'::jsonb` to every `drug_kb_*` content
table before indigenous rows are allowed.

Minimum row provenance payload:

- `source_refs`: array of source registry IDs plus URL or document reference,
  accessed date, license status, and whether quoted text was used.
- `content_basis`: `original_authoring`, `permitted_source_transform`, or
  `hospital_mapping`.
- `author_user_id` and `authored_at`.
- `clinical_reviewer_user_id`, `pharmacy_reviewer_user_id`, and review times.
- `evidence_grade` and reviewer rationale.
- `license_decision_id` and reviewer.
- `edition_key`, `source_key`, and `version`.
- `coverage_scope`: pilot formulary, tenant, department, or release wave that
  justified the row.

Rows with missing provenance must fail import, fail review, and fail release
activation.

## Editorial Workflow

The program should reuse the content-studio lifecycle pattern: draft, in review,
approved, released, and retired, with immutable approved content and rollback
through prior releases
(`docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:500-518`).

Roles:

- `DRUG_KB_AUTHOR_ROLES`: designated pharmacy staff, clinical pharmacology
  authors, or clinician authors appointed for a release wave.
- `PHARMACOLOGY_REVIEWER_ROLES`: senior clinical pharmacist, clinical
  pharmacologist, or named physician reviewer. If the current role taxonomy
  cannot express this cleanly, add a dedicated `PHARMACOLOGY_REVIEWER` role in
  the implementation PR.
- `DRUG_KB_RELEASE_APPROVER_ROLES`: owner-appointed release approvers using the
  same two-person pattern as medication-containing order-set review.
- Self-approval is rejected. Medication safety content always requires pharmacy
  review, even when authored by a physician.

Workflow:

1. Create a source registry entry with license status, source owner, access
   method, and allowed use.
2. Define the release wave and formulary coverage target before authoring any
   row.
3. Author rows in draft state from approved sources only. The author records
   provenance and writes original recommendation text where source reproduction
   is not permitted.
4. Run structural lint: canonical keys, source IDs, license status, required
   provenance, no raw source excerpts, no missing reviewer fields, no unscoped
   rows, no starter-only activation.
5. Send rows to clinical pharmacology and pharmacy review. Reviewers record
   accept, request changes, or reject decisions with rationale.
6. Build an edition candidate using the neutral importer in dry-run and then
   import mode once review passes.
7. Run the acceptance battery against the candidate edition, capture counts,
   failing cases, coverage metrics, source hashes, and KB status.
8. Require named clinician signoff plus pharmacy release approval.
9. Activate the edition, deactivate superseded starter rows only when go-live
   criteria are met, and record the activation event.
10. Monitor status, safety-check errors, and coverage drift. Emergency patches
    follow the same provenance and two-person review path with a shorter SLA if
    owners approve that cadence.

## Edition and Release Model

The owner-facing source family is `vh_indigenous`. Current schema makes
`drug_kb_sources.source_key` unique and content rows foreign-key to that source
key (`apps/backend/src/migrations/277_drug_knowledge_base.sql:38-84`), so the
implementation must not overwrite a singleton row in place if rollback and audit
history are required.

Preferred implementation seam:

- Add a source-family concept, or encode immutable edition keys as concrete
  source keys such as `vh_indigenous_<version>` while storing
  `metadata.family = 'vh_indigenous'`.
- Keep `version` as the human release label.
- Keep one active indigenous edition at a time unless the priority/dedup work
  explicitly supports mixed active editions.
- Store the acceptance snapshot, coverage metrics, reviewer approvals, source
  hashes, and release notes in `drug_kb_sources.metadata`.
- Use `drug_kb_sources.priority` and deterministic deduplication before
  activating indigenous rows over starter rows, as already identified in the
  content-studio survey
  (`docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:444-454`).

Activation gate:

- Candidate source imported with all seven dataset checks applicable to the
  release wave.
- Acceptance battery passes.
- `drugKbStatus()` shows active indigenous source counts and not starter-only
  status where the pilot requires indigenous coverage
  (`apps/backend/src/services/clinical/drugKnowledgeBaseService.js:242-255`).
- Coverage meets the pilot target.
- Named clinician and pharmacy reviewer signoff are recorded.
- Starter deactivation SQL is run only after the above pass.

Rollback:

- Reactivate the previous accepted indigenous edition if one exists.
- If no accepted indigenous edition exists and the pilot gate allows it,
  reactivate the starter source as emergency fallback while prescription safety
  status clearly reports starter-only coverage.
- Do not delete rejected, superseded, or rolled-back source rows; mark them
  inactive and keep metadata.

## Coverage Roadmap

The first release should be scoped by real VH usage, not by generic drug-list
ambition.

Wave 0: program setup

- Appoint reviewers and approvers.
- Freeze the first pilot formulary scope.
- Decide in-repo versus operator-supplied content storage.
- Add provenance schema, source registry, lint, diff, and acceptance tooling.
- Run no clinical content rows.

Wave 1: pilot formulary safety floor

- Cover the pilot formulary items with the highest local prescribing volume and
  owner-selected high-risk medication families.
- Use the aushadhi composition import and tenant catalog matching to find
  aliases, compositions, ambiguous matches, and coverage gaps
  (`apps/backend/scripts/import-drug-reference.mjs:100-170`).
- Prioritize rows that exercise all active safety families needed for the pilot:
  monographs, interactions, allergy groups and cross-reactivity, condition
  cautions, dose ranges, and IV compatibility if IV prescribing is in scope.

Wave 2: inpatient and emergency expansion

- Expand coverage across inpatient, emergency, pediatric, renal, obstetric, and
  IV workflow needs based on owner-approved formulary subsets.
- Add department-specific coverage metrics and drift reports.

Wave 3: full formulary and maintenance cadence

- Move from pilot coverage to complete hospital formulary coverage.
- Add quarterly or monthly editions plus emergency safety patch releases.
- Track coverage against formulary churn, aushadhi import drift, and
  terminology release updates.

Required coverage metrics:

- `formulary_items_total`
- `formulary_items_with_monograph`
- `monograph_coverage_pct`
- `alias_coverage_pct`
- `composition_match_pct`
- `ambiguous_composition_match_count`
- `interaction_coverage_by_selected_family`
- `allergy_group_coverage_pct`
- `condition_caution_coverage_pct`
- `dose_range_coverage_by_population`
- `iv_compatibility_coverage_pct`
- `provenance_complete_pct`
- `review_complete_pct`
- `acceptance_pass_count`
- `acceptance_fail_count`
- `starter_rows_still_active`

Pilot go-live requires the acceptance battery, named clinician signoff, pharmacy
review signoff, and documented coverage at or above the owner-approved target
for the pilot formulary.

## Tooling Gaps

Authoring surface:

- Start with reviewable CSV plus provenance JSON because the neutral importer
  already exists.
- Add a content-studio UI only after the CSV path has source registry,
  provenance lint, diff, review events, and acceptance snapshots.
- The UI must not show model-generated suggestions as candidate facts.

Diff and review:

- Add a drug-KB diff tool that compares edition candidate versus active edition
  by dataset, canonical key, source, severity, risk level, and reviewer status.
- Redact or block restricted source excerpts in diff output.
- Show reviewer-facing provenance and license status beside every changed row.

CI and release protections:

- Reject rows without provenance.
- Reject rows whose source registry status is `permission_required` or
  `prohibited`.
- Reject raw PDFs, source exports, copied restricted tables, and unlabeled
  external content in repo paths.
- Reject any content package containing starter-only activation.
- Run import dry-run, structural lint, duplicate/priority checks, acceptance
  battery, and coverage target checks before activation.
- Keep synthetic-only fixtures in CI. Real clinical content fixtures are not
  needed for generic unit tests.

Storage decision:

- Self-authored VH `vh_indigenous` content can live in the repo if the owner
  wants reviewable pull requests, the repository access model is appropriate,
  and every row is original VH text with provenance.
- Operator-supplied terminology files, vendor files, PMBI exports without
  permission, NFI text, CDSCO reproduced material, WHOCC release files, and
  other restricted sources must stay outside the repo.
- If the owner chooses operator-supplied content storage for all drug-KB rows,
  PRs should carry only schema/tooling/release metadata and the content package
  hash, not row content.

## Owner Decisions

Before the first implementation PR, the owner must decide:

1. Reviewer appointments: named pharmacology lead, pharmacy reviewer, backup
   reviewer, senior clinician signoff owner, and release operator.
2. Role model: reuse existing order-set approver roles, or add a dedicated
   `PHARMACOLOGY_REVIEWER` role for this program.
3. First formulary scope: pilot tenant or department, prescribing-volume lookback
   window, selected high-risk medication families, and minimum coverage target.
4. Content storage: reviewable self-authored rows in repo, operator-supplied
   package storage, or a hybrid where only self-authored VH rows are in repo.
5. Edition cadence: monthly, quarterly, and emergency patch SLA.
6. Source permissions: whether VH will request PMBI permission, IPC/NFI
   permission, CDSCO reproduction permission, or treat those sources as
   reference-only.
7. Starter deactivation threshold: exact coverage target and signoff language
   required before `vh_starter_set` is deactivated.

## Next Implementation Slice

The next PR should still contain no drug content. It should implement only the
program substrate:

- Source-family or immutable-edition modeling for `vh_indigenous`.
- Row-level provenance columns on every `drug_kb_*` table.
- Source registry license status and release metadata validation.
- `drug_kb_sources.priority` and deterministic active-source deduplication.
- Drug-KB structural lint and diff tools.
- Acceptance snapshot storage using the existing composition-search and
  terminology-release patterns.
- CI guardrails that block restricted content and missing provenance.

Only after that substrate is merged should a separate content PR or
operator-supplied package introduce any indigenous KB rows.

## External Licensing References

Accessed on 2026-07-07:

- [CDSCO copyright policy](https://cdsco.gov.in/opencms/opencms//en/Copyright-Policy/)
- [IPC National Formulary of India overview](https://www.ipc.gov.in/mandates/nfi/about-nfi.html)
- [NFI 2011 PDF](https://qps.nhsrcindia.org/sites/default/files/2022-01/National%20Formulary%20of%20India%20%28NFI%29%2C%202011.pdf)
- [NFI 2016 PDF](https://www.ipc.gov.in/images/news/NFI-0414979118.pdf)
- [WHO ATC/DDD methodology](https://www.who.int/tools/atc-ddd-toolkit/methodology)
- [WHOCC 2026 ATC/DDD Guidelines PDF](https://atcddd.fhi.no/filearchive/publications/2026_guidelines_for_atc_classification_and_ddd_assignment.pdf)
- [WHOCC copyright and disclaimer](https://atcddd.fhi.no/copyright_disclaimer/)
- [Government Open Data License India Gazette](https://data.gov.in/sites/default/files/Gazette_Notification_OGDL.pdf)
- [PMBI product list](https://www.pmbi.co.in/ProductList.aspx)
- [PMBI copyright](https://www.pmbi.co.in/copyright.aspx)
- [PMBI disclaimer](https://www.pmbi.co.in/disclaimer.aspx)
