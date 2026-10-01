# D8 maternity capture: field-level human review worksheet

**UNSIGNED — no form, clinical protocol, performer policy, prescription, vaccine policy, patient release or deployment is authorized by this worksheet.**

Updated 2026-09-30 against verified GitHub main
`a38055b8d2f3e2215ccc17338f6e199d0a063685`. The original September 16 source was
the frozen backend candidate `c605c9f0a4f80f2e4e927a51a503e4af142480a4`.
This is an existing-code inventory, not evidence that every accepted field is safe,
clinically appropriate, approved, or connected to a client form. That local head
contained the narrow ANC audit/APGAR/birth-order repairs. Those repairs are now
on main through #1089 (`09cca3d4f`); no tests or deployed state were revalidated
for this update. Existing row IDs and unsigned decision cells are preserved.

Unsigned repository snapshot prepared 2026-10-01 from the reviewed worksheet,
SHA-256 `343C3E366154035772F6FFCAAE89498618ACDD8C22CD4FD27DEF23B1C7905FAD`.
References to current source or main describe the September 30 evidence baseline
above. Inclusion in a draft checkpoint does not approve D2/D8, implementation or
release. The coordinator retains ownership of the canonical plan and audit status.

Companion: [maternity workflow review package](maternity-workflow-closure-review-package.md).
The original worksheet records the owner's confirmation that D2 and D8 are
undecided; current reviewed audit sources retain those stops. All owner entries
remain blank.
September 30 confirmation permitted editing only this worksheet and its companion
package. It grants no form or policy approval. The canonical July 13 plan,
audit/ROADMAP, migration 803 and other repair lanes remain outside this ownership.

## How to complete the worksheet

For **every row**, fill the owner-decision cell in this order:

- **V**: visible or hidden; where and to whom; any conditional display.
- **R**: required, optional or conditional; exact condition; representation of unknown/not assessed/not applicable.
- **U**: approved label, unit, precision, date/time zone and permissible representation. A unit suggested by a code identifier is not approval.
- **Role**: permitted clinical recorder, responsible performer, signer and credential/delegation reference. D2 must be resolved separately.
- **A**: correction/addendum/retraction process, reason, signatures, permitted timing and evidence retention. Never authorize destructive history replacement by a blank entry.

Split a grouped row into one signed row per field if its decisions differ. An
empty decision, a code default, a passing test or an existing endpoint is **not**
an affirmative selection. Requiredness below means an observed backend check,
not an approved clinical requirement. Numeric ranges are quoted existing input
contracts, not diagnostic thresholds or recommendations. No new range is proposed.

The shorthand **T-null** means the inspected writer uses a truthiness conversion
such as `value ? Number(value) : null`; explicit numeric zero can therefore become
NULL. **Text-null** means `value || null`. **Bool-false** means `!!value`; omitted
values become false, and this is not an approved way to record “not assessed.”
These are review facts, not endorsements or fixes authorized by this worksheet.

## Signed boundaries that this review must preserve

- **D2 remains unset.** Decide self-entry versus explicitly audited delegated
  documentation. Existing authenticated actor attribution and default-off
  obstetrician credential gates do not decide who may record for another person.
- **D7 is signed:** automatic infant identity for live birth and early neonatal
  death; no patient identity for stillbirth; initial guardian is the mother;
  independent infant subjects; a `both` postnatal visit has one detail row and
  two subject-separated canonical event/audit pairs; one visit per infant for
  multiples. No mother-subject fallback for an invalid infant link. A minted
  identity is not retro-deleted on outcome correction. Canonical maternity
  events stay staff-only unless separately authorized under D3.
- **D6 remains unsigned.** Existing birth-dose booleans and signed review notes
  retain their existing D7 semantics. They do not authorize adopting a vaccine
  schedule, equivalence map, catch-up rule or schedule importer. No prescription
  or vaccine content is selected in this worksheet.
- D4 reminder/recipient governance and D5 visit schedules are separate decisions.
  Existing generated dates/times must not become newly approved defaults by being
  copied into a form. Red-flag recording is not a closed escalation workflow.

The operative D7 record distinguishes signed selections from engineering defaults
flagged for countersign, including correction and consent details. Preserve its
open flags; the summary above neither supplies those countersignatures nor
approves a new consent form or delegated-authority policy.

## Source key and inspection boundary

Service and route anchors below refer to the verified September 30 main; the
earlier field inventory is retained with explicit current-source qualifications:

Git blob equality was checked for M, R, I and N between the original candidate
and current main. Their bytes are unchanged, so the retained field anchors and
observed defaults still apply; their presence on main is now recorded accurately.

