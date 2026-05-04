# Weekly Drift Sweep — 2026-05-04

**Timestamp:** 2026-05-04T00:00:00Z  
**Scanner:** `node scripts/scan-code-drift.mjs` (static, no DB required)  
**Schema-drift check:** skipped — `DATABASE_URL` not set in environment

## Scanner exit codes

| Scan | Exit code | Meaning |
|---|---|---|
| `scan-code-drift.mjs` | **1** | Drift found |
| `check:schema-drift` (npm) | — | Skipped (no DATABASE_URL) |

## Full scanner stdout

```
# scan-code-drift: parsed 328 tables from schema.prisma
# scan-code-drift: scanning 833 .js files under src/
✗ 1 code↔schema drift finding(s):


## data_breaches
  UPDATE .notification_sent_at  —  apps/backend/src/services/compliance/breachService.js:314
    UPDATE data_breaches SET notification_sent_at = NOW() WHERE breach_id = $1
```

---

## Per-table findings

### `data_breaches` — 1 finding

**Classification: RENAME CANDIDATE**

The raw SQL at `apps/backend/src/services/compliance/breachService.js:314` writes to a column `notification_sent_at` that does not exist in `schema.prisma`.

The `data_breaches` model has two timestamp columns that could plausibly be the intended target:

| Schema column | Type | Notes |
|---|---|---|
| `data_subjects_notified_at` | `DateTime? @db.Timestamptz(6)` | Closest semantic match — records when data subjects were notified |
| `regulator_notified_at` | `DateTime? @db.Timestamptz(6)` | Records regulator notification (different audience) |

The code context (`breachService.js`, function that "queues breach notifications for admins") suggests `data_subjects_notified_at` is the intended column. The column was likely renamed during the GDPR compliance hardening that added the full notification-tracking fields (`data_subjects_notified_at`, `data_subject_notification_count`, `regulator_notified_at`, etc.), but the raw query in `breachService.js` was not updated to match.

**This is not a missing column — the column exists under a different name.**

**Recommended fix (do not apply automatically — human review required):**
```js
// apps/backend/src/services/compliance/breachService.js:314
// Before:
`UPDATE data_breaches SET notification_sent_at = NOW() WHERE breach_id = $1`
// After (verify intent first):
`UPDATE data_breaches SET data_subjects_notified_at = NOW() WHERE breach_id = $1`
```

Confirm against the call site and any downstream reads of `notification_sent_at` before applying.

---

## Summary

| Table | Finding type | Column in code | Column in schema |
|---|---|---|---|
| `data_breaches` | Rename candidate | `notification_sent_at` | `data_subjects_notified_at` (probable) |

**Total findings: 1**  
No real schema gaps (missing columns) detected by the static scanner.  
Schema-drift check (live DB comparison) was not run — schedule a follow-up when `DATABASE_URL` is available.
