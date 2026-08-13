// HL7_INBOUND_ENABLED='true' without HL7_INBOUND_SHARED_SECRET is not a failing
// test — it is a dead jest worker.
//
// `src/utils/validateEnv.js:24-28` makes the secret `required()` the moment the
// flag reads exactly 'true'; the schema runs at import of `src/app.js`, and a
// violation reaches `validateEnv.js:569 process.exit(1)`. Jest reports no
// suite, no test count, and no assertion — just a non-zero exit. Worse, the
// symptom is environment-dependent: a module that happens to die earlier for an
// unrelated reason (a transitive ESM resolution failure, say) hides it, so the
// pair can separate on one Node version and only surface on another.
//
// This test is the fence. Any test file that turns the interface ON must also
// supply the secret in the same file — which is what
// `src/tests/helpers/hl7InboundTestEnv.js` exists to do in one call.
//
// Deliberately a source scan, not a runtime probe: the hazard happens at module
// evaluation of *another* file, which no runtime hook in this process can
// observe before it has already exited.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_ROOT = fileURLToPath(new URL('../', import.meta.url));
const HELPER_RELATIVE = path.join('helpers', 'hl7InboundTestEnv.js');

// Matches an assignment that turns the interface on, at any indentation.
const ENABLES_INTERFACE = /process\.env\.HL7_INBOUND_ENABLED\s*=\s*(['"`])true\1/;
// Either half of the pairing obligation: a direct secret assignment, or the
// helper that performs it.
const SUPPLIES_SECRET = /process\.env\.HL7_INBOUND_SHARED_SECRET\s*=/;
const IMPORTS_HELPER = /hl7InboundTestEnv\.js/;

function collectTestSources(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestSources(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

describe('HL7 inbound test-environment pairing', () => {
  const sources = collectTestSources(TESTS_ROOT).map(file => ({
    relative: path.relative(TESTS_ROOT, file).replaceAll('\\', '/'),
    absolute: file,
    contents: readFileSync(file, 'utf8'),
  }));

  test('scans a non-trivial test tree', () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  test('every test that enables HL7 inbound also supplies the shared secret', () => {
    const offenders = sources
      .filter(source => path.relative(TESTS_ROOT, source.absolute) !== HELPER_RELATIVE)
      .filter(source => ENABLES_INTERFACE.test(source.contents))
      .filter(source => !(IMPORTS_HELPER.test(source.contents) || SUPPLIES_SECRET.test(source.contents)))
      .map(source => source.relative);

    expect(offenders).toEqual([]);
  });

  test('at least one suite exercises the enabled interface, so the fence is live', () => {
    const enablers = sources.filter(source => ENABLES_INTERFACE.test(source.contents));
    expect(enablers.length).toBeGreaterThan(0);
  });

  test('the helper writes both halves of the pair', () => {
    const helper = readFileSync(path.join(TESTS_ROOT, HELPER_RELATIVE), 'utf8');
    expect(ENABLES_INTERFACE.test(helper)).toBe(true);
    expect(SUPPLIES_SECRET.test(helper)).toBe(true);
  });
});
