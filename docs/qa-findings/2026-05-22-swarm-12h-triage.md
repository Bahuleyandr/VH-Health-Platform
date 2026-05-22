# Swarm 12h run — deduped fix-list (2026-05-22) — ✅ COMPLETE

Source: autonomous QA swarm (codex, tuned ×3), ~12h run against main `cf49fa83`
(i.e. **after** the 12 fixes shipped 2026-05-21, PRs #149–#160). 213 open
critical/high findings collapsed to ~18 distinct issues (~12:1).

**Outcome: all 18 clusters resolved.** Each was verified against current `main`
first (several were already-fixed or harness false-negatives), then fixed
minimally with a deep regression test, eslint + `lint:raw-params` clean, and
merged behind green CI (`lint-and-test` + smokes + fhir-conformance). PRs
#162–#178.

## Harness noise — NOT product bugs (swarm-config, no platform change)
- [x] **Driver verifies against the wrong DB** (~25 files) — driver checks `:5433/vhhealth_test`, backend writes `vhhealth-postgres/vhhealth`; reports "0 rows" for rows that exist. Repr `2026-05-21-inpatient-admission-receptionist-39192cb0`. → swarm-harness config; documented, not a platform fix.
- [x] **Patient/guardian login unavailable** (~15) — `/auth/dev/patient-login` 401 + Firebase degraded → patient-app surface unverified. Repr `2026-05-22-walk-in-opd-patient-e1632f80`. → harness/env (the dev-login route is gated by `ENABLE_DEV_AUTH` + non-prod, by design).

## CRITICAL — clinical safety / security
- [x] **C1 → PR #162.** WHO time-out rejects completion on a documented site/side mismatch (`SURGICAL_SITE_SIDE_MISMATCH`) unless an explicit clinical override — closes the wrong-site→incision path.
- [x] **C2 → already-fixed (verified).** The walk-in `doctor_id` guard (`appointmentWorkflowController.js`) already rejects any id not resolving to an active DOCTOR (`INVALID_DOCTOR_ID`). Deploy-lag/harness false-negative. No change needed.
- [x] **C3 → PR #163.** Final discharge now requires a finalized `billing_invoices` row; removed the dead-code `if (!billing_closed_at)` bypass that `markForDischarge` always tripped.
- [x] **C4 → PR #177.** Walk-in inserts (users/appointments/emergency_visits) bind to the **authenticated** `req.user.tenant_id`, never the untrusted `x-tenant-id` header (also fixed a `tenantId` camelCase bug). Latent multi-tenant correctness; no active leak today (single-tenant).

## HIGH
- [x] **H1 → PR #164.** Investigations + ward-indent lists scope to `patient_uid`/`admission_id` (fail-closed); PATIENT role not widened.
- [x] **H2 → PR #165.** Note-create/sign + appointment-complete enforce assigned-doctor (or supervisor) ownership via a shared helper.
- [x] **H3 → PR #178.** Legacy phone-only `/auth/login` + `/auth/register` (an OTP-less JWT mint) disabled in production (`PHONE_AUTH_DISABLED`).
- [x] **H4 → PR #166.** Pharmacy: quantity derived from frequency×duration (no silent 1), dispense-qty mismatch requires acknowledgement, tablet/solid never gets liquid measuring instructions. (IV→oral map deferred — different flow.)
- [x] **H5 → PR #168.** Pediatric liquid dose derived weight-first (`mg/kg×wt÷conc`), not the concentration's mL denominator; `child_weight_kg` resolved from recorded weight.
- [x] **H6 → PR #173.** Lab report PDF `::int` cast (was `42883`→500) + merges finalized `lab_results` into the PDF and the detail read.
- [x] **H7 → PR #169.** ANC timeline surfaces prior obstetric imaging (anomaly USG) so a prior scan is visible. (Empty-visits was a harness false-empty.)
- [x] **H8 → PR #174.** Final cashless claim rejected if anchored to an interim invoice when a larger live final invoice exists for the admission (`CLAIM_INVOICE_NOT_FINAL`); #154's `claimed ≤ billed` preserved.
- [x] **H9 → PR #170.** Doctor queue maps all triage scales (esi/ats/ctas/manchester) → unified acuity rank; emergent (rank 1-2) sorts ahead of routine tokens.
- [x] **H10 → PR #167.** `normalizeRoute` canonicalizes compound routes ("PO chewed" → oral) so a STAT order materializes a chartable MAR row instead of being silently dropped.
- [x] **H11 → PR #171.** `recordVitals` evaluates the **normalized Celsius** temperature for alerts (was raw F vs C threshold → false CRITICAL); added `normalizeTemperatureC`.
- [x] **H12 → PR #172.** Admit closes the advice loop (Phase 1.5) — clears the originating appointment's `advised_for_admission_*` so the patient leaves the advice queue. No migration (reused columns).
- [x] **H13 → PR #176.** Discharge-summary sign-gate (`DISCHARGE_SUMMARY_INCOMPLETE` on blank/placeholder required sections) + discontinued/parenteral meds excluded from the takeaway list. (Patient-surface materialization deferred.)
- [x] **H14 → PR #175.** Growth percentile recomputed on read (anchored on `recorded_at`) so it persists on read-back. No migration.

## Deferred (documented in the PRs, not regressions)
- H13(c): signed EMR summaries materialized to the patient read surface (larger read-model wiring).
- Prescription-PDF temperature label hardcodes `°F` (`prescriptionPdfHelper.js`) — separate snapshot path (flagged in #171).
- Claim "claimed > sanctioned cover" + room-cap (from #154) — needs enhancement-aware cover logic + a reject-vs-warn product decision.
- Broader tenant-RLS *enforcement* posture (`AUTH_ENFORCE_TENANT_RLS` / bootstrap-superuser BYPASSRLS) — tracked separately (#137); the test-env superuser bypasses RLS by design.

## Status log
- 2026-05-22: all 18 clusters resolved (PRs #162–#178 merged; C2 verified already-fixed). Swarm paused on dalekdefender; QA Postgres watchdog installed (auto-restart on the `0xC0000142` crash class).
