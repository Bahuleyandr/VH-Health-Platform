import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  dependencyEntries,
  dependencyViolations,
} from '../../../scripts/security/dependency-floors.mjs';

const require = createRequire(import.meta.url);
const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockfile = JSON.parse(readFileSync(path.join(gatewayRoot, 'package-lock.json'), 'utf8'));
const braceFloors = { 1: '1.1.21', 2: '2.1.7' };
const braces = dependencyEntries(lockfile, 'brace-expansion');

describe('gateway development dependency advisory regressions', () => {
  it('keeps every brace-expansion copy above its current advisory floor', () => {
    expect(dependencyViolations(lockfile, 'brace-expansion', braceFloors)).toEqual([]);
  });

  it('retains both development copies on their consumers\' native major lines', () => {
    expect(braces.length).toBeGreaterThan(0);
    expect(braces.map(({ packagePath, version }) => ({
      packagePath,
      major: Number(version.split('.')[0]),
      dev: lockfile.packages[packagePath].dev,
    }))).toEqual([
      { packagePath: 'node_modules/brace-expansion', major: 2, dev: true },
      { packagePath: 'node_modules/test-exclude/node_modules/brace-expansion', major: 1, dev: true },
    ]);
  });

  it('rejects an individual downgrade at every hoisted or nested path', () => {
    expect(braces.length).toBeGreaterThan(0);
    const patched = structuredClone(lockfile);
    for (const { packagePath, version } of braces) {
      patched.packages[packagePath].version = braceFloors[Number(version.split('.')[0])];
    }
    expect(dependencyViolations(patched, 'brace-expansion', braceFloors)).toEqual([]);

    for (const { packagePath } of braces) {
      const downgraded = structuredClone(patched);
      const floor = patched.packages[packagePath].version;
      const [major, minor, patch] = floor.split('.').map(Number);
      const vulnerable = `${major}.${minor}.${patch - 1}`;
      downgraded.packages[packagePath].version = vulnerable;
      expect(dependencyViolations(downgraded, 'brace-expansion', braceFloors))
        .toEqual([`${packagePath} resolved ${vulnerable} (floor ${floor})`]);
    }
  });

  it('rejects an absent dependency family', () => {
    const absent = structuredClone(lockfile);
    for (const { packagePath } of braces) delete absent.packages[packagePath];
    expect(dependencyViolations(absent, 'brace-expansion', braceFloors))
      .toEqual(['brace-expansion is absent from the lockfile']);
  });

  describe.each(braces)('$packagePath preserves ordinary expansion', ({ packagePath, version }) => {
    const expand = require(path.join(gatewayRoot, packagePath));

    it('loads the locked copy', () => {
      expect(require(path.join(gatewayRoot, packagePath, 'package.json')).version).toBe(version);
    });

    it.each([
      ['file{1..3}.js', ['file1.js', 'file2.js', 'file3.js']],
      ['{a..c}', ['a', 'b', 'c']],
      ['{03..01}', ['03', '02', '01']],
      ['{a,{b,c}}/file.{js,json}', ['a/file.js', 'a/file.json', 'b/file.js', 'b/file.json', 'c/file.js', 'c/file.json']],
      ['file\\{1,2\\}.js', ['file{1,2}.js']],
      ['plain.js', ['plain.js']],
    ])('expands %s', (pattern, expected) => {
      expect(expand(pattern)).toEqual(expected);
    });
  });
});
