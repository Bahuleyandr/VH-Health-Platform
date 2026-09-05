// apps/staff/scripts/i18n-review-apply.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDecisions, dartString } from './i18n-review-apply.mjs';

// Mirrors the real lib/l10n/app_strings.dart shapes: 6-space entries,
// `// REVIEW:` flags at 6 spaces, double-quoted literals (8,161 of them in the
// real file, e.g. line 3017 `"Point the camera at the QR code on the patient's
// wristband."`), multi-line adjacent-literal continuations at 10 spaces,
// `\'` escapes inside single-quoted literals (real file lines 4195, 7220), and
// the `...malayalamTechnicalParityPlaceholders,` spread inside the `ml` block
// (real file line 37871).
const FIXTURE = `class AppStrings {
  static const Map<String, Map<String, String>> _byLang = {
    'en': {
      'a.one': 'One',
      'a.two': 'Two {count}',
      'a.three': 'Three',
      'a.four': "It's four",
      'a.five':
          "Five {count} item's",
      'a.six': 'Six\\'s',
    },
    'hi': {
      // REVIEW: AI first-pass
      'a.one': 'एक',
      'a.two': 'दो {count}',
      // REVIEW: security wording
      // REVIEW: second flag line
      'a.three': 'तीन',
      'a.four': "चार's",
      'a.five':
          'पाँच {count}'
          ' वस्तु',
      'a.six': 'Six\\'s',
    },
    'ml': {
      ...malayalamTechnicalParityPlaceholders,
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

// ── Shapes the real app_strings.dart has that the fixture above encodes ──

test('a double-quoted entry is read and rewritten as an escaped single-quoted literal', () => {
  const out = withFixture((f) => applyDecisions(f, [
    { key: 'a.four', locale: 'hi', value: "चार का मान", approved: true, changed: true },
  ]));
  assert.ok(out.includes(`      'a.four': 'चार का मान',`));
  assert.ok(!out.includes(`"चार's"`), 'the old double-quoted literal is gone');
});

test('a multi-line adjacent-literal entry is joined for placeholder checks and collapsed on write', () => {
  const out = withFixture((f) => applyDecisions(f, [
    { key: 'a.five', locale: 'hi', value: 'पाँच {count} वस्तुएँ', approved: true, changed: true },
  ]));
  assert.ok(out.includes(`      'a.five': 'पाँच {count} वस्तुएँ',`));
  assert.ok(!out.includes(`          ' वस्तु',`), 'the continuation line is consumed, not orphaned');
  // The `en` side is itself a multi-line double-quoted literal, so its
  // placeholder set has to come from the joined value.
  assert.throws(() => withFixture((f) => applyDecisions(f, [
    { key: 'a.five', locale: 'hi', value: 'पाँच वस्तुएँ', approved: true, changed: true },
  ])), /placeholder/);
});

test("a value containing \\' round-trips: confirming it writes nothing", () => {
  const out = withFixture((f) => applyDecisions(f, [
    { key: 'a.six', locale: 'hi', value: "Six's", approved: true, changed: false },
  ]));
  assert.equal(out, FIXTURE);
});

test('the ml spread element is never treated as an entry and survives insertion', () => {
  const out = withFixture((f) => applyDecisions(f, [
    { key: 'a.three', locale: 'ml', value: 'മൂന്ന്', approved: true, changed: true },
  ]));
  assert.ok(out.includes(`      ...malayalamTechnicalParityPlaceholders,`));
  const ml = out.slice(out.indexOf(`'ml': {`), out.indexOf(`  };`));
  assert.ok(ml.indexOf(`...malayalamTechnicalParityPlaceholders`) < ml.indexOf(`'a.three'`),
    'an approved explicit ml value must come after the spread so it overrides the placeholder');
});
