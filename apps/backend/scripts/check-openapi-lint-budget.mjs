#!/usr/bin/env node
// apps/backend/scripts/check-openapi-lint-budget.mjs
//
// WARNING-COUNT RATCHET for the OpenAPI Spectral lint.
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
// to PIN the current per-rule counts and fail when any of them moves:
//
//   * count went UP   -> a new warning was introduced. Fail. Fix it, don't re-pin.
//   * count went DOWN -> debt was paid off. Fail, and re-pin with --write so the
//                        ratchet tightens and the slack can't be silently re-used.
//
// So existing debt stays VISIBLE and can only ever shrink, while anything new
// fails loudly and immediately.
//
// This mirrors how the repo pins other semantic state:
// infra/kubernetes/base/monitoring/rule-semantics.sha256 (+ verify-rule-metadata.mjs).
//
// Lowering the baseline is a normal PR: pay off some warnings, run
// `npm run openapi:lint-budget -- --write`, commit the smaller numbers.
//
// ERRORS ARE NEVER BASELINED. Any severity-0 result fails outright and is
// refused by --write, so a real error can't be laundered into the pin file.
//
// Usage:
//   node scripts/check-openapi-lint-budget.mjs            # verify (CI)
//   node scripts/check-openapi-lint-budget.mjs --write    # re-pin the baseline
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
// uses. localeCompare() varies by host locale, which would make this pin file
// flap between machines and false-trip the very gate it backs.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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

/** Aggregate results into an ordered Map<ruleCode, count>. */
function countByRule(results) {
  const counts = new Map();
  for (const r of results) {
    const code = String(r.code);
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return new Map([...counts.entries()].sort((a, b) => cmp(a[0], b[0])));
}

/** Parse the pin file. CRLF-tolerant so a mis-checked-out file still verifies. */
function readBaseline() {
  if (!existsSync(baselinePath)) return null;
  const entries = new Map();
  for (const line of readFileSync(baselinePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [code, count] = trimmed.split(/\s+/, 2);
    entries.set(code, Number(count));
  }
  return entries;
}

const HEADER = `# apps/backend/.spectral-baseline.txt
#
# Pinned per-rule Spectral WARNING counts for src/docs/openapi.json.
# Verified by scripts/check-openapi-lint-budget.mjs (npm run openapi:lint-budget).
#
# This is a RATCHET, not a suppression list. The counts below are existing,
# known debt. CI fails if any count moves in EITHER direction:
#   * higher -> a new warning was introduced; fix the operation, don't re-pin.
#   * lower  -> debt was paid off; re-pin so the slack can't be silently re-used.
#
# To re-pin after legitimately changing the spec:
#   npm run openapi:lint-budget -- --write
#
# Errors (severity 0) are never recorded here — they fail the gate outright.
#
# Format: <spectral-rule-code> <count>, sorted by code-unit compare, LF endings.
`;

function serialize(counts) {
  const lines = [...counts.entries()].map(([code, n]) => `${code} ${n}`);
  return `${HEADER}${lines.join('\n')}\n`;
}

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

const counts = countByRule(results);
const total = [...counts.values()].reduce((a, b) => a + b, 0);

if (write) {
  writeFileSync(baselinePath, serialize(counts));
  console.log(`✓ re-pinned ${counts.size} rule(s) / ${total} finding(s) -> .spectral-baseline.txt`);
  process.exit(0);
}

const baseline = readBaseline();
if (!baseline) {
  console.error('✗ .spectral-baseline.txt is missing — create it with:');
  console.error('    npm run openapi:lint-budget -- --write');
  process.exit(1);
}

const increased = [];
const decreased = [];
for (const code of new Set([...baseline.keys(), ...counts.keys()])) {
  const was = baseline.get(code) ?? 0;
  const now = counts.get(code) ?? 0;
  if (now > was) increased.push({ code, was, now });
  else if (now < was) decreased.push({ code, was, now });
}
increased.sort((a, b) => cmp(a.code, b.code));
decreased.sort((a, b) => cmp(a.code, b.code));

if (increased.length) {
  console.error('✗ OpenAPI lint budget exceeded — NEW Spectral findings were introduced:');
  for (const { code, was, now } of increased) {
    console.error(`    ${code}: ${was} -> ${now}  (+${now - was})`);
  }
  console.error('');
  console.error('  Fix the offending operations. Do NOT re-pin to make this pass —');
  console.error('  the baseline only ever goes down.');
  console.error('  Locate them with:  npx spectral lint src/docs/openapi.json');
}

if (decreased.length) {
  console.error(`${increased.length ? '' : '✗ '}OpenAPI lint debt went DOWN — re-pin the baseline:`);
  for (const { code, was, now } of decreased) {
    console.error(`    ${code}: ${was} -> ${now}  (${now - was})`);
  }
  console.error('');
  console.error('  Run:  npm run openapi:lint-budget -- --write   (then commit .spectral-baseline.txt)');
}

if (increased.length || decreased.length) process.exit(1);

console.log(
  `✓ OpenAPI lint budget holds: ${total} finding(s) across ${counts.size} rule(s), 0 errors, none increased`,
);
process.exit(0);
