# NEWS2 Deterioration → CDS Surfacing (v1) — Design

- **Date:** 2026-06-16
- **Status:** Approved (design); implementation pending
- **Branch:** `feat/news2-early-warning` (off `main`)
- **Module:** `deterioration_early_warning` (EXISTS, `enabled:false`)
- **Surface:** Clinical decision support (clinician-facing). Deterministic — **no LLM**.

> **Scope correction (grounded 2026-06-16):** an initial exploration claimed NEWS2 was unimplemented. Reading the code disproved that — **NEWS2 already exists and is wired.** `services/clinical/news2Service.js` has the full `calculateNEWS2(vitals)` (Scale 1 + Scale 2, all six params + ACVPU + supplemental O₂), `getClinicalRisk(score)`, and `recordNEWS2(patientUid, vitals, recordedBy)` which persists a `news2_scores` row + queues a `NEWS2_ALERT` notification for score ≥ 5, **already called** from `vitalsChartService.js:624` on every qualifying vitals set. This spec therefore does **NOT** rebuild NEWS2; it adds the two genuinely-missing pieces below.

## 1. Context & the real gap

The HL7 **CDS-Hooks pipeline is fully built** (`cdsEngine.js`, `cdsHooksAdapter.js`, `encounterCdsHelper.js`): `cds_alerts` (persist/acknowledge/retrieve, tenant-scoped via `persistCdsAlert`), surfaced on `patient-view` (`getActiveAlerts`) and `encounter-start` (`buildEncounterStartAlerts`).

**Two gaps:**
1. **NEWS2 is invisible on the CDS dashboard.** `recordNEWS2` writes to `news2_scores` + a notification, but **never calls `persistCdsAlert`** — so a high NEWS2 score never appears on the clinician's `patient-view`/`encounter-start` cards. This is the same class of defect as the **D26 pregnancy-BP finding** (`vitalSignMonitor.js:299-335`), where gestational-HTN alerts landed only in `clinical_alerts` and the doctor's CDS screen showed nothing until a `cds_alerts` mirror was added.
2. **`getClinicalRisk` ignores the NEWS2 "single parameter = 3" rule.** Per RCP NEWS2, a score of 3 in *any single* parameter mandates urgent clinician review even when the aggregate is low — `getClinicalRisk(score)` keys on the aggregate only.

## 2. Goals / non-goals

**Goals (v1):**
- **Reuse** `calculateNEWS2` unchanged for the math; **add** `anyParamThree` (did any single parameter score 3?) to its return.
- **Fix** `getClinicalRisk` to honor the single-parameter-=3 escalation (urgent ward-doctor review) — backward-compatible.
- **Surface** NEWS2 deterioration to `cds_alerts` via `persistCdsAlert` so it appears on `patient-view`/`encounter-start`, **gated** on the `deterioration_early_warning` module (tenant 3-layer), **adult-only**, with **escalation-only de-dup**.
- Disabled by default; deterministic (no model).

