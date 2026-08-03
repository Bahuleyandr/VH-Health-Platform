#!/usr/bin/env node
// apps/backend/scripts/check-openapi-lint-budget.mjs
//
// DIAGNOSTIC-FINGERPRINT BASELINE for the OpenAPI Spectral lint.
//
// Why this exists
// ---------------
// `npx spectral lint src/docs/openapi.json` fails only on ERRORS. The spec
// carried thousands of WARNINGS, so the run ended `✖ N problems (0 errors, N
// warnings)` every single time and a genuinely NEW warning was invisible inside
// the noise — the lint had no signal left.
//
// The fix is not to silence the rules (that hides the debt permanently, and a
// subsystem that later authors real descriptions gets no credit for it). It is
// to pin the current diagnostics INDIVIDUALLY and fail when a new one appears.
//
// Why fingerprints and NOT per-rule counts
// ----------------------------------------
// A per-rule count baseline does not meet its own goal, and this was verified
// against the real spec, not assumed: document one operation while a DIFFERENT
// operation loses its description and `operation-description` stays at 3574, so
// a count gate reports `✓ none increased` and exits 0 while a brand-new warning
// exists. Renames, warnings moving between operations, and severity changes at
// constant count all slip through the same hole.
//
// So identity is the tuple { severity, code, path, message } — never a count.
// Counts are still DERIVED below, but only as telemetry for the debt report.
//
// What is deliberately EXCLUDED from identity
// -------------------------------------------
// `range` (line/character positions shift whenever anything above them moves),
// `source` (an absolute path that differs per machine and per OS), and
// `documentationUrl` (ruleset metadata, not a property of this spec). Excluding
// `range` is also what makes the manifest immune to LF/CRLF differences.
//
// Comparison is a sorted MULTISET, not a set: two distinct findings can share a
// fingerprint (component-level rules in particular), and collapsing them would
// let one of a pair regress invisibly.
//
//   * present in current, absent from baseline -> a NEW finding. FAIL.
//   * present in baseline, absent from current -> RESOLVED. Re-pin with --write
//     so the entry is PRUNED; a stale entry would let the same finding come
//     back at the same path later and hide behind it.
//
// A blind `--write` is therefore always visible in review as concrete removed
// lines, never as a single changed number.
//
// This mirrors how the repo pins other semantic state:
// infra/kubernetes/base/monitoring/rule-semantics.sha256 (+ verify-rule-metadata.mjs).
//
// ERRORS ARE NEVER BASELINED. Any severity-0 result fails outright and is
// refused by --write, so a real error can't be laundered into the manifest.
//
// Usage:
//   node scripts/check-openapi-lint-budget.mjs            # verify (CI)
//   node scripts/check-openapi-lint-budget.mjs --write    # re-pin the manifest
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '..');
const specPath = join(backendRoot, 'src', 'docs', 'openapi.json');
const baselinePath = join(backendRoot, '.spectral-baseline.txt');

const write = process.argv.includes('--write');

// Locale-INDEPENDENT code-unit comparator — the same rule the spec generator
// uses. localeCompare() varies by host locale, which would make this manifest
// flap between machines and false-trip the very gate it backs.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const SEVERITY_NAMES = ['error', 'warning', 'info', 'hint'];

/** Run spectral and return its parsed JSON results.
 *
 * Invokes the CLI's JS entry with process.execPath rather than the
 * node_modules/.bin shim: on Windows the shim is a .cmd, which Node refuses to
 * spawn without `shell: true`, and under a shell an install path containing a
 * space (…/VH Health/…) is split into separate arguments. Running the entry
 * point directly needs no shell, so spaces are passed through intact. */
function runSpectral() {
  const cli = join(backendRoot, 'node_modules', '@stoplight', 'spectral-cli', 'dist', 'index.js');
  if (!existsSync(cli)) {
    console.error(`✗ spectral CLI not found at ${cli} — run \`npm install\` in apps/backend`);
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [cli, 'lint', '--format', 'json', specPath], {
    cwd: backendRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`✗ failed to run spectral: ${res.error.message}`);
    process.exit(1);
  }
  const stdout = (res.stdout || '').trim();
  const start = stdout.indexOf('[');
  if (start === -1) {
    console.error('✗ spectral produced no JSON result array');
    if (res.stderr) console.error(res.stderr.trim());
    process.exit(1);
  }
  try {
    return JSON.parse(stdout.slice(start));
  } catch (e) {
    console.error(`✗ could not parse spectral JSON output: ${e.message}`);
    process.exit(1);
  }
}

/** One diagnostic -> one stable, readable, machine-comparable line.
 * Tabs separate the 4 identity fields, so any tab/newline inside a message is
 * flattened to a space rather than corrupting the column layout. */
