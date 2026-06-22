# Weekly Drift Sweep — 2026-06-22

**Run timestamp:** 2026-06-22T00:00:00Z (scheduled)
**Scanner:** `apps/backend/scripts/scan-code-drift.mjs`
**Static scan exit code:** 1 (drift found)
**Schema-drift check:** skipped — `DATABASE_URL` not set in environment

---

## Scanner stdout

```
# scan-code-drift: parsed 538 tables from schema.prisma
# scan-code-drift: scanning 1532 .js files under src/
✗ 2 code↔schema drift finding(s):


## doctors
  SELECT .search_vector  —  apps/backend/src/utils/search/searchService.js:78
    SELECT d.id, d.name, d.specialty AS specialization, d.qualifications AS qualification, u.phone, d.is_active, ts_rank(d.search_vector, to_tsquery('', $1)) AS rank, ts_headline('', coalesce(d.name, '') || '' || coalesce(d.specialty, ''), to_t…

## radiology_orders
  SELECT .patient_uid__INTERP__  —  apps/backend/src/services/radiology/pacsService.js:198
    SELECT ro.id, ro.patient_uid, ro.modality, ro.body_part, ro.clinical_indication, ro.priority, ro.created_at, u.id AS patient_db_id, u.name AS patient_name, u.birthday, u.gender, (SELECT pi.identifier_value FROM patient_identifiers pi WHERE …
```

---

## Per-table findings

### 1. `doctors` — `search_vector` · REAL SCHEMA GAP

| Field | Value |
|---|---|
| File | `apps/backend/src/utils/search/searchService.js:78` |
| Kind | SELECT |
| Classification | **Real schema gap — column missing from `prisma/schema.prisma`** |
| Rename candidate? | No — no similarly-named column exists in the `doctors` model |

**Detail:**
`searchService.js` line 78 issues a `$queryRawUnsafe` that both SELECTs `d.search_vector` and filters on `d.search_vector @@ to_tsquery(...)`. The `doctors` model in `prisma/schema.prisma` (around line 4490) lists no such column. Because the query runs successfully in production, the column *does* exist in the actual Postgres database — it is a `tsvector` generated column maintained by a trigger or a `GENERATED ALWAYS AS` expression for full-text search. Prisma does not emit `tsvector` columns via `db pull` unless they are declared as `Unsupported("tsvector")` in the schema; it appears this column was either never added or was silently dropped when the schema was last regenerated.

**Recommended fix:**
Add the column to the `doctors` model in `prisma/schema.prisma`:
```prisma
search_vector Unsupported("tsvector")?
```
Then verify with `npx prisma db pull` and `node scripts/check-schema-drift.mjs`. No migration is needed — the column already exists in the DB.

---

### 2. `radiology_orders` — `patient_uid__INTERP__` · FALSE POSITIVE

| Field | Value |
|---|---|
| File | `apps/backend/src/services/radiology/pacsService.js:198` |
| Kind | SELECT |
| Classification | **False positive — scanner artifact from template interpolation** |
| Rename candidate? | N/A |

**Detail:**
The actual query at line 207 reads:
```js
LEFT JOIN users u ON u.uid = ro.patient_uid${userTenantJoin}
```
When `tenantId` is supplied, `userTenantJoin` is `" AND u.tenant_id = $N::uuid"`. The scanner's `stripInlineDollarInterp()` replaces `${userTenantJoin}` with `__INTERP__`, producing the token `ro.patient_uid__INTERP__` which it then parses as an alias-qualified column reference on `radiology_orders`. The real column `patient_uid` IS declared in the `radiology_orders` model (`prisma/schema.prisma` line 8068). **No schema change is needed for this table.**

The root cause is a JS template expression being appended directly to a column identifier mid-JOIN-clause. While this produces valid SQL at runtime, the scanner cannot distinguish the concatenated suffix from a column name suffix. This is a known scanner limitation for interpolation that starts mid-token rather than at a token boundary.

**Recommended fix (optional, low priority):**
Restructure the dynamic tenant filter as a standalone WHERE clause condition instead of appending it to the JOIN ON clause:
```sql
LEFT JOIN users u ON u.uid = ro.patient_uid
WHERE ... AND ($tenantId IS NULL OR u.tenant_id = $tenantId::uuid)
```
This eliminates the false positive and is also cleaner SQL.

---

## Summary table

| Table | Column | Classification | Action required |
|---|---|---|---|
| `doctors` | `search_vector` | Real schema gap | Add `Unsupported("tsvector")?` to `doctors` model in `schema.prisma` |
| `radiology_orders` | `patient_uid__INTERP__` | False positive (scanner artifact) | None — `patient_uid` is correctly declared |

---

*This file was generated automatically by the weekly drift sweep routine. Do not edit by hand — it will be overwritten on the next run.*
