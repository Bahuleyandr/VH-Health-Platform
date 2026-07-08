# Indigenous Drug-KB Program Design

Date: 2026-07-08
Status: design gate only
Branch: `docs/indigenous-drugkb-design`

This spec defines the VH-owned indigenous drug knowledge-base program. It is
survey-grounded, docs-only, and contains no drug facts, no interaction pairs, no
dose values, no caution rows, no compatibility rows, no source extracts, and no
importable content.

## Non-Goals

- Do not author, infer, transform, copy, or import drug-content rows in this
  design gate.
- Do not add code, migrations, seed data, CSV fixtures, PDFs, source exports,
  generated artifacts, or acceptance fixtures in this PR.
- Do not use model knowledge for any medication fact. Future rows must be tied
  to source review or original VH clinical authoring with recorded provenance.
- Do not commit vendor exports, terminology releases, restricted government
  tables, copied source text, PDFs, or third-party content packages unless the
  owner has explicitly approved that storage model and the source terms permit
  it.

## Survey Grounding

The live roadmap owner override replaced the earlier licensed-vendor direction
with an indigenous, evidence-gated program on 2026-07-07. It says the program
must be built before any production-prescribing activation, and the go-live gate
is an accepted indigenous edition, acceptance battery, named-clinician signoff,
documented coverage, and aushadhi-assisted seeding
(`docs/NEXT_LEVEL_ROADMAP.md:269-278`).

The original KB substrate is migration 277. It created global, non-PHI
reference tables for seven datasets: sources, monographs, interactions, allergy
groups, allergy cross-reactivity, condition cautions, dose ranges, and IV
compatibility (`apps/backend/src/migrations/277_drug_knowledge_base.sql:38-161`).
The starter source is deliberately flagged as starter content and is meant to be
deactivated only after an accepted real KB replaces it
(`apps/backend/src/migrations/277_drug_knowledge_base.sql:28-34`,
`apps/backend/src/migrations/277_drug_knowledge_base.sql:167-170`).

Current main already includes the NL-5 P2 substrate for this program: source
priority, source family, edition status, source-level license status, the
acceptance-snapshot activation guard for `vh_indigenous`, active-source indexes,
and row-level provenance fields on every `drug_kb_*` content table
(`apps/backend/src/migrations/408_drug_kb_priority_provenance.sql:11-14`,
`apps/backend/src/migrations/408_drug_kb_priority_provenance.sql:95-110`,
`apps/backend/src/migrations/408_drug_kb_priority_provenance.sql:126-136`).
Rows also carry source references, license status, review status, reviewer
fields, and approval fields with constraints
(`apps/backend/src/migrations/408_drug_kb_priority_provenance.sql:140-184`).

The runtime engine uses a five-minute KB cache and loads only active source rows
from all seven datasets, ordered by source priority and starter status
(`apps/backend/src/services/clinical/drugKnowledgeBaseService.js:25`,
`apps/backend/src/services/clinical/drugKnowledgeBaseService.js:158-208`).
It deduplicates overlapping active rows by highest source priority
(`apps/backend/src/services/clinical/drugKnowledgeBaseService.js:139-150`) and
reports sources, counts, `starter_only`, source family, edition status, and
license status through `drugKbStatus()`
(`apps/backend/src/services/clinical/drugKnowledgeBaseService.js:305-323`).

Prescription safety remains the mandatory floor around the KB. The utility runs
deterministic checks for allergy, duplicate active prescriptions,
composition-backed allergy/duplicate screens, pediatric dose sanity, medication
safety, pregnancy/lactation-adjacent rules, renal rules, and stewardship prompts
before check 8 invokes the KB
(`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:775-930`,
`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:1135-1244`,
`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:1249-1324`).
KB evaluation failure currently records a warning after deterministic checks
rather than disabling those floor checks
(`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:1326-1335`), while
outer safety-check failures still return a blocker
(`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:1345-1351`).

