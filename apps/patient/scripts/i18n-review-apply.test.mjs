// apps/patient/scripts/i18n-review-apply.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyArbDecisions, stampDescription } from './i18n-review-apply.mjs';

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
    rawEn: readFileSync(join(dir, 'l10n', 'intl_en.arb'), 'utf8'),
  };
}

// The real ARBs are NOT a fixed point of `JSON.stringify(json, null, 2) + '\n'`:
// intl_en.arb writes 184 of its 1,198 `@key` objects on one line, and each of
// intl_{hi,ta,te,ml}.arb carries 11 duplicate top-level keys (an English block
// at ~line 1077 shadowed by the translated block at ~line 2117 — JSON.parse and
// `flutter gen-l10n` both keep the last). A re-serialising writer would silently
// delete those 11 keys and reflow the 184 objects, so the writer edits text.
function withRawArbs(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'arb-raw-'));
  mkdirSync(join(dir, 'l10n'));
  for (const [loc, raw] of Object.entries(files)) writeFileSync(join(dir, 'l10n', `intl_${loc}.arb`), raw);
  fn(join(dir, 'l10n'));
  const out = {};
  for (const loc of Object.keys(files)) out[loc] = readFileSync(join(dir, 'l10n', `intl_${loc}.arb`), 'utf8');
  return out;
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

// ── Shapes the real intl_*.arb files have ────────────────────────────────

const RAW_EN = `{
  "@@locale": "en",
  "greet": "Hello {name}",
  "@greet": {
    "description": "Greeting. hi/ta/te/ml values are machine-translated and marked for review.",
    "placeholders": {
      "name": {}
    }
  },
  "dupKey": "Duplicate demo",
  "@dupKey": {"description": "One-line metadata object, as 184 of intl_en.arb's are."},
  "noMetaKey": "No metadata"
}
`;

const RAW_HI = `{
  "@@locale": "hi",
  "dupKey": "Duplicate demo",
  "greet": "नमस्ते {name}",
  "dupKey": "डुप्लिकेट डेमो",
  "noMetaKey": "कोई मेटाडेटा नहीं"
}
`;

test('a duplicate top-level key is edited at its LAST occurrence, and neither line is dropped', () => {
  const out = withRawArbs({ en: RAW_EN, hi: RAW_HI }, (d) => applyArbDecisions(d, [
    { key: 'dupKey', locale: 'hi', value: 'नकल डेमो', approved: true, changed: true },
  ], { date: '2026-09-05' }));
  assert.ok(out.hi.includes(`  "dupKey": "Duplicate demo",\n`), 'the shadowed English duplicate is untouched');
  assert.ok(out.hi.includes(`  "dupKey": "नकल डेमो",\n`), 'the winning duplicate carries the approved value');
  assert.equal(JSON.parse(out.hi).dupKey, 'नकल डेमो');
  // every byte outside the replaced literal is unchanged
  assert.equal(out.hi, RAW_HI.replace('"डुप्लिकेट डेमो"', '"नकल डेमो"'));
});

test('a one-line @key metadata object is stamped in place and stays on one line', () => {
  const out = withRawArbs({ en: RAW_EN, hi: RAW_HI }, (d) => applyArbDecisions(d, [
    { key: 'dupKey', locale: 'hi', value: 'डुप्लिकेट डेमो', approved: true, changed: false },
  ], { date: '2026-09-05' }));
  const line = out.en.split('\n').find((l) => l.includes('"@dupKey"'));
  assert.match(line, /^ {2}"@dupKey": \{"description": ".*approved hi 2026-09-05\."\},$/);
});

test('a key with no @key metadata gets one inserted directly after it', () => {
  const out = withRawArbs({ en: RAW_EN, hi: RAW_HI }, (d) => applyArbDecisions(d, [
    { key: 'noMetaKey', locale: 'hi', value: 'कोई मेटाडेटा नहीं', approved: true, changed: false },
  ], { date: '2026-09-05' }));
  const lines = out.en.split('\n');
  const i = lines.findIndex((l) => l.startsWith('  "noMetaKey"'));
  assert.match(lines[i], /^ {2}"noMetaKey": "No metadata",$/, 'the last entry gains the separating comma');
  assert.match(lines[i + 1], /^ {2}"@noMetaKey": \{"description": "approved hi 2026-09-05\."\}$/);
  JSON.parse(out.en); // still valid JSON
});

test('every other byte of intl_en.arb is preserved when one description is stamped', () => {
  const out = withRawArbs({ en: RAW_EN, hi: RAW_HI }, (d) => applyArbDecisions(d, [
    { key: 'greet', locale: 'hi', value: 'नमस्ते {name}', approved: true, changed: false },
  ], { date: '2026-09-05' }));
  assert.equal(out.en, RAW_EN.replace(
    '"Greeting. hi/ta/te/ml values are machine-translated and marked for review."',
    '"Greeting approved hi 2026-09-05."',
  ));
  assert.equal(out.hi, RAW_HI, 'an unchanged value rewrites nothing');
});

test('stampDescription replaces a stale stamp for the same locale and keeps the others', () => {
  assert.equal(
    stampDescription('Greeting. approved hi 2026-09-01; ta 2026-09-02.', 'hi', '2026-09-07'),
    'Greeting. approved ta 2026-09-02; hi 2026-09-07.',
  );
  assert.equal(stampDescription('', 'ml', '2026-09-05'), 'approved ml 2026-09-05.');
});

test('an unknown key, an unknown locale value, or a missing locale file is rejected', () => {
  assert.throws(() => withRawArbs({ en: RAW_EN, hi: RAW_HI }, (d) => applyArbDecisions(d, [
    { key: 'nope', locale: 'hi', value: 'x', approved: true, changed: true },
  ], { date: '2026-09-05' })), /unknown key/);
  assert.throws(() => withRawArbs({ en: RAW_EN, hi: RAW_HI }, (d) => applyArbDecisions(d, [
    { key: 'greet', locale: 'ta', value: 'வணக்கம் {name}', approved: true, changed: true },
  ], { date: '2026-09-05' })), /intl_ta\.arb|ENOENT/);
});
