# Weekly Drift Sweep — 2026-06-29

**Run timestamp:** 2026-06-29T03:31 UTC  
**Scanner exit code:** 1 (drift detected)  
**Schema-drift check:** skipped — `DATABASE_URL` not set in CI environment  
**`npm ci` status:** partial failure — `onnxruntime-node` binary download timed out (ECONNRESET); scan ran against existing node_modules

---

## Scanner invocation

```
cd apps/backend && node scripts/scan-code-drift.mjs
```

```
# scan-code-drift: parsed 543 tables from schema.prisma
# scan-code-drift: scanning 1649 .js files under src/
✗ 5 code↔schema drift finding(s):


## doctors
  SELECT .search_vector  —  apps/backend/src/utils/search/searchService.js:78
    SELECT d.id, d.name, d.specialty AS specialization, d.qualifications AS qualification, u.phone, d.is_active, ts_rank(d.search_vector, to_tsquery('', $1)) AS rank, ts_headline('', coalesce(d.name, '') || '' || coalesce(d.specialty, ''), to_t…

## health_milestone_claims
  INSERT .expires_at__INTERP__  —  apps/backend/src/services/gamification/pointService.js:546
    INSERT INTO health_milestone_claims (user_uid, milestone_id, voucher_code, expires_at__INTERP__) VALUES ($1::uuid, $2, $3, $4__INTERP__) RETURNING id, voucher_code, claimed_at, expires_at

## health_point_ledger
  INSERT .description__INTERP__  —  apps/backend/src/services/gamification/pointService.js:29
    INSERT INTO health_point_ledger (user_uid, points, activity_type, activity_ref_id, description__INTERP__) VALUES ($1::uuid, $2, $3, $4, $5__INTERP__) RETURNING id, user_uid, points, activity_type, activity_ref_id, description, earned_at

## radiology_orders
  SELECT .patient_uid__INTERP__  —  apps/backend/src/services/radiology/pacsService.js:198
    SELECT ro.id, ro.patient_uid, ro.modality, ro.body_part, ro.clinical_indication, ro.priority, ro.created_at, u.id AS patient_db_id, u.name AS patient_name, u.birthday, u.gender, (SELECT pi.identifier_value FROM patient_identifiers pi WHERE …

## webhook_deliveries
  UPDATE .last_error  —  apps/backend/src/services/integrations/webhookDeliveryService.js:410
    UPDATE webhook_deliveries SET status = 'failed', last_error = 'reaped: stale in_flight (worker crashed mid-delivery)', next_retry_at = NOW(), updated_at = NOW() WHERE status = 'in_flight' AND started_at < NOW() - ($1::int * INTERVAL '1 minu…
```

---

## Analysis

Of the 5 reported findings, **2 are real** and **3 are scanner false positives** caused by a known limitation with suffix-interpolated template literals in column lists.

### Real findings (require action)

#### 1. `doctors.search_vector` — schema gap (missing column in schema.prisma)

| | |
|---|---|
| **File** | `apps/backend/src/utils/search/searchService.js:78` |
| **Kind** | SELECT |
| **Status** | Real schema gap |

`search_vector` is a PostgreSQL `tsvector` generated column used for full-text search in the `doctors` table (referenced via `d.search_vector @@ to_tsquery(...)` and `ts_rank(d.search_vector, ...)`). The column is absent from the `doctors` model in `prisma/schema.prisma`. It was likely added via a raw SQL migration without a subsequent `prisma db pull`.

**Fix:** Run `npx prisma db pull --schema=prisma/schema.prisma` against the QA/dev DB and verify the column appears in the `doctors` model, then commit the updated schema. Alternatively add the field manually:
```prisma
search_vector Unsupported("tsvector")?
```

---

#### 2. `webhook_deliveries.last_error` — rename candidate

| | |
|---|---|
| **File** | `apps/backend/src/services/integrations/webhookDeliveryService.js:410` |
| **Kind** | UPDATE |
| **Status** | Rename candidate |