The neutral importer now accepts row provenance and review metadata, source
priority, source family, edition status, source-level license status, metadata,
and inactive candidate imports
(`apps/backend/scripts/drug-kb-import.mjs:25-30`,
`apps/backend/scripts/drug-kb-import.mjs:225-252`,
`apps/backend/scripts/drug-kb-import.mjs:270-318`,
`apps/backend/scripts/drug-kb-import.mjs:342-361`). It still imports the seven
CSV datasets and reports parsed/upserted row counts
(`apps/backend/scripts/drug-kb-import.mjs:11-22`,
`apps/backend/scripts/drug-kb-import.mjs:388-393`).

The drug-KB runbook already defines immutable indigenous edition keys,
required row provenance, lint, inactive candidate import, acceptance snapshot
recording, activation, starter deactivation evidence, and edition diffing
(`apps/backend/docs/RUNBOOKS/drug-kb-import.md:7-25`,
`apps/backend/docs/RUNBOOKS/drug-kb-import.md:30-67`,
`apps/backend/docs/RUNBOOKS/drug-kb-import.md:77-111`). The acceptance battery
records a JSON snapshot into `drug_kb_sources.metadata.acceptance_snapshot` and
fails non-passing scenarios (`apps/backend/scripts/drug-kb-acceptance.mjs:150-212`).
The lint script rejects non-releasable license statuses, missing indigenous row
source references, non-approved indigenous review status, and non-immutable
`vh_indigenous_*` source keys (`apps/backend/scripts/drug-kb-lint.mjs:122-171`).
The edition diff compares persisted editions across the seven datasets without
claiming clinical correctness (`apps/backend/scripts/drug-kb-edition-diff.mjs:4-55`,
`apps/backend/scripts/drug-kb-edition-diff.mjs:164-178`).

The aushadhi composition spine is present as a composition and matching layer,
not as a clinical safety authority. Migration 350 defines global composition
rows, pharmacy catalog composition fields, and a tenant-scoped curation queue
(`apps/backend/src/migrations/350_drug_compositions.sql:1-48`). The importer
loads aushadhi artifacts into the composition layer, exact-matches tenant
catalog brands, and reports matched, ambiguous, and unmatched counts
(`apps/backend/scripts/import-drug-reference.mjs:1-7`,
`apps/backend/scripts/import-drug-reference.mjs:100-170`). The per-tenant
composition flag is fail-closed and stores an acceptance snapshot at enablement
(`apps/backend/src/migrations/351_composition_search_settings.sql:1-13`,
`apps/backend/src/services/pharmacy/compositionFeatureService.js:20-59`,
`apps/backend/src/services/pharmacy/compositionFeatureService.js:79-108`).

The terminology spine already includes ATC as the pharmacy/medication axis, but
release files stay operator-supplied. The terminology service is imported
rather than hand-seeded (`apps/backend/src/migrations/275_terminology_service.sql:15-21`,
`apps/backend/src/migrations/275_terminology_service.sql:119-141`). The
terminology runbook says SNOMED CT, LOINC, ICD-11, ICD-10, and ATC downloads
must not be committed to git and that ATC is obtained under WHOCC terms
(`apps/backend/docs/RUNBOOKS/terminology-releases.md:11-14`,
`apps/backend/docs/RUNBOOKS/terminology-releases.md:27-39`).

The content-studio program is the governance precedent. It uses immutable
approved versions, review events, rollback, and per-tenant enablement
(`docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:503-518`).
Its role pattern requires author and approver separation, a pharmacy review for
medication-containing sets, and rejected self-approval
(`docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:547-554`,
`docs/superpowers/build-prompts/nl5-p3-content-studio.md:15-24`). Clinical AI
knowledge curation provides the parallel that imported rows land pending, dark
to retrieval, with curation/audit provenance before approval
(`docs/CLINICAL_AI_KNOWLEDGE_CURATION.md:43-76`).

## Source Licensing Survey

This survey is a design input and not legal advice. Every future source needs a
repository-recorded license decision before any row derived from it is authored,
imported, reviewed, or released.

