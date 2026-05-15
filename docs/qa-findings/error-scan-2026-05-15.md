# Weekly Error-Pattern Scan — 2026-05-15

**Scan window:** 14 days (2026-05-01 → 2026-05-15)  
**MCP status:** `mcp__vh-mcp-postgres__error_patterns` / `new_error_patterns` tools **unavailable** — live DB error data could not be queried.  
**Fallback mode:** Static code review of `apps/backend/src/services/` and `apps/backend/src/middleware/` diff.

---

## Summary

Code review across **104 commits** (highest volume sprint to date — Stage 4-b through Stage 5-8
plus multi-chip merge trains) covering 40 changed files in `services/` and `middleware/`.

- **1 medium-risk silent swallow** — growth percentile computation on paediatric vitals silently drops bad measurements with no log trace
- **1 low-risk design note** — session-tracking upsert failure in `claimUserSession` continues after `logger.error` (tokens remain valid; stale `user_active_sessions` rows possible)
- **1 low-risk bare `Error` pattern** — internal auth helpers use `new Error()` instead of `AppError`; programmer-invariant guards only, will surface as 500s if ever hit
- **POSITIVE:** Discharge readiness gate tightened — 3 silent catches removed (`740322d`)
- **POSITIVE:** Order-type validation expanded and improved error messages — `ecg`/`radiology`/`procedure` promoted to first-class types

No removed `AppError` calls that reduce safety (one removal confirmed as deliberate improvement).  
All Stage 4–5 new services (TPA billing, walk-in consent, obstetric ANC, paediatric, IPD orders, surgical daycare, portal channels) use `AppError` factory methods throughout.

---

## Notable Findings

### 1. Silent Drop — Growth percentile bad-measurement catch with no log (MEDIUM)

**File:** `apps/backend/src/services/clinical/growthPercentileService.js`  
**Commit:** `814ba60` — `fix(vitals): auto-compute WHO growth percentile on paediatric vitals POST`

```js
} catch (_e) {
  // A bad single measurement (negative, non-numeric) shouldn't sink
  // the other metric or the vitals save — skip it.
}
```

