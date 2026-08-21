// DB-guard convention for the deep test corpus.
//
// Deep suites skip themselves when no test database is configured, via a
// module-level guard like:
//
//   const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
//   const describeIfTestDb = databaseUrl ? describe : describe.skip;
//
// The fallback is load-bearing: the canonical CI test job
// (.github/workflows/_reusable-backend-lint-test.yml) historically exported
// only DATABASE_URL, so a guard that read TEST_DATABASE_URL *alone* made its
// suite silently skip in every canonical / merge-gate lane while still
// passing locally against the QA cluster — zero tests, green check, no
// signal that anything was lost. Three lab-ORU deep suites (plus a fourth
// same-class file) shipped that way and were invisible to CI for their whole
// life until 2026-08-15.
//
// This test statically scans every file under src/tests/**/*.test.js and
// fails when a file references process.env.TEST_DATABASE_URL without also
// referencing process.env.DATABASE_URL anywhere in the file. Either operand
// order is fine (`TEST_DATABASE_URL || DATABASE_URL` and the reverse both
// appear across the corpus); what is forbidden is the single-form guard.
// The regex for the fallback is anchored on the `.DATABASE_URL` member
// access, so `process.env.TEST_DATABASE_URL` itself does not satisfy it.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEST_DB_REF = /process\.env\.TEST_DATABASE_URL\b/;
const FALLBACK_DB_REF = /process\.env\.DATABASE_URL\b/;

function listTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe('deep-suite DB guard convention', () => {
  test('every TEST_DATABASE_URL guard carries the DATABASE_URL fallback', () => {
    const offenders = [];

    for (const filePath of listTestFiles(testsRoot)) {
      const source = readFileSync(filePath, 'utf8');
      if (TEST_DB_REF.test(source) && !FALLBACK_DB_REF.test(source)) {
        offenders.push(path.relative(testsRoot, filePath));
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        [
          'These test files reference process.env.TEST_DATABASE_URL without the',
          'process.env.DATABASE_URL fallback, so their suites silently skip in the',
          'canonical CI test job (which reaches the DB via DATABASE_URL):',
          ...offenders.map((file) => `  - src/tests/${file.split(path.sep).join('/')}`),
          'Use the corpus convention instead:',
          '  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL',
          '(see lab-oru-replay-migration.deep.test.js for the canonical shape).',
        ].join('\n'),
      );
    }
  });
});
