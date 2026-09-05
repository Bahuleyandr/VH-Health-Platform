#!/usr/bin/env node
// apps/patient/scripts/i18n-review-apply.mjs
//
// Applies review decisions to intl_<loc>.arb and records approval in intl_en.arb's
// @key.description ("... approved <loc> <date>[; <loc> <date>]"), replacing the
// "hi/ta/te/ml values are machine-translated and marked for review" phrase when present.
//
// The edits are textual, not a re-serialisation, because the real ARBs are not a
// fixed point of `JSON.stringify(json, null, 2) + '\n'` (measured 2026-09-05):
//   - intl_en.arb writes 184 of its 1,198 `@key` objects on a single line;
//   - intl_{hi,ta,te,ml}.arb each carry 11 duplicate top-level keys — an English
//     block (~line 1077) shadowed by the translated block (~line 2117). JSON.parse
//     and `flutter gen-l10n` both keep the LAST occurrence, so this tool edits the
//     last one and leaves the shadowed line alone.
// Re-serialising would silently delete those 11 keys per file and reflow the 184
// objects, burying the reviewed change in unrelated churn.
//
// Usage: node apps/patient/scripts/i18n-review-apply.mjs <decisions.jsonl> [--dir lib/l10n] [--date YYYY-MM-DD]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REVIEW_PHRASE = /\s*hi\/ta\/te\/ml values are machine-translated and marked for review\.?/;
const PLACEHOLDER_RE = /\{[a-zA-Z0-9_]+\}/g;
const ph = (s) => [...String(s).matchAll(PLACEHOLDER_RE)].map((m) => m[0]).sort().join(',');

// ── Minimal JSON text scanner (span-preserving) ─────────────────────────

function stringEnd(raw, start) {
  // `start` is the index of the opening quote; returns the index after the close.
  for (let i = start + 1; i < raw.length; i += 1) {
    if (raw[i] === '\\') { i += 1; continue; }
    if (raw[i] === '"') return i + 1;
  }
  throw new Error(`unterminated JSON string at ${start}`);
}

function objectEnd(raw, start) {
  let depth = 0;
  for (let i = start; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === '"') { i = stringEnd(raw, i) - 1; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return i + 1; }
  }
  throw new Error(`unterminated JSON object at ${start}`);
}

// Locates a top-level `"key": <value>` member. Returns the span of the VALUE plus
// the span of the whole member. The LAST match wins, mirroring JSON.parse.
function findMember(raw, key) {
  const needle = new RegExp(`(^|\\n)( {2})${JSON.stringify(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`, 'g');
  let last = null;
  for (const m of raw.matchAll(needle)) last = m;
  if (!last) return null;
  const valueStart = last.index + last[0].length;
  const memberStart = last.index + last[1].length;
  const c = raw[valueStart];
  const valueEnd = c === '"' ? stringEnd(raw, valueStart) : c === '{' ? objectEnd(raw, valueStart) : null;
  if (valueEnd === null) throw new Error(`unsupported value type for '${key}' (starts with ${JSON.stringify(c)})`);
  return { memberStart, valueStart, valueEnd, text: raw.slice(valueStart, valueEnd) };
}

function splice(raw, start, end, replacement) {
  return raw.slice(0, start) + replacement + raw.slice(end);
}

// ── Description stamping ────────────────────────────────────────────────

export function stampDescription(description, locale, date) {
  const base = String(description ?? '').replace(REVIEW_PHRASE, '').trim();
  const stamp = `${locale} ${date}`;
  const m = base.match(/^(.*?)(?:\s*approved ([^.]*))?\.?$/s);
  const prior = m && m[2] ? m[2].split(';').map((s) => s.trim()).filter(Boolean) : [];
  const list = prior.filter((p) => !p.startsWith(`${locale} `)).concat(stamp);
  return `${(m ? m[1] : base).trim()} approved ${list.join('; ')}.`.replace(/^\s*approved/, 'approved');
}

// Rewrites (or inserts) the `@key` metadata object's description in `raw`.
function stampEn(raw, key, locale, date) {
  const meta = findMember(raw, `@${key}`);
  if (meta) {
    const objText = meta.text;
    const dm = objText.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (dm) {
      const current = JSON.parse(`"${dm[1]}"`);
      const next = JSON.stringify(stampDescription(current, locale, date));
      const at = meta.valueStart + dm.index;
      return splice(raw, at, at + dm[0].length, `"description": ${next}`);
    }
    // Metadata object with no description (6 such keys in intl_en.arb today).
    const desc = `"description": ${JSON.stringify(stampDescription('', locale, date))}`;
    const openBrace = meta.valueStart;
    const rest = raw.slice(openBrace + 1);
    const nl = rest.match(/^\n( *)/);
    const inserted = nl ? `\n${nl[1]}${desc},` : `${desc}${/^\s*\}/.test(rest) ? '' : ', '}`;
    return splice(raw, openBrace + 1, openBrace + 1, inserted);
  }
  // No metadata at all (249 such keys in intl_en.arb today): insert `@key` right
  // after the key's own member, in the one-line style the file already uses.
  const entry = findMember(raw, key);
  if (!entry) throw new Error(`unknown key ${key}`);
  const desc = JSON.stringify(stampDescription('', locale, date));
  const after = raw[entry.valueEnd];
  if (after === ',') {
    return splice(raw, entry.valueEnd + 1, entry.valueEnd + 1, `\n  "@${key}": {"description": ${desc}},`);
  }
  // Last member of the object: it must gain the separating comma instead.
  return splice(raw, entry.valueEnd, entry.valueEnd, `,\n  "@${key}": {"description": ${desc}}`);
}

// ── Apply ───────────────────────────────────────────────────────────────

export function applyArbDecisions(dir, decisions, { date }) {
  const path = (loc) => join(dir, `intl_${loc}.arb`);
  const files = new Map(); // loc -> raw text
  const read = (loc) => {
    if (!files.has(loc)) files.set(loc, readFileSync(path(loc), 'utf8'));
    return files.get(loc);
  };
  const originals = new Map();
  const enRaw0 = read('en');
  originals.set('en', enRaw0);
  const enJson = JSON.parse(enRaw0);

  // Validate everything before writing anything.
  for (const d of decisions) {
    if (!d.approved) continue;
    if (d.locale === 'en') throw new Error(`refusing to write the source locale for ${d.key}`);
    if (!(d.key in enJson)) throw new Error(`unknown key ${d.key}`);
    if (ph(enJson[d.key]) !== ph(d.value)) throw new Error(`placeholder mismatch for ${d.key} (${d.locale})`);
    const raw = read(d.locale);
    if (!originals.has(d.locale)) originals.set(d.locale, raw);
    if (!(d.key in JSON.parse(raw))) throw new Error(`no ${d.locale} entry for ${d.key}`);
  }

  for (const d of decisions) {
    if (!d.approved) continue;
    const raw = read(d.locale);
    const entry = findMember(raw, d.key);
    if (!entry) throw new Error(`no ${d.locale} entry for ${d.key}`);
    files.set(d.locale, splice(raw, entry.valueStart, entry.valueEnd, JSON.stringify(d.value)));
    files.set('en', stampEn(read('en'), d.key, d.locale, date));
  }

  for (const [loc, raw] of files) {
    if (raw !== originals.get(loc)) writeFileSync(path(loc), raw);
  }
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