**Non-goals (v1):**
- Rebuilding NEWS2 scoring / persistence / the notification (all exist).
- Adding `tenant_id` to the `news2_scores` insert (separate correctness concern — deferred).
- AI "trend + recent-lab composite" augmentation (the module's eventual vision) — v2.
- New hook / card schema / route / migration (all reused).
- Paediatric (PEWS) / obstetric (MEOWS) scores; patient-facing surface.

## 3. Locked decisions
1. **Reuse existing `calculateNEWS2`**; only add `anyParamThree`.
2. **Surface to `cds_alerts`** via `persistCdsAlert` (tenant-correct), called best-effort from `recordNEWS2`.
3. Raise threshold = **score ≥ 5 OR `anyParamThree`** (the clinically-escalating set); **escalation-only de-dup**.
4. **Adult-only** (skip paediatric/pregnant — NEWS2 not validated for them).
5. Fix the single-parameter-=3 rule in `getClinicalRisk` (backward-compatible).

## 4. Architecture & flow

```
recordNEWS2(patientUid, vitals, recordedBy)                       [EXISTING — extended]
  ... existing: calculateNEWS2 → INSERT news2_scores → notify if score≥5 ...
  + best-effort: surfaceNews2Cds({ patientUid, news2 })           [NEW call, in try/catch — never blocks]

surfaceNews2Cds({ patientUid, encounterId = null, news2 })        [NEW]
   news2 = { totalScore, clinicalRisk, scores, anyParamThree }    (from calculateNEWS2)
 1. module-enabled gate (deterioration_early_warning, tenant 3-layer via the patient's tenant) → disabled ⇒ no-op
 2. adult-only: resolvePatientContext(patientId) → paediatric OR pregnant ⇒ no-op
 3. raise threshold: totalScore ≥ 5 OR anyParamThree → else no-op (routine; no card)
 4. band for the card: totalScore≥7 → critical; (5–6 OR anyParamThree) → warning   (never 'info' — we don't raise low)
 5. de-dup: latest UNACKNOWLEDGED NEWS2_DETERIORATION cds_alert for this patient → raise ONLY if none, or the
    new severity rank is HIGHER than the standing one (escalation). Equal/lower ⇒ skip (no spam).
 6. persistCdsAlert({ patientUid, encounterId, alertType:'NEWS2_DETERIORATION', severity,
      title:`NEWS2 ${totalScore} — ${clinicalRisk}`, description:<escalationAction>,
      sourceData:{ total_score, clinical_risk, scores, any_param_three:anyParamThree, source:'news2Service.recordNEWS2' } })
   → surfaces via getActiveAlerts (patient-view) + buildEncounterStartAlerts (encounter-start)
```

`encounterId` is `null` in v1 (the vitals path doesn't thread an admission id, and `getActiveAlerts(patientUid)` returns alerts regardless of encounter, so patient-view still shows it). De-dup keys on `patient_uid + alert_type + acknowledged=false`.

## 5. Components (files)

**New:**
- `apps/backend/src/services/cds/deteriorationEarlyWarningService.js` — `surfaceNews2Cds({ patientUid, encounterId, news2 })`: module gate, adult-only check, threshold, escalation-only de-dup, `persistCdsAlert`. Returns `{ raised: boolean, reason? }`. **Lazy-imports** `persistCdsAlert` to avoid an eager import-graph change.
- Tests: `deteriorationEarlyWarningService.test.js` (unit — gate/threshold/de-dup/adult-only, mocked), `news2CdsSurfacing.deep.test.js` (real-PG — vitals → cds_alert via getActiveAlerts).

**Changed:**
- `services/clinical/news2Service.js`:
  - `calculateNEWS2` → also return `anyParamThree` (`Object.values(scores).some((v) => v === 3)`).
  - `getClinicalRisk(score, { anyParamThree = false } = {})` → when `anyParamThree` and `score < 5`, escalationAction becomes the urgent-single-parameter review text; `clinicalRisk` stays `low_to_medium` (already is for 1–4). Backward-compatible (default false ⇒ unchanged).
  - `recordNEWS2` → after the existing persistence/notification, call `surfaceNews2Cds(...)` in its own try/catch (best-effort).
- `services/emr/cdsEngine.js` — `export` `persistCdsAlert` (was private).
- `utils/clinical/vitalSignMonitor.js` — `export` `resolvePatientContext` (was private) + add to default export.
- `services/ai/clinicalAiModuleService.js` — confirm/adjust `deterioration_early_warning` `settings.outputSchema` matches `{ score, band, contributors }` framing (keep `enabled:false`).

**No new migration** — reuses `cds_alerts`, `news2_scores`, vitals.

## 6. Single-parameter-=3 fix specifics
- `calculateNEWS2` adds `anyParamThree = Object.values(scores).some((v) => v === 3)` to its return object (additive; existing fields unchanged).
- `getClinicalRisk(score, { anyParamThree })`: existing aggregate branches unchanged; when `anyParamThree === true` AND `1 ≤ score < 5`, override `escalationAction` to: *"Urgent review by the ward doctor — a single NEWS2 parameter scored 3. Determine the cause and decide on escalation/monitoring frequency."* (`clinicalRisk` remains `low_to_medium`). A param=3 always implies `score ≥ 3`, so this only affects 3–4 aggregates; 5+ already escalates.

## 7. Gating, scope, honesty
- `deterioration_early_warning` stays `enabled:false`; surfacing runs only when enabled for the patient's tenant. `persistCdsAlert` resolves + stamps `tenant_id` (fail-safe skip on null).
- **Adult-only** via `resolvePatientContext`.
- **Honesty:** NEWS2 is a screening/escalation aid, not a diagnosis; the card's `sourceData` carries the per-parameter `scores` for transparency. The existing `news2_scores` row + notification are unchanged (this only adds the CDS card).

## 8. Error handling
- `surfaceNews2Cds` is called best-effort from `recordNEWS2` (try/catch); a failure must never break the NEWS2 record or the vitals write.
- Module-disabled / non-adult / below-threshold → clean `{ raised:false, reason }` no-op (not an error).
- `persistCdsAlert` already fail-safes on unresolved tenant.

## 9. Test plan (TDD)
- **Unit (`news2Service`):** `calculateNEWS2` now returns `anyParamThree` (true when e.g. RR 25 scores 3 at aggregate 3; false for an all-1s aggregate of 3); `getClinicalRisk(3, { anyParamThree:true })` → low_to_medium with the urgent-single-parameter action; `getClinicalRisk(3)` (default) → unchanged; aggregate bands unchanged.
- **Unit (`surfaceNews2Cds`, mocked):** module disabled → no `persistCdsAlert`; paediatric/pregnant → none; score 2 / anyParamThree=false → none; score 6 → persist `warning`; score 8 → persist `critical`; single-param-3 at aggregate 3 → persist `warning`; de-dup — a standing unacked equal-band alert ⇒ no second persist, a higher-band ⇒ persist (escalation). (Mock `clinicalAiModuleService.getClinicalAiModule`, `vitalSignMonitor.resolvePatientContext`, `cdsEngine.persistCdsAlert`, and the prisma read for the standing alert.)
- **Integration (real PG):** enable the module for a tenant; seed an adult patient + admission; `recordNEWS2(patientUid, deterioratingVitals, recordedBy)` (RR 26, SpO2 90 on O2, HR 130 → score ≥ 7) → a `cds_alerts` row (`NEWS2_DETERIORATION`, `critical`, tenant-stamped) exists and is returned by `getActiveAlerts(patientUid)`; a normal set → none; a second equal-band record → no duplicate (de-dup); a paediatric patient → none; module disabled → none. The existing `news2_scores` insert + return are unaffected.
- **Gates:** `npm run test:ci` (all chunks), `npm run lint`. No Ollama smoke (deterministic).

## 10. Code-grounded anchors
- Existing NEWS2: `services/clinical/news2Service.js` — `calculateNEWS2` (`:16`), `getClinicalRisk` (`:96`), `recordNEWS2` (`:128`, persists `news2_scores` + notification). Called at `vitalsChartService.js:624`.
- CDS write/read: `cdsEngine.js:89` `persistCdsAlert` (export it), `:1002` `getActiveAlerts`; cds_alerts mirror precedent `vitalSignMonitor.js:308-331` (D26).
- Patient context: `vitalSignMonitor.js` `resolvePatientContext` (export it).
- Surfacing consumer: `services/cds/encounterCdsHelper.js` `buildEncounterStartAlerts`.
- Module: `clinicalAiModuleService.js` `deterioration_early_warning`.

## 11. Future (v2+)
- AI "trend + recent-lab composite" augmentation layered on the deterministic NEWS2 (the module's full vision), enabled last.
- Thread `encounter_id` into the NEWS2 CDS alert (needs the admission id at the vitals path).
- `tenant_id` on the `news2_scores` insert (multi-tenant correctness sweep).
- Acknowledgement-aware re-raise if a high score persists past a monitoring interval.
