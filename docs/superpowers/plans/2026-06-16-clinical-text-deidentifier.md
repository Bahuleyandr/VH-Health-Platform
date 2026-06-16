# Clinical Text De-identifier (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A deterministic, chart-anchored PHI de-identification transformer (`deidentifyText`) plus a chart-identifier assembler, registered as a disabled module and wired into research export's free-text fields.

**Architecture:** A pure engine redacts the patient's *actual* identifiers (fetched from the DB) by exact value (solving names deterministically) + regex-sweeps structured identifiers of anyone, in typed-redaction (default) or stable-pseudonym mode, fail-closed, with a residual-risk report. No LLM.

**Tech Stack:** Node.js (ESM), Jest (`--experimental-vm-modules`), `crypto` (HMAC), Prisma (`users` read), the existing `researchRegistryService`.

**Spec:** `docs/superpowers/specs/2026-06-16-clinical-text-deidentifier-design.md`

**Conventions:** DB-free unit tests `npm run test:suite -- <pattern>` (from `apps/backend`). Branch `feat/clinical-text-deidentifier` (checked out). Never `git add -A` (unrelated untracked files exist — `apps/backend/scripts/gen-ai-module-inventory.mjs`, `docs/CLINICAL_AI_MODULE_INVENTORY.md`). Raw SQL: spread params, `::type` casts. Commit per task.

---

## File Structure
- **Create:** `apps/backend/src/services/ai/deidentificationService.js` (pure `deidentifyText` + `collectKnownIdentifiers`), + 2 tests.
- **Modify:** `apps/backend/src/services/ai/clinicalAiModuleService.js` (register module), `apps/backend/src/services/research/researchRegistryService.js` (`exportRegistry` de-id wiring).

---

## Task 1: Pure engine — typed redaction + structured regex + fail-closed

**Files:** Create `apps/backend/src/services/ai/deidentificationService.js`; Test `apps/backend/src/tests/unit/deidentificationService.test.js`.

- [ ] **Step 1: Write the failing unit test.**

```javascript
import { jest } from '@jest/globals';
// Pure module — but it imports prisma for collectKnownIdentifiers (Task 3), so mock it now.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { users: { findUnique: jest.fn() } },
  prismaReadOnly: { users: { findUnique: jest.fn() } },
}));
const { deidentifyText } = await import('../../services/ai/deidentificationService.js');

test('redacts chart-anchored known identifiers by exact value (NAME, PHONE)', () => {
  const out = deidentifyText('Ramesh Kumar (98765 43210) seen in clinic.', {
    knownIdentifiers: [
      { value: 'Ramesh Kumar', category: 'NAME' },
      { value: '98765 43210', category: 'PHONE' },
    ],
  });
  expect(out.text).toBe('[REDACTED:NAME] ([REDACTED:PHONE]) seen in clinic.');
  expect(out.redactions).toEqual(expect.arrayContaining([
    { category: 'NAME', count: 1 }, { category: 'PHONE', count: 1 },
  ]));
});

test('redacts longest known value first so a surname does not leak as a partial', () => {
  const out = deidentifyText('Kumar; full name Ramesh Kumar.', {
    knownIdentifiers: [
      { value: 'Kumar', category: 'NAME' },
      { value: 'Ramesh Kumar', category: 'NAME' },
    ],
  });
  // "Ramesh Kumar" replaced as a whole; standalone "Kumar" also replaced. No leftover "Kumar".
  expect(out.text).not.toContain('Kumar');
  expect(out.text).toBe('[REDACTED:NAME]; full name [REDACTED:NAME].');
});

test('regex-sweeps structured identifiers of anyone (email, Aadhaar, UID)', () => {
  const out = deidentifyText('contact kin@example.com, aadhaar 1234 5678 9012, id 9f8e7d6c-1234-4abc-89ab-0123456789ab', {});
  expect(out.text).toContain('[REDACTED:EMAIL]');
  expect(out.text).toContain('[REDACTED:AADHAAR]');
  expect(out.text).toContain('[REDACTED:UID]');
  expect(out.text).not.toContain('kin@example.com');
});

test('redacts ages >= 90 but leaves younger ages', () => {
  const out = deidentifyText('A 92 year old man; his 45 year old son.', {});
  expect(out.text).toContain('[REDACTED:AGE]');
  expect(out.text).toContain('45 year old'); // under 90 retained
});

test('flags residual identifier-shaped tokens and absolute dates without auto-redacting dates', () => {
  // A phone the known-list missed (belongs to nobody we anchored) still gets regex-redacted;
  // an absolute date is NOT redacted but is flagged.
  const out = deidentifyText('Admitted 12/06/2026. Ph 99887 76655.', {});
  expect(out.text).toContain('12/06/2026'); // date retained
  expect(out.residualFlags.some((f) => f.code === 'RESIDUAL_DATE')).toBe(true);
  expect(out.text).toContain('[REDACTED:PHONE]'); // phone redacted by regex
});

test('fail-closed: an internal error returns empty text + DEID_FAILED, never the original', () => {
  // A throwing `value` getter triggers an internal error the moment the engine
  // inspects the identifier — reliably exercising the fail-closed catch.
  const evil = { category: 'NAME', get value() { throw new Error('boom'); } };
  const out = deidentifyText('secret PHI here', { knownIdentifiers: [evil] });
  expect(out.text).toBe('');
  expect(out.text).not.toContain('secret PHI here');
  expect(out.residualFlags.some((f) => f.code === 'DEID_FAILED' && f.severity === 'critical')).toBe(true);
});
```

