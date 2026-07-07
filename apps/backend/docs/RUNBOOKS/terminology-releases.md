# Runbook - Terminology release import, rollback, and binding coverage

## Symptoms

- A SNOMED CT, LOINC, ICD-11, ICD-10, or ATC release must be imported or rolled back.
- Terminology autocomplete is stale, incomplete, or still using the ICD-11 WHO API after a full local import.
- LOINC/ATC binding coverage needs to be refreshed after a terminology release.

## Prerequisites

- Do not commit terminology release files to git. SNOMED CT, LOINC, ICD-11, and ATC downloads stay operator-supplied on the target host or in approved private object storage.
- Set `DATABASE_URL` for the target environment before running importer commands.
- Run imports from `apps/backend`.
- Record the release label exactly as published by the source. Use the same label for rollback re-imports.

## Acquisition

1. SNOMED CT via NRCeS:
   Apply for the free Indian SNOMED CT Affiliate license through NRCeS at `https://www.nrces.in/`, accept the affiliate terms, obtain MLDS access through the India NRC, and download the RF2 Snapshot Terminology directory for the India Edition or International Edition.

2. LOINC:
   Register at `https://loinc.org/`, accept the Regenstrief license, and download the release ZIP. Use `Loinc.csv` from that release.

3. ICD-11:
   Prefer a self-hosted WHO ICD API container for on-prem use. If cloud lookup is approved, register a WHO ICD API client and set `WHO_ICD_CLIENT_ID` and `WHO_ICD_CLIENT_SECRET`. For local-first search, also download/export the ICD-11 MMS linearization CSV in `code,display,category` shape.

4. ATC:
   Obtain the annual WHOCC ATC/DDD electronic files under WHOCC terms and transform the operator-owned export to `code,display,category` CSV before import.

## Import

Run a dry-run first. Dry-runs write provenance only; they do not change concepts, maps, or retirement state.

```bash
cd apps/backend
node scripts/terminology-import.mjs --system SNOMED_CT --rf2 /secure/releases/snomed/Snapshot/Terminology --version 20260731 --full --dry-run
node scripts/terminology-import.mjs --system LOINC --loinc /secure/releases/loinc/Loinc.csv --version 2026-06 --full --dry-run
node scripts/terminology-import.mjs --system ICD11 --csv /secure/releases/icd11/icd11-mms.csv --version 2026-01 --full --dry-run
node scripts/terminology-import.mjs --system ATC --csv /secure/releases/atc/atc-2026.csv --version 2026 --full --dry-run
```

If the counts look right, run the real imports:

```bash
node scripts/terminology-import.mjs --system SNOMED_CT --rf2 /secure/releases/snomed/Snapshot/Terminology --version 20260731 --full
node scripts/terminology-import.mjs --system LOINC --loinc /secure/releases/loinc/Loinc.csv --version 2026-06 --full
node scripts/terminology-import.mjs --system ICD11 --csv /secure/releases/icd11/icd11-mms.csv --version 2026-01 --full
node scripts/terminology-import.mjs --system ATC --csv /secure/releases/atc/atc-2026.csv --version 2026 --full
```

Import maps after the concept release they refer to:

```bash
node scripts/terminology-import.mjs --system SNOMED_CT --rf2-map /secure/releases/snomed/Refset/der2_iisssccRefset_ExtendedMapSnapshot.txt --version 20260731
node scripts/terminology-import.mjs --system ICD10 --map-csv /secure/releases/maps/icd10-icd11-map.csv --version 2026-01
```

## Verify

```sql
SELECT system_key, release_label, status, rows_processed, rows_inserted, rows_skipped, rows_failed, started_at, finished_at
FROM terminology_import_batches
ORDER BY created_at DESC
LIMIT 20;

SELECT system_key, version, concept_count, imported_at
FROM terminology_code_systems
ORDER BY system_key;

SELECT source_system, target_system, relationship, COUNT(*)
FROM terminology_concept_maps
GROUP BY source_system, target_system, relationship
ORDER BY source_system, target_system, relationship;
```

Then call:

```bash
curl -sS -H "x-api-key: $API_KEY_STAFF" -H "Authorization: Bearer $STAFF_JWT" \
  "$API_BASE/api/v1/terminology/coverage"
```

## Rollback Drill

Rollback is a prior-release full re-import. Never delete terminology concepts; missing current-release concepts become `inactive`, and historical bindings keep resolving as inactive codes.

```bash
cd apps/backend
node scripts/terminology-import.mjs --system LOINC --loinc /secure/releases/loinc-prior/Loinc.csv --version 2025-12 --full --dry-run
node scripts/terminology-import.mjs --system LOINC --loinc /secure/releases/loinc-prior/Loinc.csv --version 2025-12 --full
```

Verify that the previous release label is now present in `terminology_code_systems.version`, the import batch is `completed`, and retired codes return `valid:false` with `reason:'concept_inactive'` from `/api/v1/terminology/validate`.

## Binding Suggestion Step

After LOINC import, run the migration-102 investigation catalog suggestion pass and leave rows as `suggested` for curator confirmation:

```bash
curl -sS -X POST \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY_STAFF" \
  -H "Authorization: Bearer $CURATOR_JWT" \
  "$API_BASE/api/v1/terminology/bindings/suggest" \
  -d '{"catalog_type":"investigation_test","system":"LOINC","persist":true,"limit":200}'
```

Curators then review suggestions through the existing catalog binding flow and confirm or reject each row. The P1 acceptance target is at least 90 percent confirmed LOINC coverage on the seeded `investigation_test_catalog`.

## Post-incident / Post-release

- Attach the latest `terminology_import_batches` rows to the release evidence.
- Attach `/api/v1/terminology/coverage` output after curator confirmation.
- Record whether the ICD-11 local concept count is above the local-first threshold.
- Store the release files in the approved private location; do not copy them into the repository.
