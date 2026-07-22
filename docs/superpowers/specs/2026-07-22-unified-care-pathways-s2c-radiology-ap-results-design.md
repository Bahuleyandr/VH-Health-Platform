# Unified Care Pathways S2c — Radiology and Anatomic Pathology Result Loop Design

**Status:** implementation design; Diagnostics remains activation-gated

**Grounding revision:** `28791c4019600f24caa689623c66ce4d60dd1985`
(`2026-07-22T14:42:33+05:30`)

**Intended branch:** `feat/care-pathways-s2c-radiology-ap-results`

**Migration:** `591_radiology_ap_diagnostic_generations.sql`

**Program authority:** `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md`

**Dependencies:** S2a result-release/sign-off safety; S2b immutable diagnostic generations/actions;
S1b owner routing, pathway execution, reconciliation, projector inbox and outbox recovery.

## 1. Outcome and boundary

S2c connects the existing Radiology and Anatomic Pathology (AP) report/sign-off/addendum workflows to
the shared `diagnostics_order_to_action` pathway. It adds explicit clinician-signed structured
classification to each final report and addendum, creates one immutable diagnostic generation per
signed version, and routes every current generation using the existing pathway/task/SLA/action rails.

The clinical classification is supplied and signed by the radiologist or pathologist as exactly one of
`critical|abnormal|normal|indeterminate`. The service never derives clinical significance from report
text, order priority, diagnosis codes, malignancy text, TAT severity or AI output. A bounded structured
basis is retained as evidence of the clinician declaration.

This slice does not choose clinical thresholds, SLA targets, escalation recipients, patient/guardian
visibility, notification wording, external-provider communication, break-glass authority, historical
backfill or retention. It never flips a tenant to `active`, migrates a live database, deploys or sends an
external notification.

## 2. Verified baseline

- Radiology stores the signed base report on `radiology_orders`. Its addendum endpoint concatenates text
  back into that base blob while recording audit/canonical evidence; no typed version or
  re-acknowledgement exists.
- AP stores one signed `ap_reports` row and append-only-in-practice `ap_report_addenda` rows, but neither
  source has signed result classification or a diagnostic-generation link.
- Both sign-off paths already write canonical timeline/audit evidence in their source transaction.
- S2b accepts only `lab_panel|shared_investigation` generations and deliberately rejects
  Radiology/AP generic investigation types.
- The S2b projector, doctor-action command, staff clinical inbox and reconciliation rails are generic by
  diagnostic generation. S2c must register source adapters, not create another workflow engine.

## 3. Source evidence model

### 3.1 Initial reports

New Radiology/AP sign-offs require:

- an explicit structured classification;
- a non-empty JSON-object classification basis;
- the authenticated radiologist/pathologist as signer; and
- the source report content and complete structured-report/synoptic state under the source row lock.

The source row retains the declaration, signer and generation version `1`. Legacy signed rows remain
nullable and are reported as reconciliation/backfill blockers; migration 591 invents no classification.
Once signed, report content, structured classification and sign-off evidence cannot be changed in place.

### 3.2 Addenda

Radiology addenda move to a dedicated append-only `radiology_report_addenda` ledger. AP keeps its
existing addendum ledger and gains the same structured fields. Every new addendum records:

- a per-report monotonic generation version;
- previous and current signed classification;
- structured classification basis;
- an explicit clinical-significance code
  `unchanged|new_finding|worsened|improved|corrected`;
- signer and signing time; and
- the addendum text in the source ledger only.

The significance code is clinician testimony, not an inferred rank comparison. The diagnostic event,
task metadata and notification layers never carry report or addendum text.

## 4. Immutable diagnostic generation adapters

Migration 591 extends `diagnostic_result_generations` with typed Radiology/AP source foreign keys and
extends item source constraints for their source ledgers. Source kinds are:

- `radiology_report`, episode key `radiology_order:<id>`; and
- `anatomical_pathology_report`, episode key `ap_report:<id>`.

