# OPEN-21 Linguistic Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the human-review residual of audit finding OPEN-21 for the Staff and Patient apps in Hindi, Tamil, Telugu and Malayalam: review every first-pass translation, translate the 4,008 Staff Malayalam placeholders, make one term per concept per locale, and record the approval where the ledger looks for it, batch by batch, each batch a green draft PR with an owner approval packet.

**Architecture:** Every batch runs the same pipeline: (1) extract the keys in scope to a five-column table; (2) one native-quality reviewer per locale emits a JSONL decision per key (confirm / change / escalate); (3) an independent back-translation checker re-renders every changed or risk-bearing value into English so meaning drift is caught by someone who never saw the reviewer's reasoning; (4) a reconciler enforces the glossary, placeholder integrity and length rules and produces the apply file, the tracker table and the escalation list; (5) `i18n-review-apply.mjs` writes the decisions into `app_strings.dart` / the ARBs mechanically, removing the `// REVIEW:` flag on approval and moving approved Malayalam into the explicit map; (6) the parity, format, analyze and test gates run; (7) the record lands in the tracker, the two `LANGUAGE_HEALTH.md` tables and the ledger rows. The owner is the human authority: each batch's tracker section is the approval packet; escalations are decided by the owner, never by an agent.

**Tech Stack:** Flutter 3.47.0 (Staff `app_strings.dart` map literal; Patient ARB + `flutter gen-l10n`), Node 26.5 scripts (`apps/staff/scripts/i18n-verify.mjs` parser conventions, `node --test`), melos scripts (`i18n-parity-check`, `gen-staff-ml-parity`, `format`, `analyze`, `test`), review agents (Opus per locale; Fable for the clinical-safety reconciliation of dose/consent/emergency/identity batches).

---

## What OPEN-21 is, measured on `main` `e53dae66d` (2026-09-05)

| Surface | Locale | Keys | First-pass to review | Placeholders to translate | `// REVIEW:` flags |
|---|---|---:|---:|---:|---:|
| Staff `apps/staff/lib/l10n/app_strings.dart` | hi | 6,598 | 6,598 | 0 | 501 |
| Staff | ta | 6,598 | 6,598 | 0 | 954 |
| Staff | te | 6,598 | 6,598 | 0 | 955 |
| Staff | ml | 6,598 | 2,590 explicit | **4,008** (`app_strings_ml_parity.g.dart`, English copied verbatim) | 18 |
| Patient `apps/patient/lib/l10n/intl_{hi,ta,te,ml}.arb` | each | 1,447 | 1,447 | 0 | 388 `@` descriptions say "machine-translated and marked for review" |
| Backend presentation contracts | 4 non-en | 3 contracts × fields | 28 | 0 | — |

Held OUTSIDE this plan (the ledger says no technical lane may approve them; the owner decides who signs):
- Payment-link wording: `apps/backend/src/services/billing/paymentLinkService.js:35-52` (frozen English + one Hindi line for all five locales) — **finance + linguistic**.
- Dependent guardianship / relationship / consent copy: `apps/patient/lib/features/family/screens/family_screen.dart:784-840` — **legal + linguistic**.
- Staff Web activation copy: `apps/staff/lib/main.dart:475-484` — **operator / release ownership**.
- Admin console: zero locale resources — **owner scope decision**.
- Three signed attestations exempt in `DELIBERATE_ENGLISH_FALLBACK` (`clinical_inbox.action.attestation`, `ed_trauma.continuity.external_attestation`, `s4.lib.referrals.continue_ownership`) — the deploying hospital's approved text; reviewers **confirm, never rewrite**.

Programme terms kept in Latin script in every locale, confirm-not-fix: `ABHA`, `OTP`, `Aadhaar` (rendered as the standard local form where one exists), `HIV`, `HBsAg`, `HCV`, device tags like `RP00000042`, unit strings (`g/dL`, `mmol/L`).

Two test pins a reviewer must not break:
- `apps/staff/test/i18n_guard_test.dart:36-46` pins `continuity.unknown.allergy` and `continuity.unknown.code_status` to their English text in all five locales (Task 1 documents them as deliberate).
- `apps/staff/test/features/nursing/mar_supply_i18n_test.dart:80-92` pins `mar_supply.allocation` to `'வார்டு ஒதுக்கீடு'` (ta) and `'వార్డు కేటాయింపు'` (te); `apps/staff/test/core/utils/api_error_messages_test.dart:133-136` pins one Hindi re-auth message; `apps/backend/src/tests/unit/paymentGatewayService.test.js:302` pins the `ml` gateway-refund title. If a reviewer changes one of these renderings, the same commit updates the pin and the tracker row says so.

One widget-test hazard: `find.text(ml.someKey)` … `findsOneWidget` in `appointment_about_l10n_test.dart:122`, `safe_presentation_l10n_test.dart:140`, `safe_presentation_batch3_l10n_test.dart:141` (patient) and `apps/staff/test/.../safe_presentation_batch3_l10n_test.dart:132`. Unifying two concepts to one rendering on the same screen turns one match into two. The consistency pass (Task 3) runs `melos run test` and treats such a failure as "these two keys are different concepts on one screen; keep them distinct".

## Review protocol (used by every batch)

