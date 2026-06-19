# Weekly Error-Pattern Scan — 2026-06-19

**Scan date:** 2026-06-19  
**Window:** 14 days (2026-06-05 → 2026-06-19)  
**Path:** Fallback — MCP `vh-mcp-postgres` tools unavailable; code review of `apps/backend/src/services/` and `apps/backend/src/middleware/`  
**Commits reviewed:** 25 commits touching services/middleware  
**New service files added this window:** 362

---

## Summary

No production error-rate data available (MCP unreachable). Code review surfaces **3 findings** worth tracking: two patterns that could silently suppress recurring failures in critical paths, and one that produces unstructured 500s for a class of AI STT errors.

---

## Findings

### FINDING-1 — ops-alerts sweep failures silently degrade at WARN level (medium risk)

**File:** `apps/backend/src/services/operationalAlertService.js`  
**Commit:** `4de62df` — "refactor(ops-alerts): fault-isolate sweep write/notify pass"

The `runSweep` loop fault-isolates each evaluator so one failing DB write doesn't abort the whole sweep. Good pattern. However, a persistently-failing evaluator (e.g., schema mismatch, missing table) emits only `logger.warn` — never `logger.error`. If evaluators 7a/7b (forecast-bridge evaluators added same day) consistently fail their DB queries, operational alerts for bed-forecasts, pharmacy-forecasts, staff-burnout, etc. silently stop populating with no error-level signal.

```js
} catch (err) {
  logger.warn('operational alert write/notify pass failed', { module_key, error: err?.message });
}
```

**Recommendation:** Promote to `logger.error` after N consecutive failures per evaluator, or add a sweep health metric (evaluators_failed_count) to the existing Prometheus instrumentation so alert thresholds can catch persistent degradation.

---

### FINDING-2 — results-inbox "best-effort" bridges could silently drop critical lab results (medium risk)

**Files:** `apps/backend/src/services/resultsInboxService.js`  
**Commits:** `fbd8721` — "feat(results-inbox): wire abnormal_result_triage + lab_autoverification_delta"

`promoteAbnormalTriageResult` and `promoteLabAutoverification` are explicitly designed to never throw — failures emit `logger.warn` and return silently. This is intentional (best-effort bridge, doesn't block the primary `updateReview`/`decideLabAutoverification` response). However, if the `tasks` table has a schema change or the `enqueueCriticalResultTask` path breaks (e.g., partial unique index change from migration 312), critical lab results would silently stop routing to the results inbox — with no caller-visible error and only a `logger.warn` trace.

**Recommendation:** Add a periodic reconciliation check or a dead-letter counter metric: if `promoteAbnormalTriageResult` has logged warn N times in a row without a successful enqueue, surface a `logger.error` or operational alert.

---

### FINDING-3 — AI STT provider errors throw raw `Error`, not `AppError` (low risk)

**File:** `apps/backend/src/services/ai/ambientDocumentationService.js` (and related ambient/diarization services)  
**Commit:** `7bda17a` + earlier ambient service additions

Several AI service functions throw raw `new Error(...)` for external-provider failures:
```js
throw new Error(`local_whisper returned ${response.status}`);
throw new Error('openai_stt_key_missing');
throw new Error(`openai_stt_status_${response.status}`);
```

These propagate as unstructured 500s to the client (generic "Internal Server Error") rather than an `AppError` with a machine-readable code. Not a blocking issue (the global error handler catches them), but makes monitoring and client-side error handling harder.

**Recommendation:** Wrap provider-level failures in `AppError.internal('STT provider error', 'STT_PROVIDER_FAILED')` or an ambient-specific error code so they're distinguishable in logs and client responses.

---

## Patterns reviewed and cleared

| Pattern | Verdict |
|---|---|
| `catch { }` in `fhirPatientContext.js` / `cdsPatientContext.js` | Intentional + documented — best-effort PHI bridge, must never 403 on extraction failure |
| `catch { module = { enabled: false }; }` in ops-alert evaluator gate | Intentional fail-closed (disabled = safe) |
| `catch { return fallback; }` in JSON parse helpers | Benign — utility functions returning safe defaults |
| ABDM consent-scope clamping uses `AppError.forbidden` | Correct — structured, logged, client-visible |
| Ops-alerts per-evaluator fault isolation | Sound pattern — only WARN level logging is the concern (FINDING-1) |
| `return next(new Error(...))` in tenant middleware | Passed to global error handler, renders as 500 — acceptable for infra-level failures |

---

## Recent commits reviewed (services + middleware, last 14 days)

| Commit | Subject |
|---|---|
| `459fa18` | feat(revenue-cycle): revenueCycleTrackerService + deep test green |
| `1a763a5` | feat(quality): M&M/RCA standing queue from incidents + readmissions |
| `7bda17a` | feat(ambient): allow recording_consent issuance + audio-retention janitor |
| `fbd8721` | feat(results-inbox): wire abnormal_result_triage + lab_autoverification_delta |
| `63d8bb1` | fix(ops-alerts): correct notificationOutbox contract + tenant caveats |
| `c5764df` | feat(ops-alerts): wire 8 remaining forecast-bridge evaluators (7b) |
| `5913069` | feat(ops-alerts): wire no-show, inventory-bridge, ot-overrun, acuity-staffing evaluators |
| `4de62df` | refactor(ops-alerts): fault-isolate sweep write/notify pass |
| `9ac96ec` | feat(ops-alerts): operationalAlertService reconcile + runSweep + list/decide |
| `fd5e6ad` | feat(ops-alerts): AlertCandidate contract + evaluator registry skeleton |
| `283d638` | fix(security): keep CDS Hooks + clinical-document mounts hard-enforcing |
| `d05c196` | fix(security): bring CDS Hooks + clinical-document PHI mounts to ABAC parity |
| `1a4ee40` | fix(backend): bring FHIR R4 under the patient care-team ABAC guard |
| `0792eac` | fix(backend): clamp ABDM data request to the granted consent scope |
| `00c4ecb` | fix(backend): clinical-plane EHR-query patient guard + tenant-scoped loads |
| `f849ee0` | fix(backend): virtual-ward check-in staff IDOR |
| `91d2c79` | fix(backend): verify caller-asserted patient binding on the report explainer |
| `c2d9ddc` | fix(backend): reject clinical note bound to a mismatched appointment patient |
| `6304ac5` | fix(security): clinical-AI IDOR guards + idempotency keys + voice pinning |
| `1d742ce` | fix(security): batch of verified quick-win remediations (audit triage) |
| `5e889e0` | feat(emr): clinical-notes autosave backend — note_drafts store + routes |
| `9288e43` | feat(clinical-ai): close the enablement-plan C1/C2/C3 caveats |
| `f159b04` | fix(security): exempt non-staff actors from the staff phone-mode device gate |
| `62da85e` | feat(cds): surface high/critical post-op complications to CDS dashboard |
| `8ce0f36` | docs(ai): regenerate inventory — CDS surfacing now 11/99 |

---

## Recommendations (priority order)

1. **Restore MCP connectivity** — `vh-mcp-postgres` was unreachable this run. Without it, frequency spikes (>50 occurrences of a given error pattern) and new regressions go undetected. Check connector health before next scan.
2. **FINDING-1** — Add `logger.error` or a Prometheus counter for ops-alert evaluator failures so persistent sweep degradation surfaces above warn level.
3. **FINDING-2** — Add a dead-letter metric or reconciliation check for the results-inbox bridge so silently-dropped critical lab results can be detected.
4. **FINDING-3** — Normalise AI STT provider throws to `AppError.internal` with structured error codes.
