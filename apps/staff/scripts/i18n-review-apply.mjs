#!/usr/bin/env node
// apps/staff/scripts/i18n-review-apply.mjs
//
// Applies linguistic-review decisions to lib/l10n/app_strings.dart.
// Decisions are JSONL rows: {"key","locale","value","approved":true,"changed":bool}.
// For each approved row: the entry's value is set to `value` — but when the
// decoded current value already equals it (a confirm), the entry's line(s) are
// left byte-for-byte untouched: no `"` → `'` requoting, no multi-line collapse,
// so the diff carries only real changes (OPEN-21 batch 1 had 226 of 371 changed
// lines that were quote-only confirm rewrites). Every `// REVIEW:` line
// immediately above the entry is removed either way (approval IS the flag's
// removal — see i18n-verify.mjs), and an `ml` row whose key has no explicit
// entry is appended to the 'ml' block so the generated parity placeholder can be
// dropped by `--generate-ml-parity`. Nothing else in the file is touched.
//
// Line shapes handled (measured against the real file, 2026-09-05):
//   - entries at 6 spaces, `'key': <literal>,`;
//   - values as single- OR double-quoted literals (8,161 of the latter today,
//     because `dart format` prefers double quotes for values containing `'`);
//   - multi-line entries whose value continues as adjacent literals at 10 spaces;
//   - `// REVIEW:` flag lines at 6 spaces directly above an entry (block-level
//     REVIEW comments sit at 4 spaces and are left alone);
//   - the `...malayalamTechnicalParityPlaceholders,` spread inside `'ml'`, which
//     is not an entry and must stay above any explicit value that overrides it.
//
// Usage: node apps/staff/scripts/i18n-review-apply.mjs <decisions.jsonl> [--file <app_strings.dart>]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOCALES = new Set(['en', 'hi', 'ta', 'te', 'ml']);
const PLACEHOLDER_RE = /\{[a-zA-Z0-9_]+\}/g;
// A Dart string literal, single- or double-quoted, escapes included.
const LITERAL_RE = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;

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

// Decode a Dart string-literal body (the inverse of dartString, plus the
// escapes `dart format` emits: \" in double-quoted literals, \t, \r).
function decodeDart(body) {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c !== '\\' || i + 1 >= body.length) { out += c; continue; }
    const next = body[i + 1];
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else out += next; // \' \" \\ \$
  }
  return out;
}

function localeBlocks(lines) {
  // Returns { hi: {start, end}, ... } as line indices of the block's own
  // entries (exclusive of the `'hi': {` and closing `},` lines).
  const blocks = {};
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^ {4}'(en|hi|ta|te|ml)'\s*:\s*\{\s*$/);
    if (m) { open = m[1]; blocks[open] = { start: i + 1, end: -1 }; continue; }
    if (open && /^ {4}\},?\s*$/.test(lines[i])) { blocks[open].end = i; open = null; }
  }
  return blocks;
}

// Finds the entry for `key` inside a block: returns {line, endLine, value} where
// the entry may span continuation lines of adjacent literals ending with `,`.
function findEntry(lines, block, key) {
  const head = new RegExp(`^ {6}'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:\\s*`);
  for (let i = block.start; i < block.end; i += 1) {
    if (!head.test(lines[i])) continue;
    let endLine = i;
    while (!/,\s*$/.test(lines[endLine]) && endLine < block.end) endLine += 1;
    const joined = lines.slice(i, endLine + 1).join('\n').replace(head, '');
    const literals = [...joined.matchAll(LITERAL_RE)]
      .map((m) => decodeDart(m[1] !== undefined ? m[1] : m[2]));
    return { line: i, endLine, value: literals.join('') };
  }
  return null;
}

function stripReviewAbove(lines, index) {
  let i = index - 1;
  let removed = 0;
  while (i >= 0 && /^ {6}\/\/ REVIEW:/.test(lines[i])) { lines.splice(i, 1); removed += 1; i -= 1; }
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
    if (!blocks[d.locale]) throw new Error(`locale block '${d.locale}' not found in ${filePath}`);
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
      // Confirm: value already equal → keep the existing line(s) verbatim.
      if (entry.value !== d.value) {
        lines.splice(entry.line, entry.endLine - entry.line + 1, `      '${d.key}': ${dartString(d.value)},`);
      }
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
