#!/usr/bin/env node
// scripts/check-docs-plugin-versions.mjs
//
// Docs-vs-pubspec drift guard for Flutter plugin versions.
//
// Why this exists: docs/FLUTTER_PLUGIN_MAJOR_MIGRATIONS.md was written
// 2026-04-29 (commit ebd0204ed) as a record of the P3 migration pass, but
// phrased in the present tense — a bare "New constraint" table plus prose like
// "calls now use v21 named arguments". It then sat untouched while three of its
// rows went stale (flutter_local_notifications, flutter_secure_storage,
// go_router) across separate dependency waves, and
// docs/SMOKE_E2E_JOURNEYS.md picked up the same rot ("migrated to
// flutter_local_notifications 21"). A constraint's home is the pubspec;
// duplicating it into prose is what drifts.
//
// What this checks: inside the guarded docs, every plugin version stated about
// one of OUR packages must agree with the constraint in the pubspec that
// declares it. This is an agreement check, not a ban — docs may state versions,
// they just cannot state wrong ones.
//
// Two escape hatches, both deliberately greppable:
//
//   <!-- vh:historical-start <label> -->  ...  <!-- vh:historical-end -->
//     Everything between is a past-tense record ("what P3 applied"). Permanently
//     true, never checked. An unbalanced marker is a hard failure so the whole
//     file cannot be silenced by a stray open marker.
//
//   <!-- vh:upstream -->
//     Exempts the single line it appears on. For statements about an UPSTREAM
//     version we deliberately do not have — e.g. "permission_handler_android
//     14.0.0 requires compileSdk 37" — which by definition will not match our
//     pubspec.
//
// Exit codes:
//   0  every stated version agrees with the pubspecs
//   1  at least one stated version disagrees (drift)
//   2  structural problem — missing file, unbalanced markers, unparseable pubspec
//
// Usage:
//   node scripts/check-docs-plugin-versions.mjs

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, '..');

// Pubspecs that own the authoritative constraints.
export const PUBSPECS = [
  'apps/patient/pubspec.yaml',
  'apps/staff/pubspec.yaml',
  'packages/vhhealth_core/pubspec.yaml',
];

// Docs under this guard. Extend deliberately: a doc belongs here once it names
// plugin versions at all. A repo-wide sweep is NOT viable — `record`, `health`,
// and `timezone` are simultaneously real plugin names and ordinary English
// across 370+ files in docs/.
export const GUARDED_DOCS = [
  'docs/FLUTTER_PLUGIN_MAJOR_MIGRATIONS.md',
  'docs/SMOKE_E2E_JOURNEYS.md',
];

const HISTORICAL_START = /<!--\s*vh:historical-start\b/;
const HISTORICAL_END = /<!--\s*vh:historical-end\s*-->/;
const UPSTREAM_EXEMPT = /<!--\s*vh:upstream\s*-->/;

// A version token as it appears in docs: ^22.2.0, 22.2.0, 13.x, 21, 12.0.0+1.
const VERSION_TOKEN = String.raw`\^?\d+(?:\.\d+)*(?:\+\d+)?|\d+\.x`;

/**
 * Parse direct dependencies out of a pubspec.yaml.
 *
 * Deliberately regex-based, not a YAML library: there is no root package.json
 * and therefore no node_modules at the repo root to install one into. The shape
 * consumed here is trivial (two-space-indented `name: constraint` under a
 * top-level key), so a parser is not warranted.
 *
 * Entries with no inline constraint (`flutter: {sdk: flutter}`, path overrides)
 * are skipped — they carry no version to compare against.
 */
export function parsePubspecDeps(source) {
  const deps = new Map();
  let section = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const topLevel = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (topLevel) {
      section = topLevel[1];
      continue;
    }

    if (section !== 'dependencies' && section !== 'dev_dependencies') continue;

    const entry = /^ {2}([a-z0-9_]+):[ \t]*(.*)$/.exec(line);
    if (!entry) continue;

    const name = entry[1];
    const constraint = entry[2].replace(/\s+#.*$/, '').trim();
    if (!constraint) continue;
    if (!new RegExp(`^(?:${VERSION_TOKEN})$`).test(constraint)) continue;

    if (!deps.has(name)) deps.set(name, new Set());
    deps.get(name).add(constraint);
  }

  return deps;
}

/** Strip range operators, build metadata, and a trailing `.x` wildcard. */
function normalizeVersion(value) {
  return value
    .replace(/^[\^~>=<\s]+/, '')
    .replace(/\+.*$/, '')
    .replace(/\.x$/, '');
}

