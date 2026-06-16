# NEWS2 Deterioration Early Warning (v1) — Design

- **Date:** 2026-06-16
- **Status:** Approved (design); implementation pending
- **Branch:** `feat/news2-early-warning` (off `main`)
- **Module:** `deterioration_early_warning` (EXISTS, `enabled:false` — currently an empty shell)
- **Surface:** Clinical decision support (clinician-facing). Deterministic — **no LLM** in v1.

## 1. Context

The HL7 **CDS-Hooks pipeline is already fully built** (`cdsHooksRoutes.js`, `cdsHooksAdapter.js`, `services/emr/cdsEngine.js`, `services/cds/encounterCdsHelper.js`): a `GET /cds-services` discovery, 6 wired hooks (patient-view, medication-prescribe, order-select/-sign, encounter-start/-discharge), a CDS-Hooks-v1.0 card shape, the `cds_alerts` table (persist/acknowledge/retrieve, tenant-scoped via `persistCdsAlert`), and live rules (drug interactions, allergies, duplicate orders, critical labs, protocol reminders). **What's missing:** the dormant AI decision-support modules aren't wired into it, and the `deterioration_early_warning` module is registered but has **no actual NEWS2 implementation**.

v1 fills that gap with the standard, published **NEWS2** score, computed deterministically and surfaced through the existing card pipeline. NEWS2 is a fixed algorithm → no model needed; the module's described AI "trend + recent-lab composite" augmentation is layered **last** (v2).

Existing substrate to reuse:
- `vitalSignMonitor.checkVitalAnomalies(patientId, vitals, ctx)` (`:159`) runs on every vitals recording (called from `vitalsChartService.js:661`); `resolvePatientContext` (private — **export it**) classifies adult/paediatric/pregnant.
- `cdsEngine.persistCdsAlert({ patientUid, encounterId, alertType, severity, title, description, sourceData })` (`:89`, private — **export it**) — resolves the patient's tenant + stamps `tenant_id` (fail-safe skip on null). The canonical tenant-correct `cds_alerts` writer.
- `cdsEngine.getActiveAlerts(patientUid)` (`:1002`) feeds `patient-view`; `encounterCdsHelper.buildEncounterStartAlerts` feeds `encounter-start`.

## 2. Goals / non-goals

