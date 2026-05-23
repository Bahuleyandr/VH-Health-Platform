# Weekly Error-Pattern Scan — 2026-05-22

**Scan mode:** Fallback (MCP vh-mcp-postgres connector unavailable)
**Coverage window:** 2026-05-08 → 2026-05-22 (14 days, 53 commits touching `apps/backend/src/services/` and `apps/backend/src/middleware/`)
**Scan baseline:** `72a7426` (fix(backend/vitals): persist admission_id + encounter_id on staff vitals)

---

## Summary

No production error-volume data is available (MCP unavailable). Static code review of all error-handling changes in the period found **no regressions on primary clinical paths**, but surfaced three patterns that warrant tracking.

| # | Severity | Finding |
|---|---|---|
| 1 | Low | Silent catch swallowing JSONB parse failure with no log signal |
| 2 | Medium | 12 non-fatal side-effect catch blocks — silent degradation accumulates |
| 3 | Low | `42P01` schema-skip for `insurance_preauth` — migration-state hack |

---

## Finding 1 — Silent catch in lab report PDF (H6 fix)

**File:** `apps/backend/src/services/` (lab report PDF builder, PR #172)
**Code added:**
```js
if (typeof results === 'string') {
  try {
    results = JSON.parse(results);
  } catch {          // ← no (e) binding, no logger.warn
    results = null;
  }
}
```
**Context:** Guard against malformed legacy JSONB that Prisma returns as a raw string. Intentional for the legacy-data path.

**Risk:** If `results` fails to parse for a *non-legacy* reason (encoding corruption, truncation), the section silently disappears from the PDF with no log entry. The patient gets a blank Results section; no alert fires.

**Recommendation:** Add `logger.warn(\`lab report: JSON parse failed for inv=${inv.id}: ${e.message}\`)` inside the catch.

---

## Finding 2 — Accumulation of swallowed side-effect errors (17 new `logger.warn` catch blocks)

Twelve distinct non-fatal catch blocks were added across the period. Each is individually defensible (side-effect enrichment, non-blocking), but together they represent a wide surface of features that can silently degrade:

| Location | Swallowed failure | Visible impact if fires at scale |
|---|---|---|
| `admitPatient` — allergy inheritance | Patient admitted without inherited OPD allergies | Allergy alerts may not fire for admitted patients |
| `admitPatient` — advice-queue close | OPD advice-to-admit queue not closed on admission | Duplicate work queue items for OPD staff |
| `admitPatient` — preauth auto-draft | No TPA pre-auth draft auto-created | TPA team must manually create pre-auths on every admission |
| `computeGrowthPercentile` | Returns `null` | Paediatric vitals shown without percentile band |
| `getVitalsWithPercentiles` | Returns raw rows | Same as above, silently degraded for all paed patients |
| `buildClaimWarnings` — advisory | Warning layer skipped ("non-fatal by contract") | No cover-exceeded / room-cap advisories on TPA claims |
| `buildClaimWarnings` — correspondence | Cover-exceeded note not written | Correspondence log incomplete for auditors |
| `ensureClaimDocumentBundle` | Document attach failed per-doc-type | Claim packet submitted with missing attachments |
| `signOffLabResults` — in-app notification | Per-recipient insert failed | Individual patient/guardian not notified of lab results |
| `signOffLabResults` — fan-out | Entire notification batch failed | All patients for a batch not notified |
| `signOffLabResults` — order completion | Lab order stays in non-COMPLETED state | MAR / downstream order status stale |
| ANC timeline — general vitals / prior imaging | Timeline enrichment skipped | Incomplete ANC visit timeline for clinicians |

**Recommendation:** These are already at `warn` level so they appear in structured logs. Ensure the logging pipeline has an alert rule: if `logger.warn` rate for any of these keys exceeds N/hour, page on-call. Consider a Sentry `captureException` (non-fatal context) for the `signOffLabResults` fan-out and lab order completion blocks specifically — those are patient-safety-adjacent.

---

## Finding 3 — `42P01` schema-skip for `insurance_preauth`

**File:** `apps/backend/src/services/` (TPA billing, PR #183/184 area)
**Code added:**
```js
} catch (err) {
  // Under-migrated tenants: insurance_preauth missing → treat as cash.
  if (err?.meta?.code !== '42P01') throw err;
}
```
**Context:** Defensive shim allowing the platform to run on tenants whose DB hasn't received the `insurance_preauth` migration yet.

**Risk:** If a *future* migration that touches `insurance_preauth` fails to apply, this silently falls back to cash flow instead of surfacing a migration error. The shim has no expiry/removal path.

**Recommendation:** Track which tenants still need this migration. Add a startup check or migration-status endpoint so the ops team can verify `42P01` skips are expected; remove the shim once all tenants are migrated.

---

## Good signal

- 20 new `throw AppError.*` calls — all primary-path validation using the structured error type correctly.
- The one removed `throw new Error('Investigation not found')` was *upgraded* to a typed error with `statusCode = 404` and `code = 'INVESTIGATION_NOT_FOUND'`.
- 9 new bare `throw new Error(...)` are exclusively inside Jest test mocks (mock DB failures for `buildClaimWarnings` unit tests).
- No removed `AppError` calls.

---

## Next steps

| Action | Owner | Priority |
|---|---|---|
| Add `logger.warn` to silent JSONB catch in lab PDF builder | Backend | Low |
| Add alerting rules for high-frequency `logger.warn` keys above | Ops / SRE | Medium |
| Inventory tenants still needing `insurance_preauth` migration and schedule cleanup | Backend + Ops | Low |

---

*Scan generated automatically by Claude Code error-pattern workflow (fallback mode — MCP unavailable).*
