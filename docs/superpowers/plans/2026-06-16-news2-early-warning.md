# NEWS2 Deterioration → CDS Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Surface the EXISTING NEWS2 deterioration score onto the CDS-Hooks card pipeline (so it shows on patient-view/encounter-start), gated + adult-only + escalation-only de-dup, and fix the NEWS2 single-parameter-=3 escalation rule.

**Architecture:** Reuse `news2Service.calculateNEWS2` (add `anyParamThree`); fix `getClinicalRisk`; add `surfaceNews2Cds` that, when the `deterioration_early_warning` module is enabled for an adult patient and the score escalates, persists a `cds_alert` via the existing `persistCdsAlert`. No rebuild, no migration.

**Tech Stack:** Node.js (ESM), Jest (`--experimental-vm-modules`), Prisma, the existing CDS engine.

**Spec:** `docs/superpowers/specs/2026-06-16-news2-early-warning-design.md`

**Conventions:** DB-free unit tests `npm run test:suite -- <pattern>` (from `apps/backend`). Branch `feat/news2-early-warning`. Never `git add -A` (unrelated untracked files: `apps/backend/scripts/gen-ai-module-inventory.mjs`, `docs/CLINICAL_AI_MODULE_INVENTORY.md`). Raw SQL: spread params, `::type` casts. Commit per task.

---

## File Structure
- **Create:** `apps/backend/src/services/cds/deteriorationEarlyWarningService.js` + 2 tests.
- **Modify:** `apps/backend/src/services/clinical/news2Service.js` (anyParamThree + getClinicalRisk + recordNEWS2 call), `apps/backend/src/services/emr/cdsEngine.js` (export persistCdsAlert), `apps/backend/src/utils/clinical/vitalSignMonitor.js` (export resolvePatientContext).

---

## Task 1: `anyParamThree` + single-parameter-=3 escalation in news2Service

**Files:** Modify `apps/backend/src/services/clinical/news2Service.js`; Test `apps/backend/src/tests/unit/news2Service.test.js`.

- [ ] **Step 1: Write the failing test.**

```javascript
import { jest } from '@jest/globals';
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: { $queryRawUnsafe: jest.fn() } }));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({ default: { queue: jest.fn() } }));
const { calculateNEWS2, getClinicalRisk } = await import('../../services/clinical/news2Service.js');

const NORMAL = { respiration_rate: 16, spo2: 98, temperature: 37, systolic_bp: 120, heart_rate: 72, consciousness: 'A' };

test('calculateNEWS2 reports anyParamThree=true when a single parameter scores 3', () => {
  const r = calculateNEWS2({ ...NORMAL, respiration_rate: 26 }); // RR>=25 -> 3
  expect(r.anyParamThree).toBe(true);
  expect(r.totalScore).toBe(3);
});

test('calculateNEWS2 reports anyParamThree=false when no single parameter scores 3', () => {
  const r = calculateNEWS2({ ...NORMAL, respiration_rate: 22, heart_rate: 95 }); // 2 + 1 = 3 aggregate, no single 3
  expect(r.anyParamThree).toBe(false);
  expect(r.totalScore).toBe(3);
});

test('getClinicalRisk honors the single-parameter-3 urgent-review rule at low aggregate', () => {
  const withParam3 = getClinicalRisk(3, { anyParamThree: true });
  expect(withParam3.clinicalRisk).toBe('low_to_medium');
  expect(withParam3.escalationAction).toMatch(/single NEWS2 parameter scored 3/i);
  // backward-compatible default:
  const plain = getClinicalRisk(3);
  expect(plain.clinicalRisk).toBe('low_to_medium');
  expect(plain.escalationAction).toMatch(/registered nurse/i);
});

test('getClinicalRisk aggregate bands unchanged', () => {
  expect(getClinicalRisk(7).clinicalRisk).toBe('high');
  expect(getClinicalRisk(5).clinicalRisk).toBe('medium');
  expect(getClinicalRisk(0).clinicalRisk).toBe('low');
});
```

- [ ] **Step 2: Run `npm run test:suite -- news2Service.test`; confirm the anyParamThree + single-param-3 tests FAIL.**

