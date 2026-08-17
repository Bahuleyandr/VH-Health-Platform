'use strict';

// Skip-floor reporter — the runtime half of the HIGH-3 (PR #874) follow-up.
//
// THE CLASS THIS CLOSES
// ---------------------
// Four lab-ORU deep suites env-guarded themselves out of every canonical CI
// merge-gate lane and passed green with zero tests for their whole life.
// deepSuiteDbGuardConvention.test.js statically catches THAT guard shape
// (TEST_DATABASE_URL without the DATABASE_URL fallback), but only that shape:
// a guard on any other env var, a stray `.only` (which silently skips every
// sibling), or a new `describe.skip` all still pass green. This reporter
// closes the class at the only layer that sees every skip regardless of its
// mechanism: jest's own run results.
//
// HOW IT WORKS
// ------------
// When JEST_ENFORCE_SKIP_FLOOR is set (the canonical CI jobs export it —
// .github/workflows/_reusable-backend-lint-test.yml and
// _reusable-backend-quick.yml — where the full DB env is provisioned and no
// suite has a legitimate reason to skip), every test that finishes the run
// with a skipped-family status (pending / skipped / todo / disabled) must be
// declared in scripts/jest-skip-floor.json, matched by file plus its own
// title or any ancestor describe title. Any undeclared skip fails the run via
// getLastError() with a paste-ready floor entry.
//
// Local runs are untouched: without the env var the reporter is inert, so
// DB-less dev runs (where the deep-suite guards legitimately skip hundreds of
// suites) do not fail. That asymmetry is the point — a skip is fine locally
// and a silent hole in the gate.
//
// The static half — every literal skip marker must have a floor entry, and
// every floor entry must still name a real test — lives in
// src/tests/unit/jestSkipFloor.test.js, which also pins this reporter into
// package.json's jest.reporters so the gate cannot be silently unwired.

const fs = require('node:fs');
const path = require('node:path');

const SKIP_STATUSES = new Set(['pending', 'skipped', 'todo', 'disabled']);
const FLOOR_PATH = path.join(__dirname, 'jest-skip-floor.json');

function enforcementEnabled() {
  const raw = String(process.env.JEST_ENFORCE_SKIP_FLOOR || '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function loadFloorEntries() {
  const parsed = JSON.parse(fs.readFileSync(FLOOR_PATH, 'utf8'));
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error('jest-skip-floor.json must be an object with an "entries" array');
  }
  return parsed.entries;
}

function isAllowed(entries, relPath, assertion) {
  const ancestors = Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles : [];
  return entries.some(
    (entry) =>
      entry
      && entry.file === relPath
      && (entry.title === assertion.title || ancestors.includes(entry.title)),
  );
}

class JestSkipFloorReporter {
  constructor(globalConfig) {
    this._rootDir = (globalConfig && globalConfig.rootDir) || path.resolve(__dirname, '..');
    this._error = null;
  }

  onRunComplete(_contexts, results) {
    if (!enforcementEnabled()) return;

    let entries;
    try {
      entries = loadFloorEntries();
    } catch (err) {
      this._error = new Error(
        `JEST_ENFORCE_SKIP_FLOOR is set but the skip floor could not be loaded from ${FLOOR_PATH}: ${err.message}`,
      );
      return;
    }

    const offenders = [];
    for (const fileResult of (results && results.testResults) || []) {
      const relPath = path
        .relative(this._rootDir, fileResult.testFilePath || '')
        .split(path.sep)
        .join('/');
      for (const assertion of fileResult.testResults || []) {
        if (!SKIP_STATUSES.has(assertion.status)) continue;
        if (isAllowed(entries, relPath, assertion)) continue;
        offenders.push({
          file: relPath,
          fullName: assertion.fullName || assertion.title,
          title: assertion.title,
          status: assertion.status,
        });
      }
    }

    if (offenders.length === 0) return;

    // Jest fails the run on getLastError() but prints nothing for it — write
    // the diagnosis ourselves or a CI shard dies with a bare exit 1.
    this._error = new Error(
      [
        'SKIP FLOOR VIOLATION — tests skipped in an enforced run without a floor entry.',
        'Skipping is invisible-green: this is exactly how the lab-ORU deep suites',
        'vanished from every merge-gate lane (HIGH-3, PR #874). Either make these',
        'tests run under the canonical CI env, or — if the skip is a deliberate,',
        'reviewed decision — declare it in apps/backend/scripts/jest-skip-floor.json:',
        '',
        ...offenders.map(
          (o) => `  - [${o.status}] ${o.file} :: ${o.fullName}`,
        ),
        '',
        'Paste-ready floor entries (fill in the reason):',
        ...offenders.map((o) =>
          `  { "file": ${JSON.stringify(o.file)}, "title": ${JSON.stringify(o.title)}, "reason": "" },`,
        ),
      ].join('\n'),
    );
    process.stderr.write(`\n${this._error.message}\n\n`);
  }

  getLastError() {
    return this._error || undefined;
  }
}

module.exports = JestSkipFloorReporter;
