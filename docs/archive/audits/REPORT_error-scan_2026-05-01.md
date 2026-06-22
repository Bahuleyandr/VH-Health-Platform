# Weekly Error-Pattern Scan — 2026-05-01

**Scan window:** 14 days (2026-04-17 → 2026-05-01)  
**MCP tools:** Unavailable — fallback code review performed  
**Scope:** `apps/backend/src/services/` + `apps/backend/src/middleware/`  
**Commits reviewed:** 35 (all touching the scoped paths in the window)

---

## Top Findings (code-review path)

No production frequency data available (MCP unavailable). Findings below are
structural error-handling risks surfaced from the diff.

| # | File | Location | Issue | Severity |
|---|------|----------|-------|----------|
| 1 | `services/security/phiColumnEncryption.js` | L129 | Bare `catch {}` swallows ALL decryption errors — falls through to plaintext with no alert | **HIGH** |
| 2 | `services/record/recordService.js` | L31–33, L45–48 | PHI shadow-column encrypt + write failures silently `warn`-logged; no metric emitted | **MEDIUM** |
| 3 | `services/user/userService.js` | L80–83, L93–95, L105–108 | Same PHI shadow-column silent suppression pattern as recordService | **MEDIUM** |
| 4 | `middleware/idempotencyMiddleware.js` | L60–64 | Idempotency claim DB error → `fail open` + `next()` — idempotency silently disabled on any DB hiccup | **MEDIUM** |
| 5 | `middleware/idempotencyMiddleware.js` | L95–97 | Idempotency finalise DB error → response not cached — duplicate re-execution on client retry | **MEDIUM** |
| 6 | All AI tier services (Tiers A–H, 74 modules) | `safeQuery` helper | `isMissingSchemaError` returns empty fallback silently — failed migrations produce empty AI results, no error surfaced | **LOW** |

---

## NEW Error-Handling Patterns (introduced in window)

All of the following were introduced in this 14-day window and represent net-new
risk surface:

### 1. Bare `catch {}` in `readWithFallback` — PHI decryption silently falls to plaintext

**File:** `apps/backend/src/services/security/phiColumnEncryption.js:129`

```js
} catch {
  // Decryption errors should be loud upstream, but during a phased
  // cutover we don't want a single corrupt envelope to take down a
  // patient page. Fall through to the plaintext column.
  return plainValue;
}
```

The comment acknowledges the risk is temporary. However there is no metric,
no Sentry capture, and no expiry mechanism for this fallback path. If the
KMS or DEK becomes permanently broken for a subset of rows, the system will
silently serve unencrypted PHI from the legacy column indefinitely.

**Recommendation:** Emit a structured warning log with a rate-limit or a
Prometheus counter (`phi_decryption_fallback_total`). Add a scheduled audit
that alerts when the counter is non-zero in production.

---

### 2. PHI shadow-column write silently suppressed in `recordService` + `userService`

**Files:**
- `apps/backend/src/services/record/recordService.js:31–48`
- `apps/backend/src/services/user/userService.js:80–109`

Both files catch encryption/write errors and only emit `logger.warn(...)`.
The "does not exist" suppression on the column check is correct for the
migration phase, but any other failure (wrong KMS key, env var typo, KMS
service down) is also silently swallowed. If `KMS_MASTER_KEY` is set but
incorrect, shadow columns are never written and no alert fires.

**Recommendation:** Add a `phi_shadow_write_failure_total` counter. At startup,
validate that `KMS_MASTER_KEY` is parseable and matches expected length so
misconfiguration is detected before the first real write.

---

### 3. Idempotency middleware fails open on DB errors

**File:** `apps/backend/src/middleware/idempotencyMiddleware.js:60–64, 95–97`

Claim phase: any DB error (connection pool exhausted, PG down) causes the
middleware to call `next()` and bypass idempotency entirely. The warn log is
the only signal.

Finalise phase: `.catch((err) => logger.warn(...))` means a successful
operation that fails to persist its idempotency record will be re-executed
on client retry — potentially double-creating records or double-charging.

The "fail open" design is a deliberate availability choice, but there is no
circuit-breaker or alerting. A sustained DB degradation would disable
idempotency cluster-wide with only warn-level logs.

**Recommendation:**
- Emit a counter (`idempotency_claim_error_total`, `idempotency_finalise_error_total`).
- Consider a short-circuit: if the claim table is unreachable for > N seconds,
  return 503 for idempotency-keyed requests rather than silently bypassing.

---

### 4. `safeQuery` / `isMissingSchemaError` silent degrade across 74 AI modules

**Files:** All Tier A–H service files (`tierAAssistantsService.js`, `tierCAssistantsService.js`, `tierDEmergencyService.js`, `tierEPatientEngagementService.js`, `tierFInteropService.js`, `tierGPublicHealthService.js`, `tierHOperationalService.js`)

```js
} catch (err) {
  if (isMissingSchemaError(err)) return fallback;
  throw err;
}
```

If a migration fails and leaves a table missing, AI modules silently return
empty/fallback results to the caller. The calling route sees a 200 with an
empty `citations` array and no indication of degradation.

**Recommendation:** Log a structured `warn` when `isMissingSchemaError` fires
in production so ops can detect migration-incomplete states. Consider adding
a `/health/ai-modules` probe that checks for missing tables on startup.

---

## Frequency Spikes

None identified — MCP production data unavailable.

---

## Recommendations (priority order)

1. **PHI decryption counter** — add `phi_decryption_fallback_total` Prometheus
   counter to `phiColumnEncryption.readWithFallback`. Alert at > 0/min in prod.
2. **KMS startup validation** — verify `KMS_MASTER_KEY` is correctly formatted
   at app startup (fail fast rather than silent warn in every write path).
3. **Idempotency observability** — counters for claim + finalise failures.
   Consider 503-on-sustained-failure rather than fail-open.
4. **AI safeQuery observability** — structured warn log when
   `isMissingSchemaError` fires; add migration completeness probe.
5. **Schedule a follow-up scan with MCP** once the `vh-mcp-postgres` connector
   is configured — code-review can't detect runtime frequency spikes.

---

*Generated by the weekly error-pattern scan routine (MCP unavailable — code review fallback).*  
*Next scheduled scan: 2026-05-08 17:00 IST.*
