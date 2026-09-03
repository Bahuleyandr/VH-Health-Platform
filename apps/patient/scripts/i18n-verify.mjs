#!/usr/bin/env node
// i18n-verify.mjs
//
// Health check for the patient app's ARB-based i18n. Run from
// `apps/patient/` (or via `melos run i18n-health-patient`):
//
//     node scripts/i18n-verify.mjs
//
// Patient uses Flutter's standard `gen-l10n` with ARB files at
// `lib/l10n/intl_<locale>.arb`. Source-of-truth is `intl_en.arb`;
// every other locale falls back through `flutter gen-l10n`'s
// generated lookup if a key is absent.
//
// Reports:
//   1. Per-locale coverage (% of English keys translated)
//   2. Missing keys per non-English locale (full sorted list)
//   3. Suspected copy-paste (translation === English) with the
//      same intentionally-English filter used in the staff verifier
//   4. Length outliers (translation > 2.5x English chars)
//   5. Hardcoded English remaining in screens (Text('...') heuristic)
//
//     node scripts/i18n-verify.mjs --check
//
// runs the blocking structural contract: all five locale files must carry
// the English key set, preserve every ICU placeholder, and may equal the
// English value only for the short, reasoned identifier list below.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const ARB_DIR = join(APP_ROOT, 'lib', 'l10n');
const LIB_ROOT = join(APP_ROOT, 'lib');
const LOCALES = ['en', 'hi', 'ta', 'te', 'ml'];

const DELIBERATE_ENGLISH_VALUES = {
  profileEmailHint: 'Literal example email address.',
  vitalsSpO2: 'International clinical abbreviation.',
  splashAppName: 'Product name.',
  aboutHospitalName: 'Registered hospital name.',
  ancBpLabel: 'International clinical abbreviation.',
  ancFhrLabel: 'International clinical abbreviation.',
  ancHbLabel: 'International clinical abbreviation.',
  yourHealthTimelineRxPill: 'International prescription symbol.',
  teleconsultBadge: 'Product badge token.',
  abdmAddressHint: 'Literal example ABHA address.',
  abhaEnrolOtpLabel: 'ABDM programme term and required-field marker.',
};

function loadArb(loc) {
  const path = join(ARB_DIR, `intl_${loc}.arb`);
  const raw = readFileSync(path, 'utf8');
  const obj = JSON.parse(raw);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('@')) continue;        // metadata key
    out[k] = v;
  }
  return out;
}

function isIntentionallyEnglish(en) {
  const s = en.trim();
  if (s.length < 4) return true;
  if (/^[A-Z0-9/+,. ]+$/.test(s)) return true;
  if (/(mg\/dL|mmHg|bpm|°[FC]|kg|cm|µ|μ|%|₹)/.test(s)) return true;
  if (/^\+?\d|XXXXX|^OD,|^PO,|^BD\b|^TDS\b/.test(s)) return true;
  if (/^EMP[-:]/.test(s)) return true;
  if (/SpO[₂2]/.test(s)) return true;
  if (/^(DNR|DNI|CPR|ICU|ECG|EEG|MRI|CT|XR|USG|HR|BP|RR|GCS|AVPU|OTP|UPI|UID|URL)/.test(s)) return true;
  return false;
}

function listDartFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) listDartFiles(p, acc);
    else if (name.endsWith('.dart')) acc.push(p);
  }
  return acc;
}

