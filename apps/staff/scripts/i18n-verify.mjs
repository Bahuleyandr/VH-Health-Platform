#!/usr/bin/env node
// i18n-verify.mjs
//
// Static-analysis health check for `lib/l10n/app_strings.dart`.
// Run from `apps/staff/`:
//
//     node scripts/i18n-verify.mjs
//
// Reports:
//   1. Per-locale coverage (% of English keys with a translation)
//   2. Missing keys per non-English locale
//   3. Suspected copy-paste (non-English value identical to English)
//   4. Length outliers (translation > 2.5x English chars — UI overflow risk)
//   5. `// REVIEW:` flag count per locale (translator-attention queue)
//   6. Orphan getters: declared on AppStrings but never called from lib/
//   7. Orphan calls: `s.foo` / `AppStrings.of(context).foo` with no
//      matching getter on the class (would 500 at runtime)
//   8. Hardcoded English left in screen files (Text('...') heuristic)
//
// Exit code: 0 always (informational). Wire into CI as a non-blocking
// "language health" job once the gaps are triaged.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const STRINGS_FILE = join(APP_ROOT, 'lib', 'l10n', 'app_strings.dart');
const LIB_ROOT = join(APP_ROOT, 'lib');

// ── Dart map parsing ───────────────────────────────────────────────────
//
// The maps look like:
//   'en': {
//     'action.cancel': 'Cancel',
//     'leave.notes_hint':
//         'Multi-line\n'
//         'continuation',
//     ...
//   },
//
// Strategy: find each locale block boundary, then scan key/value pairs
// inside. Values can be Dart string literals with adjacent-concat
// (`'foo' 'bar'` → `'foobar'`), `\n` escapes, etc. We only care about
// extracting the resolved string for checks; we don't need to handle
// every Dart corner case — the file is hand-maintained and trims to a
// predictable shape.

function readStrings() {
  const raw = readFileSync(STRINGS_FILE, 'utf8');

  // Locate the `_byLang` map literal start.
  const startMatch = raw.match(/_byLang\s*=\s*\{/);
  if (!startMatch) throw new Error('_byLang declaration not found');
  const start = startMatch.index + startMatch[0].length;

  // Find matching closing brace by counting depth.
  let depth = 1, i = start, inStr = false, strCh = '';
  while (i < raw.length && depth > 0) {
    const c = raw[i];
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === strCh) inStr = false;
    } else {
      if (c === '\'' || c === '"') { inStr = true; strCh = c; }
      else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    i++;
  }
  const body = raw.slice(start, i - 1);

  // Split into per-locale chunks. Each looks like `'en': { ... },`.
  const chunks = {};
  const localeRegex = /'(en|hi|ta|te|ml)'\s*:\s*\{/g;
  const positions = [];
  for (const m of body.matchAll(localeRegex)) {
    positions.push({ locale: m[1], start: m.index + m[0].length });
  }
  for (let p = 0; p < positions.length; p++) {
    let d = 1, j = positions[p].start, inS = false, sCh = '';
    while (j < body.length && d > 0) {
      const c = body[j];
      if (inS) {
        if (c === '\\') { j += 2; continue; }
        if (c === sCh) inS = false;
      } else {
        if (c === '\'' || c === '"') { inS = true; sCh = c; }
        else if (c === '{') d++;
        else if (c === '}') d--;
      }
      j++;
    }
    chunks[positions[p].locale] = body.slice(positions[p].start, j - 1);
  }

  return chunks;
}

// Parse `'key.name': 'value',` pairs from a map-body chunk.
// Captures REVIEW comments on the line above each entry.
function parseMap(chunk) {
  const entries = {};
  const reviewKeys = new Set();
  // Match `'key': value,` where value can span multiple lines as
  // adjacent string literals.
  // Dart adjacent-string-concat: 'foo' 'bar' compiles to 'foobar'.
  const lines = chunk.split('\n');
  let pendingReview = null;

  let buf = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('// REVIEW:')) pendingReview = trimmed;
    // Skip comment-only and blank lines — they were corrupting the
    // string-state machine below when the comment text contained
    // apostrophes (e.g. "// REVIEW: doctor's note"). The REVIEW
    // marker is captured above; everything else in a `//` line is
    // metadata, not data.
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    buf += '\n' + line;

    // An entry ends with `,` outside any quoted string.
    let depth = 0, inStr = false, strCh = '', endIdx = -1;
    for (let k = 0; k < buf.length; k++) {
      const c = buf[k];
      if (inStr) {
        if (c === '\\') { k++; continue; }
        if (c === strCh) inStr = false;
      } else {
        if (c === '\'' || c === '"') { inStr = true; strCh = c; }
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') depth--;
        else if (c === ',' && depth === 0) {
          endIdx = k; break;
        }
      }
    }
    if (endIdx === -1) continue;

    const entry = buf.slice(0, endIdx).trim();
    buf = buf.slice(endIdx + 1);

    // Skip dangling commas / blank lines.
    if (!entry) continue;

    // Match `'key': <value>` (key always starts with quote).
    const km = entry.match(/^['"]([^'"]+)['"]\s*:\s*([\s\S]+)$/);
    if (!km) continue;
    const key = km[1];
    let valRaw = km[2].trim();

    // Concatenate adjacent string literals: 'a' 'b'.
    // Replace `'<X>' (whitespace) '<Y>'` with `'<XY>'` repeatedly.
    let value = '';
    {
      let r = valRaw, inS2 = false, ch2 = '', cur = '';
      for (let k = 0; k < r.length; k++) {
        const c = r[k];
        if (inS2) {
          if (c === '\\' && k + 1 < r.length) { cur += r[k+1]; k++; continue; }
          if (c === ch2) { inS2 = false; continue; }
          cur += c;
        } else {
          if (c === '\'' || c === '"') { inS2 = true; ch2 = c; }
        }
      }
      value = cur;
    }

    entries[key] = value;
    if (pendingReview) reviewKeys.add(key);
    pendingReview = null;
  }

  return { entries, reviewKeys };
}