The intent (don't block the vitals save for one bad field) is correct. However, a malformed weight or height value — negative number, text, server-side NaN — is silently swallowed **with no log line at any level**. In a paediatric chart this could produce incomplete WHO percentiles with no paper trail, making it impossible to distinguish "measurement not taken" from "measurement submitted but silently rejected."

**Recommendation:** Add a `logger.warn` inside the catch body so the bad value and metric name are visible:
```js
} catch (_e) {
  logger.warn('growthPercentileService: skipped malformed metric', { metric, value, patientContext });
}
```

---

### 2. Low-Risk — Session-tracking upsert continues on failure (LOW)

**File:** `apps/backend/src/services/auth/userActiveSession.js`  
**Commit:** `428f258` — `fix(backend): refresh-token rotation also rotates user_active_sessions`

```js
} catch (err) {
  // If the insert fails, the new token is still valid (we generated it
  // already) — the user just won't be tracked here. Log and continue;
  // the next login will catch up.
  logger.error('claimUserSession: upsert failed', { userUid, error: err.message });
}
```

The design trade-off (token already minted; don't fail the login on a tracking write) is deliberate and logged at `error` level, which is correct. However:

- If the `user_active_sessions` upsert fails repeatedly (e.g., schema drift, connection pool exhaustion), concurrent-session enforcement **silently degrades**: the single-active-session guarantee stops holding.
- There is no alerting beyond the log line.

**Recommendation:** Add a Prometheus counter / Loki alert on `claimUserSession: upsert failed` log lines. More than a handful per hour should page oncall — it indicates the active-session table is unhealthy and single-session enforcement has stopped.

---

### 3. Low-Risk — Bare `new Error()` in internal auth-helper guards (LOW)

**File:** `apps/backend/src/services/auth/loginSessionHelper.js`, `userActiveSession.js`  
**Commit:** `428f258`

```js
if (!userUid) throw new Error('issueAccessTokenAndClaimSession: userUid is required');
if (!tokenPayload) throw new Error('issueAccessTokenAndClaimSession: tokenPayload is required');
throw new Error('claimUserSession: userUid, jti, deviceType, expiresAt are required');
```

These guard programmer-level invariants (missing required arguments at call sites that are only ever called by authenticated, internal code). They will surface as 500s to the client rather than typed `AppError` 400s. This is arguably correct — a missing `userUid` at this level is a server-side bug, not a client input error.

**Recommendation:** No change required for correctness. If the team adopts a convention of `AppError.internal()` for programmer-contract failures (to give them a distinct error code in logs), these three are candidates to migrate.

---

## Removed AppError — Confirmed Deliberate Improvements

| File | Removed message | Replacement |
|---|---|---|
| `orderEntryService.js` | `'Each medication must have medication_name, dose, route, and scheduled_time'` | Split into two more specific messages: one for `medication_name`/`drug_name` only, one for full field set; also now raised per-item with index |
| `orderEntryService.js` | `` `Invalid order_type: ${order_type}. Must be one of: ...` `` | Replaced with expanded type list (added `ecg`, `radiology`, `procedure`) and alias resolution before rejection |

Both removals tighten validation rather than loosen it.

---

## Acceptable / Intentional Soft-Catch Patterns

| Location | Pattern | Verdict |
|---|---|---|
| `dischargeService.js` — `queueDischargeSms` | `.catch((e) => logger.warn(...))` | Correct — SMS is best-effort; discharge delivery marking must not block |
| `growthPercentileService.js` — `computePercentile` | `catch (_e) { /* skip */ }` | Intent correct; **add warn log** (see Finding 1) |
| `labResultsService.js` — critical-alert outbox | `.catch((e) => logger.error(...))` | Correct — notification failure logged, result write unaffected |
| `translationService.js` — `safeJsonParse` | `} catch { return fallback; }` | Correct — JSON parse helper, fallback semantics intentional |
| `otpService.js` — health check | `} catch { return true; }` | Pre-existing; correct — health endpoint, not business logic |
| `investigation/orderService.js` — catalog lookup | `if (err?.meta?.code !== '42P01') throw err` | Correct — under-migrated tenant fallback, documented |
| `patient/medicationReminderService.js` — ANC union | `if (err?.meta?.code === '42P01') fallback` | Correct — under-migrated tenant fallback, documented |
| AI services (10 files) | `} catch { ... }` | Pre-existing pattern; AI inference failures are intentionally soft |

---

## Error-Handling Quality — Stage 4–5 New Services (this window)

All new services added in the 14-day window follow the `AppError` pattern correctly:

| Area | Services added | AppError usage |
|---|---|---|
| TPA / insurance | `clinicalJustificationTemplate.js`, `packagesService.js`, `claimsService.js` | `badRequest`, `notFound` throughout |
| Walk-in consent | `consentService.js` | `badRequest`, `notFound` |
| Obstetric ANC | Extended `maternityService.js` | `badRequest`, `notFound`, pre-eclampsia alert gate |
| Paediatric | `paediatricImmunisationService.js`, `growthPercentileService.js` | `badRequest`, `notFound` (percentile catch is the one flag above) |
| IPD orders | Extended `orderEntryService.js`, bulk-order `POST /emr/orders/bulk` | `badRequest`, `notFound`, per-item error surfacing |
| Surgical daycare / OT | `surgicalService.js`, theatre updates | `badRequest`, `notFound`, diabetic-glucose gate, WHO timeout default |
| Portal channels | `portalChannelsService.js` | `badRequest`, `notFound` |
| Auth — single session | `userActiveSession.js`, `loginSessionHelper.js` | `forbidden`, `badRequest`; see Finding 3 |
| Beds — ICU tier gate | `bedManagementService.js` | `AppError.forbidden` for tier enforcement |

No raw `res.status()` calls found in new services.

---

## Recommendations

1. **Growth percentile silent swallow (Finding 1):** Add `logger.warn` in the `catch (_e)` body in `growthPercentileService.js`. One-line change, no behaviour impact.
2. **Session-tracking alert (Finding 2):** Wire a Loki/Grafana alert on the `claimUserSession: upsert failed` log pattern. Threshold: >5 occurrences/hour → page oncall, as it means single-session enforcement has degraded.
3. **Verify `user_active_sessions` schema:** Migration `232` (referenced in commit `712e6ef`) includes changes to this table — confirm it has been applied to the production CloudNativePG cluster before the refresh-rotation code reaches prod.
4. **Next scan:** Re-run with MCP postgres connector available to get live occurrence counts and frequency spikes from the actual error log table.

---

*Generated by weekly error-pattern scan — fallback (code-review) mode. MCP postgres connector was unavailable. 104 commits reviewed across 40 files in `apps/backend/src/services/` and `apps/backend/src/middleware/`.*