- **M**: [apps/backend/src/services/maternity/maternityService.js](https://github.com/Bahuleyandr/VH-Health-Platform/blob/a38055b8d2f3e2215ccc17338f6e199d0a063685/apps/backend/src/services/maternity/maternityService.js).
- **R**: [apps/backend/src/routes/maternity/maternityRoutes.js](https://github.com/Bahuleyandr/VH-Health-Platform/blob/a38055b8d2f3e2215ccc17338f6e199d0a063685/apps/backend/src/routes/maternity/maternityRoutes.js).
- **I**: [apps/backend/src/services/maternity/immunisationService.js](https://github.com/Bahuleyandr/VH-Health-Platform/blob/a38055b8d2f3e2215ccc17338f6e199d0a063685/apps/backend/src/services/maternity/immunisationService.js).
- **N**: [apps/backend/src/services/maternity/newbornIdentity.js](https://github.com/Bahuleyandr/VH-Health-Platform/blob/a38055b8d2f3e2215ccc17338f6e199d0a063685/apps/backend/src/services/maternity/newbornIdentity.js).
- **SQL800**: [apps/backend/src/migrations/800_restore_maternity_pregnancy_checks.sql](https://github.com/Bahuleyandr/VH-Health-Platform/blob/a38055b8d2f3e2215ccc17338f6e199d0a063685/apps/backend/src/migrations/800_restore_maternity_pregnancy_checks.sql).
- **SQL801**: [apps/backend/src/migrations/801_restore_maternity_labor_delivery_checks.sql](https://github.com/Bahuleyandr/VH-Health-Platform/blob/a38055b8d2f3e2215ccc17338f6e199d0a063685/apps/backend/src/migrations/801_restore_maternity_labor_delivery_checks.sql).

Observed service checks/casts/defaults are distinguished from database-domain
declarations. This pass does not query a database, measure deployed enforcement,
revalidate all schema/FK constraints, or re-audit every route/client. “No service
enum observed” does not mean every database value is accepted.

## 1. Context, actor and audit fields shared by forms

Source: R:271–427 and the individual service signatures below.

| ID | Exact fields / source | Implemented behavior, not approval | Owner V / R / U / Role / A |
| --- | --- | --- | --- |
| C01 | `tenantId` | Route derives tenant context; not a free-text clinical form field. Every clinical link remains subject to tenant/patient authority. | _____ / _____ / _____ / _____ / _____ |
| C02 | `actor_uid`, `actor_role` | Relevant routes override body values with authenticated user context after spreading the body. Not a selectable performer field. | _____ / _____ / _____ / _____ / _____ |
| C03 | `created_by`, `recorded_by` | Pregnancy creation and ANC/partograph/newborn/Apgar/postnatal routes pin the applicable field to authenticated UID. Different from the separately named responsible performer. | _____ / _____ / _____ / _____ / _____ |
| C04 | `patient_uid`, `pregnancy_id`, `labor_admission_id`, `delivery_id`, `newborn_id`, `admission_id` | Context links use distinct UUID/integer domains. Forms need authorized context selection and explicit mother/infant/episode readback; a manually entered numeric ID is not a complete approved journey. | _____ / _____ / _____ / _____ / _____ |
| C05 | server-generated IDs, timestamps, `visit_number`, canonical evidence | Not interchangeable with an observation's occurrence time. Existing insert-once/amendable semantics below differ; a global “edit everything” form is not justified. | _____ / _____ / _____ / _____ / _____ |

## 2. Pregnancy creation and amendment

Source: M:359–451 (`createPregnancy`), M:477–520 (`updatePregnancy` allowlist),
SQL800:1–59 (existing domain declarations).

| ID | Exact fields | Implemented behavior / observed units | Owner V / R / U / Role / A |
| --- | --- | --- | --- |
| P01 | `patient_uid` | Explicitly required; patient existence/tenant checks. UUID context, not a clinical measurement. | _____ / _____ / _____ / _____ / _____ |
| P02 | `pregnancy_number` | Creation default 1; numeric conversion and integer SQL cast. Not in ordinary amendment allowlist. | _____ / _____ / _____ / _____ / _____ |
| P03 | `lmp_date` | Optional date; can drive computed EDD when `edd_date` is absent. Allowed ordinary amendment. No owner-approved dating protocol is supplied here. | _____ / _____ / _____ / _____ / _____ |
| P04 | `edd_date` | Supplied date takes precedence over computed EDD on creation; optional if unavailable. Allowed ordinary amendment. | _____ / _____ / _____ / _____ / _____ |
| P05 | `edd_method` | Text-null; SQL800 domain `lmp`, `usg`, `mixed`, or NULL. Not in ordinary amendment allowlist. | _____ / _____ / _____ / _____ / _____ |
| P06 | `gravida` | Creation default 1; numeric conversion/integer cast; allowed amendment. No new minimum or clinical interpretation chosen. | _____ / _____ / _____ / _____ / _____ |
| P07 | `parity`, `living_children`, `abortions` | Each defaults 0 on creation, integer cast, and is amendable. Decide separately whether unknown may ever be represented as zero. | _____ / _____ / _____ / _____ / _____ |
| P08 | `blood_group`, `rh_factor` | Text-null; both amendable. No service enum observed in this bounded writer inspection. | _____ / _____ / _____ / _____ / _____ |
| P09 | `booking_status` | Creation default `booked`; SQL800 domain `booked`, `unbooked`, `transferred_in`, `transferred_out`. Not in ordinary amendment allowlist. | _____ / _____ / _____ / _____ / _____ |
| P10 | `booking_visit_date` | Optional date; not in ordinary amendment allowlist. | _____ / _____ / _____ / _____ / _____ |
| P11 | `high_risk`, `high_risk_reasons` | Default false/coerced boolean and optional text array; both amendable. Existing storage does not decide diagnostic criteria or who may make this determination. | _____ / _____ / _____ / _____ / _____ |
| P12 | `notes` | Text-null on creation; amendable text field. Not an approved patient-visible narrative. | _____ / _____ / _____ / _____ / _____ |
| P13 | `status` (derived, not a generic edit field) | Creation explicitly writes `ongoing`; PATCH rejects any supplied `status`. SQL800 vocabulary includes `ongoing`, `delivered`, `aborted`, `still_birth`, `transferred`; membership does not authorize a transition. | _____ / _____ / _____ / _____ / _____ |

Amendment review: the actual allowlist is `lmp_date`, `edd_date`, `gravida`,
`parity`, `living_children`, `abortions`, `blood_group`, `rh_factor`, `high_risk`,
`high_risk_reasons`, `notes`. Decide retrospective entry, effective date and
clinical sign-off without silently extending this allowlist.

## 3. ANC visit and same-day amendments

Source: M:668–803 and its subsequent UPSERT. The record is keyed by pregnancy
and visit date. Non-null values generally replace existing values; IFA/calcium
flags merge by OR. Exact effective-state repeats are no-ops. These facts are not
approval for one-visit-per-day clinical policy or for erasing observations.

| ID | Exact fields | Implemented behavior / observed units | Owner V / R / U / Role / A |
| --- | --- | --- | --- |
| A01 | `pregnancy_id`, `visit_date` | Both explicitly required; visit date cast to date. Same-date UPSERT can amend an existing row. | _____ / _____ / _____ / _____ / _____ |
| A02 | `gestational_age_weeks` | Existing service range 4–45; numeric value, stored at one decimal in compared effective state. Unit indicated by name: weeks. | _____ / _____ / _____ / _____ / _____ |
| A03 | `weight_kg` | T-null; numeric(5,2) comparison. Unit indicated by name: kg. No additional service range asserted here. | _____ / _____ / _____ / _____ / _____ |
| A04 | `bp_systolic`, `bp_diastolic` | Existing integer ranges 40–300 and 20–200 respectively. Unit is not encoded in these identifiers; clinical owner must confirm display/recording unit. | _____ / _____ / _____ / _____ / _____ |
| A05 | `pulse_bpm` | Existing integer range 20–300; unit indicated by name: bpm. | _____ / _____ / _____ / _____ / _____ |
| A06 | `fundal_height_cm` | Existing integer range 5–60; unit indicated by name: cm. | _____ / _____ / _____ / _____ / _____ |
| A07 | `fetal_heart_rate_bpm` | Existing integer range 30–250; unit indicated by name: bpm. Input bound, not a clinical alert threshold. | _____ / _____ / _____ / _____ / _____ |
| A08 | `fetal_movements_felt` | Nullish-coalescing input preserves false; unspecified becomes NULL. Same-day amendment preserves existing value when incoming NULL. | _____ / _____ / _____ / _____ / _____ |
| A09 | `presentation`, `edema`, `pallor` | Text-null, no service enum observed here. Approved choices and unknown representation are undecided. | _____ / _____ / _____ / _____ / _____ |
| A10 | `hb_gm_dl` | T-null; numeric(4,1) comparison. Unit label is the literal code name `gm_dl`; approve clinical display explicitly. No Patient Hb projection is authorized. | _____ / _____ / _____ / _____ / _____ |
| A11 | `urine_albumin`, `urine_sugar` | Text-null; units/qualitative vocabulary not selected here. | _____ / _____ / _____ / _____ / _____ |
| A12 | `iron_folic_acid_given`, `calcium_given` | Bool-false on incoming values; existing row merges by OR. False does not revoke a previously recorded true. These are facts, not an order or prescription. | _____ / _____ / _____ / _____ / _____ |
| A13 | `tt_dose` | Text-null. No dose vocabulary, schedule or vaccine equivalence approved by this inventory. | _____ / _____ / _____ / _____ / _____ |
| A14 | `next_visit_date` | Optional supplied date, same-day COALESCE preservation; no new visit schedule selected. | _____ / _____ / _____ / _____ / _____ |
| A15 | `notes`, `recorded_by` | Notes text-null/COALESCE; route pins recorder. Decide note/signature/correction workflow without changing canonical subject privacy. | _____ / _____ / _____ / _____ / _____ |

## 4. Labour admission

Source: M:2280–2373; domain constants M:51–58. Existing credential check targets
`attending_obstetrician` when its operator-controlled gate is enabled; this does
not settle D2 or grant activation authority. Admission is insert-once here.

| ID | Exact fields | Implemented behavior / observed units | Owner V / R / U / Role / A |
| --- | --- | --- | --- |
| L01 | `pregnancy_id`, `admission_id` | Pregnancy explicitly required. Optional hospital admission must belong to the same patient and tenant. | _____ / _____ / _____ / _____ / _____ |
| L02 | `admission_reason` | Optional; exact service set `spontaneous_labour`, `induction`, `elective_lscs`, `pprom`, `reduced_fm`, `postdated`, `other`. These codes are not indications or recommendations. | _____ / _____ / _____ / _____ / _____ |
| L03 | `gestational_age_weeks` | Optional numeric, existing range 4–45, absent/empty stored NULL. Weeks indicated by name. | _____ / _____ / _____ / _____ / _____ |
| L04 | `membrane_status`, `membranes_ruptured_at` | Text-null and optional timestamp with time zone. No service status enum or approved time-entry policy supplied here. | _____ / _____ / _____ / _____ / _____ |
| L05 | `cervix_dilation_cm`, `cervix_effacement_pct` | Existing numeric 0–10 cm and integer 0–100 percent input ranges; explicit zero preserved. | _____ / _____ / _____ / _____ / _____ |
| L06 | `station`, `presentation` | Text-null; no service enum observed. Do not infer a coding scale. | _____ / _____ / _____ / _____ / _____ |
| L07 | `fetal_heart_rate_bpm` | Existing integer 30–250; absent/empty becomes NULL. | _____ / _____ / _____ / _____ / _____ |
| L08 | `contractions_per_10min` | Integer cast via T-null. Denominator encoded in name: 10 minutes; no additional range chosen. | _____ / _____ / _____ / _____ / _____ |
| L09 | `labor_started_at` | Optional timestamp with time zone; not automatically the documented active-phase starting time. | _____ / _____ / _____ / _____ / _____ |
| L10 | `attending_obstetrician`, `attending_midwife` | Optional UUIDs in insert; responsible obstetrician is used by the separate credential gate. Performer versus recorder decision remains blank. | _____ / _____ / _____ / _____ / _____ |
| L11 | `notes` | Text-null. No approved correction/transfer/undelivered-discharge command established by this form inventory. | _____ / _____ / _____ / _____ / _____ |

## 5. Partograph observations

Source: M:2461–2608. Existing entries are append-only observations, not generic
in-place edits. Derived alert/action flags and fetal-deceleration handling exist;
this worksheet does not approve or change their thresholds, recipients or timers.

| ID | Exact fields | Implemented behavior / observed units | Owner V / R / U / Role / A |
| --- | --- | --- | --- |
| G01 | `labor_admission_id`, `recorded_at` | Labour link explicitly required; observation time defaults to current application ISO timestamp if absent. Time zone/back-entry policy must be signed. | _____ / _____ / _____ / _____ / _____ |
| G02 | `bp_systolic`, `bp_diastolic`, `pulse_bpm` | Integer casts via T-null in this writer; no ANC range inference. Only pulse name embeds bpm. | _____ / _____ / _____ / _____ / _____ |
| G03 | `temperature_c`, `urine_output_ml` | Numeric / integer via T-null. Names encode Celsius / mL; measurement interval is not defined by the urine field name. | _____ / _____ / _____ / _____ / _____ |
| G04 | `urine_protein`, `urine_acetone` | Text-null; qualitative codes/units undecided. | _____ / _____ / _____ / _____ / _____ |
| G05 | `cervix_dilation_cm` | Existing numeric 0–10; zero preserved. | _____ / _____ / _____ / _____ / _____ |
| G06 | `descent_fifths_above_brim` | Existing exact whole-number representation, range 0–5; zero preserved. Name encodes fifths, not a station scale. | _____ / _____ / _____ / _____ / _____ |
| G07 | `contractions_per_10min`, `contractions_duration_sec` | Integer casts via T-null; names encode per 10 minutes / seconds. | _____ / _____ / _____ / _____ / _____ |
| G08 | `contractions_intensity` | Optional exact set `weak`, `moderate`, `strong`; no new assessment rubric supplied. | _____ / _____ / _____ / _____ / _____ |
| G09 | `fetal_heart_rate_bpm` | Existing integer 30–250; this bound is not an alert threshold. | _____ / _____ / _____ / _____ / _____ |
| G10 | `fetal_decel` | Text-null; existing lowercased nonempty text other than `none`, `no`, `absent`, `nil`, `normal` contributes to escalation. This is implemented behavior requiring clinical vocabulary review, not a proposed normal/abnormal definition. | _____ / _____ / _____ / _____ / _____ |
| G11 | `amniotic_fluid`, `moulding` | Text-null; approved vocabularies/scales absent from this worksheet. | _____ / _____ / _____ / _____ / _____ |
| G12 | `oxytocin_units_l`, `oxytocin_drops_min` | Numeric with zero preserved / integer via T-null; names encode units per litre / drops per minute. Record-only inventory: no infusion order, dosing recommendation or prescription authority. | _____ / _____ / _____ / _____ / _____ |
| G13 | `drugs_given`, `iv_fluids` | Text-null observations; no medication or fluid prescription selected. | _____ / _____ / _____ / _____ / _____ |
| G14 | `notes`, `recorded_by` | Text-null and route-pinned recorder. Amendments must respect append-only observation/canonical evidence semantics. | _____ / _____ / _____ / _____ / _____ |
| G15 | `on_alert_line`, `on_action_line` (derived) | Computed by existing service, not caller-supplied fields. Clinical policy/recovery/notification review remains separate. | _____ / _____ / _____ / _____ / _____ |

## 6. Delivery record

Source: M:2787–2890 and M:57–60. Explicitly requires an ongoing pregnancy; any
linked labour record must be active and belong to that pregnancy. Successful
recording transitions existing lifecycle projections atomically. No in-place
delivery correction endpoint is authorized by this worksheet.

| ID | Exact fields | Implemented behavior / observed units | Owner V / R / U / Role / A |
| --- | --- | --- | --- |
| D01 | `pregnancy_id`, `labor_admission_id` | Pregnancy explicitly required; labour link optional but checked when supplied. | _____ / _____ / _____ / _____ / _____ |
| D02 | `delivery_datetime` | Explicitly required timestamp with time zone; no retrospective-entry policy selected. | _____ / _____ / _____ / _____ / _____ |
| D03 | `delivery_mode` | Required exact code: `nvd`, `lscs_emergency`, `lscs_elective`, `instrumental_forceps`, `instrumental_vacuum`, `breech`, `destructive`, `other`. Existing code membership is not procedural approval or an indication. | _____ / _____ / _____ / _____ / _____ |
| D04 | `stage1_duration_min`, `stage2_duration_min`, `stage3_duration_min` | Integer casts via T-null; minutes named. Definitions of stage timing and unknown values need approval. | _____ / _____ / _____ / _____ / _____ |
| D05 | `episiotomy`, `perineal_repair_done` | Bool-false. Do not equate omission with examined-and-absent without owner decision. | _____ / _____ / _____ / _____ / _____ |
| D06 | `perineal_tear_grade` | Text-null; no service grade enum observed in this signature/write. | _____ / _____ / _____ / _____ / _____ |
| D07 | `blood_loss_ml` | Integer via T-null; mL named. No diagnostic threshold or estimation method selected. | _____ / _____ / _____ / _____ / _____ |
| D08 | `pph_diagnosed`, `pph_treatment` | Bool-false and Text-null. Recording a diagnosis/treatment fact is not engineering authority to diagnose or prescribe. | _____ / _____ / _____ / _____ / _____ |
| D09 | `placenta_delivered_at`, `placenta_method`, `placenta_complete` | Optional timestamp, Text-null, and nullish boolean (false preserved) respectively. | _____ / _____ / _____ / _____ / _____ |
| D10 | `cord_around_neck`, `cord_loops_count` | Bool-false and `Number(value || 0)` integer cast; omitted loop count becomes zero. | _____ / _____ / _____ / _____ / _____ |
| D11 | `anesthesia_type`, `complications` | Text-null; no approved vocabulary or treatment implication selected. | _____ / _____ / _____ / _____ / _____ |
| D12 | `delivered_by`, `delivered_by_name` | Optional UUID/text in insert; UUID is checked by existing default-off performer credential gate. Free text is not verified performer identity. D2 remains unresolved. | _____ / _____ / _____ / _____ / _____ |
| D13 | `pediatrician_present`, `pediatrician_uid` | Bool-false and optional UUID. No inference that presence proves clinical review, signature or credential. | _____ / _____ / _____ / _____ / _____ |
| D14 | `notes` | Text-null; patient release and correction ceremony remain separately governed. | _____ / _____ / _____ / _____ / _____ |

## 7. Newborn record and signed D7 identity

Source: M:3113–3160, M:3277–3316, N:30–39. Identity, guardian and canonical
subject behavior remain governed by signed D7, not by a new selector in this form.

| ID | Exact fields | Implemented behavior / observed units | Owner V / R / U / Role / A |
| --- | --- | --- | --- |
| N01 | `delivery_id`, `birth_datetime` | Both explicitly required; tenant/maternal context resolved from delivery. Timestamp with time zone. | _____ / _____ / _____ / _____ / _____ |
| N02 | `birth_order` | Default 1; exact integer representation, 1–2,147,483,647 existing integer-storage bound; duplicate order for same delivery rejected. This bound is not a plausible clinical maximum. | _____ / _____ / _____ / _____ / _____ |
| N03 | `sex` | Text-null; no service enum observed in this writer. No gender/sex terminology decision invented. | _____ / _____ / _____ / _____ / _____ |
| N04 | `birth_weight_g` | Integer via T-null; grams indicated. | _____ / _____ / _____ / _____ / _____ |
| N05 | `birth_length_cm`, `head_circumference_cm`, `chest_circumference_cm` | Numeric via T-null; cm indicated; measurement technique/precision undecided. | _____ / _____ / _____ / _____ / _____ |
| N06 | `gestational_age_weeks` | Numeric via T-null in newborn writer; no assumption that ANC's range is automatically reused. | _____ / _____ / _____ / _____ / _____ |
| N07 | `outcome` | Defaults/falls back to `live`; service set `live`, `early_neonatal_death`, `fresh_stillbirth`, `macerated_stillbirth`. D7 mints identities only for first two. Migration 155:253 instead spells the stillbirth tokens `fresh_still_birth` and `macerated_still_birth`; the existing September 25 ruling request is unresolved. Review explicit confirmation/unknown handling; no token or outcome choice is made here. | _____ / _____ / _____ / _____ / _____ |
| N08 | `newborn_patient_uid` | Optional existing infant link; strict identity/exclusivity checks. Otherwise D7 mints identity when permitted. Explicit link rejected for stillbirth. Do not offer arbitrary patient selection or mother fallback. | _____ / _____ / _____ / _____ / _____ |
| N09 | `resuscitation_done`, `resuscitation_type` | Bool-false and Text-null; no resuscitation protocol or indication selected. | _____ / _____ / _____ / _____ / _____ |
| N10 | `cord_clamped_at_min`, `breastfeeding_initiated_min` | Numeric / integer via T-null; minutes named, reference origin must be approved. | _____ / _____ / _____ / _____ / _____ |
| N11 | `skin_to_skin_done` | Bool-false; no unknown/not-assessed policy selected. | _____ / _____ / _____ / _____ / _____ |
| N12 | `vit_k_given`, `bcg_given`, `hep_b_given`, `opv_given` | Bool-false delivery-room facts. Preserve D7 detail semantics; not a per-dose administration ledger, vaccine equivalence map, schedule or prescribing authority. D6 unsigned. | _____ / _____ / _____ / _____ / _____ |
| N13 | `congenital_anomaly`, `congenital_anomaly_desc` | Bool-false and Text-null; no diagnosis or examination criteria selected. | _____ / _____ / _____ / _____ / _____ |
| N14 | `recorded_by`, `notes` | Route-pinned recorder and Text-null narrative. D7 outcome corrections compensate/annotate; never retro-delete a minted identity. | _____ / _____ / _____ / _____ / _____ |

**OPEN-QUESTION N03/N07 — existing source conflict:** the `sex` vocabulary in
migration 155:245 includes `indeterminate` (13 characters), while baseline
`maternity_newborns.sex` at 11884 and Prisma at 15325 remain `VARCHAR(10)`.
The September 25 local newborn service repair is not current-main behavior.
Do not drop a clinical value, broaden a predicate, rename tokens, claim database
enforcement, or occupy another lane's migration to resolve this worksheet.
Accountable domain owner and existing repair-lane owner must supply the ruling
and implementation handoff. Decision/reference: **UNSET**. Reuse the
existing September 25 `newborn-outcome-token-ruling-packet.md` (line 7;
coordinator-held evidence, not included in this snapshot).

## 8. Apgar assessment/amendment

Source: M:3381–3508. Existing UPSERT key is newborn plus assessment minute;
incoming NULL components overwrite rather than preserve previous components.
Exact effective-state repeats do not create revisions; changed assessments emit
new canonical revisions. The worksheet does not adopt a scoring protocol.
The current canonical occurrence timestamp is the row's `recorded_at`
(M:3513), not a separately supplied assessment timestamp. `time_minute` is the
assessment category, not server recording time. An amendment changes
`recorded_at`; D8-02 must decide the intended display and provenance.

| ID | Exact fields | Implemented behavior / observed units | Owner V / R / U / Role / A |
| --- | --- | --- | --- |
| AP01 | `newborn_id` | Required route parameter; independent valid infant identity required. No mother fallback. | _____ / _____ / _____ / _____ / _____ |
| AP02 | `time_minute` | Existing exact integer set 1, 5, 10. These are existing API-supported values, not a newly prescribed assessment schedule. | _____ / _____ / _____ / _____ / _____ |
| AP03 | `appearance` | If non-null, exact integer 0–2; absent becomes NULL. Owner must approve labels and component rubric separately. | _____ / _____ / _____ / _____ / _____ |
| AP04 | `pulse` | If non-null, exact integer 0–2; this is a score, not the raw pulse-bpm field. | _____ / _____ / _____ / _____ / _____ |
| AP05 | `grimace` | If non-null, exact integer 0–2; absent becomes NULL. | _____ / _____ / _____ / _____ / _____ |
| AP06 | `activity` | If non-null, exact integer 0–2; absent becomes NULL. | _____ / _____ / _____ / _____ / _____ |
| AP07 | `respiration` | If non-null, exact integer 0–2; absent becomes NULL. | _____ / _____ / _____ / _____ / _____ |
| AP08 | `total_score` (derived) | Service computes sum with NULL components contributing zero. Owner must approve incomplete-assessment display and requiredness; a partial sum must not silently be certified as a complete assessment. | _____ / _____ / _____ / _____ / _____ |
| AP09 | `recorded_by` | Route-pinned actor; amendment attribution and named responsible performer remain D2/D8 decisions. | _____ / _____ / _____ / _____ / _____ |

## 9. Postnatal maternal / infant / combined record

Source: M:3565, M:3591–3690. Insert-only visits; `mother`, `baby`, `both` subject
semantics follow D7. Maternal care is not conditional on a living infant.

| ID | Exact fields | Implemented behavior / observed units | Owner V / R / U / Role / A |
| --- | --- | --- | --- |
| PN01 | `delivery_id`, `visit_at` | Delivery explicitly required; time defaults to current application ISO timestamp if absent. | _____ / _____ / _____ / _____ / _____ |
| PN02 | `visit_kind` | Default/fallback `mother`; exact set `mother`, `baby`, `both`. Decide explicit subject confirmation and visibility of non-applicable fields. | _____ / _____ / _____ / _____ / _____ |
| PN03 | `newborn_id` | Required for `baby`/`both`; if supplied must belong to same delivery; infant scope requires valid infant identity. One combined visit per infant, two canonical subject pairs. | _____ / _____ / _____ / _____ / _____ |
| PN04 | `mother_temp_c`, `mother_pulse_bpm` | Numeric / integer via T-null; Celsius / bpm indicated. No new normal ranges supplied. | _____ / _____ / _____ / _____ / _____ |
| PN05 | `mother_bp_systolic`, `mother_bp_diastolic` | Integer via T-null; unit not encoded in identifiers. | _____ / _____ / _____ / _____ / _____ |
| PN06 | `uterine_involution`, `lochia`, `perineum_status`, `breastfeeding_status` | Text-null; no service enum or approved assessment rubric observed here. | _____ / _____ / _____ / _____ / _____ |
| PN07 | `baby_weight_g`, `baby_temperature_c` | Integer / numeric via T-null; grams / Celsius indicated. | _____ / _____ / _____ / _____ / _____ |
| PN08 | `baby_feeding`, `baby_jaundice`, `baby_cord_status` | Text-null; classification and response policy undecided. | _____ / _____ / _____ / _____ / _____ |
| PN09 | `baby_passed_meconium`, `baby_passed_urine` | Nullish booleans preserve false; absent becomes NULL. Assessment interval must be approved. | _____ / _____ / _____ / _____ / _____ |
| PN10 | `red_flags` | Optional text array. Stored fact is not acknowledgment, assigned action, SLA, notification delivery or recovery evidence. Exact vocabulary and follow-up policy require signed owners. | _____ / _____ / _____ / _____ / _____ |
| PN11 | `notes`, `recorded_by` | Text-null and route-pinned recorder. Shared notes/red flags remain detail-only; canonical payloads remain minimal and subject-separated. | _____ / _____ / _____ / _____ / _____ |

Red-flag response attachment: owner _____; action policy/version _____;
acknowledgment and escalation deadlines _____; recipient/dispatch authority _____;
failure/reconciliation owner _____; clinical approval _____; D4 linkage _____.

### Focused owner review for delivery newborn APGAR and postnatal forms

Use this section with the companion package's D2-01–04 and D8-01–09 decisions.
Recommendations below are candidate product behavior only. The field tables
above describe accepted backend inputs; they supply no clinical authority to
expose a field, require it, default it or accept a particular assessment.

| Form and affected rows | Concrete proposal for owner review | OPEN-QUESTION and required authority |
| --- | --- | --- |
| Delivery D01–D14 | Enter from a confirmed pregnancy/labour context. Display authenticated recorder separately from the named delivery performer. Review event time and the selected delivery facts before submission; display the returned record and episode state afterward. | **D2-01–04; D8-01–03,05–06:** which delivery facts are visible, required/optional/conditional; what defines completed documentation and who signs; who may correct time, performer or mode or cancel a committed record? Obstetrics/nursing/medical-records approval and cited protocol/version: **UNSET**. Existing backend minimum is D01 pregnancy, D02 and D03; that is not an approved clinical minimum. |
| Newborn N01–N14 | Work under the recorded delivery, identify each infant by birth order and show the existing D7 identity result. Seek explicit outcome confirmation rather than treating an unanswered question as live. Keep birth-dose observations separate from dose administration records and immunisation-review notes. | **D2-01–04; D8-01–03,05–06:** confirm field/measurement requiredness, unknown outcome/sex representation, recorder versus examining clinician, and truthful use of existing guardian/consent evidence. Neonatology, obstetrics, nursing and privacy/medical-records authority/version: **UNSET**. Existing backend requires N01 and a valid N02, which defaults to 1. Resolve N03/N07 through the existing owner lane. No new consent rule is proposed. |
| APGAR AP01–AP09 | Show all component entries and distinguish missing components from scored zero. An incomplete assessment must not look like a completed assessment. Give an amendment review the prior and proposed values and recorder attribution; a separately approved version contract must detect stale edits. | **D2-01–04; D8-01–04,06:** may incomplete assessments be saved or finalized, what labels/rubric and time categories are approved, and who performed versus recorded each assessment? Paediatrics/neonatology, nursing and medical-records source/version: **UNSET**. Backend requires AP01/AP02, accepts null components, sums them as zero, and overwrites absent components. Choosing complete-only entry is an alternative that may prevent timely partial capture; accepting partial entry requires explicit status/display semantics. Neither is selected. |
| Postnatal PN01–PN11 | Explicitly choose maternal, infant or combined scope; show only the applicable approved field groups and confirm the exact infant. Preserve maternal-only access without requiring a living infant. Read back each subject's evidence after a combined visit. | **D2-01–04; D8-01–03,05–07:** who assesses each subject, which fields are required/optional/conditional, and which red flags create what assigned response? Obstetrics, nursing and neonatology authority/version: **UNSET**. Backend requires PN01 delivery and PN03 for infant scope; PN01 time and PN02 scope currently default. A saved flag is not an acknowledged action. |

For each field in these four families record an explicit answer to
**OPEN-QUESTION D8-01**: visible/hidden, required/optional/conditional and the
condition, unit/precision/vocabulary, allowed unknown representation, source of
clinical authority and its edition/section, responsible recorder/performer,
correction rules and approving person. All values remain **UNSET**. Rows may be
approved separately only if the owner records what the resulting form excludes.

#### Time lifecycle recovery and wording review

| OPEN-QUESTION | Proposed behavior and current limitation | Approval field |
| --- | --- | --- |
| **D8-02 — event and recording time** | Display both with clear time-zone labels. Existing delivery/birth timestamps are supplied; postnatal time can default to now; APGAR uses recording time in its canonical event. Do not infer an assessment timestamp from the minute category or silently backdate an audit record. | Event-time definition, retrospective/estimated/future-time treatment, correction policy, zone and clinical/medical-records source: **UNSET**. |
| **D8-03 — draft and completion** | Current target routes persist immediately and expose no common draft/sign/cancel API. Propose discard for pre-submit cancellation and attributable compensation after commit. Decide session-only input versus a durable draft explicitly; durable drafts need ownership, expiry and access rules. | Per-form completion/signing criteria, draft disposition, amendment/cancellation transitions and medico-legal source: **UNSET**. No expiry or mandatory clinical field is invented. |
| **D8-04 — duplicate retry and concurrency** | Delivery/newborn duplicate guards currently return conflicts; postnatal is insert-only; identical APGAR repeats are no-ops but changed/stale writes overwrite components. Propose command-result receipts and revision checks, preserving genuinely new assessments. A client submit lock alone cannot recover an uncertain server commit. | Product duplicate/new-visit rule; conflict and reconciliation owner; backend contract/versioning and receipt retention proposal: **UNSET**. |
| **D8-05 — context** | Keep mother, episode, delivery and infant confirmation visible. Preserve D7 identity checks and one combined visit per infant; no mother UID as an infant fallback. The current route access decision uses the maternal episode, with separate infant-validity checks inside the service. | Approved entry point, maternal/infant access model and wrong-context recovery; outside-birth procedure reference: **UNSET**. |
| **D8-06 — review evidence** | Return detail and canonical evidence with separate recorder/performer and event/recording time labels. Current APGAR canonical payload contains a total, not a complete historic component snapshot. Retain evidence of every genuine change and original infant identity. | Required reviewer view, component-history/attestation evidence, retention authority and permitted audience: **UNSET**. Staff-only events remain in effect; D3 governs any new patient release. |
| **D8-07 — validation and recovery** | Cover 400 validation, 403 denial, 404 missing context, 409 duplicate/link/state conflict, transport failure and failed/malformed readback. Mark an uncertain save as uncertain and reconcile before resubmitting. Keep safe in-session input when possible; clear protected context on denial, logout or patient change. | Approved recovery wording and owner; postnatal red-flag response/action, deadline, escalation and D4 dependency: **UNSET**. No clinical clock or notification policy selected. |
| **D8-08 — offline** | Propose online-only submission for the initial approved forms. Offline draft/replay is a separate option needing approved device storage, revocation and synchronization semantics. A generic connectivity queue does not establish suitability for infant identity minting or clinical amendments. | Clinical/product, privacy and continuity-owner decision; permitted drafts, retention and downtime procedure reference: **UNSET**. No activation authorized. |
| **D8-09 — clinical and linguistic wording** | Review exact labels for birth/outcome, APGAR components versus raw observations, who recorded/performed, unknown values, signature, cancellation and uncertainty. Technical five-locale parity does not mean human review passed. | Named en/hi/ta/te/ml reviewers, clinical reviewer, approved version/batch and exceptions: **UNSET**. |

Acceptance scenarios and the proposed implementation split live in the companion
package. This worksheet adds no second execution plan. Every required decision
must have its source and accountable human; an unavailable answer stays open.

## 10. Supplement facts and existing reminder preference

Source: M:1455–1610, M:2177–2219. Inventory only: no supplement regimen,
medication, route, dose, reminder schedule or prescription is recommended here.

| ID | Exact fields | Implemented behavior / observed units | Owner V / R / U / Role / A |
| --- | --- | --- | --- |
| S01 | `pregnancy_id`, `supplement` | Required pregnancy; exact supplement set `iron`, `folic_acid`, `calcium`, `vitamin_d`, `b_complex`, `other`. Existing active same-supplement row is updated; not always a new prescription row. | _____ / _____ / _____ / _____ / _____ |
| S02 | `dose` | Optional text, string length checked at 60 characters. This is not structured dosage validation or approval of any example text in source. | _____ / _____ / _____ / _____ / _____ |
| S03 | `frequency` | Existing allowed set `once_daily`, `twice_daily`, `thrice_daily`, `weekly`, `as_needed`; omitted value defaults to `once_daily`, including update behavior. No frequency chosen by this worksheet. | _____ / _____ / _____ / _____ / _____ |
| S04 | `route` | Defaults to `oral`; no service route enum observed. Existing default is not a prescription recommendation. | _____ / _____ / _____ / _____ / _____ |
| S05 | `start_date`, `end_date` | Start defaults to current application UTC date; end optional. Existing-row update can apply the computed start default; incoming null end preserves existing end. Sign effective-date/amendment semantics. | _____ / _____ / _____ / _____ / _____ |
| S06 | `reminder_enabled` | New row defaults true unless literal false; omitted update value preserves existing flag. Separate preference writer requires actual boolean. D4 permission not inferred. | _____ / _____ / _____ / _____ / _____ |
| S07 | `prescribed_by`, `notes` | Prescriber explicitly required in service; notes Text-null/COALESCE. Route/role/credential/delegation decisions must be confirmed, not inferred from a UUID. | _____ / _____ / _____ / _____ / _____ |
| S08 | `supplement_id` (preference update), `pregnancy_id` | Existing preference mutation binds exact supplement within pregnancy/tenant and emits audited revision for change. | _____ / _____ / _____ / _____ / _____ |
| S09 | `dose_schedule` (read-derived) | Existing frequency-to-time mapping and `Asia/Kolkata` zone enrich responses; unknown frequencies fall back to once-daily. Mapping is not adopted as clinical/reminder policy by this worksheet. D4/D5 must govern future behavior. | _____ / _____ / _____ / _____ / _____ |

## 11. Signed immunisation-review note, not dose administration

Source: I:423–428 (age-group vocabulary), I:444–530 (`markScheduleUpToDate`).
The note is born signed and retained as a separate review; repeat reviews/addenda
create new rows. It is not one `newborn_immunisations` record per administered dose.

| ID | Exact fields | Implemented behavior / observed units | Owner V / R / U / Role / A |
| --- | --- | --- | --- |
| IR01 | `patient_uid` | Explicitly required, existing patient checked; select correct independent infant subject where applicable. | _____ / _____ / _____ / _____ / _____ |
| IR02 | `as_of` | `YYYY-MM-DD`-shaped input accepted by this service; missing/malformed shape defaults to current application UTC date. No new clinical validity inference. | _____ / _____ / _____ / _____ / _____ |
| IR03 | `age_group` | Set `birth`, `6_week`, `10_week`, `14_week`, `6_month`, `9_month`, `12_month`, `15_month`, `18_month`, `2_year`, `5_year`, `10_year`, `current`; missing/unknown falls back to `current`. This vocabulary is not a vaccine schedule. | _____ / _____ / _____ / _____ / _____ |
| IR04 | `signed_by`, `signed_by_name` | Signer UUID required; display name optional. Decide attestation/source-evidence/recorder policy under D2/D8; a display name alone is not identity evidence. | _____ / _____ / _____ / _____ / _____ |
| IR05 | `notes` | Optional content; decide whether parental report, external evidence or clinical verification must be distinguished, without inventing the answer. | _____ / _____ / _____ / _____ / _____ |
| IR06 | `actor_role` | Optional service context; note author-role fallback is `STAFF`. Actual route-bound role/authority is not replaced by this worksheet. | _____ / _____ / _____ / _____ / _____ |
| IR07 | `status`, `is_signed`, `signed_at` (derived) | Content status is `up_to_date`; note inserted signed with server timestamp. It must not silently mark missing individual doses administered or waive unsigned D6. | _____ / _____ / _____ / _____ / _____ |

## 12. Existing newborn immunisation dose recording

Source: I:220–411 (`recordDose`) and R:459–468 (`PATCH
/immunisations/:id/record`). The inspected service does not export
`recordVaccineGiven`; the operation inventoried here is `recordDose`.
This is an existing programme workflow, not deferred future scope. Completing
its field inventory does **not** approve a new Staff form or select vaccine policy.

The route requires its existing staff/admin and patient-context guards, derives
the tenant, takes the immunisation ID from the path, and pins `given_by` and
`actor_role` to authenticated context after spreading the request body. A
body-supplied display name is not a separately credentialed performer identity;
D2 still decides whether another person's action may be documented.

| ID | Exact fields | Implemented behavior / observed units | Owner V / R / U / Role / A |
| --- | --- | --- | --- |
| ID01 | `immunisation_id` | Explicit service requirement; route path overrides body. Resolves an existing `newborn_immunisations` row, not a vaccine catalogue choice or instruction to seed a schedule. | _____ / _____ / _____ / _____ / _____ |
| ID02 | `status` | Existing exact set `given`, `missed`, `refused`, `contraindicated`; other/missing values rejected by this service. This lists accepted values, not clinical authority to select them or approve every transition. | _____ / _____ / _____ / _____ / _____ |
| ID03 | `given_by` | Route pins authenticated UID; service uses it for recorded actor and updates via COALESCE. No separately governed on-behalf-of performer tuple is introduced. D2 remains unset. | _____ / _____ / _____ / _____ / _____ |
| ID04 | `given_by_name` | Service explicitly requires a truthy value when `status='given'`; otherwise optional. Incoming empty/null becomes NULL and preserves existing value by COALESCE. No clinical-requiredness or identity-verification decision is inferred from this check. | _____ / _____ / _____ / _____ / _____ |
| ID05 | `batch_number` | Optional Text-null; incoming null/empty preserves existing batch by COALESCE. No source, format or clinical requiredness adopted. | _____ / _____ / _____ / _____ / _____ |
| ID06 | `manufacturer` | Optional Text-null; incoming null/empty preserves existing manufacturer. This inventory does not approve product equivalence or a manufacturer catalogue. | _____ / _____ / _____ / _____ / _____ |
| ID07 | `site_of_injection` | Optional Text-null; existing value preserved on incoming null/empty. No approved site vocabulary, route, dose or administration technique is supplied. | _____ / _____ / _____ / _____ / _____ |
| ID08 | `adverse_event` | Optional Text-null; existing value preserved on incoming null/empty. Recording text is not proof of an assigned response, escalation, notification receipt or adverse-event reporting workflow. | _____ / _____ / _____ / _____ / _____ |
| ID09 | `notes` | Optional Text-null/COALESCE. Decide documentation provenance, addenda and correction reasons without granting in-place deletion of historical clinical evidence. | _____ / _____ / _____ / _____ / _____ |
| ID10 | `tenantId`, `actor_role` | Tenant and authenticated role come from route context; service role default is null. Not selectable clinical form fields. | _____ / _____ / _____ / _____ / _____ |
| ID11 | `given_at` (derived, not a writer input) | When status becomes `given`, the update uses existing `given_at` or database `NOW()`; other statuses retain existing `given_at`. The signature accepts no administration-time override. Retrospective timing and correction need explicit review; a new timestamp input is not authorized here. | _____ / _____ / _____ / _____ / _____ |
| ID12 | `newborn_id`, `newborn_patient_uid`, `vaccine_catalogue_id`, `vaccine_code`, `dose_number` (resolved context) | Loaded from the existing dose/newborn/catalogue relationships, not caller-selected identity or dose-equivalence fields in this mutation. D7 requires the infant's own valid identity, checked again under locks before mutation or retry return; no mother fallback. | _____ / _____ / _____ / _____ / _____ |

Amendment/replay behavior to review: the current writer compares effective
persisted state under locks. An identical effective repeat returns the existing
row without another update; a changed status/detail updates the existing dose
row and emits a new staff-only canonical event/audit revision within the same
transaction. Existing null/empty inputs do not clear COALESCE-preserved fields.
This is not an approved transition graph, a historical-correction ceremony, or
evidence that lost-response replay is fully closed.

The newborn birth-dose booleans, this individual dose row and the signed
`immunisation_review` note are three distinct representations. No automatic
status copying, dose creation, schedule completion, vaccine equivalence,
catalogue import, catch-up policy or recommendation is authorized by adding
this section. **D6 remains unsigned.**

## 13. Form-level decisions and signatures — all unset

For each form family above, attach a versioned complete field matrix and record:

| Form | Approved row IDs / exclusions | Workflow and screen location | Finalization/signature | Correction policy/version | Approval reference |
| --- | --- | --- | --- | --- | --- |
| Pregnancy / amendment | _____ | _____ | _____ | _____ | _____ |
| ANC / same-day amendment | _____ | _____ | _____ | _____ | _____ |
| Labour admission | _____ | _____ | _____ | _____ | _____ |
| Partograph | _____ | _____ | _____ | _____ | _____ |
| Delivery | _____ | _____ | _____ | _____ | _____ |
| Newborn | _____ | _____ | _____ | _____ | _____ |
| Apgar / amendment | _____ | _____ | _____ | _____ | _____ |
| Postnatal | _____ | _____ | _____ | _____ | _____ |
| Supplement / reminder preference | _____ | _____ | _____ | _____ | _____ |
| Immunisation review | _____ | _____ | _____ | _____ | _____ |
| Newborn immunisation dose recording | _____ | _____ | _____ | _____ | _____ |

D2 selection/reference and authorized performer/delegation model: _____

Product owner name/role, authority reference and accepted form scope: _____

D2-01–04 and D8-01–09 decisions accepted, exceptions and exact version: _____

Clinical owner name/role, signature, date: _____

Nursing owner name/role, signature, date: _____

Paediatrics/neonatology reviewer name/role, signature, date: _____

Medico-legal / privacy owner name/role, signature, date: _____

Language reviewers and exact approved version/batch:
en _____; hi _____; ta _____; te _____; ml _____.

Tenant/site/department scope: _____

Effective date/time and time zone: _____

Decision version, source clinical references and review date: _____

Release/operator authorization, separately if later requested: _____

Approval does not take effect through silence. A signature must identify the
exact accepted rows and unresolved exceptions; an engineering instruction to
“finish the workflow” does not fill this clinical worksheet.

## 14. Coverage and remaining evidence

The worksheet covers the current named inputs to pregnancy creation/amendment,
ANC, labour admission, partograph, delivery, newborn, Apgar, postnatal,
supplement/preference, signed immunisation review and existing newborn
immunisation dose recording. Context/actor inputs are
listed separately to avoid treating authenticated values as user-selectable.

It does not claim a fresh whole-module audit, live database state, completed
backend CI, approved role policy, complete route validation, UI parity, medical
device measurement semantics, clinical protocol correctness, historical data
acceptance, or patient-language approval. Fetal-kick entry, advice generators,
immunisation catalogue/schedule/import policy, imaging release, missed-cycle
screening and reminder dispatch are excluded from this worksheet. Where already
in programme scope, they remain separately governed, unresolved work rather than
being deferred as a future scope expansion. The field inventory for current
newborn dose recording is now included separately from the signed-review-note
section; its D2/D8 choices, UI implementation and workflow closure remain open.
No excluded work is silently approved by these field inventories.

Before any form implementation is approved, resolve missing-versus-false/zero
semantics, exact units, default confirmation, retrospective entry, partial
assessments, caregiver/performer attribution and correction behavior. Existing
code quirks listed above are not proposals to preserve unsafe behavior, and this
artifact grants no authority to change them or weaken tests/constraints.

Authority documents read for this worksheet:

- July 13 `obgyn-journey-controlled-parallel-plan.md`: coordinator-held evidence;
  not included in this snapshot.
- July 14 artifact `obgyn-d7-decision-record.md` (operative signed D7):
  coordinator-held evidence; not included in this snapshot.
- July 17 `obgyn-d6-decisions-draft.md` (explicitly unsigned): coordinator-held
  evidence; not included in this snapshot.
- [Canonical clinical timeline](https://github.com/Bahuleyandr/VH-Health-Platform/blob/a38055b8d2f3e2215ccc17338f6e199d0a063685/docs/CANONICAL_CLINICAL_TIMELINE.md#L131)
  at the September 30 reviewed main, especially lines 131–182.
- September 25 `newborn-outcome-token-ruling-packet.md` (unresolved source conflict,
  not approval): coordinator-held evidence; not included in this snapshot.

During the September 30 review, no repository files, database, containers, tests,
deployments or publication were modified or run. That review changed only the two
confirmed review artifacts and session-owned working evidence. The source
snapshots, Git blob/hash manifest and four inspected OpenAPI operations remain
coordinator-held evidence and are not included in this repository snapshot.
Preparing this snapshot does not rerun or recertify those inspections.
All four operations have generic success schemas and no request body contract;
typed contracts remain future work. Test-source inspection is not a passing run.