// ── Getter / call analysis ─────────────────────────────────────────────
function listDartFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) listDartFiles(p, acc);
    else if (name.endsWith('.dart')) acc.push(p);
  }
  return acc;
}

function extractGetters() {
  const raw = readFileSync(STRINGS_FILE, 'utf8');
  // Three declaration shapes the file uses:
  //   1. `String get NAME => _t('key');`                  (zero-arg getter)
  //   2. `String NAME(int n) => '$_t(...)…';`             (arrow parametric)
  //   3. `String NAME(int n) { ... return ...; }`         (brace parametric)
  // Capture all three so the orphan-call detector doesn't false-positive
  // on a parametric helper that doesn't directly call `_t()` in its body.
  const getters = [];
  const seen = new Set();
  const push = (name, key = null, parametric = false) => {
    if (seen.has(name)) return;
    seen.add(name);
    getters.push({ name, key, parametric });
  };
  // 1. Zero-arg getters bound to a key.
  for (const m of raw.matchAll(/String\s+get\s+(\w+)\s*=>\s*_t\(['"]([^'"]+)['"]\)/g)) {
    push(m[1], m[2], false);
  }
  // 2 + 3. Any parametric `String NAME(...)` declaration. These don't
  // need to bind a single key — they often compose other accessors.
  for (const m of raw.matchAll(/^\s+String\s+(\w+)\s*\(\s*\w/gm)) {
    push(m[1], null, true);
  }
  return getters;
}

function findCallSites(files, getterNames) {
  // Match `s.foo` or `AppStrings.of(context).foo`, with `foo` being the
  // getter name. Conservative: require word boundary on either side.
  const calledNames = new Set();
  const allNames = new Set(getterNames);
  // Build a grep regex of all known names (alternation).
  const sortedByLen = Array.from(allNames).sort((a,b) => b.length - a.length);
  if (sortedByLen.length === 0) return calledNames;
  const pattern = new RegExp(
    `(?:\\bs\\.|AppStrings\\.of\\([^)]*\\)\\.)(${sortedByLen.join('|')})\\b`,
    'g',
  );
  for (const f of files) {
    if (f.endsWith('app_strings.dart')) continue;
    const txt = readFileSync(f, 'utf8');
    for (const m of txt.matchAll(pattern)) calledNames.add(m[1]);
  }
  return calledNames;
}

// ── Hardcoded-string sweep ─────────────────────────────────────────────
function findHardcodedTexts(files) {
  // Heuristic: `Text('Some words with letters')` and similar where the
  // literal contains 2+ words and at least one uppercase letter (a sign
  // of UI copy, not data keys / paths / placeholders).
  const hits = [];
  // Skip files that legitimately have lots of literal English (test
  // files, the scaffolding itself, route declarations, theme).
  const skipPatterns = [
    /\\test\\/i,
    /\\generated_/i,
    /app_strings\.dart$/,
    /app_router\.dart$/,
    /app_theme\.dart$/,
    /role_config\.dart$/,
  ];
  // Two shapes: direct Text('...') literals, AND English assigned to
  // error/message state variables that later flow into Text widgets — the
  // blind spot that let the MAR hard-stop message ship unlocalized
  // (once-over 2026-08-23: five strings evaded the Text-only heuristic).
  const re = /Text\(\s*['"]([^'"\$\{]{4,})['"]/g;
  const errAssignRe = /_?(?:error|errorMessage|error_message|statusMessage)\w*\s*=\s*['"]([^'"\$\{]{4,})['"]/g;
  const isLikelyUiCopy = (s) => {
    if (s.length < 4) return false;
    if (!/\s/.test(s)) return false;        // single word
    if (!/[A-Z]/.test(s)) return false;      // no uppercase
    if (/^https?:|^mailto:|^[+\d ]+$/.test(s)) return false;
    if (/^[\d.\-:\/ T]+$/.test(s)) return false; // timestamps / numbers
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
    for (const m of txt.matchAll(errAssignRe)) {
      if (isLikelyUiCopy(m[1])) {
        hits.push({ file: relative(APP_ROOT, f), text: m[1] });
      }
    }
  }
  return hits;
}

// ── Main ───────────────────────────────────────────────────────────────
function main() {
  console.log('VH Health — Staff app i18n health check');
  console.log('========================================\n');

  const chunks = readStrings();
  const parsed = {};
  for (const [loc, chunk] of Object.entries(chunks)) {
    parsed[loc] = parseMap(chunk);
  }

  const enKeys = new Set(Object.keys(parsed.en?.entries ?? {}));
  console.log(`English source-of-truth keys: ${enKeys.size}\n`);

  // 1+2. Coverage + missing keys per locale.
  // `ml` is a DECLARED-PARTIAL locale (2026-06-10 nurse-facing first
  // pass; everything else falls back to English by design) — its
  // coverage is reported but missing keys are not listed and partial
  // coverage is not a finding.
  const FULL_LOCALES = ['hi', 'ta', 'te'];
  const PARTIAL_LOCALES = ['ml'];
  for (const loc of [...FULL_LOCALES, ...PARTIAL_LOCALES]) {
    const partial = PARTIAL_LOCALES.includes(loc);
    const got = new Set(Object.keys(parsed[loc]?.entries ?? {}));
    const missing = [];
    for (const k of enKeys) if (!got.has(k)) missing.push(k);
    const cov = (((enKeys.size - missing.length) / enKeys.size) * 100).toFixed(1);
    const reviewN = parsed[loc]?.reviewKeys.size ?? 0;
    console.log(`[${loc}] coverage ${cov}%  (${enKeys.size - missing.length}/${enKeys.size}),  // REVIEW: flags ${reviewN},  missing ${missing.length}${partial ? '  [partial by design — nurse-facing first pass]' : ''}`);
    if (partial) {
      console.log('');
      continue;
    }
    if (missing.length > 0 && missing.length < 25) {
      for (const k of missing.sort()) console.log(`   missing: ${k}`);
    } else if (missing.length >= 25) {
      console.log(`   (showing first 15 of ${missing.length})`);
      for (const k of missing.sort().slice(0, 15)) console.log(`   missing: ${k}`);
    }
    console.log('');
  }

  // 3. Suspected copy-paste — but filter strings that are intentionally
  // English everywhere (medical abbreviations, unit symbols, format
  // placeholders). Heuristics: short all-caps tokens, unit suffixes,
  // and explicit format hints with `+91 XXXXX` etc.
  console.log('--- 3. Suspected copy-paste (translation === English) ---');
  const isIntentionallyEnglish = (en) => {
    const s = en.trim();
    if (s.length < 4) return true;
    if (/^[A-Z0-9/+,. ]+$/.test(s)) return true;       // all-caps or punct
    if (/(mg\/dL|mmHg|bpm|°[FC]|kg|cm|µ|μ|%|₹)/.test(s)) return true;
    if (/^\+?\d|XXXXX|^OD,|^PO,|^BD\b|^TDS\b/.test(s)) return true;
    if (/^EMP[-:]/.test(s)) return true;               // employee-id format
    if (/SpO[₂2]/.test(s)) return true;                 // medical
    if (/^(DNR|DNI|CPR|ICU|ECG|EEG|MRI|CT|XR|USG|HR|BP|RR|GCS|AVPU)/.test(s)) return true;
    return false;
  };
  let copyHits = 0;
  for (const loc of ['hi', 'ta', 'te', 'ml']) {
    const dups = [];
    for (const [k, v] of Object.entries(parsed[loc]?.entries ?? {})) {
      const en = parsed.en?.entries[k];
      if (en && v === en && /[a-zA-Z]/.test(en) && !isIntentionallyEnglish(en)) {
        dups.push(k);
      }
    }
    if (dups.length > 0) {
      console.log(`[${loc}] ${dups.length} keys identical to English`);
      for (const k of dups.slice(0, 8)) console.log(`   ${k} → "${parsed.en.entries[k].slice(0, 60)}"`);
      if (dups.length > 8) console.log(`   ...and ${dups.length - 8} more`);
      copyHits += dups.length;
    } else {
      console.log(`[${loc}] none`);
    }
  }
  console.log(`Total: ${copyHits} (intentionally-English strings filtered out)\n`);

  // 4. Length outliers
  console.log('--- 4. Length outliers (translation > 2.5x English chars) ---');
  for (const loc of ['hi', 'ta', 'te', 'ml']) {
    const out = [];
    for (const [k, v] of Object.entries(parsed[loc]?.entries ?? {})) {
      const en = parsed.en?.entries[k];
      if (!en || en.length < 10) continue;
      if (v.length > en.length * 2.5) {
        out.push({ k, ratio: (v.length / en.length).toFixed(1), en: en.slice(0, 40), tx: v.slice(0, 60) });
      }
    }
    if (out.length === 0) {
      console.log(`[${loc}] none`);
    } else {
      console.log(`[${loc}] ${out.length} outliers`);
      for (const o of out.slice(0, 5)) console.log(`   ${o.k}  ${o.ratio}x  "${o.en}…" → "${o.tx}…"`);
    }
  }
  console.log('');

  // 5. Getters: declared vs called
  const getters = extractGetters();
  console.log(`--- 5. Getters declared on AppStrings: ${getters.length} ---`);
  const files = listDartFiles(LIB_ROOT);
  const getterNames = getters.map(g => g.name);
  const called = findCallSites(files, getterNames);
  const declaredButUnused = getters.filter(g => !called.has(g.name));
  console.log(`   called from lib/: ${called.size}`);
  console.log(`   declared but never called: ${declaredButUnused.length}`);
  if (declaredButUnused.length > 0 && declaredButUnused.length < 25) {
    for (const g of declaredButUnused.sort((a,b) => a.name.localeCompare(b.name))) {
      console.log(`   unused: ${g.name}  (key=${g.key})`);
    }
  } else if (declaredButUnused.length >= 25) {
    console.log(`   (first 15 of ${declaredButUnused.length})`);
    for (const g of declaredButUnused.sort((a,b) => a.name.localeCompare(b.name)).slice(0, 15)) {
      console.log(`   unused: ${g.name}  (key=${g.key})`);
    }
  }
  console.log('');

  // 6. Orphan calls — `s.foo` with no matching getter. The hard part
  // is that `s` is a common variable name (stat objects, action chips,
  // string utilities), so a naive grep for `s.foo` is mostly false
  // positives. Restrict to:
  //   - Files that import `app_strings.dart` (so `s` likely IS the
  //     AppStrings instance).
  //   - Names that look like a typical accessor camelCase (start with
  //     a domain prefix we use, e.g. dashboard / bed / leave / etc.).
  //   - Names that are NOT a known Dart String/List/Map/Object method.
  console.log('--- 6. Orphan calls (`s.foo` with no matching AppStrings getter) ---');
  const orphanRe = /(?:\bs\.|AppStrings\.of\([^)]*\)\.)([a-z][A-Za-z0-9]+)\b/g;
  const declaredSet = new Set(getterNames);
  // Built-in Dart / Flutter member names commonly accessed off variables
  // named `s`. Anything matching these is a false positive.
  const dartCommon = new Set([
    'toString', 'hashCode', 'runtimeType', 'noSuchMethod',
    'isEmpty', 'isNotEmpty', 'length', 'trim', 'trimLeft', 'trimRight',
    'substring', 'startsWith', 'endsWith', 'contains', 'replaceAll',
    'replaceFirst', 'split', 'toLowerCase', 'toUpperCase', 'codeUnitAt',
    'padLeft', 'padRight', 'reversed',
    // Common app-domain object property names (NavItem / Stat / Action
    // chip / Map row).
    'icon', 'label', 'route', 'color', 'value', 'count', 'name', 'key',
    'title', 'description', 'data', 'first', 'last', 'role', 'id',
  ]);
  // Also accept names that have a known AppStrings prefix as suspicious.
  const appStringsPrefixes = [
    'action', 'label', 'dashboard', 'login', 'bed', 'attendance',
    'leave', 'notifications', 'messaging', 'patient', 'voice',
    'profile', 'about', 'settings', 'vitals', 'nursing', 'handover',
    'queue', 'prescriptions', 'appt', 'admission', 'orders', 'clinical',
    'mar', 'discharge', 'payroll', 'hr', 'reports', 'incident',
    'grievance', 'housekeeping', 'blood', 'dietary', 'theatre',
    'radiology', 'schedule', 'investigations', 'lab', 'pharmacy',
    'telemedicine', 'tax', 'investment', 'overtime', 'dispute',
  ];
  const looksLikeAppStringsAccessor = (n) => {
    if (dartCommon.has(n)) return false;
    return appStringsPrefixes.some(p => n.startsWith(p));
  };
  const orphans = new Map();
  for (const f of files) {
    if (f.endsWith('app_strings.dart')) continue;
    const txt = readFileSync(f, 'utf8');
    if (!txt.includes('app_strings.dart')) continue;
    for (const m of txt.matchAll(orphanRe)) {
      const name = m[1];
      if (declaredSet.has(name)) continue;
      if (!looksLikeAppStringsAccessor(name)) continue;
      const ent = orphans.get(name) ?? [];
      ent.push(relative(APP_ROOT, f));
      orphans.set(name, ent);
    }
  }
  if (orphans.size === 0) {
    console.log('   none');
  } else {
    console.log(`   ${orphans.size} suspect orphan(s):`);
    for (const [n, fs] of [...orphans.entries()].sort()) {
      console.log(`   ${n}  in ${fs.length} file(s): ${fs[0]}${fs.length>1?` (+${fs.length-1})`:''}`);
    }
  }
  console.log('');

  // 7. Hardcoded English remaining
  console.log('--- 7. Hardcoded English remaining (Text(\'...\') heuristic) ---');
  const hardcoded = findHardcodedTexts(files);
  // Group by file
  const byFile = {};
  for (const h of hardcoded) {
    byFile[h.file] = (byFile[h.file] ?? []);
    byFile[h.file].push(h.text);
  }
  console.log(`Files with suspected hardcoded UI strings: ${Object.keys(byFile).length}, total occurrences: ${hardcoded.length}`);
  const sortedFiles = Object.entries(byFile).sort((a,b) => b[1].length - a[1].length);
  for (const [f, ss] of sortedFiles.slice(0, 12)) {
    console.log(`   ${f}  (${ss.length})`);
    for (const s of ss.slice(0, 3)) console.log(`     "${s.slice(0, 70)}"`);
  }
  if (sortedFiles.length > 12) console.log(`   ...and ${sortedFiles.length - 12} more files`);

  console.log('\n========================================');
  console.log('Done. Treat as informational; gaps queue for translator review.');
}

main();