**Goals (v1):**
- A pure `computeNews2(obs, { scale2 })` implementing the published NEWS2 table → `{ score, band, params, anyParamThree, monitoring, response }`.
- Compute NEWS2 on each adult inpatient vitals recording; when the band warrants, persist a `cds_alert` (via `persistCdsAlert`) so it surfaces on `patient-view` / `encounter-start` — acknowledgeable + audited, **reusing the existing pipeline** (no new hook, no new card shape, no new table).
- **Escalation-only de-dup** so repeated observations don't spam alerts.
- **Adult-only** (NEWS2 isn't validated for pregnancy/paediatrics).
- Gate on the `deterioration_early_warning` module being enabled (tenant 3-layer); **disabled by default**.

**Non-goals (v1):**
- AI "trend + recent-lab composite" augmentation (the module's eventual richer score) — v2; deterministic NEWS2 only here.
- NEWS2 Scale 2 default-on (supported via an explicit `scale2` flag, default Scale 1 — Scale 2 needs a hypercapnic-risk clinical flag not in the vitals payload).
- A new CDS hook, card schema, route, or migration (all reused).
- Paediatric (PEWS) / obstetric (MEOWS) early-warning scores.
- Patient-facing surface.

## 3. Locked decisions
1. **Deterministic NEWS2** (published algorithm); AI composite is v2.
2. **Compute-on-vitals**, persist via `persistCdsAlert`, surface through the existing `getActiveAlerts`/`encounter-start` pipeline.
3. **Escalation-only de-dup** (raise on first crossing or band increase; not every obs).
4. **Adult-only**; skip paediatric/pregnant (no NEWS2 alert).
5. Reuse `persistCdsAlert` + `resolvePatientContext` (export both); no bare inserts.

## 4. NEWS2 scoring (the deterministic core)

`computeNews2({ respiratory_rate, oxygen_saturation, on_oxygen, temperature, systolic_bp, heart_rate, consciousness }, { scale2 = false })`. Missing params are scored as not-contributing (and listed in `params` as `null`); `consciousness` defaults to `Alert`, `on_oxygen` to `false` (room air) when absent.

**Scale 1 table (points):**
- **Respiration rate** /min: ≤8 → 3; 9–11 → 1; 12–20 → 0; 21–24 → 2; ≥25 → 3
- **SpO2 (Scale 1)** %: ≥96 → 0; 94–95 → 1; 92–93 → 2; ≤91 → 3
- **Air or oxygen**: room air → 0; on supplemental O2 → 2
- **Temperature** °C: ≤35.0 → 3; 35.1–36.0 → 1; 36.1–38.0 → 0; 38.1–39.0 → 1; ≥39.1 → 2
- **Systolic BP** mmHg: ≤90 → 3; 91–100 → 2; 101–110 → 1; 111–219 → 0; ≥220 → 3
- **Heart rate** /min: ≤40 → 3; 41–50 → 1; 51–90 → 0; 91–110 → 1; 111–130 → 2; ≥131 → 3
- **Consciousness (ACVPU)**: Alert → 0; new Confusion / Voice / Pain / Unresponsive → 3

(Temperature normalized to °C first, reusing `normalizeTemperatureC` honoring `temperature_unit`. Scale 2 table — for documented hypercapnic patients — implemented behind the `scale2` flag per the published Scale-2 values.)

**Aggregate → band + clinical response:**
- `0` → **low** (routine; min 12-hourly)
- `1–4` → **low** (4–6-hourly; ward-nurse assessment)
- any single parameter = 3 → **low-medium** (urgent review by the ward doctor) — `anyParamThree`
- `5–6` → **medium** (urgent; registered nurse escalates to medical team; hourly)
- `≥7` → **high** (emergency; continuous monitoring; critical-care escalation)

Indicator mapping for the card: `low` → `info`, `low-medium`/`medium` → `warning`, `high` → `critical`.

## 5. Architecture & flow

```
vitals recorded (vitalsChartService.js ~:661, after checkVitalAnomalies)
  → deteriorationEarlyWarningService.evaluateNews2OnVitals({ patientId, encounterId, vitals, recordedBy })
 1. module-enabled gate (deterioration_early_warning, tenant 3-layer) → if disabled, return (no-op)
 2. resolvePatientContext(patientId) → if paediatric OR pregnant → return (NEWS2 not applicable)
 3. map the vitals payload → computeNews2 inputs (RR, SpO2, on_oxygen, temp(+unit), SBP, HR, consciousness)
 4. const news2 = computeNews2(obs)
 5. if band is 'low' (score 0–4 AND not anyParamThree) → do NOT raise (routine); still return the score
 6. de-dup: read the latest unacknowledged NEWS2 cds_alert for this encounter; raise ONLY if none exists
    or the new band is HIGHER than the standing one (escalation). Equal/lower band → skip (no spam).
 7. persistCdsAlert({ patientUid, encounterId, alertType:'NEWS2_DETERIORATION', severity:<mapped>,
      title:`NEWS2 ${score} — ${band}`, description:<response text>, sourceData:{ score, band, params, monitoring } })
  → surfaces automatically via getActiveAlerts (patient-view) + buildEncounterStartAlerts (encounter-start)
```

`evaluateNews2OnVitals` is **best-effort** at the call site (its own try/catch in the caller; a NEWS2 failure must never block the vitals write — same posture as the existing cds_alerts mirror).

## 6. Components (files)

**New:**
- `apps/backend/src/services/cds/news2Service.js` — pure `computeNews2(obs, opts)` + helpers (`scoreRespRate`, `scoreSpo2`, …, `bandForScore`). No I/O. `__testing__` exports the per-param scorers.
- `apps/backend/src/services/cds/deteriorationEarlyWarningService.js` — `evaluateNews2OnVitals({ patientId, encounterId, vitals, recordedBy })`: module gate, adult-only check, vitals→obs mapping, `computeNews2`, escalation-only de-dup, `persistCdsAlert`. Returns `{ score, band, raised:boolean, skippedReason? }`.
- Tests: `news2Service.test.js` (unit — the table), `deteriorationEarlyWarning.deep.test.js` (real-PG — gate + persist + de-dup + surface via getActiveAlerts).

**Changed:**
- `services/emr/cdsEngine.js` — `export` `persistCdsAlert` (was private).
- `utils/clinical/vitalSignMonitor.js` — `export` `resolvePatientContext` (was private) + add to the default export.
- `services/emr/vitalsChartService.js` (~:661) — after `checkVitalAnomalies`, call `evaluateNews2OnVitals(...)` in a best-effort try/catch (lazy `await import(...)` to avoid an eager import-graph change — same gotcha that bit prior features).
- `services/ai/clinicalAiModuleService.js` — extend the `deterioration_early_warning` `settings.outputSchema` if needed so `{ score, band, contributors }` matches what we emit (keep `enabled:false`).

**No new migration** — reuses `cds_alerts` + the vitals tables.

## 7. Gating, scope, honesty
- `deterioration_early_warning` stays `enabled:false`; runs only when enabled for the tenant. Tenant-correct writes via `persistCdsAlert` (resolves + stamps `tenant_id`).
- **Adult-only**: paediatric/pregnant patients get no NEWS2 alert (NEWS2 isn't validated for them; PEWS/MEOWS are separate, out of scope).
- **Honesty:** NEWS2 is a **screening/escalation aid, not a diagnosis**; the card shows the per-parameter contributors for transparency. Deterministic — committed config unaffected (no model).

## 8. Error handling
- `evaluateNews2OnVitals` never throws to the vitals-recording caller (best-effort try/catch at the call site; internal errors logged, vitals write unaffected).
- Missing/partial vitals → `computeNews2` scores only present params (a partial NEWS2 is still clinically used); `sourceData.params` records which were absent.
- `persistCdsAlert` already fail-safes on an unresolved tenant (skips the write) — inherited.
- Module-disabled or non-adult → clean no-op return (not an error).

## 9. Test plan (TDD)
- **Unit (`computeNews2`):** each parameter's points at every boundary (e.g. RR 8/9/12/20/21/24/25; SpO2 91/92/94/96; HR 40/41/50/51/90/91/110/111/130/131; SBP 90/91/100/110/111/219/220; temp 35/35.1/36/36.1/38/38.1/39/39.1; on_oxygen; consciousness non-Alert=3); aggregate; band thresholds (0/4/5/6/7); `anyParamThree` → low-medium even at low aggregate; temperature unit normalization; missing-param handling; Scale 2 behind the flag.
- **Integration (real PG):** enable the module for a tenant; seed an adult patient + admission; call `evaluateNews2OnVitals` with a deteriorating set (e.g. RR 26, SpO2 90 on O2, HR 130) → a `cds_alert` (`NEWS2_DETERIORATION`) persists at band ≥ medium, tenant-stamped, and appears in `getActiveAlerts`; a normal set → no alert; a second equal-band obs → **no** second alert (de-dup), a higher-band obs → escalation alert; a paediatric/pregnant patient → no alert; module disabled → no alert.
- **Gates:** `npm run test:ci` (all chunks), `npm run lint`, local gitleaks/semgrep. No Ollama smoke (deterministic, no model).

## 10. Code-grounded anchors
- Trigger + vitals shape: `vitalsChartService.js:661` (`checkVitalAnomalies(patientUser.id, vitalsForCheck, …)`); vitals keys (`systolic_bp`, `temperature`(+`temperature_unit`), `oxygen_saturation`, `respiratory_rate`, `heart_rate`) per `vitalSignMonitor.js` ranges — confirm `consciousness`/`on_oxygen` columns at implementation (read-first; default Alert/room-air if absent).
- Persistence: `cdsEngine.js:89` `persistCdsAlert` (export it), `:1002` `getActiveAlerts`; existing cds_alerts mirror precedent `vitalSignMonitor.js:308-331`.
- Patient context: `vitalSignMonitor.js` `resolvePatientContext` (export it) + `normalizeTemperatureC`.
- Surfacing: `services/cds/encounterCdsHelper.js` `buildEncounterStartAlerts`.
- Module: `clinicalAiModuleService.js` `deterioration_early_warning` (`outputSchema.required: ['score','band','contributors']`).

## 11. Future (v2+)
- AI "trend + recent-lab composite" augmentation (the module's full vision): vitals-trend slope + recent abnormal labs layered on top of the deterministic NEWS2, only ever *raising* concern — wired behind the model, enabled last.
- Recompute-on-patient-view (fresh score in the hook) in addition to compute-on-vitals.
- Acknowledgement-aware re-raise policy (re-alert if a high score persists past a monitoring interval).
- PEWS (paediatric) / MEOWS (obstetric) sibling scores.