- [ ] **Step 2: Run to confirm fail.** `npm run test:suite -- deidentificationService.test` → FAIL (module/function missing).

- [ ] **Step 3: Implement the engine.** Create `deidentificationService.js`:
  - Imports: `import crypto from 'crypto';` `import prisma from '../../lib/prisma.js';` `import { AppError } from '../../utils/AppError.js';`
  - Regexes (mirror `hallucinationDefenses.js:26-29` + extend):
    ```javascript
    const UID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
    const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
    const AADHAAR_RE = /\b\d{4}\s?\d{4}\s?\d{4}\b/g;            // shape-only, no Verhoeff
    const PHONE_RE = /\b(?:\+?\d{1,3}[-\s]?)?(?:\d{10}|\d{5}[-\s]?\d{5})\b/g;
    const MRN_RE = /\bMRN[\s:-]*([A-Z0-9-]{4,20})\b/gi;
    const URL_RE = /\bhttps?:\/\/\S+/gi;
    const AGE_RE = /\b(\d{2,3})\s*(?:years?|yrs?|y\/?o|yo)\b/gi;  // redact only when captured number >= 90
    const DATE_RE = /\b(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})\b/gi;
    // Aadhaar is checked BEFORE phone (12 digits) so a 12-digit run isn't eaten as two phones.
    const STRUCTURED = [['UID', UID_RE], ['EMAIL', EMAIL_RE], ['AADHAAR', AADHAAR_RE], ['PHONE', PHONE_RE], ['MRN', MRN_RE], ['URL', URL_RE]];
    function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    ```
  - `placeholder(category, value, mode, salt)`: `mode === 'pseudonymize'` → `` `[${category}-${crypto.createHmac('sha256', salt || '').update(String(value).toLowerCase()).digest('hex').slice(0, 8)}]` `` ; else `` `[REDACTED:${category}]` ``.
  - `deidentifyText(text, { knownIdentifiers = [], mode = 'redact', salt = null } = {})`: wrap the whole body in `try { … } catch { return { text: '', redactions: [], residualFlags: [{ code: 'DEID_FAILED', severity: 'critical', message: 'de-identification failed; text suppressed' }] }; }`.
    1. `let work = String(text ?? '');` `const counts = {};` `const bump = (c) => { counts[c] = (counts[c] || 0) + 1; };`
    2. Known identifiers, **longest value first**: `const known = [...knownIdentifiers].filter(k => k && typeof k.value === 'string' && k.value.trim()).sort((a,b) => b.value.length - a.value.length);`. (A malformed entry — e.g. a throwing `value` getter — raises inside this expression and is caught by the outer try/catch → fail-closed DEID_FAILED. That is the fail-closed trigger the unit test exercises.)
    3. For each `k`: `work = work.replace(new RegExp(escapeRegExp(k.value), 'gi'), () => { bump(k.category); return placeholder(k.category, k.value, mode, salt); });`
    4. AGE: `work = work.replace(AGE_RE, (m, num) => { if (Number(num) >= 90) { bump('AGE'); return placeholder('AGE', m, mode, salt); } return m; });`
    5. STRUCTURED in order: for each `[cat, re]`, `work = work.replace(re, (m) => { bump(cat); return placeholder(cat, m, mode, salt); });`
    6. Residual scan on `work`: for `[UID_RE, EMAIL_RE, AADHAAR_RE, PHONE_RE, MRN_RE]`, if any `.test(work)` → push `{ code: 'RESIDUAL_PHI_SUSPECTED', severity: 'medium', message: 'identifier-shaped token may remain' }` (once). If `DATE_RE.test(work)` → push `{ code: 'RESIDUAL_DATE', severity: 'medium', message: 'absolute date(s) remain (not auto-redacted in v1)' }`. (Reset `re.lastIndex = 0` before each `.test`.)
    7. `return { text: work, redactions: Object.entries(counts).map(([category, count]) => ({ category, count })), residualFlags };`
  - Export `deidentifyText`; add `export const __testing__ = { placeholder, escapeRegExp };`.