| Source family | Intended role | Licensing finding | Program rule |
| --- | --- | --- | --- |
| VH hospital formulary, pharmacy catalog, and prescribing volume | Coverage priority, first formulary scope, local alias coverage, and pilot metrics | Hospital-owned operational data, subject to internal privacy, tenancy, and governance controls | Use for prioritization and local mapping only. Do not convert prescribing history into clinical drug facts. Store only non-PHI aggregate coverage metrics in release metadata. |
| PMBI / Jan Aushadhi product list | Brand-to-composition seeding, generic-composition matching, and coverage gap analysis | PMBI exposes product-list pages, but its copyright page requires permission before reproduction and source acknowledgement; its disclaimer tells users to verify and obtain professional advice before acting. | Treat as `permission_required` unless VH has written permission or an accepted operator-supplied artifact. Use for composition and alias coverage only, not clinical safety authority. |
| Government Open Data License India datasets | Possible public metadata and public health reference lists | OGDL grants broad use, adaptation, publication, and derivatives with attribution for shareable non-sensitive public-funded data, but excludes personal, non-shareable, sensitive, unauthorized, symbol, and other protected data. | Use only when the exact dataset explicitly carries compatible OGDL terms. Record attribution, dataset URL, version/date, and exclusions in provenance. |
| CDSCO public pages, notices, schedules, and alerts | Regulatory citations and alerts for reviewer-authored rows | CDSCO copyright policy requires permission for partial or full reproduction and source acknowledgement when referenced. | Use as `reference_only` unless permission is recorded. Do not copy tables or notice text into the KB. Reviewers may author original row text that cites the notice. |
| Indian Pharmacopoeia Commission / National Formulary of India | Indian authoritative reference for clinical reviewer judgment | IPC presents NFI as an authoritative prescribing/dispensing/administering guide and the current edition as NFI 2021; IPC pages retain copyright. | Use as `reference_only` unless IPC permission is recorded. Do not import, scrape, or reproduce NFI tables or language. |
| WHO ATC/DDD / WHOCC | ATC classification validation and terminology alignment | WHOCC allows referencing, but bars commercial copying/distribution and changing/manipulating the material. The repo runbook already keeps ATC releases operator-supplied. | Follow the terminology runbook. Do not commit WHOCC release files. Store ATC identifiers only through accepted operator-supplied terminology imports. |
| State formularies, standard treatment guidelines, hospital protocols, labels, and open-access literature | Evidence references for original clinical authoring | Terms vary by document and publisher; public availability is not redistribution permission. | Every document gets a license decision. Use restricted sources as citations for original VH-authored recommendations only; do not copy restricted text. |
| Original VH clinical authoring | Primary path for indigenous safety rows where source material is not redistributable | VH owns original text created by appointed authors and reviewers, subject to internal governance and audit controls. | Can be stored in repo only if the owner chooses reviewable in-repo storage and every row is original VH text with provenance, source references, and approvals. |

Required source/license statuses remain aligned with migration 408 and lint:

- `hospital_owned`
- `government_open_data_attribution`
- `permission_recorded`
- `permission_required`
- `operator_supplied_terms`
- `reference_only`
- `prohibited`

The default is `permission_required` whenever terms are unclear.

## Dataset Sourcing Strategy

Every dataset uses the same rule: rows are either original VH clinical authoring
backed by reviewed evidence, or source-derived content whose license decision
permits the exact use. No row may be filled from model memory, unlabeled source
text, or assumed clinical common knowledge.

