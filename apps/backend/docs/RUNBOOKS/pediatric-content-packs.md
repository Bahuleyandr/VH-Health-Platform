# Pediatric Content Packs Runbook

NL-5 P4 ships operator-run content import paths for pediatric growth LMS data and per-tenant UIP/IAP immunisation schedules. Deploy remains held; imports run only after clinical and policy sign-off for the target tenant.

## Growth LMS Import

Use operator-supplied CSV files unless the playbook decision log explicitly clears redistribution for the source tables.

Required CSV columns:

```csv
sex,metric,age_days,l,m,s,source_version
M,weight_kg,730,0,12.2,0.13,WHO-2026
```

Run a dry run first:

```bash
cd apps/backend
node scripts/growth-lms-import.mjs --dataset WHO_0_5 --csv D:/secure-content/who-lms.csv --version WHO-2026 --dry-run
```

Then import:

```bash
node scripts/growth-lms-import.mjs --dataset WHO_0_5 --csv D:/secure-content/who-lms.csv --version WHO-2026
node scripts/growth-lms-import.mjs --dataset IAP_5_18 --csv D:/secure-content/iap-lms.csv --version IAP-2026
```

Evidence to retain:

- Source file location and checksum in the operator evidence store.
- Import batch id from `growth_lms_import_batches`.
- Source/version label used in the command.
- Confirmation that no restricted source CSV was committed to git.

## Immunisation Schedule Import

Each tenant chooses UIP-only, IAP-only, or UIP+IAP after a named clinician signs off the schedule variant. The import updates `vaccine_catalogue` only; existing `patient_immunisations` and `newborn_immunisations` due dates remain unchanged because they were computed at seed time.

Dry run:

```bash
cd apps/backend
node scripts/immunisation-schedule-import.mjs --tenant <tenant-uuid> --schedule both --version UIP-IAP-2026 --dry-run
```

Import:

```bash
node scripts/immunisation-schedule-import.mjs --tenant <tenant-uuid> --schedule both --version UIP-IAP-2026
```

Update semantics:

- Rows are upserted by `(tenant_id, code, dose_number)` semantics.
- Timing changes apply only to future patient/newborn schedule seeds.
- Schedule rows missing from a new import are marked `active=false` with `retired_at=NOW()`.
- Removed rows are never deleted because administered doses may reference them.

Clinical sign-off evidence:

- Tenant id and chosen pack: `uip`, `iap`, or `both`.
- Version label.
- Named clinician, role, sign-off timestamp, and approval note.
- Import batch id from `immunisation_schedule_import_batches`.
- Any local policy exceptions, such as endemic JE applicability or vaccines not offered by the facility.
