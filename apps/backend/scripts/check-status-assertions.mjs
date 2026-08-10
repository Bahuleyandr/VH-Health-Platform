#!/usr/bin/env node
// scripts/check-status-assertions.mjs
//
// Ban status assertions that accept both success and a serious failure.
//
// Pattern: `expect([200, 500]).toContain(res.statusCode)` — an accepted-status
// array that mixes a 5xx code with any non-5xx code. Such an assertion can
// NEVER fail on a server regression: the route 500s, the test still passes.
// These date from the pre-2026-04-14 "no DB in test" smoke suites; CI has run
// against a fully migrated + seeded Postgres since then, so tolerating a 5xx
// only masks fixture gaps and real regressions. House rule (apps/backend/
// CLAUDE.md, Phase 0.5): "Tests assert exactly, never [200, 500]".
//
// What is flagged: any array literal containing BOTH a 5xx status (500-599)
// and a non-5xx status, or BOTH a 2xx status and 401/403, asserted via
// `.toContain(<expression>)`. The AST pass also detects split forms such as
// `if (res.status !== 200) expect([403, 404]).toContain(res.status)`.
// `.not.toContain(...)` is the inverse (good) pattern and is skipped. An
// all-5xx set (e.g. [500, 503]) is not mixing and is allowed.
//
// Exemption: a deliberate contract (e.g. a readiness probe that is 200 when
// healthy and 503 when degraded) may carry an inline marker on the assertion
// line or the line directly above it:
//     // ban-exempt: <reason>
// The reason is mandatory — a bare "ban-exempt:" with no text fails too.
//
// Standalone CLI (same conventions as lint-raw-params.mjs): plain console,
// CWD-independent path resolution, exit 1 with per-hit file:line output.
// NOTE: lint-raw-params.mjs deliberately skips tests/ in its walk; this
// script exists precisely to walk src/tests/.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMixedStatusAssertions } from './lib/statusAssertionAst.mjs';

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(test|spec)\.(js|mjs|cjs)$/.test(name)) acc.push(p);
  }
  return acc;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const files = walk(join(scriptDir, '..', 'src'));

let offenders = 0;
let exemptions = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let findings;
  try {
    findings = findMixedStatusAssertions(src);
  } catch (err) {
    console.error(`✗ ${file}:1 — status assertion AST parse failed: ${err.message}`);
    offenders++;
    continue;
  }
  for (const finding of findings) {
    if (finding.exempt) {
      exemptions++;
      continue;
    }
    console.error(
      `✗ ${file}:${finding.line} — status set [${finding.codes.join(', ')}] ` +
        (finding.mixesServerFailure
          ? 'mixes 5xx with non-5xx; '
          : 'mixes success with an authentication/authorization failure; ') +
        'a test that tolerates this failure cannot protect the contract. Assert the exact status ' +
        '(seed the data the route needs), or mark a deliberate contract with `// ban-exempt: <reason>`.'
    );
    offenders++;
  }
}

if (offenders > 0) {
  console.error(
    `\nFAIL: ${offenders} mixed success/failure status assertion(s) in test files.` +
      (exemptions > 0 ? ` (${exemptions} ban-exempt assertion(s) skipped.)` : '')
  );
  process.exit(1);
}
console.log(
  `✓ 0 mixed success/failure status assertions across ${files.length} test files.` +
    (exemptions > 0 ? ` (${exemptions} ban-exempt assertion(s) allowed.)` : '')
);