**Inputs per key** (one row of the batch table): `key`, `en`, current locale value, `domain` (first key segment, e.g. `s4.lib.cath_lab`, `payroll`), `surface` (button / label / sentence / error / hint — inferred from the key's last segment and length), glossary entries for the concepts in `en`.

**Reviewer output** — one JSON object per line, file `scratchpad/open21/<batch>/<locale>.review.jsonl`:

```json
{"key":"s4.lib.cath_lab.readiness.state.stale","locale":"ta","verdict":"change","value":"முடிவு காலாவதியானது","reason":"'மிகப் பழையது' reads as 'very old' (age), not 'no longer valid'; clinical register uses காலாவதி","risk":"clinical"}
{"key":"s4.lib.cath_lab.readiness.item.hb","locale":"ta","verdict":"confirm","value":"ஹீமோகுளோபின்","reason":"standard transliteration used by Tamil Nadu lab reports","risk":"none"}
{"key":"abhaEnrolAadhaarIntro","locale":"ml","verdict":"escalate","value":null,"reason":"two defensible renderings of 'used for OTP verification' with different consent scope; owner/legal to pick","risk":"identity"}
```

`verdict` ∈ `confirm | change | escalate`; `risk` ∈ `none | clinical | legal | identity | finance | security`. Rules the reviewer follows, verbatim in every reviewer brief:
1. Preserve every placeholder exactly: `{name}`, `{count}`, `{date}`, `$var`, and ICU plural/select syntax in ARBs. A changed placeholder is a build break, not a wording choice.
2. Keep programme terms and units in their Latin forms (list above). Keep test-pinned renderings unless the pin is being changed in the same batch.
3. One term per concept per locale: use the glossary rendering; if the glossary has none, propose one in `reason` prefixed `GLOSSARY:` and use it consistently within the batch.
4. Register: patient-facing copy is plain, respectful, second person; staff copy is concise clinical register. Prefer the established native clinical term over transliteration unless the glossary (or Tamil Nadu / Kerala / AP-Telangana / Hindi-belt hospital usage) prefers the transliteration (e.g. `டிஸ்சார்ஜ்` is common in Tamil hospitals; the glossary decides once).
5. Buttons and chips: rendered length ≤ 1.6 × the English length; if impossible, `escalate` with a shorter alternative in `reason`.
6. Meaning first: a rendering that is grammatical but changes what the user believes (consent scope, who is notified, whether something is blocked) is `change` with `risk` set, or `escalate` if two readings are defensible.
7. Never "fix" a deliberately English value (the confirm-not-fix list); emit `confirm`.
8. Do not translate keys marked dead in `apps/staff/docs/LANGUAGE_HEALTH.md` (`reception_counter.*` except the eight live ones); emit `confirm` with reason `dead surface`.

**Back-translation checker** — a second agent that sees ONLY `key`, `locale`, and the proposed `value` (never `en`, never the reviewer's reason) and returns `{"key","locale","back_en":"..."}`. Runs on every `change` and on every key with `risk != none`. The reconciler compares `back_en` to `en`; a meaning mismatch becomes `escalate`.

**Reconciler** (agent, Fable for dose/consent/emergency/identity batches, Opus otherwise) produces three files per batch: `apply.jsonl` (only `confirm` and `change` rows, schema `{"key","locale","value","approved":true,"changed":true|false}`), `tracker.md` (the section for `docs/TRANSLATION_REVIEW_TRACKER.md`: reviewer, locales, commit reviewed, counts, and a table of changed keys `key | locale | old | new | reason`), and `escalations.md` (the owner's decisions list: key, locale, the candidate renderings, what differs). Escalated keys are NOT applied and keep their `// REVIEW:` flag.

**Owner packet** = `tracker.md` + `escalations.md`, attached to the batch PR body. The owner's approval (a reply naming the batch) is what turns the tracker's `Pending` into `Partial — <batch> approved <date> (owner)`. HELD-12 stays held until the held categories are signed by their named signatories.

## File Structure

- Create: `apps/staff/scripts/i18n-review-apply.mjs` — applies a JSONL of decisions to `app_strings.dart` (value replace, `// REVIEW:` removal, explicit-`ml` insertion). One responsibility: mechanical edits, no judgement.
- Create: `apps/staff/scripts/i18n-review-apply.test.mjs` — `node --test` coverage on a fixture map.
- Create: `apps/patient/scripts/i18n-review-apply.mjs` + `.test.mjs` — the ARB twin (value replace in `intl_<loc>.arb`, `@key.description` approval note in `intl_en.arb`).
- Create: `docs/i18n/GLOSSARY.md` — canonical rendering per concept per locale, with the decision's reason and date. Consulted by every reviewer brief; extended by every batch.
- Modify: `apps/staff/scripts/i18n-verify.mjs` — `DELIBERATE_ENGLISH_FALLBACK` gains the two `continuity.unknown.*` keys with reasons (they are already pinned English by test).
- Modify per batch: `apps/staff/lib/l10n/app_strings.dart`, `apps/staff/lib/l10n/app_strings_ml_parity.g.dart` (regenerated), `apps/patient/lib/l10n/intl_*.arb`, `apps/patient/lib/generated/*` (regenerated), `docs/TRANSLATION_REVIEW_TRACKER.md`, `apps/staff/docs/LANGUAGE_HEALTH.md`, `apps/patient/docs/LANGUAGE_HEALTH.md`.
- Modify at milestones: `docs/FULL_REPOSITORY_AUDIT_2026_08.md` (OPEN-21 row residual counts; HELD-12 clause), `docs/ROADMAP.md` (OPEN-21 bullets).
- Scratch (not committed): `scratchpad/open21/<batch>/{keys.md,<loc>.review.jsonl,<loc>.back.jsonl,apply.jsonl,tracker.md,escalations.md}`.

Branch: `feat/open21-linguistic-review` for Task 0–2 (tooling + glossary + batch 1); later batches on `feat/open21-b<N>-<name>` off the then-current `main`, one draft PR each, handed to the coordinating session green with head SHA and both gates by name.

---

### Task 0: Staff apply tool

**Files:**
- Create: `apps/staff/scripts/i18n-review-apply.mjs`
- Test: `apps/staff/scripts/i18n-review-apply.test.mjs`

`app_strings.dart` shape (from `apps/staff/scripts/i18n-verify.mjs:96-170`): the map `static const Map<String, Map<String, String>> _byLang = {` at line 3729; locale blocks `'en': {`, `'hi': {`, `'ta': {`, `'te': {`, `'ml': {` each closed by `    },`; entries are `      'key': 'value',` possibly split across adjacent single-quoted literals on continuation lines; a first-pass entry has `      // REVIEW: <text>` on the line(s) immediately above it. Dart escapes inside single-quoted literals: `\'`, `\\`, `\$`, `\n`.

- [ ] **Step 1: Write the failing tests**

```js
// apps/staff/scripts/i18n-review-apply.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDecisions, dartString } from './i18n-review-apply.mjs';

const FIXTURE = `class AppStrings {
  static const Map<String, Map<String, String>> _byLang = {
    'en': {
      'a.one': 'One',
      'a.two': 'Two {count}',
      'a.three': 'Three',
    },
    'hi': {
      // REVIEW: AI first-pass
      'a.one': 'एक',
      'a.two': 'दो {count}',
      // REVIEW: security wording
      // REVIEW: second flag line
      'a.three': 'तीन',
    },
    'ml': {
      'a.one': 'ഒന്ന്',
    },
  };
}
`;

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-apply-'));
  const file = join(dir, 'app_strings.dart');
  writeFileSync(file, FIXTURE);
  fn(file);
  return readFileSync(file, 'utf8');
}

test('dartString escapes quotes, backslashes, dollars and newlines', () => {
  assert.equal(dartString(`it's \\ $x\nnext`), `'it\\'s \\\\ \\$x\\nnext'`);
});

test('a confirm removes the REVIEW flag and leaves the value', () => {
  const out = withFixture((f) => applyDecisions(f, [
    { key: 'a.one', locale: 'hi', value: 'एक', approved: true, changed: false },
  ]));
  assert.ok(!/REVIEW: AI first-pass/.test(out));
  assert.ok(out.includes(`      'a.one': 'एक',`));
});

test('a change replaces the value and removes every REVIEW line above it', () => {
  const out = withFixture((f) => applyDecisions(f, [
    { key: 'a.three', locale: 'hi', value: "तीन'", approved: true, changed: true },
  ]));
  assert.ok(!/REVIEW: security wording/.test(out));
  assert.ok(!/REVIEW: second flag line/.test(out));
  assert.ok(out.includes(`      'a.three': 'तीन\\'',`));
});

test('an approved ml value for a key without an explicit entry is inserted into the ml block', () => {
  const out = withFixture((f) => applyDecisions(f, [
    { key: 'a.two', locale: 'ml', value: 'രണ്ട് {count}', approved: true, changed: true },
  ]));
  const ml = out.slice(out.indexOf(`'ml': {`), out.indexOf(`  };`));
  assert.ok(ml.includes(`      'a.two': 'രണ്ട് {count}',`));
  assert.ok(ml.indexOf(`'a.one'`) < ml.indexOf(`'a.two'`), 'appended after existing entries');
});

test('placeholders must survive: a value dropping {count} is rejected', () => {
  assert.throws(() => withFixture((f) => applyDecisions(f, [
    { key: 'a.two', locale: 'hi', value: 'दो', approved: true, changed: true },
  ])), /placeholder/);
});

test('unknown key or locale is rejected and nothing is written', () => {
  const out = withFixture((f) => {
    assert.throws(() => applyDecisions(f, [{ key: 'nope', locale: 'hi', value: 'x', approved: true, changed: true }]), /unknown key/);
  });
  assert.equal(out, FIXTURE);
});

test('re-applying the same decisions is a no-op', () => {
  const decisions = [{ key: 'a.one', locale: 'hi', value: 'एक', approved: true, changed: false }];
  const once = withFixture((f) => applyDecisions(f, decisions));
  const twice = withFixture((f) => { applyDecisions(f, decisions); applyDecisions(f, decisions); });
  assert.equal(once, twice);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from repo root, `export PATH="/d/Dev/Tools/node-26.5.0:$PATH"`): `node --test apps/staff/scripts/i18n-review-apply.test.mjs`
Expected: FAIL — `Cannot find module './i18n-review-apply.mjs'`.

- [ ] **Step 3: Implement the tool**

```js
#!/usr/bin/env node
// apps/staff/scripts/i18n-review-apply.mjs
//
// Applies linguistic-review decisions to lib/l10n/app_strings.dart.
// Decisions are JSONL rows: {"key","locale","value","approved":true,"changed":bool}.
// For each approved row: the entry's value is set to `value` (a no-op when equal),
// every `// REVIEW:` line immediately above the entry is removed (approval IS the
// flag's removal — see i18n-verify.mjs), and an `ml` row whose key has no explicit
// entry is appended to the 'ml' block so the generated parity placeholder can be
// dropped by `--generate-ml-parity`. Nothing else in the file is touched.
//
// Usage: node apps/staff/scripts/i18n-review-apply.mjs <decisions.jsonl> [--file <app_strings.dart>]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOCALES = new Set(['en', 'hi', 'ta', 'te', 'ml']);
const PLACEHOLDER_RE = /\{[a-zA-Z0-9_]+\}/g;

export function dartString(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n');
  return `'${escaped}'`;
}

function placeholders(text) {
  return [...String(text).matchAll(PLACEHOLDER_RE)].map((m) => m[0]).sort();
}

// Decode a Dart single-quoted literal body (the inverse of dartString for the
// escapes this file uses).
function decodeDart(body) {
  return body
    .replace(/\\n/g, '\n')
    .replace(/\\\$/g, '$')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

function localeBlocks(lines) {
  // Returns { hi: {start, end}, ... } as line indices of the block's own
  // entries (exclusive of the `'hi': {` and closing `},` lines).
  const blocks = {};
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s{4}'(en|hi|ta|te|ml)'\s*:\s*\{\s*$/);
    if (m) { open = m[1]; blocks[open] = { start: i + 1, end: -1 }; continue; }
    if (open && /^\s{4}\},?\s*$/.test(lines[i])) { blocks[open].end = i; open = null; }
  }
  return blocks;
}

// Finds the entry for `key` inside a block: returns {line, endLine, value} where
// the entry may span continuation lines of adjacent literals ending with `,`.
function findEntry(lines, block, key) {
  const head = new RegExp(`^\\s{6}'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:\\s*`);
  for (let i = block.start; i < block.end; i += 1) {
    if (!head.test(lines[i])) continue;
    let endLine = i;
    while (!/,\s*$/.test(lines[endLine]) && endLine < block.end) endLine += 1;
    const joined = lines.slice(i, endLine + 1).join('\n').replace(head, '');
    const literals = [...joined.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => decodeDart(m[1]));
    return { line: i, endLine, value: literals.join('') };
  }
  return null;
}

function stripReviewAbove(lines, index) {
  let i = index - 1;
  let removed = 0;
  while (i >= 0 && /^\s{6}\/\/ REVIEW:/.test(lines[i])) { lines.splice(i, 1); removed += 1; i -= 1; }
  return removed;
}

export function applyDecisions(filePath, decisions) {
  const original = readFileSync(filePath, 'utf8');
  const lines = original.split('\n');
  const blocks = localeBlocks(lines);
  const en = blocks.en;
  if (!en) throw new Error(`'en' block not found in ${filePath}`);

  // Validate everything before writing anything.
  for (const d of decisions) {
    if (!d.approved) continue;
    if (!LOCALES.has(d.locale) || d.locale === 'en') throw new Error(`unknown locale ${d.locale} for ${d.key}`);
    const enEntry = findEntry(lines, en, d.key);
    if (!enEntry) throw new Error(`unknown key ${d.key}`);
    const want = placeholders(enEntry.value).join(',');
    const got = placeholders(d.value).join(',');
    if (want !== got) throw new Error(`placeholder mismatch for ${d.key} (${d.locale}): en has [${want}], value has [${got}]`);
  }

  // Apply bottom-up per block so line indices stay valid.
  const sorted = [...decisions].filter((d) => d.approved).sort((a, b) => {
    const ea = findEntry(lines, blocks[a.locale], a.key)?.line ?? Infinity;
    const eb = findEntry(lines, blocks[b.locale], b.key)?.line ?? Infinity;
    return eb - ea;
  });
  for (const d of sorted) {
    const block = localeBlocks(lines)[d.locale];
    const entry = findEntry(lines, block, d.key);
    if (entry) {
      lines.splice(entry.line, entry.endLine - entry.line + 1, `      '${d.key}': ${dartString(d.value)},`);
      stripReviewAbove(lines, entry.line);
    } else if (d.locale === 'ml') {
      lines.splice(block.end, 0, `      '${d.key}': ${dartString(d.value)},`);
    } else {
      throw new Error(`no ${d.locale} entry for ${d.key}; only ml may be inserted`);
    }
  }
  const out = lines.join('\n');
  if (out !== original) writeFileSync(filePath, out);
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const fileFlag = args.indexOf('--file');
  const here = dirname(fileURLToPath(import.meta.url));
  const file = fileFlag >= 0 ? resolve(args[fileFlag + 1]) : resolve(here, '../lib/l10n/app_strings.dart');
  const jsonl = args.find((a) => a.endsWith('.jsonl'));
  if (!jsonl) { console.error('usage: i18n-review-apply.mjs <decisions.jsonl> [--file app_strings.dart]'); process.exit(2); }
  const decisions = readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  applyDecisions(file, decisions);
  const approved = decisions.filter((d) => d.approved);
  console.log(`applied ${approved.length} decisions (${approved.filter((d) => d.changed).length} changed) to ${file}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test apps/staff/scripts/i18n-review-apply.test.mjs`
Expected: `# pass 7` / `# fail 0`.

- [ ] **Step 5: Prove it on the real file without changing it**

Run: `node apps/staff/scripts/i18n-review-apply.mjs /dev/null 2>&1 || true` (usage line), then a dry run that applies a `confirm` of an existing value and diffs: create `scratchpad/open21/smoke.jsonl` with `{"key":"login.locked_title","locale":"hi","value":"<current hi value copied verbatim>","approved":true,"changed":false}`, run the tool, and `git diff --stat apps/staff/lib/l10n/app_strings.dart`.
Expected: only the `// REVIEW:` line above `login.locked_title` in the `hi` block is removed (1 deletion). Then `git checkout -- apps/staff/lib/l10n/app_strings.dart`.

- [ ] **Step 6: Commit**

```bash
git add apps/staff/scripts/i18n-review-apply.mjs apps/staff/scripts/i18n-review-apply.test.mjs
git commit -m "chore(i18n): staff review-apply tool (value replace, REVIEW-flag removal, explicit ml insertion)" -- apps/staff/scripts/i18n-review-apply.mjs apps/staff/scripts/i18n-review-apply.test.mjs
```

### Task 1: Patient apply tool

**Files:**
- Create: `apps/patient/scripts/i18n-review-apply.mjs`
- Test: `apps/patient/scripts/i18n-review-apply.test.mjs`

ARB shape: `apps/patient/lib/l10n/intl_<loc>.arb` is JSON, two-space indent, keys in insertion order, `@key` metadata objects (`description`, `placeholders`) mostly in `intl_en.arb` (1,199) and partly in the others (259–451). 388 `intl_en.arb` descriptions contain the phrase `hi/ta/te/ml values are machine-translated and marked for review`.

- [ ] **Step 1: Write the failing tests**

```js
// apps/patient/scripts/i18n-review-apply.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyArbDecisions } from './i18n-review-apply.mjs';

const EN = {
  '@@locale': 'en',
  greet: 'Hello {name}',
  '@greet': { description: 'Greeting. hi/ta/te/ml values are machine-translated and marked for review.', placeholders: { name: {} } },
  bye: 'Bye',
  '@bye': { description: 'Farewell.' },
};
const HI = { '@@locale': 'hi', greet: 'नमस्ते {name}', bye: 'अलविदा' };

function withArbs(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'arb-apply-'));
  mkdirSync(join(dir, 'l10n'));
  writeFileSync(join(dir, 'l10n', 'intl_en.arb'), JSON.stringify(EN, null, 2) + '\n');
  writeFileSync(join(dir, 'l10n', 'intl_hi.arb'), JSON.stringify(HI, null, 2) + '\n');
  fn(join(dir, 'l10n'));
  return {
    en: JSON.parse(readFileSync(join(dir, 'l10n', 'intl_en.arb'), 'utf8')),
    hi: JSON.parse(readFileSync(join(dir, 'l10n', 'intl_hi.arb'), 'utf8')),
    raw: readFileSync(join(dir, 'l10n', 'intl_hi.arb'), 'utf8'),
  };
}

test('a change replaces the locale value and keeps key order and formatting', () => {
  const r = withArbs((d) => applyArbDecisions(d, [
    { key: 'greet', locale: 'hi', value: 'नमस्कार {name}', approved: true, changed: true },
  ], { date: '2026-09-05' }));
  assert.equal(r.hi.greet, 'नमस्कार {name}');
  assert.deepEqual(Object.keys(r.hi), ['@@locale', 'greet', 'bye']);
  assert.ok(r.raw.endsWith('}\n'));
});

test('approval rewrites the en description review phrase with the approved locales and date', () => {
  const r = withArbs((d) => applyArbDecisions(d, [
    { key: 'greet', locale: 'hi', value: 'नमस्ते {name}', approved: true, changed: false },
  ], { date: '2026-09-05' }));
  assert.match(r.en['@greet'].description, /approved hi 2026-09-05/);
  assert.doesNotMatch(r.en['@greet'].description, /machine-translated and marked for review/);
});

test('a second locale approval appends to the approved list', () => {
  const r = withArbs((d) => {
    applyArbDecisions(d, [{ key: 'greet', locale: 'hi', value: 'नमस्ते {name}', approved: true, changed: false }], { date: '2026-09-05' });
    // simulate a ta file for the second approval
    writeFileSync(join(d, 'intl_ta.arb'), JSON.stringify({ '@@locale': 'ta', greet: 'வணக்கம் {name}', bye: 'போய் வருகிறேன்' }, null, 2) + '\n');
    applyArbDecisions(d, [{ key: 'greet', locale: 'ta', value: 'வணக்கம் {name}', approved: true, changed: false }], { date: '2026-09-06' });
  }, { date: '2026-09-05' });
  assert.match(r.en['@greet'].description, /approved hi 2026-09-05; ta 2026-09-06/);
});

test('placeholder loss is rejected', () => {
  assert.throws(() => withArbs((d) => applyArbDecisions(d, [
    { key: 'greet', locale: 'hi', value: 'नमस्ते', approved: true, changed: true },
  ], { date: '2026-09-05' })), /placeholder/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test apps/patient/scripts/i18n-review-apply.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
#!/usr/bin/env node
// apps/patient/scripts/i18n-review-apply.mjs
// Applies review decisions to intl_<loc>.arb and records approval in intl_en.arb's
// @key.description ("... approved <loc> <date>[; <loc> <date>]"), replacing the
// "hi/ta/te/ml values are machine-translated and marked for review" phrase when present.
// Usage: node apps/patient/scripts/i18n-review-apply.mjs <decisions.jsonl> [--dir lib/l10n] [--date YYYY-MM-DD]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REVIEW_PHRASE = /\s*hi\/ta\/te\/ml values are machine-translated and marked for review\.?/;
const PLACEHOLDER_RE = /\{[a-zA-Z0-9_]+\}/g;
const ph = (s) => [...String(s).matchAll(PLACEHOLDER_RE)].map((m) => m[0]).sort().join(',');

function readArb(dir, loc) {
  const raw = readFileSync(join(dir, `intl_${loc}.arb`), 'utf8');
  return { json: JSON.parse(raw), trailingNewline: raw.endsWith('\n') };
}
function writeArb(dir, loc, json, trailingNewline) {
  writeFileSync(join(dir, `intl_${loc}.arb`), JSON.stringify(json, null, 2) + (trailingNewline ? '\n' : ''));
}

export function applyArbDecisions(dir, decisions, { date }) {
  const en = readArb(dir, 'en');
  const byLoc = new Map();
  for (const d of decisions) {
    if (!d.approved) continue;
    if (!(d.key in en.json)) throw new Error(`unknown key ${d.key}`);
    if (ph(en.json[d.key]) !== ph(d.value)) throw new Error(`placeholder mismatch for ${d.key} (${d.locale})`);
    if (!byLoc.has(d.locale)) byLoc.set(d.locale, readArb(dir, d.locale));
    const arb = byLoc.get(d.locale);
    if (!(d.key in arb.json)) throw new Error(`no ${d.locale} entry for ${d.key}`);
    arb.json[d.key] = d.value;
    const meta = en.json[`@${d.key}`] ?? (en.json[`@${d.key}`] = {});
    const base = String(meta.description ?? '').replace(REVIEW_PHRASE, '').trim();
    const stamp = `${d.locale} ${date}`;
    const m = base.match(/^(.*?)(?:\s*approved ([^.]*))?\.?$/s);
    const prior = m && m[2] ? m[2].split(';').map((s) => s.trim()).filter(Boolean) : [];
    const list = prior.filter((p) => !p.startsWith(`${d.locale} `)).concat(stamp);
    meta.description = `${(m ? m[1] : base).trim()} approved ${list.join('; ')}.`.replace(/^\s*approved/, 'approved');
  }
  for (const [loc, arb] of byLoc) writeArb(dir, loc, arb.json, arb.trailingNewline);
  writeArb(dir, 'en', en.json, en.trailingNewline);
}

function main() {
  const args = process.argv.slice(2);
  const here = dirname(fileURLToPath(import.meta.url));
  const dirFlag = args.indexOf('--dir');
  const dateFlag = args.indexOf('--date');
  const dir = dirFlag >= 0 ? resolve(args[dirFlag + 1]) : resolve(here, '../lib/l10n');
  const date = dateFlag >= 0 ? args[dateFlag + 1] : new Date().toISOString().slice(0, 10);
  const jsonl = args.find((a) => a.endsWith('.jsonl'));
  if (!jsonl) { console.error('usage: i18n-review-apply.mjs <decisions.jsonl> [--dir lib/l10n] [--date YYYY-MM-DD]'); process.exit(2); }
  const decisions = readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  applyArbDecisions(dir, decisions, { date });
  console.log(`applied ${decisions.filter((d) => d.approved).length} decisions; run: cd apps/patient && flutter gen-l10n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test apps/patient/scripts/i18n-review-apply.test.mjs` — Expected: `# pass 4`.

- [ ] **Step 5: Confirm the real ARBs round-trip byte-identically through the writer**

Run a Node one-liner that reads each `apps/patient/lib/l10n/intl_*.arb`, `JSON.stringify(JSON.parse(raw), null, 2) + '\n'`, and compares to `raw`. Expected: identical for all five (if not, the writer must mirror the existing indentation/newline; fix before proceeding).

- [ ] **Step 6: Commit**

```bash
git add apps/patient/scripts/i18n-review-apply.mjs apps/patient/scripts/i18n-review-apply.test.mjs
git commit -m "chore(i18n): patient ARB review-apply tool with approval stamps in en descriptions" -- apps/patient/scripts/i18n-review-apply.mjs apps/patient/scripts/i18n-review-apply.test.mjs
```

### Task 2: Glossary and the confirm-not-fix list

**Files:**
- Create: `docs/i18n/GLOSSARY.md`
- Modify: `apps/staff/scripts/i18n-verify.mjs:69-95` (`DELIBERATE_ENGLISH_FALLBACK`)
- Modify: `docs/TRANSLATION_REVIEW_TRACKER.md` (a "Confirm, do not fix" list)

- [ ] **Step 1: Seed the glossary from the terminology report**

Create `docs/i18n/GLOSSARY.md` with this header and the initial rows (decided in Task 3's review; until then the rows carry `pending` in the decision column so reviewers propose rather than assume):

```markdown
# Five-locale glossary (Staff + Patient apps)

One rendering per concept per locale. A reviewer who needs a term not listed here
proposes it in the review row (`GLOSSARY:` prefix) and the batch adds it. A change
to an existing row is a reviewed decision recorded with date and reason, and is
applied to every key that uses the concept in the same batch.

Kept in Latin script in every locale (confirm, do not translate): ABHA, OTP, HIV,
HBsAg, HCV, unit strings (g/dL, mmol/L, 10^3/uL), device tags (RP…), drug and
test codes as printed on reports. Aadhaar uses the standard local form
(hi आधार, ta ஆதார், te ఆధార్, ml ആധാർ).

| Concept (en) | hi | ta | te | ml | Decision / reason | Date |
|---|---|---|---|---|---|---|
| Critical (value/alert) | गंभीर | pending (not முக்கியம் = important) | pending (క్లిష్టమైన vs క్రిటికల్) | ഗുരുതരം | Tamil today has 5 renderings, 3 meaning "important" | |
| Urgent (priority) | pending | pending | pending | pending | 3 renderings per locale today | |
| Emergency | pending | pending | pending | pending | | |
| Discharge (from hospital) | pending | pending (டிஸ்சார்ஜ் vs வெளியேற்றம்) | pending | pending (ഡിസ്ചാർജ്) | | |
| Prescription | pending (प्रिस्क्रिप्शन vs नुस्खा) | pending | pending | pending | | |
| Dose / Dosage | pending | pending (அளவு / மருந்தளவு / டோஸ்) | pending | pending | | |
| Platelets | pending | pending (பிளேட்லெட்டுகள் vs தட்டணுக்கள்) | pending | pending | | |
| Haemoglobin | pending | pending | pending | pending | lab names are mostly backend-driven; keep the report form | |
| Creatinine | (single rendering today) | | | | keep | |
| Potassium | (single rendering today) | | | | keep | |
| Cancel (button) | pending | pending (4 today) | pending (3 today) | pending | | |
| Waive | pending | pending | pending | pending | | |
| Consent | pending | pending | pending | pending | | |
```

- [ ] **Step 2: Document the two test-pinned English strings as deliberate**

In `apps/staff/scripts/i18n-verify.mjs`, add to `DELIBERATE_ENGLISH_FALLBACK` (keep the object's existing style; each entry is `key: 'reason'`):

```js
  'continuity.unknown.allergy':
    'Pinned English in all five locales by apps/staff/test/i18n_guard_test.dart:36-46 — a continuity UNKNOWN marker read by clinicians across language settings; reviewers confirm, do not translate.',
  'continuity.unknown.code_status':
    'Pinned English in all five locales by apps/staff/test/i18n_guard_test.dart:36-46 — same class as continuity.unknown.allergy.',
```

Run: `node apps/staff/scripts/i18n-verify.mjs --check` — Expected: green, and the summary line's `[+N declared English fallback]` goes from 3 to 5. If the checker reports the two keys as "stale exemption" (it validates that an exempted key actually is English in every locale), read `i18n-verify.mjs:667-672` and adjust: the exemption applies only when the locale values equal English, which they do.

- [ ] **Step 3: Add the "Confirm, do not fix" list to the tracker**

Append to `docs/TRANSLATION_REVIEW_TRACKER.md` under a new heading `## Confirm, do not fix (all locales)`: the three attestations, the two `continuity.unknown.*` keys, `abhaEnrolOtpLabel`, the `DELIBERATE_ENGLISH_VALUES` allowlist of the patient verifier (`authPhonePrefix`, `profileEmailHint`, `vitalsSpO2`, `splashAppName`, `aboutHospitalName`, `ancBpLabel`, `ancFhrLabel`, `ancHbLabel`, `yourHealthTimelineRxPill`, `teleconsultBadge`, `abdmNumberHint`, `abdmAddressHint`), the programme terms, and the test-pinned renderings listed at the top of this plan, each with the reason.

- [ ] **Step 4: Gates and commit**

Run: `node apps/staff/scripts/i18n-verify.mjs --check && node apps/patient/scripts/i18n-verify.mjs --check`
Expected: both green.

```bash
git add docs/i18n/GLOSSARY.md apps/staff/scripts/i18n-verify.mjs docs/TRANSLATION_REVIEW_TRACKER.md
git commit -m "docs(i18n): five-locale glossary seed, confirm-not-fix list, continuity UNKNOWN pins declared" -- docs/i18n/GLOSSARY.md apps/staff/scripts/i18n-verify.mjs docs/TRANSLATION_REVIEW_TRACKER.md
```

### Task 3: Batch 1 — the 96 cath strings (Plans 2 and 3)

**Files:**
- Inputs: `scratchpad/open21/b1/keys.md` (copy of `scratchpad/open21-cath-keys.md`: 96 keys × en/hi/ta/te/ml)
- Outputs: `scratchpad/open21/b1/{hi,ta,te,ml}.review.jsonl`, `{hi,ta,te,ml}.back.jsonl`, `apply.jsonl`, `tracker.md`, `escalations.md`
- Modify: `apps/staff/lib/l10n/app_strings.dart` (via the tool), `docs/i18n/GLOSSARY.md`, `docs/TRANSLATION_REVIEW_TRACKER.md`, `apps/staff/docs/LANGUAGE_HEALTH.md`

Scope facts: 23 keys from #1004 + 73 from #1008; all four locales have explicit values (no `ml` placeholders); no `// REVIEW:` flags exist on them (Plans 2 and 3 did not add flags — the tracker note in the plans is the only marker); four values are English in every locale by design (`readiness.item.hiv/hbsag/hcv`, `consumables.device_tag_hint`).

- [x] **Step 1: Reviewer runs (four agents, one per locale, in parallel)**

Each reviewer receives: the protocol rules 1–8 verbatim, the five-column table, the glossary, the domain note ("cath lab: interventional cardiology staff app; readiness = pre-procedure lab checklist; reuse = reprocessed catheters/guidewires; audience = cath lab staff, nurses, cardiologists, CSSD, infection control; RECEPTIONIST/TECHNICIAN see state labels but not serology values"), and writes `<loc>.review.jsonl` with one row per key (96 rows, every row has a verdict). Expected outcome: mostly `confirm`; `change` where a rendering is wrong in register or meaning (the inventory already flags Tamil "critical" ≠ "important", and Platelets `தட்டணுக்கள்` vs the blood-bank `பிளேட்லெட்டுகள்`); `escalate` only for genuine ambiguity.

- [x] **Step 2: Back-translation runs (one agent per locale)**

Input: the rows with `verdict == change` or `risk != none` — only `key`, `locale`, `value`. Output `<loc>.back.jsonl` rows `{"key","locale","back_en"}`.

- [x] **Step 3: Reconcile (one agent; Fable, since the batch carries clinical state labels and a critical-value warning)**

Inputs: the four review files, the four back-translation files, the key table, the glossary, and the **external human review of 2026-09-05** (`scratchpad/open21/external-review-2026-09-05.md`, forwarded by the owner; disposition REQUEST CHANGES). The human review is authoritative where it speaks; an agent reviewer's choice that conflicts with it survives only when it rests on a verified code fact (e.g. a rendering that collides with another label on the same screen), and then the conflict is an owner escalation, never a silent agent choice.

Produces `apply.jsonl` (confirm + change rows), `en.changes.jsonl` (English SOURCE changes the human review requires: `state.result_final` → "Final result", `check.timeout` → "Procedure safety time-out", `confirm_critical` / `confirm_critical_unnamed` → "…Give a reason for marking this check as passed despite the critical result.", `post_use_device_already_discarded` → "CSSD has already marked this device as discarded; post-use disposition recorded." — each with its four locale renderings), `tracker.md`, `escalations.md`, and glossary rows for every `GLOSSARY:` proposal. Checks: placeholders identical to `en`; button/chip length ≤ 1.6× measured in rendered grapheme clusters; back-translation meaning matches `en`; one rendering per concept across the 96 keys (exposure flag ≠ infection ≠ infection risk; acknowledgement ≠ consent; discarded ≠ destroyed ≠ deleted; critical ≠ important/complex; pass is a check status, never "normal"); English-by-design keys are `confirm`.

- [x] **Step 3b: English source changes carry their tests**

An `en` change edits the `'en'` block and, in the same commit, every place that asserts or matches the OLD English text anywhere in the repository: `git grep -n -F "<old text>" -- . ':!apps/staff/lib/l10n/app_strings.dart'` (Staff and Patient tests, Maestro flows, admin tests and snapshots, backend fixtures and log/analytics literals, docs). A hit in a surface this lane does not own is reported to the coordinator, not edited. The old locale translations of a changed source are NEVER carried across: all four locale values come from `en.changes.jsonl`, rendered against the new English, and the tracker's source-change table shows the five values as one row. The Staff cath widget tests (`test/features/cath_lab/*`) and the five-locale pins must stay green.

- [x] **Step 4: Apply and regenerate**

```bash
node apps/staff/scripts/i18n-review-apply.mjs scratchpad/open21/b1/apply.jsonl
melos run gen-staff-ml-parity          # no-op expected (no ml placeholders in this batch) but keeps the file honest
node apps/staff/scripts/i18n-verify.mjs --check
```

Expected: `git diff --stat` shows only `app_strings.dart` lines for the changed keys; `--check` green.

- [x] **Step 5: Flutter gates**

```bash
cd apps/staff && flutter analyze && flutter test test/features/cath_lab test/i18n_guard_test.dart && cd ../..
melos run format
```

Expected: analyze unchanged (0 in cath_lab), the cath tests green (the five-locale pins `Cath consumable copy…` and `Cath readiness copy…` enumerate keys, not renderings), format clean. If `dart format` reflows a long line, run `dart format apps/staff/lib/l10n/app_strings.dart` and re-run `--check`.

- [x] **Step 6: Record**

Append `tracker.md`'s section to `docs/TRANSLATION_REVIEW_TRACKER.md` as `## Review completed — 2026-09-05 — Batch 1: cath lab (Plans 2 and 3), 96 keys × hi/ta/te/ml` (reviewer: Claude Fable 5.1 review pipeline; approval: owner, pending); add the glossary rows; re-measure `apps/staff/docs/LANGUAGE_HEALTH.md` headline numbers from `node apps/staff/scripts/i18n-verify.mjs` output and update the `_Last verified:_` date; update the Coverage table cells for Staff hi/ta/te/ml to `Partial — B1 cath (96 keys) approved <date> (owner)` only after the owner replies; until then write `Partial — B1 cath reviewed 2026-09-05, owner approval pending`.

- [x] **Step 7: Commit and PR**

```bash
git add apps/staff/lib/l10n/app_strings.dart apps/staff/lib/l10n/app_strings_ml_parity.g.dart docs/i18n/GLOSSARY.md docs/TRANSLATION_REVIEW_TRACKER.md apps/staff/docs/LANGUAGE_HEALTH.md docs/superpowers/plans/2026-09-05-open21-linguistic-review.md
git commit -m "i18n(cath): OPEN-21 batch 1 — review of the 96 Plan 2/3 strings in hi/ta/te/ml" -- <same paths>
git commit --allow-empty -m "chore(ci): [full-ci] OPEN-21 batch 1"
git push -u github feat/open21-linguistic-review
gh pr create --draft --base main --head feat/open21-linguistic-review --title "i18n: OPEN-21 batch 1 — cath strings reviewed in hi/ta/te/ml + review tooling" --body-file scratchpad/open21/b1/pr-body.md
```

PR body: batch scope and counts; the changed-keys table; escalations for the owner; the tooling added (Tasks 0–2); gates run; "Draft; merge authority stays with the coordinating session; `Merge Gate` / `Full Merge Gate` reported by name with the head SHA"; end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

**Landed 2026-09-05** on `feat/open21-linguistic-review`. What the batch actually did, where it differs from the step text above:
- The three PROPOSED English source changes are APPLIED with their four locale renderings, not held: the owner's veto window is this PR's review, so a veto is a one-commit revert rather than a re-translation. `apply.final.jsonl` (392 rows, 99 changed) = `apply.jsonl` with the `en.changes.jsonl` renderings substituted plus one `en` row per source change.
- Counts: 91 locale values changed, 293 confirmed, 8 English source values changed, 0 escalated-and-withheld.
- Step 3b grep result: every hit on an old English literal was in `apps/staff/test/features/cath_lab/` and was updated in the same commit. One hit is NOT edited and is reported instead — the Plan 2 build table in `docs/superpowers/plans/2026-09-04-cath-lab-readiness.md:2091`, which is a dated record of what that plan shipped; the tracker section is the record of the new values.
- Tool work Step 0 needed before the apply: `i18n-review-apply.mjs` re-serialised every approved entry, so 298 confirms produced quote-only diffs. Confirms now leave entry lines byte-identical, a changed value keeps the entry's quote style, and `locale: 'en'` rows are accepted with an `en_old` guard against a moved key.

### Task 4: Batch 2 — terminology consistency pass

**Files:**
- Inputs: `scratchpad/open21-terminology.md` (650 English strings used by ≥2 keys; 478 rendered inconsistently in ≥1 locale)
- Outputs: `scratchpad/open21/b2/…` as above
- Modify: `app_strings.dart`, patient `intl_*.arb` + `lib/generated/*`, `docs/i18n/GLOSSARY.md`, tracker, both `LANGUAGE_HEALTH.md`

**Scope correction from the human review (2026-09-05):** the inventory's 478 divergent English groups are review CANDIDATES, not defects. Identical English does not prove identical meaning (Open: command vs state; Complete: command vs status; Route: medication vs navigation; Dose: medication vs radiation; Critical: dangerous state vs essential to safety; Emergency: leave administration vs triage), and the bare-label probe conflates grammatical forms ("Waive" / "Waived" / "Reason for waiving" / "Waive {item}?"), compounds ("Consent" / "Written consent"), and abbreviations ("Hb" / "Haemoglobin"), all of which legitimately differ. **No global replacement is performed from the divergence counts.**

- [ ] **Step 0: Rebuild the grouping** — regenerate the terminology report with identity = `concept + clinical/workflow domain (key prefix family) + UI role (button / chip / label / sentence / error, from the key's last segment and length) + locale`, treating plural, case-form and abbreviation variants as one family. Output: `scratchpad/open21/b2/groups.md` with, per group, the members and whether any locale renders them inconsistently. Only groups whose members share concept, domain and UI role are candidates.
- [ ] **Step 1: Decide the glossary rows** — start from the human review's base terms (Consent: hi सहमति / ta ஒப்புதல் / te సమ్మతి / ml സമ്മതം; Prescription: प्रिस्क्रिप्शन / மருந்துச்சீட்டு / ప్రిస్క్రిప్షన్ / കുറിപ്പടി; Hospital discharge: डिस्चार्ज / டிஸ்சார்ஜ் / డిశ్చార్జ్ / ഡിസ്ചാർജ്; Medication dose: खुराक / மருந்தளவு / మోతాదు / ഡോസ്) and the Batch 1 decisions; one agent per locale proposes renderings for the remaining clinical-risk concepts (Critical vs important, Urgent vs Emergency as distinct priority classes, Waive, Allergy, Vitals, and the common controls Cancel / Save / Submit / Confirm / Retry / Back / Next / Done) with reasons; a Fable reconciler settles conflicts and records them in `GLOSSARY.md` with date. Dose vs dosage regimen stay separate concepts.
- [ ] **Step 2: Generate the apply set for the genuine problems only** — the human review's priority list: clinical critical rendered as "important"/"complex" (ta `முக்கியம்` / `முக்கியமானவை`, te `క్లిష్ట…`), emergency and urgent collapsed into one word where they are separate classes, hospital discharge rendered as bodily discharge (te `ఉత్సర్గ…`, e.g. `discharge.proceed_title` → `డిశ్చార్జ్‌ను నిర్ధారించండి`, `s4.lib.patient_records.discharge_summary` → `డిశ్చార్జ్ సారాంశం`), consent used for acknowledgement, and single-dose terms used for regimen fields; then, within a rebuilt group, keys whose rendering differs from the glossary rendering. Keys where the divergence is a different concept stay as they are and the group is annotated.
- [ ] **Step 3: Apply** with both tools; `melos run gen-staff-ml-parity`; `cd apps/patient && flutter gen-l10n`.
- [ ] **Step 4: Gates** — `melos run i18n-parity-check && melos run format && melos run analyze && melos run test`. The `findsOneWidget` hazard: any failing `*_l10n_test.dart` means two different concepts on one screen now share a rendering; revert that pair to distinct renderings, note it in the glossary ("distinct on <screen>"), and re-run.
- [ ] **Step 5: Record** (tracker section `Batch 2: terminology consistency`, glossary, both LANGUAGE_HEALTH tables) and PR on `feat/open21-b2-terminology` off current main.

### Task 5: Batch 3 — Staff first-pass review, `// REVIEW:`-flagged keys first (2,428 strings)

Waves by risk, each its own review run and PR (`feat/open21-b3-<wave>`), using the domain prefixes to cut the queue (`grep -n "// REVIEW:" -A1 apps/staff/lib/l10n/app_strings.dart` inside each locale block gives the keys):

| Wave | Prefixes | Reconciler |
|---|---|---|
| 3a medication & MAR | `drug_chart`, `prescriptions`, `pharmacy`, `mar_supply`, `s4.lib.pharmacy`, `clinical_ai` (drug wording) | Fable |
| 3b emergency & escalation | `ed_trauma`, `sos`, `code_blue`, `escalation`, `burn_care`, `theatre` | Fable |
| 3c consent, identity, security | `login`, `consent`, `abdm`, `security`, `biometric`, `session` | Fable |
| 3d finance & payroll | `payroll`, `billing`, `insurance`, `attendance`, `leave`, `hr` | Opus |
| 3e clinical workflow | `admission`, `clinical_notes`, `clinical_inbox`, `bed_board`, `radiology`, `lab_bookings`, `blood_bank`, `partograph_entry`, `incident_report`, `s4.lib.*` remainder | Opus |

Per wave: extract keys (all four locales, flagged in any), reviewer × 4, back-translation, reconcile, apply (flags removed on approval), `melos run gen-staff-ml-parity`, gates (`i18n-parity-check`, `format`, `analyze`, `flutter test` for the touched feature folders + `i18n_guard_test.dart`), record, PR. Escalations accumulate in `escalations.md` for the owner.

### Task 6: Batch 4 — Patient priority queue (94 keys × 4)

Inputs: `scratchpad/open21-patient-queue.md` (ABHA enrolment + biometric 29, consent actions 12, Ask-a-Doubt 2, MT-corruption fixes 3, the 48-key list) and the human review's section 2. Reconciler: Fable (identity/consent copy).

**Holds set by the human review (2026-09-05):**
- `aboutUsContent` is HELD in all five languages until the owner approves a factual English master (the current English carries equipment, volume, accreditation, outcome and "stem cell therapy for cardiac regeneration" claims this review cannot substantiate; the Jan 2026 MoHFW/DHR cardiac guidelines recommend against routine clinical use). The definite translation errors (Tamil lead-metal-free pacemaker → `லீட்லெஸ் இதயமுடுக்கி பொருத்துதல்`; `CyberKnife ரேடியோசர்ஜரி`; "closed ICU" rendered as a shut facility; "Integrity" → hi `ईमानदारी` / ta `நேர்மை` / te `నిజాయితీ` / ml `സത്യസന്ധത`) are applied when the master lands.
- Identity and security strings (`abhaEnrol*` OTP intros, `settingsBiometricLockSubtitle`, `biometricGate*`) are HELD pending the two product decisions below; the routine controls in those groups (Send/Resend/Verify buttons, Settings/Home buttons) proceed with the Tamil polite-imperative forms the review gives.

**Product changes this batch depends on (patient-app lane, `feat/open21-patient-source-fixes`, own PR, before or with 4):**
- OTP purpose state: the second OTP step (ABHA mobile verification) must not reuse the Aadhaar-OTP intro. Add a state-specific string pair — Aadhaar step: "Enter the OTP sent to the mobile number linked to your Aadhaar."; ABHA mobile step: "Enter the OTP sent to the mobile number being verified for your ABHA." — and masked variants fed from the authoritative recipient. Verify `abhaEnrolMobileHint`'s claim that a blank field defaults to the Aadhaar-linked number against the backend, and that every state showing `abhaEnrolDoneIntro` (incl. `enrolled`, not only `linked`) guarantees persisted linkage; if not, split the completion copy by state.
- SOS: `authSosBackendFailed` → "We could not confirm that the SOS alert was sent to the hospital. Call for emergency help. If you are already connected, stay on the line."; `authSosGuestSkipped` → say "phone app opened" / "emergency dialler opened" only when the launch succeeded and never imply staff received an alert; route the `SosException.message` display path through a localised, controlled string; replace the raw `{error}` interpolation in `abhaEnrolServerUnreachable` with a controlled localised error plus sanitised logging.
- Biometric — OWNER DECIDED 2026-09-05 ("do what is best"): treat the lock as a protection against a holder of a signed-in phone. `toggleBiometric(false)` must require a fresh authentication (biometric, or the account credential when biometrics are unavailable) before disabling; the locked pane keeps its emergency-access affordance and its explicit route to Settings. Copy: `settingsBiometricLockSubtitle` → "Use your fingerprint or face to sign in and open prescriptions, results, notes, messages and bills. Home, appointments and video consultations do not require this biometric check." — verified against the router's guarded routes before it is written; `biometricGateLockedEscapeHint` refers to fingerprint or face VERIFICATION not working and names Settings. The absolute "…so emergency help is never blocked" claim is removed everywhere.
- `investigationsUploadNotAvailableForDependent` source → "Report uploads are not available while viewing {name}'s profile. To upload a report for yourself, switch back to your own profile." (record-attribution issue).
- `aboutHomeSampleAction` / `aboutFreeHomeSampleCollectionTitle` — OWNER DECIDED 2026-09-05: sample collection at home is free and available to everyone; the tests themselves are charged. Source → "Free home sample collection" with a subtitle/hint "Collection is free; tests are charged as per the price list." (or the nearest existing hint key); locales render both facts.
- Ask a Doubt — OWNER DECIDED 2026-09-05: add a separately approved, prominent statement that the channel is not for urgent or emergency concerns (with the SOS / emergency number as the alternative), and make the "every message is read … follow up by phone or at the next visit" promise true by mechanism: verify there is a staff-side worklist where unanswered doubts surface with an owner and an escalation after a bounded time (grep the backend for the ask-a-doubt / patient-message tables and any staff route that lists them); if there is none, the lane adds a minimal one (open-doubts list on the staff clinical inbox with an "acknowledged / followed up" action and an overdue marker) before the promise is kept; if that is out of reach, the copy is narrowed to what is true and the owner is told which.

Corrections applied in this batch as given by the human review: `abdmConsentGrantConfirmBody` ta; `appointmentInPersonConsultation` hi; `appointmentReasonForVisitHint` ta; `aboutHomeSampleAction` ×4; `labOrdersScheduled` ml; `familyLinkedDependentBadge` / `familySetUpLinkedDependent` ml; `abdmRegister` ta/te/ml; the eight Tamil polite imperatives; `abhaEnrolResendOtpIn` ×4 with localised units; the `conditionsBody` ml data-accuracy sentence split (not legal approval).

Apply with the patient tool (`--date`), then `cd apps/patient && flutter gen-l10n` and commit `lib/generated/*`; gates `node apps/patient/scripts/i18n-verify.mjs --check`, `flutter test test/features/abdm/abha_enrolment_l10n_test.dart test/features/**/*_l10n_test.dart`, `melos run format`. Fix the corrupt `intl_ta.arb` `@authPhonePrefix` metadata (contains Greek `πρόθεμα`) in the same batch. The guardianship/consent strings in `family_screen.dart` are NOT in scope (held for legal). Record + PR on `feat/open21-b4-patient-queue`.

### Task 7: Batch 5 — Staff Malayalam placeholders (4,008 → translated)

- [ ] **Step 1: Cut the dead keys** — confirm the `reception_counter.*` dead list from `apps/staff/docs/LANGUAGE_HEALTH.md` against call sites (`node apps/staff/scripts/i18n-verify.mjs` prints orphan getters); dead keys stay placeholders and are listed in the tracker as "not translated: dead surface".
- [ ] **Step 2: Waves by prefix** (≈500 keys each; live keys only): 5a `s4.lib.pharmacy` + `drug_chart` + `prescriptions` + `pharmacy` (dose/MAR — Fable reconciler); 5b `ed_trauma` + `burn_care` + `theatre` + `s4.lib.patient_command_board`; 5c `s4.lib.op_doctor_workspace` + `s4.lib.op_ai_assist` + `clinical_ai` + `clinical_inbox`; 5d `payroll` + `hr` + `leave` + `attendance` + `role`; 5e `s4.lib.front_office_workbench` + `appt_queue` + `admission` + `s4.lib.patient_records` + `s4.lib.discharge_hub`; 5f `housekeeping` + `s4.lib.housekeeping_roster_board` + `radiology` + `lab_bookings` + `blood_bank` + `partograph_entry` + `incident_report` + `bed_board` + `s4.calculators.*` + remainder.
- [ ] **Step 3: Per wave** — translator agent (Malayalam, Kerala hospital register) produces `ml.review.jsonl` with `verdict: change` for every placeholder (the "current value" is English); back-translation on every row; reconciler (glossary, placeholders, length); apply (`ml` rows are inserted into the explicit block); `melos run gen-staff-ml-parity` (placeholder count falls by the wave size); gates; record; PR `feat/open21-b5-<wave>`.

### Task 8: Batch 6 — remaining first-pass review (owner decision point)

After Batch 5 lands, present the owner with the measured cost of Batch 3–5 (agent runs, wall time, change rate, escalation rate) and the remaining population: Staff hi/ta/te unflagged (≈19,800 strings), Staff `ml` explicit (2,590), Patient remaining (≈5,400). Offer three depths: (a) domain-prioritised full review in waves like Task 5; (b) sampled review (every key in the high-risk domains, a 10% sample elsewhere, escalating any domain whose sample change rate exceeds 5% to full review); (c) stop at Batches 1–5. Execute the chosen depth with the same pipeline.

### Task 9: Records at each milestone

Per batch (Steps already listed): tracker section; Coverage table `Partial — …`; `// REVIEW:` flags removed on approved staff keys; `@` descriptions stamped on approved patient keys; both `LANGUAGE_HEALTH.md` re-measured.

At Batch 1 and again after Batch 5: edit `docs/FULL_REPOSITORY_AUDIT_2026_08.md` OPEN-21 row to carry the new residual counts (placeholders left, flags left, patient descriptions still marked) and name the batches as evidence; correct the row's path `services/payments/paymentLinkService.js` → `services/billing/paymentLinkService.js`; leave HELD-12 held and add one clause naming which categories are reviewed and which await finance / legal / operator / owner. Update `docs/ROADMAP.md`'s OPEN-21 bullets to match. Never mark OPEN-21 or HELD-12 closed while any held category is unsigned or any placeholder remains.

## Self-review against the finding

- OPEN-21 residual (1) Staff ml placeholders → Task 7; (2) `// REVIEW:` flags and the patient 48-key queue → Tasks 5 and 6; patient ABHA/consent queues → Task 6; (3) payment wording, (4) guardianship/consent, (5) Staff Web activation, (6) Admin scope and the dynamic backend contract → out of scope by the ledger's own rule, listed as owner decisions; the terminology inconsistency the inventory found → Task 4; the two undocumented English pins → Task 2; the stale `LANGUAGE_HEALTH.md` tables → Task 9.
- Type consistency: decision rows are `{key, locale, value, approved, changed}` in both tools and in every reconciler output; `applyDecisions(filePath, decisions)` (staff) and `applyArbDecisions(dir, decisions, {date})` (patient) are the only write paths; reviewer rows are `{key, locale, verdict, value, reason, risk}`; back-translation rows are `{key, locale, back_en}`.
- Placeholders scan: none.