| Dataset | Existing seam | Primary sources and authorship | Licensing rule | Required row provenance |
| --- | --- | --- | --- | --- |
| `monographs` | Source-scoped drug identity, display/classification, ATC code, aliases, and properties | Start from the pilot formulary, pharmacy catalog, aushadhi composition matches, and operator-supplied ATC terminology. Pharmacy authors approve canonical keys, aliases, and classification choices. | Hospital alias mapping can be `hospital_owned`. PMBI is `permission_required` unless cleared. ATC remains `operator_supplied_terms`. | Formulary source, composition source, ATC release/import source, mapping rationale, license status, author, reviewers, and edition. |
| `interactions` | Ordered pair, severity, mechanism/effect/management/evidence, source priority dedupe | Original clinical-pharmacology authoring from reviewed references, prioritized by pilot formulary exposure and owner-selected high-risk families. | No vendor KB copying, no NFI/CDSCO/publisher text copying, and no restricted table transformation without permission. | Evidence references, content basis, severity rationale, original-text flag, author, clinical reviewer, pharmacy reviewer, and approval. |
| `allergy-groups` | Group/member rows with source-scoped dedupe | Pharmacy-authored grouping model mapped to pilot formulary items and composition aliases. | Source documents can support review only unless their terms permit extraction. | Group rationale, formulary coverage, source refs, license decision, author, reviewer, and effective edition. |
| `cross-reactivity` | Group-to-group risk and note rows | Clinical pharmacology and pharmacy-authored risk statements from reviewed references. | No copied source language. Restricted references may support original authoring only. | Evidence references, evidence grade, original rationale, author, reviewer, and approval metadata. |
| `condition-cautions` | Drug key plus `icd10_prefix`, condition label, risk, and note | Use the terminology spine for ICD validation and author caution rows from approved clinical references, regulatory alerts, and hospital protocols. | ICD/terminology releases stay operator-supplied. Recommendations must be original or explicitly permitted. | ICD source, condition-mapping rationale, evidence refs, source license status, reviewers, and edition. |
| `dose-ranges` | Population, route/frequency, max values, weight basis, renal thresholds, and notes | Author only after the pilot formulary scope and reviewer appointments are fixed. Prioritize pediatric, renal, and safety-critical coverage by local use and committee direction. | Numeric dose content is clinical content. It must never come from model knowledge; source terms must permit extraction or support original authored recommendations. | Source refs, calculation basis, population/renal basis, independent checker, author, pharmacy reviewer, clinical reviewer, and approval. |
| `iv-compatibility` | Pairwise compatibility, diluent, concentration/stability, and recommendation | Defer unless pilot IV scope and authoritative source access are explicitly approved. Use operator-approved references or original hospital protocol authoring. | Treat external compatibility tables as restricted unless license review says otherwise. | Source terms, protocol reference, concentration/diluent basis, authored recommendation, checker, reviewers, and edition. |

## Provenance and Schema Gate

Migration 408 means the essential provenance seam is already present, so the
gate is enforcement, not schema invention. Future content packages must fail
lint, import, review, and activation unless each row has:

- `provenance` JSON with `content_basis`, `license_decision_id`, reviewer
  rationale, edition metadata, and any calculation/mapping basis.
- `source_refs` JSON array naming source registry IDs, source URLs or document
  references, accessed dates, license status, and whether any text was quoted.
- `license_status` that is releasable for the row.
- `review_status='approved'` before an indigenous row is imported as releasable.
- Author, clinical reviewer, pharmacy reviewer, and approval user/timestamps.
- `source_family='vh_indigenous'`, immutable `source_key` such as
  `vh_indigenous_<edition>`, and `metadata.acceptance_snapshot` before
  activation.

Rows with missing source references, blocked license statuses, unapproved review
status, or non-immutable indigenous source keys must remain non-releasable.

## Editorial Workflow

The editorial workflow should reuse the content-studio lifecycle and the
two-person medication-governance pattern:

1. Owner appoints reviewers and release approvers before any row authoring.
2. Release owner creates a source registry entry for every source, with license
   status, allowed use, source owner, artifact hash, access path, and reviewer.
3. Owner freezes the first formulary scope and coverage target.
4. Authors draft rows only from approved sources or original VH authoring.
5. Structural lint runs before review: dataset shape, immutable edition key,
   source refs, provenance, license status, review status, no restricted
   excerpts, no raw source files, and no starter-only activation.
6. Clinical pharmacology review and pharmacy review record independent
   decisions. Self-approval is rejected.
7. Approved rows are packaged as seven CSVs plus manifest. The package lands as
   an inactive `candidate` edition.
8. Reviewers run the edition diff against the current active edition.
9. The acceptance battery records a snapshot on the candidate source.
10. Named clinician signoff and pharmacy release approval are recorded.
11. The accepted edition activates; starter deactivation happens only after the
    owner-approved coverage target and acceptance gate pass.
