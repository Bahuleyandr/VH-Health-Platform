# FHIR R4 sample bundles

Drop curated FHIR R4 JSON bundles in this directory and the `fhir-conformance`
CI job will validate each one against the official HL7 validator JAR.

## Current samples (as of 2026-04-17)

| File | Resource | What it exercises |
|------|----------|-------------------|
| `patient_minimal.json`             | Patient           | Bare-minimum: identifier, name (text), gender, birthDate. Regression guard for the `toFhirPatient()` adapter when upstream data is sparse. |
| `patient_full.json`                | Patient           | Full shape: dual identifier systems, structured `name.family/given`, mobile + email telecom, Indian address components, next-of-kin contact with v2-0131 relationship coding. |
| `observation_vitals_bp.json`       | Observation       | Vital-signs BP panel using the LOINC 85354-9 parent + component array for systolic (8480-6) and diastolic (8462-4) with UCUM `mm[Hg]` units. Catches the "forgot to set `status`" and value-set errors. |
| `observation_lab_glucose.json`     | Observation       | Laboratory category with a single `valueQuantity`, interpretation coding, and reference range — the canonical pattern for chemistry results. |
| `medicationrequest_with_dosage.json` | MedicationRequest | RxNorm-coded medication + structured `dosageInstruction[]` with timing + route (SNOMED oral) + dose quantity + ICD-10 reasonCode. |
| `bundle_transaction_patient_vitals.json` | Bundle (transaction) | 1 Patient + 2 Observations (HR + SpO2) using `urn:uuid:*` fullUrls + PUT/POST request entries. Catches reference-integrity errors within a bundle. |

## How to add a sample

1. Generate a representative resource via the running backend, e.g.
   `curl https://api.vhhealth.app/fhir/Patient/12345 > patient_sample.json`.
2. Strip any sensitive PHI before committing (use deterministic dummy uids/dobs).
3. Save as `<resource>_<scenario>.json` (e.g. `patient_minimal.json`,
   `observation_vitals_full.json`, `medicationrequest_with_dosage.json`).
4. The CI job runs:
   `java -jar validator_cli.jar <file> -version 4.0.1 -tx n/a`

## What this catches

- Unknown resource types.
- Missing required cardinality-1 elements.
- Bound value-set violations (e.g. `Observation.status` not in R4 enum).
- Profile invariant breaks (when we declare profiles).

## What it does NOT catch

- Slicing rules — only when explicit `meta.profile` is set.
- Live terminology code validity — branch CI uses local terminology mode
  (`-tx n/a`) so FHIR validation does not block on `tx.fhir.org` latency or
  outages.
- Business semantics — "is this combination of fields meaningful for our
  workflow" is out of scope.

## CI blocking scope

Root-level samples are informational. Golden samples under `golden/`, when
present, are strict and fail CI on validation errors.