- [ ] **Step 3: Implement.** In `news2Service.js`:
  - In `calculateNEWS2`, after `const totalScore = ...`: add `const anyParamThree = Object.values(scores).some((v) => v === 3);`, change the risk call to `getClinicalRisk(totalScore, { anyParamThree })`, and return `{ scores, totalScore, anyParamThree, clinicalRisk, escalationAction }`.
  - Change `getClinicalRisk` to `export function getClinicalRisk(score, { anyParamThree = false } = {})`. Keep the `>=7` and `>=5` branches. In the `>=1` branch return:
    ```javascript
    return {
      clinicalRisk: 'low_to_medium',
      escalationAction: anyParamThree
        ? 'Urgent review by the ward doctor — a single NEWS2 parameter scored 3. Determine the cause and decide on escalation/monitoring frequency.'
        : 'Ward-based response — inform registered nurse. Increase monitoring frequency to minimum 1-hourly.',
    };
    ```
  - Leave the `else` (score 0) branch unchanged.

- [ ] **Step 4: Run `npm run test:suite -- news2Service.test`; all pass. `npx eslint src/services/clinical/news2Service.js` clean.**

- [ ] **Step 5: Commit.** `git add apps/backend/src/services/clinical/news2Service.js apps/backend/src/tests/unit/news2Service.test.js && git commit -m "feat(news2): expose anyParamThree + honor single-parameter-3 escalation rule"`

---

## Task 2: `surfaceNews2Cds` service (+ export persistCdsAlert, resolvePatientContext)

**Files:** Create `apps/backend/src/services/cds/deteriorationEarlyWarningService.js`; Modify `cdsEngine.js`, `vitalSignMonitor.js`; Test `apps/backend/src/tests/unit/deteriorationEarlyWarningService.test.js`.

- [ ] **Step 1: Make the dependencies importable.**
  - `services/emr/cdsEngine.js`: change `async function persistCdsAlert(` to `export async function persistCdsAlert(` (it stays used internally too).
  - `utils/clinical/vitalSignMonitor.js`: `export` `resolvePatientContext` (find its `function resolvePatientContext(` declaration, prefix `export`) and add `resolvePatientContext` to the `export default { ... }` list. (Read its return shape first — it returns `{ isPaediatric, isPregnant, ageYears, ... }`.)

- [ ] **Step 2: Write the failing unit test** (`deteriorationEarlyWarningService.test.js`):

```javascript
import { jest } from '@jest/globals';
const findUnique = jest.fn();
const queryRawUnsafe = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: { users: { findUnique }, $queryRawUnsafe: queryRawUnsafe } }));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const getClinicalAiModule = jest.fn();
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({ getClinicalAiModule, default: { getClinicalAiModule } }));
const resolvePatientContext = jest.fn();
jest.unstable_mockModule('../../utils/clinical/vitalSignMonitor.js', () => ({ resolvePatientContext, default: { resolvePatientContext } }));
const persistCdsAlert = jest.fn();
jest.unstable_mockModule('../../services/emr/cdsEngine.js', () => ({ persistCdsAlert, default: { persistCdsAlert } }));

const { surfaceNews2Cds } = await import('../../services/cds/deteriorationEarlyWarningService.js');

const ADULT = { isPaediatric: false, isPregnant: false, ageYears: 50 };
beforeEach(() => {
  jest.clearAllMocks();
  findUnique.mockResolvedValue({ id: 7, tenant_id: 't1' });
  getClinicalAiModule.mockResolvedValue({ enabled: true });
  resolvePatientContext.mockResolvedValue(ADULT);
  queryRawUnsafe.mockResolvedValue([]); // no standing alert
});
const news2 = (over) => ({ totalScore: 6, clinicalRisk: 'medium', escalationAction: 'x', scores: { heart_rate: 2 }, anyParamThree: false, ...over });

test('persists a warning cds_alert for an escalating score (5-6)', async () => {
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2() });
  expect(r.raised).toBe(true);
  expect(persistCdsAlert).toHaveBeenCalledWith(expect.objectContaining({ alertType: 'NEWS2_DETERIORATION', severity: 'warning', patientUid: 'p1' }));
});

test('persists a critical cds_alert for score >= 7', async () => {
  await surfaceNews2Cds({ patientUid: 'p1', news2: news2({ totalScore: 8, clinicalRisk: 'high' }) });
  expect(persistCdsAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
});

test('raises on a single-parameter-3 even at low aggregate', async () => {
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2({ totalScore: 3, clinicalRisk: 'low_to_medium', anyParamThree: true }) });
  expect(r.raised).toBe(true);
  expect(persistCdsAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning' }));
});

test('does not raise below threshold (score<5, no single-3)', async () => {
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2({ totalScore: 2, clinicalRisk: 'low_to_medium' }) });
  expect(r.raised).toBe(false);
  expect(persistCdsAlert).not.toHaveBeenCalled();
});

test('no-op when the module is disabled', async () => {
  getClinicalAiModule.mockResolvedValueOnce({ enabled: false });
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2() });
  expect(r.raised).toBe(false);
  expect(persistCdsAlert).not.toHaveBeenCalled();
});

test('no-op for a paediatric or pregnant patient', async () => {
  resolvePatientContext.mockResolvedValueOnce({ isPaediatric: true, isPregnant: false });
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2() });
  expect(r.raised).toBe(false);
  expect(persistCdsAlert).not.toHaveBeenCalled();
});

test('de-dups against a standing unacknowledged alert at equal-or-higher severity', async () => {
  queryRawUnsafe.mockResolvedValueOnce([{ severity: 'warning' }]); // standing warning
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2() }); // also warning
  expect(r.raised).toBe(false);
  expect(persistCdsAlert).not.toHaveBeenCalled();
});

test('escalates when the new severity is higher than the standing one', async () => {
  queryRawUnsafe.mockResolvedValueOnce([{ severity: 'warning' }]); // standing warning
  const r = await surfaceNews2Cds({ patientUid: 'p1', news2: news2({ totalScore: 8, clinicalRisk: 'high' }) }); // critical
  expect(r.raised).toBe(true);
  expect(persistCdsAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
});
```