/**
 * True when a version stated in a doc is consistent with a pubspec constraint.
 *
 * Component-prefix match, so a doc may legitimately say "22" for "^22.2.0"
 * without restating the full constraint — but "21" against "^22.2.0" fails, and
 * "2" against "^22.2.0" fails too (comparison is per dot-component, not string
 * prefix).
 */
export function versionMatches(stated, constraint) {
  const statedParts = normalizeVersion(stated).split('.');
  const constraintParts = normalizeVersion(constraint).split('.');
  if (statedParts.length > constraintParts.length) return false;
  return statedParts.every((part, i) => part === constraintParts[i]);
}

/**
 * Scan one doc for plugin versions that disagree with the pubspecs.
 *
 * Only backticked plugin names are considered. That is the convention in these
 * files and it is what makes the check precise: it distinguishes the plugin
 * `record` from the English word "record".
 */
export function findDriftedVersions(docText, deps, { file = '<doc>' } = {}) {
  const findings = [];
  const lines = docText.split(/\r?\n/);

  let historicalDepth = 0;
  let historicalOpenedAt = 0;

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    if (HISTORICAL_START.test(line)) {
      historicalDepth += 1;
      if (historicalDepth === 1) historicalOpenedAt = lineNo;
      return;
    }
    if (HISTORICAL_END.test(line)) {
      historicalDepth = Math.max(0, historicalDepth - 1);
      return;
    }
    if (historicalDepth > 0) return;
    if (UPSTREAM_EXEMPT.test(line)) return;

    for (const [name, constraints] of deps) {
      const nameToken = '`' + name + '`';
      let from = 0;

      for (;;) {
        const at = line.indexOf(nameToken, from);
        if (at === -1) break;
        from = at + nameToken.length;

        const trailing = line.slice(from);
        const stated = new RegExp(
          `^[\\s—:,|\\-]*\`?(?:v|version\\s+)?(${VERSION_TOKEN})\\b`,
        ).exec(trailing);
        if (!stated) continue;

        const literal = stated[1];
        const ok = [...constraints].some((c) => versionMatches(literal, c));
        if (!ok) {
          findings.push({
            file,
            line: lineNo,
            plugin: name,
            stated: literal,
            constraints: [...constraints],
            text: line.trim(),
          });
        }
      }
    }
  });

  if (historicalDepth > 0) {
    const error = new Error(
      `${file}: vh:historical-start at line ${historicalOpenedAt} is never closed`,
    );
    error.structural = true;
    throw error;
  }

  return findings;
}

export function runCheck({ root = repoRoot } = {}) {
  const deps = new Map();

  for (const rel of PUBSPECS) {
    const path = join(root, rel);
    if (!existsSync(path)) {
      return { status: 2, message: `Missing pubspec: ${rel}` };
    }
    for (const [name, constraints] of parsePubspecDeps(readFileSync(path, 'utf8'))) {
      if (!deps.has(name)) deps.set(name, new Set());
      for (const c of constraints) deps.get(name).add(c);
    }
  }

  if (deps.size === 0) {
    return { status: 2, message: 'Parsed zero dependencies — pubspec format changed?' };
  }

  const findings = [];
  for (const rel of GUARDED_DOCS) {
    const path = join(root, rel);
    if (!existsSync(path)) {
      return { status: 2, message: `Missing guarded doc: ${rel}` };
    }
    try {
      findings.push(
        ...findDriftedVersions(readFileSync(path, 'utf8'), deps, { file: rel }),
      );
    } catch (error) {
      if (error.structural) return { status: 2, message: error.message };
      throw error;
    }
  }

  return { status: findings.length === 0 ? 0 : 1, findings, checked: deps.size };
}

function main() {
  const result = runCheck();

  if (result.status === 2) {
    console.error(`✗ ${result.message}`);
    process.exit(2);
  }

  if (result.status === 0) {
    console.log(
      `✓ plugin versions in ${GUARDED_DOCS.length} doc(s) agree with the pubspecs ` +
        `(${result.checked} constrained deps known)`,
    );
    process.exit(0);
  }

  console.error('✗ doc states a plugin version that disagrees with the pubspecs');
  console.error('');
  for (const f of result.findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.text}`);
    console.error(
      `    states \`${f.plugin}\` ${f.stated}, pubspec says ${f.constraints.join(' / ')}`,
    );
    console.error('');
  }
  console.error('Fix one of:');
  console.error('  - drop the version from the doc and point at the pubspec (preferred);');
  console.error('  - correct it to match the pubspec;');
  console.error('  - if the claim is historical, move it inside');
  console.error('      <!-- vh:historical-start ... --> ... <!-- vh:historical-end -->');
  console.error('  - if it describes an UPSTREAM version we do not have, append');
  console.error('      <!-- vh:upstream -->  to that line.');
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
