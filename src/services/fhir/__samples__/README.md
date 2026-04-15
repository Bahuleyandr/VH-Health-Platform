# FHIR R4 sample bundles

Drop curated FHIR R4 JSON bundles in this directory and the `fhir-conformance`
CI job will validate each one against the official HL7 validator JAR.

## How to add a sample

1. Generate a representative resource via the running backend, e.g.
   `curl https://api.vhhealth.app/fhir/Patient/12345 > patient_sample.json`.
2. Strip any sensitive PHI before committing (use deterministic dummy uids/dobs).
3. Save as `<resource>_<scenario>.json` (e.g. `patient_minimal.json`,
   `observation_vitals_full.json`, `medicationrequest_with_dosage.json`).
4. The CI job runs:
   `java -jar validator_cli.jar <file> -version 4.0.1`

## What this catches

- Unknown resource types.
- Missing required cardinality-1 elements.
- Bound value-set violations (e.g. `Observation.status` not in R4 enum).
- Profile invariant breaks (when we declare profiles).

## What it does NOT catch

- Slicing rules — only when explicit `meta.profile` is set.
- Terminology code validity — full LOINC/SNOMED/ICD lookups need the
  packaged terminology server, which the JAR can pull from `tx.fhir.org`
  but at the cost of CI runtime.
- Business semantics — "is this combination of fields meaningful for our
  workflow" is out of scope.

## Why CI is non-blocking (continue-on-error)

Until the team has triaged every legitimate warning, blocking CI on any
diagnostic would freeze unrelated PRs. Move it to blocking once the
validator runs clean against the full sample set.