function findHardcodedTexts(files) {
  const hits = [];
  const skipPatterns = [
    /\\test\\/i,
    /\\generated\\/i,
    /app_router\.dart$/,
    /app_theme\.dart$/,
    /theme_colors\.dart$/,
    /firebase_options\.dart$/,
  ];
  const re = /Text\(\s*['"]([^'"\$\{]{4,})['"]/g;
  const isLikelyUiCopy = (s) => {
    if (s.length < 4) return false;
    if (!/\s/.test(s)) return false;
    if (!/[A-Z]/.test(s)) return false;
    if (/^https?:|^mailto:|^[+\d ]+$/.test(s)) return false;
    if (/^[\d.\-:\/ T]+$/.test(s)) return false;
    return true;
  };
  for (const f of files) {
    if (skipPatterns.some(p => p.test(f))) continue;
    const txt = readFileSync(f, 'utf8');
    for (const m of txt.matchAll(re)) {
      if (isLikelyUiCopy(m[1])) {
        hits.push({ file: relative(APP_ROOT, f), text: m[1] });
      }
    }
  }
  return hits;
}

function main() {
  console.log('VH Health — Patient app i18n health check (ARB)');
  console.log('==================================================\n');

  const arb = {};
  for (const loc of LOCALES) arb[loc] = loadArb(loc);

  const enKeys = new Set(Object.keys(arb.en));
  console.log(`English source-of-truth keys: ${enKeys.size}\n`);

  // 1+2. Coverage + missing
  for (const loc of LOCALES) {
    if (loc === 'en') continue;
    const got = new Set(Object.keys(arb[loc]));
    const missing = [];
    for (const k of enKeys) if (!got.has(k)) missing.push(k);
    const cov = (((enKeys.size - missing.length) / enKeys.size) * 100).toFixed(1);
    console.log(`[${loc}] coverage ${cov}%  (${enKeys.size - missing.length}/${enKeys.size}),  missing ${missing.length}`);
    if (missing.length > 0 && missing.length < 20) {
      for (const k of missing.sort()) console.log(`   missing: ${k}`);
    } else if (missing.length >= 20) {
      console.log(`   (showing first 12 of ${missing.length})`);
      for (const k of missing.sort().slice(0, 12)) console.log(`   missing: ${k}`);
    }
    console.log('');
  }

  // 3. Copy-paste
  console.log('--- 3. Suspected copy-paste (translation === English) ---');
  let copyHits = 0;
  for (const loc of LOCALES) {
    if (loc === 'en') continue;
    const dups = [];
    for (const [k, v] of Object.entries(arb[loc])) {
      const en = arb.en[k];
      if (en && v === en && /[a-zA-Z]/.test(en) && !isIntentionallyEnglish(en)) {
        dups.push(k);
      }
    }
    if (dups.length > 0) {
      console.log(`[${loc}] ${dups.length} keys identical to English`);
      for (const k of dups.slice(0, 5)) console.log(`   ${k} → "${arb.en[k].slice(0, 60)}"`);
      if (dups.length > 5) console.log(`   ...and ${dups.length - 5} more`);
      copyHits += dups.length;
    } else {
      console.log(`[${loc}] none`);
    }
  }
  console.log(`Total: ${copyHits}\n`);

  // 4. Length outliers
  console.log('--- 4. Length outliers (translation > 2.5x English chars) ---');
  for (const loc of LOCALES) {
    if (loc === 'en') continue;
    const out = [];
    for (const [k, v] of Object.entries(arb[loc])) {
      const en = arb.en[k];
      if (!en || en.length < 10) continue;
      if (v.length > en.length * 2.5) {
        out.push({ k, ratio: (v.length / en.length).toFixed(1), en: en.slice(0, 40), tx: v.slice(0, 60) });
      }
    }
    if (out.length === 0) {
      console.log(`[${loc}] none`);
    } else {
      console.log(`[${loc}] ${out.length} outliers`);
      for (const o of out.slice(0, 3)) console.log(`   ${o.k}  ${o.ratio}x  "${o.en}…" → "${o.tx}…"`);
    }
  }
  console.log('');

  // 5. Hardcoded English remaining
  console.log('--- 5. Hardcoded English remaining (Text(\'...\') heuristic) ---');
  const files = listDartFiles(LIB_ROOT);
  const hardcoded = findHardcodedTexts(files);
  const byFile = {};
  for (const h of hardcoded) {
    byFile[h.file] = (byFile[h.file] ?? []);
    byFile[h.file].push(h.text);
  }
  console.log(`Files with suspected hardcoded UI strings: ${Object.keys(byFile).length}, total occurrences: ${hardcoded.length}`);
  const sortedFiles = Object.entries(byFile).sort((a,b) => b[1].length - a[1].length);
  for (const [f, ss] of sortedFiles.slice(0, 12)) {
    console.log(`   ${f}  (${ss.length})`);
    for (const s of ss.slice(0, 2)) console.log(`     "${s.slice(0, 70)}"`);
  }
  if (sortedFiles.length > 12) console.log(`   ...and ${sortedFiles.length - 12} more files`);

  console.log('\n==================================================');
  console.log('Done. Treat as informational; gaps queue for translator review.');
}

function placeholders(value) {
  return [...String(value).matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
    .map((match) => match[1])
    .sort();
}

function runParityCheck() {
  console.log('Patient i18n structural parity check (hi/ta/te/ml vs en)');
  console.log('--------------------------------------------------------');

  const arb = {};
  for (const loc of LOCALES) arb[loc] = loadArb(loc);
  const enKeys = Object.keys(arb.en).sort();
  const failures = [];
  if (enKeys.length < 1000) {
    failures.push(
      `parsed only ${enKeys.length} English keys; the ARB reader is no longer trustworthy`,
    );
  }

  for (const key of Object.keys(DELIBERATE_ENGLISH_VALUES)) {
    if (!(key in arb.en)) {
      failures.push(`stale deliberate-English entry '${key}'`);
    } else if (LOCALES.slice(1).every((loc) => arb[loc][key] !== arb.en[key])) {
      failures.push(`unused deliberate-English entry '${key}'`);
    }
  }

  for (const loc of LOCALES.slice(1)) {
    const got = new Set(Object.keys(arb[loc]));
    const missing = enKeys.filter((key) => !got.has(key));
    const extra = [...got].filter((key) => !(key in arb.en)).sort();
    const placeholderDrift = [];
    const undeclaredEnglish = [];
    for (const key of enKeys) {
      if (!got.has(key)) continue;
      const expectedPlaceholders = placeholders(arb.en[key]);
      const actualPlaceholders = placeholders(arb[loc][key]);
      if (JSON.stringify(actualPlaceholders) !== JSON.stringify(expectedPlaceholders)) {
        placeholderDrift.push(
          `${key} expected {${expectedPlaceholders.join(',')}} got {${actualPlaceholders.join(',')}}`,
        );
      }
      if (
        arb[loc][key] === arb.en[key] &&
        /[A-Za-z]/.test(arb.en[key]) &&
        !(key in DELIBERATE_ENGLISH_VALUES)
      ) {
        undeclaredEnglish.push(key);
      }
    }
    console.log(
      `[${loc}] ${got.size}/${enKeys.length} keys, missing ${missing.length}, ` +
      `placeholder drift ${placeholderDrift.length}, undeclared English values ` +
      `${undeclaredEnglish.length}, orphaned ${extra.length}`,
    );
    for (const key of missing.slice(0, 20)) console.log(`   missing: ${key}`);
    for (const detail of placeholderDrift.slice(0, 20)) {
      console.log(`   placeholder drift: ${detail}`);
    }
    for (const key of undeclaredEnglish.slice(0, 20)) {
      console.log(`   undeclared English value: ${key}`);
    }
    if (missing.length > 0) failures.push(`${loc} is missing ${missing.length} key(s)`);
    if (placeholderDrift.length > 0) {
      failures.push(`${loc} has ${placeholderDrift.length} placeholder mismatch(es)`);
    }
    if (undeclaredEnglish.length > 0) {
      failures.push(`${loc} has ${undeclaredEnglish.length} undeclared English value(s)`);
    }
  }

  if (failures.length > 0) {
    console.error('\nFAIL: patient i18n structural parity');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\nOK: patient en/hi/ta/te/ml keys and placeholders are at parity.');
}

if (process.argv.includes('--check')) {
  runParityCheck();
} else {
  main();
}