- [ ] **Step 4: Run to confirm pass.** `npm run test:suite -- deidentificationService.test` → PASS. `npm run lint:raw-params` → clean.

- [ ] **Step 5: Commit.** `git add apps/backend/src/services/ai/deidentificationService.js apps/backend/src/tests/unit/deidentificationService.test.js && git commit -m "feat(deid): deterministic chart-anchored de-id engine (redact + residual report, fail-closed)"`

---

## Task 2: Stable pseudonymization mode

**Files:** Modify `deidentificationService.js`; extend the test.

- [ ] **Step 1: Write the failing test** (append):

```javascript
test('pseudonymize mode emits a STABLE per-value token (same value+salt -> same token)', () => {
  const ids = [{ value: 'Ramesh Kumar', category: 'NAME' }];
  const a = deidentifyText('Ramesh Kumar today; Ramesh Kumar again.', { knownIdentifiers: ids, mode: 'pseudonymize', salt: 's1' });
  // Both mentions collapse to the SAME token (linkage preserved), and it is NOT a plain redaction tag.
  const tokens = a.text.match(/\[NAME-[0-9a-f]{8}\]/g);
  expect(tokens).toHaveLength(2);
  expect(tokens[0]).toBe(tokens[1]);
  expect(a.text).not.toContain('[REDACTED:NAME]');
});

test('pseudonymize is salt-dependent: a different salt yields a different token', () => {
  const ids = [{ value: 'Ramesh Kumar', category: 'NAME' }];
  const a = deidentifyText('Ramesh Kumar', { knownIdentifiers: ids, mode: 'pseudonymize', salt: 's1' });
  const b = deidentifyText('Ramesh Kumar', { knownIdentifiers: ids, mode: 'pseudonymize', salt: 's2' });
  expect(a.text).not.toBe(b.text);
});
```

