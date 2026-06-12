# Live Dalekdefender Schema Drift Remediation

Last refreshed: 2026-06-12.

## Current State

Dalekdefender had real Prisma drift after commit `d774ad9e53e7e93ad62fc16fcb76f34566105a56`: route-critical contracts were healthy, but `prisma db pull` found live-only historical tables/columns. The destructive archive/narrowing path is migration `299_live_schema_drift_archive.sql`; the final contract catch-up is `301_preop_claim_schema_contract.sql`.

As of 2026-06-12, live Dalekdefender has applied migrations `298`, `299`, `300`,
and `301`, DB contracts pass, route-critical schema drift has no missing tables,
and the full Prisma pull/compare drift check reports no drift.

The migration is intentionally conservative:

- Creates `schema_drift_archives` with tenant-aware RLS.
- Archives rows from live-only historical tables before dropping them.
- Archives non-null values from live-only historical columns before dropping them.
- Refuses to drop columns expected to be empty if they contain data.
- Refuses to narrow `anesthesia_records.intubation_grade` if any value is longer than 8 characters.

## Backup Evidence

Before writing the migration, a logical backup was taken on Dalekdefender:

```text
/home/bahuleyan/backups/vhhealth/20260612T082340Z-pre-drift-remediation
```

Files created:

- `vhhealth.custom.dump`
- `vhhealth.schema.sql`
- `SHA256SUMS.txt`

Recorded checksums:

```text
9b3fba91d46df2fab91c3beef258be609d01aa0dd5e580fa7a84c2c47b42f1f1  vhhealth.custom.dump
90e6d95a8e743777c4c6644703aae8ef4350387e1450cebff07702fc0fa4ed2d  vhhealth.schema.sql
```

Immediately before applying the live destructive/narrowing migrations, a second
backup was taken:

```text
/home/bahuleyan/backups/vhhealth/20260612T100205Z-pre-live-drift-apply
```

Recorded checksums:

```text
b144519c2c30e85394a66a7118eda4fe7b8ee96e73d4eaeb29cb775d5e81807f  vhhealth.custom.dump
ec9d7052e59d7c4f392b722b50237bbc19addf2b5060008fb82f551b06d5874e  vhhealth.schema.sql
```

## Live Drift Counts

Targeted live counts before remediation:

| Object | Live state | Decision |
| --- | ---: | --- |
| `admission_advice` | table exists, 1 row | Archive rows, drop table |
| `admission_advices` | table exists, 1 row | Archive rows, drop table |
| `admission_room_days` | table exists, 1 row | Archive rows, drop table |
| `admissions.admission_advice_id` | exists, 0 non-null | Drop only if still empty |
| `insurance_claims.admission_id` | exists, 0 non-null | Drop only if still empty |
| `invoices.admission_id` | exists, 0 non-null | Drop only if still empty |
| `preop_checklists.admission_id` | exists, 1 non-null | Archive values, drop column |
| `radiology_orders.imaging_study_id` | exists, 1 non-null | Archive values, drop column |
| `anesthesia_records.intubation_grade` | `varchar(40)`, 0 non-null | Narrow to `varchar(8)` only if safe |

## Apply/Verify Sequence

1. Confirm backup exists and checksums read cleanly.
2. Apply migrations `298_otp_session_hash_width.sql`,
   `299_live_schema_drift_archive.sql`,
   `300_india_deployability_controls.sql`, and
   `301_preop_claim_schema_contract.sql` through the normal backend migration
   runner or a controlled psql session that also records `_migrations`.
3. Run:

```powershell
cd apps/backend
node scripts/check-db-contracts.mjs
node scripts/ci-schema-drift.mjs
node scripts/check-schema-drift.mjs
```

4. Verify archive evidence:

```sql
SELECT source_table, source_column, COUNT(*) AS archived_rows
  FROM schema_drift_archives
 WHERE archived_by_migration = '299_live_schema_drift_archive.sql'
 GROUP BY source_table, source_column
 ORDER BY source_table, source_column NULLS FIRST;
```

5. Verify live version and smoke:

```text
GET /api/v1/health/version
GET /api/v1/health/live
GET /api/v1/health/ready with the monitoring token
```

## 2026-06-12 Live Proof

Live apply used the current backend production image digest:

```text
ghcr.io/bahuleyandr/vh-health-platform-backend@sha256:1feb81cb4fb9af3032782a7fd82c178471c561999b09450a4bc57c4fad215906
```

Post-apply evidence:

- `_migrations` contains `298_otp_session_hash_width.sql`,
  `299_live_schema_drift_archive.sql`,
  `300_india_deployability_controls.sql`, and
  `301_preop_claim_schema_contract.sql`.
- `schema_drift_archives` contains 5 archived rows from the removed live-only
  historical objects/columns.
- Live-only historical tables `admission_advice`, `admission_advices`, and
  `admission_room_days` no longer exist.
- Removed columns are absent:
  `admissions.admission_advice_id`, `insurance_claims.admission_id`,
  `invoices.admission_id`, `preop_checklists.admission_id`, and
  `radiology_orders.imaging_study_id`.
- `anesthesia_records.intubation_grade` is `varchar(8)`.
- `preop_checklists` and `insurance_claims` residual contract drift is now
  explicit in migration `301` and `schema.prisma`.
- `node scripts/check-db-contracts.mjs`: 13/13 passing.
- `node scripts/ci-schema-drift.mjs`: 36 route-critical expected tables,
  527 present tables, 0 missing route-critical tables.
- `node scripts/check-schema-drift.mjs`: `schema.prisma` matches DB; no drift.