- [ ] **Step 3: Run; confirm FAIL (service missing).**

- [ ] **Step 4: Implement `deteriorationEarlyWarningService.js`:**
```javascript
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { getClinicalAiModule } from '../ai/clinicalAiModuleService.js';
import { resolvePatientContext } from '../../utils/clinical/vitalSignMonitor.js';

const MODULE_KEY = 'deterioration_early_warning';
const SEV_RANK = { info: 0, warning: 1, critical: 2 };

export async function surfaceNews2Cds({ patientUid, encounterId = null, news2 } = {}) {
  const { totalScore, clinicalRisk, escalationAction, scores, anyParamThree } = news2 || {};
  // Escalating set only: score >= 5 OR any single parameter scored 3.
  if (!(Number(totalScore) >= 5 || anyParamThree)) return { raised: false, reason: 'below_threshold' };

  const u = await prisma.users.findUnique({ where: { uid: patientUid }, select: { id: true, tenant_id: true } });
  if (!u) return { raised: false, reason: 'patient_not_found' };

  const module = await getClinicalAiModule(MODULE_KEY, { tenantId: u.tenant_id });
  if (!module?.enabled) return { raised: false, reason: 'module_disabled' };

  const ctx = await resolvePatientContext(u.id);
  if (ctx?.isPaediatric || ctx?.isPregnant) return { raised: false, reason: 'not_adult' };

  const severity = Number(totalScore) >= 7 ? 'critical' : 'warning';

  // Escalation-only de-dup: only raise if there's no standing unacknowledged
  // NEWS2 alert, or the new severity outranks the standing one.
  const standing = await prisma.$queryRawUnsafe(
    `SELECT severity FROM cds_alerts
       WHERE patient_uid = $1::uuid AND alert_type = 'NEWS2_DETERIORATION' AND acknowledged = false
       ORDER BY created_at DESC LIMIT 1`,
    patientUid,
  );
  const standingRank = standing?.[0] ? (SEV_RANK[standing[0].severity] ?? -1) : -1;
  if ((SEV_RANK[severity] ?? -1) <= standingRank) return { raised: false, reason: 'deduped' };

  // Lazy import so cdsEngine's heavy import graph isn't pulled at module load.
  const { persistCdsAlert } = await import('../emr/cdsEngine.js');
  await persistCdsAlert({
    patientUid,
    encounterId,
    alertType: 'NEWS2_DETERIORATION',
    severity,
    title: `NEWS2 ${totalScore} — ${String(clinicalRisk || '').replace(/_/g, ' ')}`,
    description: escalationAction || '',
    sourceData: { total_score: totalScore, clinical_risk: clinicalRisk, scores: scores || {}, any_param_three: !!anyParamThree, source: 'news2Service.recordNEWS2' },
  });
  return { raised: true, severity };
}

export default { surfaceNews2Cds };
```

- [ ] **Step 5: Run unit test (all pass). `npm run lint:raw-params` + `npx eslint` the 3 changed/new files — clean.** Also run `npm run test:suite -- "cdsEngine|cds"` to confirm exporting `persistCdsAlert` didn't break a cdsEngine suite.