- [ ] **Step 2: Run to confirm fail** (the token shape won't match if `placeholder` ignores mode/salt). If Task 1's `placeholder` already implements pseudonymize correctly, these may pass immediately — in that case ADD a sharper assertion that currently fails (e.g. cross-call stability with a fresh import) or treat Task 2 as a verification task and note it. Expected normal path: Task 1 implemented `placeholder` generically, so confirm these pass and **strengthen** with the salt-difference test above (which is new behavior coverage).

- [ ] **Step 3: Implement** — already covered by `placeholder` in Task 1. If the failing assertion was real, adjust `placeholder` so the HMAC keys on `salt` and messages on the lowercased value (as specified). No new code beyond Task 1 if green.

- [ ] **Step 4: Run to confirm pass.** `npm run test:suite -- deidentificationService.test` → PASS.

- [ ] **Step 5: Commit.** `git add apps/backend/src/services/ai/deidentificationService.js apps/backend/src/tests/unit/deidentificationService.test.js && git commit -m "test(deid): lock stable salt-keyed pseudonymization"`

---

## Task 3: `collectKnownIdentifiers` (chart-anchored assembler)

**Files:** Modify `deidentificationService.js`; extend the test.

- [ ] **Step 1: Read.** Confirm the `users` read shape from `clinicalTimelineService.js:113` `getPatient` (name, phone, email, birthday, address). `users.emergency_contact` is `Json?` (schema.prisma:390) — typically `{ name, phone, relationship }`.

- [ ] **Step 2: Write the failing test** (append):

```javascript
const svc = await import('../../services/ai/deidentificationService.js');
const prismaMod = await import('../../lib/prisma.js');
const { collectKnownIdentifiers } = svc;

test('collectKnownIdentifiers assembles patient + next-of-kin identifiers, skipping blanks', async () => {
  prismaMod.default.users.findUnique.mockResolvedValueOnce({
    name: 'Ramesh Kumar', phone: '9876543210', email: 'ramesh@example.com',
    birthday: new Date('1990-06-12T00:00:00Z'), address: '12 MG Road, Chennai',
    emergency_contact: { name: 'Sita Kumar', phone: '9000000000' },
  });
  const ids = await collectKnownIdentifiers('pat-uuid', { tenantId: 't1' });
  const byCat = (c) => ids.filter((i) => i.category === c).map((i) => i.value);
  expect(byCat('NAME')).toEqual(expect.arrayContaining(['Ramesh Kumar', 'Sita Kumar']));
  expect(byCat('PHONE')).toEqual(expect.arrayContaining(['9876543210', '9000000000']));
  expect(byCat('EMAIL')).toEqual(['ramesh@example.com']);
  expect(byCat('ADDRESS')).toEqual(['12 MG Road, Chennai']);
  // DOB expanded into common string renderings so it can be matched in free text.
  expect(byCat('DOB').some((v) => v.includes('1990'))).toBe(true);
});

test('collectKnownIdentifiers returns [] when the patient is not found', async () => {
  prismaMod.default.users.findUnique.mockResolvedValueOnce(null);
  await expect(collectKnownIdentifiers('missing', { tenantId: 't1' })).resolves.toEqual([]);
});
```

- [ ] **Step 3: Implement `collectKnownIdentifiers(patientUid, { tenantId } = {})`:**
  - `const u = await prisma.users.findUnique({ where: { uid: patientUid }, select: { name: true, phone: true, email: true, birthday: true, address: true, emergency_contact: true } });`
  - `if (!u) return [];`
  - Build `out = []`; `const push = (value, category) => { if (value && String(value).trim()) out.push({ value: String(value).trim(), category }); };`
  - `push(u.name, 'NAME'); push(u.phone, 'PHONE'); push(u.email, 'EMAIL'); push(u.address, 'ADDRESS');`
  - Next-of-kin: `const ec = u.emergency_contact && typeof u.emergency_contact === 'object' ? u.emergency_contact : {}; push(ec.name, 'NAME'); push(ec.phone, 'PHONE');`
  - DOB renderings: if `u.birthday`, format the Date into common strings and push each as `'DOB'`: ISO `yyyy-mm-dd`, `dd/mm/yyyy`, `dd-mm-yyyy`, and `d Mon yyyy` (e.g. `12 Jun 1990`). Use a small local formatter (pad day/month). Push only distinct non-blank renderings.
  - `return out;`
  - Export `collectKnownIdentifiers`.
  - **Import-graph note:** this adds no new transitive imports beyond `prisma` (already imported in Task 1), so no mock-prisma suite breaks. Keep `prisma` the only DB import.

- [ ] **Step 4: Run to confirm pass.** `npm run test:suite -- deidentificationService.test` → PASS.

- [ ] **Step 5: Commit.** `git add apps/backend/src/services/ai/deidentificationService.js apps/backend/src/tests/unit/deidentificationService.test.js && git commit -m "feat(deid): collectKnownIdentifiers (chart-anchored patient + next-of-kin)"`

---

## Task 4: Register the `clinical_text_deidentifier` module

**Files:** Modify `clinicalAiModuleService.js`; Test `apps/backend/src/tests/unit/deidModuleRegistration.test.js`.

- [ ] **Step 1: Read** the `consent_phi_policy_sentinel` entry (`clinicalAiModuleService.js:1488`) to mirror the field shape.

- [ ] **Step 2: Write the failing test:**

```javascript
const { getClinicalAiModuleDefinitions } = await import('../../services/ai/clinicalAiModuleService.js');
test('clinical_text_deidentifier is registered, disabled, governance/critical', () => {
  const mods = getClinicalAiModuleDefinitions(); // or the exported array/getter used by siblings
  const m = mods.find((x) => x.module_key === 'clinical_text_deidentifier');
  expect(m).toBeDefined();
  expect(m.enabled).toBe(false);
  expect(m.settings.surface).toBe('governance');
  expect(m.settings.risk).toBe('critical');
});
```
(First read `clinicalAiModuleService.js` to find the exact exported accessor for the module list — mirror what `clinicalCodingAssist`/sentinel tests use; adjust the import line to match.)

- [ ] **Step 3: Add the module entry** to `CLINICAL_AI_MODULES`:
```javascript
{
  module_key: 'clinical_text_deidentifier',
  display_name: 'Clinical Text De-identifier',
  description: 'Deterministically removes PHI from clinical free text (chart-anchored identifiers + structured-identifier regex), producing best-effort de-identified text plus a residual-risk report. Not a Safe-Harbor certification.',
  enabled: false,
  settings: {
    surface: 'governance', risk: 'critical', status: 'available',
    requiresClinicianSignoff: false, requiresCitations: false,
    reviewRoles: ['ADMIN', 'SUPER_ADMIN', 'COMPLIANCE_OFFICER'],
    approvalPolicy: 'privacy_governance_review',
    outputSchema: { type: 'object', required: ['text', 'redactions'] },
    retentionDays: 3650,
  },
},
```

- [ ] **Step 4: Run to confirm pass.** `npm run test:suite -- deidModuleRegistration.test`. Also run any module-count test that may assert a total (`npm run test:suite -- clinicalAiModule`) and update the expected count if one exists.

- [ ] **Step 5: Commit.** `git add apps/backend/src/services/ai/clinicalAiModuleService.js apps/backend/src/tests/unit/deidModuleRegistration.test.js && git commit -m "feat(deid): register clinical_text_deidentifier module (disabled, governance)"`

---

## Task 5: Wire de-id into `exportRegistry`

**Files:** Modify `researchRegistryService.js`; Test `apps/backend/src/tests/unit/researchExportDeid.test.js`.

- [ ] **Step 1: Re-read** `exportRegistry` (`researchRegistryService.js:672-747`). Target: `grid` cells from `dataObj[key]` (string CRF values); each `row` has `row.patient_uid`.

- [ ] **Step 2: Write the failing test** (mock prisma + the de-id service):

```javascript
import { jest } from '@jest/globals';
jest.unstable_mockModule('../../services/ai/deidentificationService.js', () => ({
  deidentifyText: jest.fn((t) => ({ text: String(t).replace('Ramesh', '[REDACTED:NAME]'), redactions: [], residualFlags: [] })),
  collectKnownIdentifiers: jest.fn(async () => [{ value: 'Ramesh', category: 'NAME' }]),
  default: {},
}));
// ...mock prisma/getRegistry/listForms to return one row whose dataObj has a free-text field "note":"Ramesh febrile"
const { exportRegistry } = await import('../../services/research/researchRegistryService.js');

test('exportRegistry with deidentify:true de-identifies free-text CRF cells', async () => {
  const res = await exportRegistry('reg1', { deidentify: true, salt: 'x', tenantId: 't1' });
  const csv = res.buffer.toString('utf8');
  expect(csv).toContain('[REDACTED:NAME]');
  expect(csv).not.toContain('Ramesh');
});

test('exportRegistry without deidentify is unchanged (no de-id call)', async () => {
  const deidMod = await import('../../services/ai/deidentificationService.js');
  await exportRegistry('reg1', { tenantId: 't1' });
  expect(deidMod.deidentifyText).not.toHaveBeenCalled();
});
```
(Match the existing test setup for `researchRegistryService` if one exists — mirror its prisma mocking; otherwise mock `prisma.$queryRawUnsafe` + `getRegistry`/`listForms` minimally.)

- [ ] **Step 3: Implement.** Extend the signature: `exportRegistry(registryId, { format = 'csv', includePhi = false, deidentify = false, salt = null, tenantId = DEFAULT_TENANT_ID } = {})`.
  - **Lazy import** to avoid an eager import-graph change: inside the function, `const { deidentifyText, collectKnownIdentifiers } = deidentify ? await import('../ai/deidentificationService.js') : {};`
  - When `deidentify`: force `includePhi = false` (de-id must not also emit `patient_uid`). Build a per-patient identifier cache: `const idCache = new Map();` `const idsFor = async (uid) => { if (!idCache.has(uid)) idCache.set(uid, await collectKnownIdentifiers(uid, { tenantId: scopedTenantId })); return idCache.get(uid); };`
  - In the `grid` build, when `deidentify`, for each `fieldKey` whose `dataObj[key]` is a non-empty string, replace with `deidentifyText(value, { knownIdentifiers: await idsFor(row.patient_uid), mode: 'pseudonymize', salt }).text`. (The `grid = rows.map(...)` becomes an `async` map — convert to a `for` loop building `grid` so `await` works.)
  - Surface a residual signal: count rows whose any cell returned a `RESIDUAL_*`/`DEID_FAILED` flag into the return object as `deidResidual` (number). Keep `rowCount` as-is.

- [ ] **Step 4: Run to confirm pass.** `npm run test:suite -- researchExportDeid.test`; `npm run lint:raw-params` clean.

- [ ] **Step 5: Commit.** `git add apps/backend/src/services/research/researchRegistryService.js apps/backend/src/tests/unit/researchExportDeid.test.js && git commit -m "feat(deid): exportRegistry de-identifies free-text CRF cells (opt-in, fail-closed)"`

---

## Task 6: Real-PG integration test

**Files:** Create `apps/backend/src/tests/clinicalTextDeid.deep.test.js`.

- [ ] **Step 1: Read** a registry deep test (`research-registry.deep.test.js`) for the connection + seed helpers (registry, CRF form, enrollment, CRF response). Read `enrollPatient`/`captureCrfResponse` to learn the minimal seed.
- [ ] **Step 2: Write the integration test:** seed a `users` patient (`name:'Ramesh Kumar', phone:'9876543210'`) + a registry + a published CRF form with a free-text field + an enrollment for that patient + a CRF response whose `data` has `{ note: 'Ramesh Kumar, ph 9876543210, febrile' }`. Then:
  - `collectKnownIdentifiers(patientUid, { tenantId })` returns NAME `Ramesh Kumar` + PHONE `9876543210`.
  - `exportRegistry(registryId, { deidentify: true, salt: 's', tenantId })` → the CSV buffer contains neither `Ramesh Kumar` nor `9876543210`, contains a `[NAME-` pseudonym token, and still contains the `subject_code`.
  - `exportRegistry(registryId, { tenantId })` (no de-id) → the CSV DOES contain `Ramesh Kumar` (proves the flag is what changed it).
  - Cleanup: DELETE seeded rows (responses, enrollment, form, registry, user) — zero residue.
- [ ] **Step 3: Run** `npm test -- clinicalTextDeid.deep` (bring QA cluster up via `node scripts/qa-cluster-up.mjs` if connection errors). `npm run lint:raw-params` clean.
- [ ] **Step 4: Commit.** `git add apps/backend/src/tests/clinicalTextDeid.deep.test.js && git commit -m "test(deid): real-PG integration (export de-id + identifier assembly)"`

---

## Task 7: Gates

- [ ] **Step 1: Full lint** `npm run lint` → clean. Watch the import-graph gotcha: `deidentificationService` imports only `prisma` (+ crypto/AppError); the `exportRegistry` de-id import is lazy — confirm no suite that mocks `../../lib/prisma.js` broke (`npm run test:suite -- "researchRegistry|clinicalAiModule"`).
- [ ] **Step 2: Full suite** `npm run test:ci` → must print the literal `All chunks passed` (exit 0 alone can mask a chunk failure). Bring the QA cluster up first.
- [ ] **Step 3: No Ollama smoke** — deterministic feature, no model. (Optional sanity: a tiny node REPL calling `deidentifyText` on a sample string.)
- [ ] **Step 4:** If `lint:fix` changed files, stage only intended ones and commit.

---

## Done criteria
- Unit + integration green; `npm run test:ci` prints `All chunks passed`; `npm run lint` clean; no suite-load regression.
- `clinical_text_deidentifier` `enabled:false`; deterministic (no provider/model). `exportRegistry` default behavior unchanged unless `deidentify:true`.
- Engine is fail-closed (never emits original text on error) and never labels output "certified safe" — only "best-effort + residual report."
- Then: `superpowers:finishing-a-development-branch` → merge to `main` → push both remotes.