Version `1` points at the signed base report. Later versions point at one exact addendum and link the
immediately preceding diagnostic generation. The single generation item stores only bounded structured
provenance and hashes of the complete current source episode; raw report/addendum text remains in the
immutable source ledger. The generation snapshot therefore attests the complete report state without
copying PHI into tasks or events.

The recorded orderer is the named accountable owner. AP resolves it through the linked source
investigation. In `off|shadow`, a missing/unavailable owner may be retained only as an explicit
reconciliation blocker so the clinical report can still be signed. In `active`, source work cannot
materialize unless the named owner is a current same-tenant route-capable clinician. No role fallback
masks an unavailable named owner.

## 5. Critical acknowledgement and doctor action

In `off|shadow`, generation/outbox/reconciliation evidence is written but no staff task is created.

In `active`, each critical Radiology/AP generation atomically creates one
`critical_result_ack` SLA and one acknowledgement-semantics task related to that immutable generation.
The task is exclusively assigned to the named orderer. A later addendum always has a different
generation identity, task and SLA, so a completed clock is never reset or reused.

The existing pathway projector creates the separate domain-evidence doctor-action task for critical,
abnormal and indeterminate generations. Critical doctor disposition cannot close the pathway until its
generation-specific acknowledgement task has an authorization receipt and its SLA has stopped. Generic
task acknowledgement never substitutes for the signed doctor disposition.

When an addendum supersedes a generation, projector supersession closes any still-open predecessor
acknowledgement obligation with typed supersession evidence before routing the successor. Prior
acknowledgement, escalation, action and signature evidence stays queryable.

## 6. Normal, abnormal and amendment routing

- `critical`: generation-specific acknowledgement plus signed doctor disposition.
- `abnormal`: named-doctor countersignature and structured disposition.
- `normal`: no staff task by default; automatic closure remains release-policy gated. Radiology/AP
  release adapters are not invented here, so normal generations remain safely open/unsupported until
  their patient visibility policy is implemented.
- `indeterminate`: fail-safe named-doctor review/action.
- any addendum/correction: supersede prior open obligations and route only from the new signed
  classification. A critical-to-normal correction follows the normal release/closure policy, not a
  critical SLA; the named doctor retains the existing discretionary re-review path after normal closure.

## 7. Product and API contract

Radiology and AP sign-off/addendum endpoints accept the structured declaration and return the resulting
diagnostic generation receipt. Radiology staff UI adds explicit classification at sign-off, a structured
addendum form, current classification/version display and no automatic clinical interpretation.

The clinical inbox enriches both pathway action tasks and direct critical-acknowledgement tasks from the
linked diagnostic generation. It continues to show **Acknowledge critical result** only for
acknowledgement semantics and **Review and record action** only for domain evidence.

## 8. Reconciliation and activation

Versioned checks cover:

- signed structured source rows/addenda versus exact generation/source/version/classification;
- complete episode-content and item hash evidence;
- monotonic predecessor continuity;
- no missing or invalid named owner in active mode;
- one critical acknowledgement task/SLA per current active critical Radiology/AP generation;
- acknowledged critical evidence before terminal doctor action; and
- superseded predecessor acknowledgement/task/SLA closure.

Repairs never infer classification, addenda significance, ownership or doctor action. A repaired run is
non-clean and must be followed by a clean observation. Production activation remains outside S2c.

## 9. Required evidence

1. migration 591 fresh-build, RLS, append-only, composite-FK and source-shape conformance;
2. atomic Radiology and AP sign-off/addendum plus canonical generation/outbox evidence;
3. free-text/priority/AI-independent classification tests;
4. active critical generation creates one exact-owner acknowledgement task/SLA; shadow creates none;
5. addenda create monotonic successor generations and never mutate the base signed report;
6. critical-to-critical, critical-to-normal, normal-to-critical and abnormal/indeterminate routing;
7. critical doctor action rejected before acknowledgement and allowed after the authorized receipt;
8. duplicate/concurrent sign-off/addendum replays produce one version and one generation; and
9. staff API/model/widget coverage for structured sign-off, correction display and action semantics.