12. Rollback reactivates the prior accepted edition and retires the current one.

Roles:

- `DRUG_KB_AUTHOR_ROLES`: appointed pharmacy staff, clinical pharmacology
  authors, or clinician authors for a release wave.
- `PHARMACOLOGY_REVIEWER`: recommended new role if the existing role registry
  cannot express senior clinical pharmacist or clinical pharmacologist review
  cleanly.
- `PHARMACY_REVIEWER_ROLES`: at minimum `PHARMACY_INCHARGE` or owner-appointed
  pharmacy reviewer.
- `DRUG_KB_RELEASE_APPROVER_ROLES`: two-person release approval, reusing the
  order-set pattern where feasible.

Medication safety content always requires pharmacy review, even when authored by
a physician.

## Edition and Release Model

The source family is `vh_indigenous`. Each edition is immutable:

- Use a concrete `source_key`, for example `vh_indigenous_2026q3`, rather than
  overwriting a singleton source row.
- Store the human label in `version`.
- Keep `source_family='vh_indigenous'`.
- Import candidate editions inactive with `edition_status='candidate'`.
- Store source hashes, acceptance snapshot, coverage metrics, reviewer
  approvals, source permission decisions, and release notes in
  `drug_kb_sources.metadata`.
- Activate only an accepted edition with an acceptance snapshot and releasable
  license state.
- Keep at most one active indigenous edition, using the migration 408 active
  family index and source-priority dedupe.

Activation gate:

- Lint passes for every dataset in the edition package.
- Candidate source imports cleanly for every dataset in scope.
- Edition diff reviewed and signed.
- Acceptance battery status is `passed`.
- `drugKbStatus()` reports active indigenous counts and not merely starter-only
  coverage for the pilot scope.
- Coverage metrics meet the owner-approved pilot target.
- Named clinician signoff plus pharmacy reviewer signoff are recorded.
- Starter deactivation snapshot is stored if starter rows are deactivated.

Rollback:

- Reactivate the previous accepted `vh_indigenous_*` edition.
- Mark the failing edition `rolled_back` or `retired`; do not delete rows.
- If no indigenous edition is accepted and the owner allows emergency fallback,
  reactivate `vh_starter_set` with clear `starter_only` status and a visible
  risk note.

## Coverage Roadmap

The first release should follow real VH use rather than generic list size.

Wave 0: program setup

- Appoint pharmacology, pharmacy, clinician signoff, and release operators.
- Freeze the pilot formulary, lookback window, departments, and coverage target.
- Finish source registry and permission records.
- Decide content storage model.
- Run no clinical content rows.

Wave 1: pilot formulary safety floor

- Cover pilot formulary items with the highest local prescribing volume and
  owner-selected high-risk families.
- Use aushadhi composition import and tenant catalog matching to find aliases,
  composition matches, ambiguous matches, and coverage gaps.
- Prioritize coverage across the safety families needed for the pilot:
  monographs, interactions, allergy groups, cross-reactivity, condition
  cautions, dose ranges, and IV compatibility only if IV prescribing is in
  pilot scope.

Wave 2: inpatient and emergency expansion

- Expand coverage across inpatient, emergency, pediatric, renal, obstetric, and
  IV workflows according to owner-approved formulary subsets.
- Add department-level coverage and drift reports.

Wave 3: maintenance cadence

- Move from pilot coverage to complete hospital formulary coverage.
- Run monthly or quarterly editions plus emergency safety patch releases.
- Track coverage drift against formulary churn, aushadhi import changes, and
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

Pilot go-live requires the acceptance battery, named clinician signoff,
pharmacy signoff, and documented coverage at or above the owner-approved target
for the pilot formulary.

## Tooling Gaps and Storage Decision

Already present in current main:

- Row-level provenance columns and license/review status.
- Source-family and immutable-edition metadata.
- Priority dedupe across active sources.
- Inactive candidate import.
- Structural lint.
- Acceptance battery with snapshot recording.
- Edition diff.
- Operator runbook.

