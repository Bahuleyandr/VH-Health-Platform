import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const backendRoot = path.resolve(import.meta.dirname, '../../..');
const repoRoot = path.resolve(backendRoot, '../..');
const isWindows = process.platform === 'win32';

// Until 2026-09-03 both apps forced every minimatch consumer onto 10.2.5 with a
// global override and then rewrote node_modules in `postinstall`: a default
// export was grafted onto minimatch 10 for consumers written against major 3,
// and test-exclude's Windows helper was rewritten to pass windowsPathsNoEscape
// because minimatch 10 no longer treats a backslash as a separator. Native
// resolution gives each consumer the major it declares, so neither rewrite is
// needed: eslint and test-exclude get their own minimatch 3, which handles
// Windows separators itself, and the 10.x copy stays exactly as published.
//
// This suite asserts on BOTH platforms with the separator the host uses. It
// deliberately does not `test.skip` off Windows: a skip marker without an
// entry in scripts/jest-skip-floor.json fails the canonical gate.
function readJson(relativeToRepo) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativeToRepo), 'utf8'));
}

describe('minimatch resolves natively without install-time mutation', () => {
  test('neither app runs a postinstall hook or overrides minimatch', () => {
    for (const app of ['backend', 'admin']) {
      const pkg = readJson(`apps/${app}/package.json`);
      expect({ app, postinstall: pkg.scripts?.postinstall }).toEqual({ app, postinstall: undefined });
      expect({ app, minimatchOverride: pkg.overrides?.minimatch }).toEqual({ app, minimatchOverride: undefined });
    }
  });

  test('test-exclude and eslint resolve their own minimatch 3, the direct dependency keeps 10', () => {
    const fromTestExclude = createRequire(require.resolve('test-exclude/package.json'));
    expect(fromTestExclude('minimatch/package.json').version).toMatch(/^3\./);
    const fromEslint = createRequire(require.resolve('eslint/package.json'));
    expect(fromEslint('minimatch/package.json').version).toMatch(/^3\./);
    expect(require('minimatch/package.json').version).toMatch(/^10\./);
  });

  test('the installed minimatch 10 is exactly as published: named exports only, no grafted default', () => {
    const minimatch10 = require('minimatch');
    expect(typeof minimatch10.minimatch).toBe('function');
    // The postinstall used to append `module.exports = exports.minimatch` so
    // `require('minimatch')` became callable. A pristine 10.x is an exports
    // object, not a function.
    expect(typeof minimatch10).toBe('object');
    const commonJsIndex = readFileSync(require.resolve('minimatch'), 'utf8');
    expect(commonJsIndex).not.toContain('module.exports = exports.minimatch');
  });

  test("minimatch 3 matches a repo-rooted path using this platform's separator without any option", () => {
    const minimatch3 = createRequire(require.resolve('test-exclude/package.json'))('minimatch');
    expect(typeof minimatch3).toBe('function');
    const [target, pattern] = isWindows
      ? ['D:\\repo\\src\\services\\auth\\otpService.js', 'D:\\repo\\**']
      : ['/repo/src/services/auth/otpService.js', '/repo/**'];
    expect(minimatch3(target, pattern, { dot: true })).toBe(true);
  });

  test('test-exclude instruments inside the backend root and refuses outside it, unpatched', () => {
    const win32Helper = require.resolve('test-exclude/is-outside-dir-win32.js');
    expect(readFileSync(win32Helper, 'utf8')).not.toContain('windowsPathsNoEscape');
    const TestExclude = require('test-exclude');
    const exclude = new TestExclude({ cwd: backendRoot });
    expect(exclude.shouldInstrument(path.join(backendRoot, 'src', 'services', 'auth', 'otpService.js'))).toBe(true);
    expect(exclude.shouldInstrument(path.resolve(backendRoot, '..', 'outside.js'))).toBe(false);
  });

  test('both ESLint compatibility layers load without a rewritten node_modules', async () => {
    const [{ Legacy }, { ESLint }] = await Promise.all([import('@eslint/eslintrc'), import('eslint')]);
    expect(typeof Legacy.CascadingConfigArrayFactory).toBe('function');
    expect(typeof ESLint).toBe('function');
  });
});