- [ ] **Step 6: Commit** the 4 files (service + test + cdsEngine + vitalSignMonitor): `git commit -m "feat(news2): surfaceNews2Cds — persist NEWS2 deterioration to the CDS card pipeline (gated, adult-only, de-duped)"`

---

## Task 3: Wire into `recordNEWS2` + real-PG integration test

**Files:** Modify `news2Service.js`; Create `apps/backend/src/tests/news2CdsSurfacing.deep.test.js`.

- [ ] **Step 1: Wire (best-effort) into `recordNEWS2`.** Capture the full calc result and call the surfacing after the existing notification block:
  - Change the destructure near the top of `recordNEWS2` from `const { totalScore, clinicalRisk, escalationAction } = calculateNEWS2(vitals);` to also capture `scores, anyParamThree`.
  - After the `if (totalScore >= 5) { ...notification... }` block, add:
    ```javascript
    try {
      const { surfaceNews2Cds } = await import('../cds/deteriorationEarlyWarningService.js');
      await surfaceNews2Cds({ patientUid, news2: { totalScore, clinicalRisk, escalationAction, scores, anyParamThree } });
    } catch (err) {
      logger.warn(`NEWS2 CDS surfacing failed for patient ${patientUid}: ${err.message}`);
    }
    ```
    (Lazy import; best-effort — must never break the news2_scores write or the vitals path.)

- [ ] **Step 2: Write the real-PG integration test** (`news2CdsSurfacing.deep.test.js`). Read `clinicalTextDeid.deep.test.js` / a `cds`-touching deep test for the connection + seed pattern. Seed an **adult** patient (DOB ~50y ago, no pregnancy) under a tenant; enable `deterioration_early_warning` for that tenant (mirror the tenant-module-enable helper used by the prior deep tests, which DELETE the override on cleanup). Then:
  - `recordNEWS2(patientUid, { respiration_rate: 26, spo2: 90, supplemental_o2: true, temperature: 37, systolic_bp: 95, heart_rate: 130, consciousness: 'A' }, recordedBy)` (score ≥ 7) → assert a `cds_alerts` row exists for the patient with `alert_type='NEWS2_DETERIORATION'`, `severity='critical'`, a non-null `tenant_id`, and that `getActiveAlerts(patientUid)` includes it.
  - A normal set (`respiration_rate: 16, spo2: 98, temperature: 37, systolic_bp: 120, heart_rate: 72, consciousness: 'A'`) → no new NEWS2 cds_alert.
  - A second identical critical record → still exactly ONE unacknowledged NEWS2 alert (de-dup).
  - With the module disabled (delete/disable the override) → no NEWS2 cds_alert.
  - Cleanup: DELETE seeded cds_alerts, news2_scores, the module override, the user — zero residue.

- [ ] **Step 3: Run** `npm test -- news2CdsSurfacing.deep` (bring QA cluster up via `node scripts/qa-cluster-up.mjs` if needed). `npm run lint:raw-params` clean.

- [ ] **Step 4: Commit** `news2Service.js` + the deep test: `git commit -m "feat(news2): wire surfaceNews2Cds into recordNEWS2 (best-effort) + real-PG integration"`

---

## Task 4: Gates

- [ ] **Step 1: Full lint** `npm run lint` → clean. Import-graph watch: `deteriorationEarlyWarningService` imports `clinicalAiModuleService` + `vitalSignMonitor` eagerly and lazy-imports `cdsEngine`; `news2Service` lazy-imports the surfacing — confirm no suite that mocks `../../lib/prisma.js` broke (`npm run test:suite -- "news2|cds|vitalSign|deterioration"`).
- [ ] **Step 2: Full suite** `npm run test:ci` → must print the literal `All chunks passed` (bring QA cluster up first; exit 0 alone can mask a chunk failure).
- [ ] **Step 3:** No Ollama smoke (deterministic). If `lint:fix` changed files, stage only intended ones.

---

## Done criteria
- Unit + integration green; `npm run test:ci` prints `All chunks passed`; `npm run lint` clean; no suite-load regression.
- `deterioration_early_warning` stays `enabled:false`; deterministic (no model). Existing `news2_scores` write + notification unchanged; this only ADDS the CDS card.
- NEWS2 deterioration now appears via `getActiveAlerts` (patient-view) when the module is enabled for an adult patient at an escalating score; de-dup holds; single-param-3 honored.
- Then: `superpowers:finishing-a-development-branch` → merge to `main` → push both remotes.