function fingerprint(r) {
  const severity = SEVERITY_NAMES[r.severity] ?? String(r.severity);
  const path = JSON.stringify(Array.isArray(r.path) ? r.path : []);
  const message = String(r.message ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return [severity, String(r.code), path, message].join('\t');
}

/** Sorted multiset of fingerprints. */
function fingerprintsOf(results) {
  return results.map(fingerprint).sort(cmp);
}

/** Multiset difference a − b, preserving duplicate multiplicity. */
function multisetDiff(a, b) {
  const remaining = new Map();
  for (const line of b) remaining.set(line, (remaining.get(line) || 0) + 1);
  const out = [];
  for (const line of a) {
    const n = remaining.get(line) || 0;
    if (n > 0) remaining.set(line, n - 1);
    else out.push(line);
  }
  return out;
}

/** Parse the manifest. CRLF-tolerant so a mis-checked-out file still verifies. */
function readBaseline() {
  if (!existsSync(baselinePath)) return null;
  return readFileSync(baselinePath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() && !l.startsWith('#'))
    .sort(cmp);
}

/** Per-rule counts, derived from the manifest purely as debt TELEMETRY.
 * Never used for enforcement — see the header. */
function countsByRule(lines) {
  const counts = new Map();
  for (const line of lines) {
    const code = line.split('\t')[1] ?? '(unknown)';
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => cmp(a[0], b[0]));
}

const HEADER = `# apps/backend/.spectral-baseline.txt
#
# Pinned Spectral diagnostics for src/docs/openapi.json — one line per finding.
# Verified by scripts/check-openapi-lint-budget.mjs (npm run openapi:lint-budget).
#
# This is a DEBT LEDGER, not a suppression list. Every line is a known, accepted
# finding. CI fails when a finding appears that is not listed here, and asks you
# to re-pin when a listed finding is resolved (so the entry is pruned and the
# same finding cannot silently return later at the same path).
#
# Identity is { severity, code, path, message }. Line/character positions,
# absolute source paths and documentation URLs are deliberately NOT part of
# identity — they move without the finding changing.
#
# Counts are NOT the gate: documenting one operation while another loses its
# description leaves every per-rule count identical, so a count-based gate would
# pass while a new warning exists. That was measured, not assumed.
#
# To re-pin after legitimately changing the spec:
#   npm run openapi:lint-budget -- --write
#
# Errors (severity 0) are never recorded here — they fail the gate outright.
#
# Format: <severity>\\t<code>\\t<json-path>\\t<message>, sorted by code-unit
# compare, LF endings.
`;

// ---------------------------------------------------------------------------

const results = runSpectral();

const errors = results.filter((r) => r.severity === 0);
if (errors.length) {
  console.error(`✗ ${errors.length} Spectral ERROR(s) — these are never baselined:`);
  for (const e of errors.slice(0, 20)) {
    console.error(`    ${e.code}  ${e.message}  (${(e.path || []).join('.') || '<root>'})`);
  }
  if (errors.length > 20) console.error(`    ... and ${errors.length - 20} more`);
  process.exit(1);
}

const current = fingerprintsOf(results);

if (write) {
  writeFileSync(baselinePath, `${HEADER}${current.join('\n')}\n`);
  console.log(`✓ re-pinned ${current.length} finding(s) -> .spectral-baseline.txt`);
  for (const [code, n] of countsByRule(current)) console.log(`    ${code}: ${n}`);
  process.exit(0);
}

const baseline = readBaseline();
if (!baseline) {
  console.error('✗ .spectral-baseline.txt is missing — create it with:');
  console.error('    npm run openapi:lint-budget -- --write');
  process.exit(1);
}

const added = multisetDiff(current, baseline);
const resolved = multisetDiff(baseline, current);

const show = (lines, limit = 25) => {
  for (const line of lines.slice(0, limit)) {
    const [severity, code, path, message] = line.split('\t');
    console.error(`    ${severity} ${code}  ${path}`);
    console.error(`        ${message}`);
  }
  if (lines.length > limit) console.error(`    ... and ${lines.length - limit} more`);
};

if (added.length) {
  console.error(`✗ ${added.length} NEW Spectral finding(s) not in the baseline:`);
  show(added);
  console.error('');
  console.error('  Fix the offending operations. Do NOT re-pin to make this pass —');
  console.error('  the baseline only ever shrinks.');
}

if (resolved.length) {
  console.error(`${added.length ? '' : '✗ '}${resolved.length} baselined finding(s) RESOLVED — prune them:`);
  show(resolved, 10);
  console.error('');
  console.error('  Run:  npm run openapi:lint-budget -- --write   (then commit .spectral-baseline.txt)');
}

if (added.length || resolved.length) process.exit(1);

console.log(`✓ OpenAPI lint baseline holds: ${current.length} known finding(s), 0 errors, 0 new`);
for (const [code, n] of countsByRule(current)) console.log(`    ${code}: ${n}`);
process.exit(0);
