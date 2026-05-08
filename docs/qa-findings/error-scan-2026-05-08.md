# Weekly Error-Pattern Scan — 2026-05-08

**Scan window:** 14 days (2026-04-24 → 2026-05-08)  
**MCP status:** `mcp__vh-mcp-postgres__error_patterns` / `new_error_patterns` tools **unavailable** — live DB error data could not be queried.  
**Fallback mode:** Static code review of `apps/backend/src/services/` and `apps/backend/src/middleware/` diff.  

---

## Summary

No live occurrence data available. Code review across **30 commits** covering Sprints 15–22 found:

- **1 notable regression risk** — removed stub fallbacks in notification service now surface real DB errors as 500s
- **1 low-risk silent swallow** — FCM token lookup swallowed to empty array, could silently degrade push delivery
- **4 intentional/acceptable soft-catch patterns** — WhatsApp, email, push notification, and smart-phrase analytics

No removed `AppError` calls. All new sprint services (dialysis, ICU, nursing assessments, BMW, PCPNDT, death cert) use `AppError` factory methods correctly throughout.

---

## Notable Findings

### 1. Regression Risk — Notification service fallbacks removed (MEDIUM)

**Files:** `apps/backend/src/services/adminNotificationService.js`  
**Commits:** `f47ce6e`, `cb64b7b` range

Three `catch` blocks that previously returned hardcoded mock data have been replaced with `throw error`:

| Method | Old behaviour | New behaviour |
|---|---|---|
| `getTemplates()` | Returned `DEFAULT_TEMPLATES` array on any DB error | Re-throws — callers get a 500 |
| `getDeliveryStats()` | Returned mock statistics object on any DB error | Re-throws — callers get a 500 |
| `createTemplate()` | Returned a fake template object with random `id` on DB error | Re-throws — callers get a 500 |

**Why it matters:** If `notification_templates` or `notification_delivery_log` tables are missing or have schema drift in production, these endpoints will now return 500s where they previously appeared to work. The admin portal notification UI will break visibly.

**Recommendation:** Verify the migration for both tables has been applied to the production CloudNativePG cluster before this reaches `main`. Check ArgoCD sync status for the relevant migration files.

---

### 2. Low-Risk Silent Swallow — FCM token lookup degraded to empty array

**File:** `apps/backend/src/services/patientPortalService.js` (~line 8517 in diff)

```js
} catch (err) {
  logger.warn('fcmTokensForPatient failed', { error: err.message });
  return [];
}
```

If the `user_devices` table is inaccessible (schema drift, RLS issue, connection pool exhaustion), the function returns `[]` silently. Push notifications will be silently dropped for all patients with no caller-visible error.

**Recommendation:** Add a Prometheus/Grafana alert on repeated `fcmTokensForPatient failed` log lines to catch silent degradation.

---

## Acceptable / Intentional Patterns

These were reviewed and found to be correct soft-failure patterns:

| Location | Pattern | Verdict |
|---|---|---|
| `billingPaymentLinkService.js` — WhatsApp send | `catch (e) { logger.warn(...) }` | Correct — side-channel delivery, core payment flow unaffected |
| `billingPaymentLinkService.js` — email send | `catch (e) { logger.warn(...) }` | Correct — same as above |
| `patientPortalService.js` — patient message FCM push | `.catch((err) => logger.warn(...))` | Correct — push is best-effort, message persisted |
| `smartPhraseService.js` — `use_count` bump | `.catch(() => {})` fire-and-forget | Correct — non-critical analytics, intentional |

---

## Error-Handling Quality — Sprint 15–22 New Services

All new services added in this window follow the `AppError` pattern correctly:

| Service | AppError usage |
|---|---|
| Dialysis (HD/CRRT/PD) | `badRequest`, `notFound`, `invalidTransition` throughout |
| ICU flowsheet / ABCDEF bundle | `badRequest`, `notFound` throughout |
| Nursing assessments (NEWS2, Braden, Morse, sepsis) | `badRequest`, `notFound` throughout |
| BMW register / drug controller returns | `badRequest`, `notFound`, `invalidTransition` |
| PCPNDT Form F / USG register | `badRequest`, `notFound` throughout |
| Death certification (MCCD Form 4) | `badRequest`, `notFound`, `invalidTransition`, `badRequest` cert guards |
| PM-JAY / Ayushman Bharat | `badRequest`, `notFound`, `invalidTransition` |
| Microbiology C&S | `badRequest`, `notFound`, `invalidTransition` |
| Newborn immunisations | `badRequest`, `notFound` throughout |

No raw `res.status()` calls found in new services. No removed `AppError` calls detected in the diff.

---

## Recommendations

1. **Before merging to main:** Confirm `notification_templates` and `notification_delivery_log` migration files exist and have been applied. Search: `grep -r "notification_templates\|notification_delivery_log" apps/backend/src/migrations/`.
2. **Alerting:** Add a log-based alert (Loki/Grafana) on `fcmTokensForPatient failed` warn lines to detect silent push degradation early.
3. **Next scan:** Re-run with MCP tools available to get live occurrence data and frequency spikes from the actual DB error log.

---

*Generated by weekly error-pattern scan — fallback (code-review) mode. MCP postgres connector was unavailable.*