Still required before content authoring:

- A first-class source/permission registry for source documents, permission
  emails, license decisions, source hashes, and reviewer notes.
- Role enforcement for `PHARMACOLOGY_REVIEWER` or an explicit mapping to
  existing senior pharmacy/clinical governance roles.
- Coverage metrics tied to the pilot formulary and aushadhi match output.
- CI guard that blocks restricted raw artifacts, copied source extracts, PDFs,
  vendor exports, and non-releasable content packages in repo paths.
- A release checklist that attaches lint output, edition diff, acceptance
  snapshot, coverage report, source registry export, and signoff evidence.
- Later, a content-studio UI for row drafting/review if CSV review becomes too
  slow.

Storage decision:

- Use a hybrid model.
- Reviewable in-repo content is allowed only for original VH-authored rows whose
  source references are citations, whose text is not copied from restricted
  sources, and whose owner-approved storage decision is recorded.
- Operator-supplied or restricted artifacts stay outside git: vendor exports,
  terminology releases, PMBI exports without permission, NFI text, CDSCO
  reproduced material, WHOCC files, publisher tables, PDFs, and source extracts.
- The first content wave should default to an operator-supplied private package
  with a manifest hash in the PR until the owner explicitly approves in-repo
  storage for self-authored rows.

This decision gives reviewers a clean path for self-authored VH content without
accidentally laundering restricted source data into git.

## Owner Decisions

Before the first content or implementation PR, the owner must decide:

1. Reviewer appointments: named pharmacology lead, pharmacy reviewer, backup
   reviewer, senior clinician signoff owner, release operator, and license
   reviewer.
2. Role model: create `PHARMACOLOGY_REVIEWER`, or map the role to existing
   senior pharmacy and clinical governance roles.
3. First formulary scope: pilot tenant or department, prescribing-volume
   lookback window, selected high-risk medication families, and minimum
   coverage target.
4. Content storage: private operator package, reviewable in-repo original VH
   rows, or hybrid. The recommended default for wave 1 is hybrid with private
   package first.
5. Edition cadence: monthly, quarterly, and emergency patch SLA.
6. Source permissions: whether VH will request PMBI permission, IPC/NFI
   permission, CDSCO reproduction permission, and any publisher permissions, or
   treat those sources as reference-only.
7. Starter deactivation threshold: exact coverage target, acceptance snapshot,
   and signoff language required before `vh_starter_set` is deactivated.

## Next Implementation Slice

The next PR should still contain no drug content unless the owner explicitly
changes scope. It should implement the remaining governance substrate:

- Source and permission registry with license decision IDs.
- Role enforcement for pharmacology review.
- Coverage report from pilot formulary plus aushadhi match output.
- CI restricted-artifact guard for content packages and source files.
- Release checklist output bundling lint, diff, acceptance, coverage, source
  registry, and signoff evidence.

Only after those gates are merged should a separate content PR or private
operator package introduce indigenous KB rows.

## External Licensing References

Accessed on 2026-07-08:

- [PMBI product list](https://www.pmbi.co.in/ProductList.aspx)
- [PMBI copyright](https://www.pmbi.co.in/copyright.aspx)
- [PMBI disclaimer](https://www.pmbi.co.in/disclaimer.aspx)
- [CDSCO copyright policy](https://cdsco.gov.in/opencms/opencms//en/Copyright-Policy/)
- [IPC National Formulary of India overview](https://www.ipc.gov.in/mandates/nfi/about-nfi.html)
- [WHO ATC/DDD methodology](https://www.who.int/tools/atc-ddd-toolkit/methodology)
- [WHOCC 2026 ATC/DDD Guidelines PDF](https://atcddd.fhi.no/filearchive/publications/2026_guidelines_for_atc_classification_and_ddd_assignment.pdf)
- [WHOCC copyright and disclaimer](https://atcddd.fhi.no/copyright_disclaimer/)
- [Government Open Data License India Gazette](https://data.gov.in/sites/default/files/Gazette_Notification_OGDL.pdf)