`webhookDeliveryService.js` sets `last_error` in an UPDATE for stale in-flight delivery reaping. The `webhook_deliveries` model in `schema.prisma` declares the equivalent column as `error_message`. One of the two is wrong:

- If the real DB column is `last_error` → `schema.prisma` needs updating via `prisma db pull`
- If the real DB column is `error_message` → `webhookDeliveryService.js:410` is referencing a non-existent column; the UPDATE will silently fail at runtime (Postgres will throw `column "last_error" does not exist`)

**Needs DB access to determine which is correct.** Confirm with:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'webhook_deliveries' ORDER BY ordinal_position;
```
If `last_error` exists in DB → update schema.prisma. If only `error_message` exists → fix the service to use `error_message`.

---

### False positives (scanner limitation — no action required)

These three findings share the same root cause: the scanner's `stripInlineDollarInterp` replaces `${expr}` with `__INTERP__`, but when the template expression is appended *directly* after a column name with no intervening space, the column token becomes `colname__INTERP__` and fails the schema lookup. The underlying SQL is valid and the referenced columns exist in schema.prisma.

#### 3. `health_milestone_claims.expires_at__INTERP__` — false positive

**Root cause:** `pointService.js:546` uses:
```js
`INSERT INTO health_milestone_claims (user_uid, milestone_id, voucher_code, expires_at${tenantId ? ', tenant_id' : ''})`
```
After interpolation stripping → `expires_at__INTERP__`. Real column: `expires_at` (confirmed in `health_milestone_claims` model). No action needed.

#### 4. `health_point_ledger.description__INTERP__` — false positive

**Root cause:** `pointService.js:29` uses:
```js
`INSERT INTO health_point_ledger (user_uid, points, activity_type, activity_ref_id, description${tenantId ? ', tenant_id' : ''})`
```
After interpolation stripping → `description__INTERP__`. Real column: `description` (confirmed in `health_point_ledger` model). No action needed.

#### 5. `radiology_orders.patient_uid__INTERP__` — false positive

**Root cause:** `pacsService.js` around line 198 builds a dynamic JOIN suffix:
```js
const userTenantJoin = ` AND u.tenant_id = $${params.length}::uuid`;
// ...
`LEFT JOIN users u ON u.uid = ro.patient_uid${userTenantJoin}`
```
After interpolation stripping the JOIN condition becomes `ro.patient_uid__INTERP__`, and the SELECT analyser parses `patient_uid__INTERP__` as the column name. Real column: `patient_uid` (confirmed in `radiology_orders` model). No action needed.

---

## Recommended scanner fix

The three false positives could be suppressed by teaching the scanner to strip `__INTERP__` suffixes from tokens before schema lookup (i.e., treat `colname__INTERP__` as `colname` rather than as an unknown column). File an issue against `scripts/scan-code-drift.mjs` to add this normalisation step.

---

## Infrastructure note

`npm ci` failed with `ECONNRESET` on the `onnxruntime-node` postinstall binary download (network timeout in the CI container). The scan ran against the pre-existing `node_modules/` checkout. The result is valid — `scan-code-drift.mjs` has no native add-on dependencies; only the binary download for the ML model adapter failed. The `onnxruntime-node` download failure should be investigated separately (proxy/network config in the weekly-sweep container).

---

## Summary table

| # | Table | Column | File | Kind | Classification |
|---|---|---|---|---|---|
| 1 | `doctors` | `search_vector` | `searchService.js:78` | SELECT | **Real — schema gap** |
| 2 | `webhook_deliveries` | `last_error` | `webhookDeliveryService.js:410` | UPDATE | **Real — rename candidate** |
| 3 | `health_milestone_claims` | `expires_at` | `pointService.js:546` | INSERT | False positive (suffix interp) |
| 4 | `health_point_ledger` | `description` | `pointService.js:29` | INSERT | False positive (suffix interp) |
| 5 | `radiology_orders` | `patient_uid` | `pacsService.js:198` | SELECT | False positive (suffix interp) |
