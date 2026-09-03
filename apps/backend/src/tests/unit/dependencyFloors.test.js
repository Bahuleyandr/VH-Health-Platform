import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PATCHED_DEPENDENCY_FLOORS,
  dependencyEntries,
  dependencyViolations,
} from '../../../../../scripts/security/dependency-floors.mjs';

// The install used to force every consumer onto minimatch 10.2.5 with a global
// override and then rewrite node_modules in postinstall so consumers written
// for majors 3, 5 and 9 kept working. Native resolution lets each consumer
// keep its own major; what must then hold instead is that EVERY resolved copy
// sits at or above the first patched release of its major (GHSA-7r86-cg39-jmmj
// and GHSA-23c5-xmqv-rm74 for minimatch, GHSA-rgw5-rvv9-x895 and its
// predecessors for brace-expansion, GHSA-5p4m-2wfm-xmqj and predecessors for
// js-yaml). scripts/security/check-infra-security-controls.mjs enforces that
// on both lockfiles in CI; this suite mutation-tests the shared checker so the
// gate cannot go quietly vacuous.

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const repoRoot = path.resolve(backendRoot, '..', '..');
const readLock = (relativePath) => JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));

const GUARDED = ['minimatch', 'brace-expansion', 'js-yaml'];

describe('dependency floors', () => {
  const locks = {
    backend: readLock('apps/backend/package-lock.json'),
    admin: readLock('apps/admin/package-lock.json'),
  };

  it.each(Object.keys(locks))('%s resolves every guarded dependency at or above its patched floor', (app) => {
    for (const name of GUARDED) {
      expect({ name, violations: dependencyViolations(locks[app], name) })
        .toEqual({ name, violations: [] });
    }
  });

  it('backend resolves minimatch natively across the majors its consumers declare', () => {
    const majors = [...new Set(
      dependencyEntries(locks.backend, 'minimatch').map(({ version }) => Number(version.split('.')[0])),
    )].sort((left, right) => left - right);
    // eslint and friends (3), readdir-glob (5), jest/rimraf (9), the direct dependency (10).
    expect(majors).toEqual([3, 5, 9, 10]);
  });

  it('flags a copy below its floor, a major with no patched release, and an absent dependency', () => {
    const below = structuredClone(locks.backend);
    const three = dependencyEntries(below, 'minimatch').find(({ version }) => version.startsWith('3.'));
    below.packages[three.packagePath].version = '3.1.2';
    expect(dependencyViolations(below, 'minimatch')).toEqual([`${three.packagePath} resolved 3.1.2 (floor 3.1.3)`]);

    const unpatchedMajor = structuredClone(locks.backend);
    unpatchedMajor.packages['node_modules/some-consumer/node_modules/brace-expansion'] = { version: '4.0.1' };
    expect(dependencyViolations(unpatchedMajor, 'brace-expansion'))
      .toEqual(['node_modules/some-consumer/node_modules/brace-expansion resolved 4.0.1 (no patched release in major 4)']);

    expect(dependencyViolations({ packages: {} }, 'js-yaml')).toEqual(['js-yaml is absent from the lockfile']);
  });

  it('rejects a malformed or prerelease version rather than treating it as safe', () => {
    const malformed = structuredClone(locks.backend);
    const nine = dependencyEntries(malformed, 'minimatch').find(({ version }) => version.startsWith('9.'));
    malformed.packages[nine.packagePath].version = '9.0.9-rc.1';
    expect(dependencyViolations(malformed, 'minimatch')).toEqual([`${nine.packagePath} resolved 9.0.9-rc.1 (unparseable)`]);
  });

  it('publishes floors that match the advisory data they came from', () => {
    expect(PATCHED_DEPENDENCY_FLOORS.minimatch).toEqual({ 3: '3.1.3', 4: '4.2.5', 5: '5.1.8', 6: '6.2.2', 7: '7.4.8', 8: '8.0.6', 9: '9.0.7', 10: '10.2.3' });
    expect(PATCHED_DEPENDENCY_FLOORS['brace-expansion']).toEqual({ 1: '1.1.18', 2: '2.1.4', 3: '3.0.6', 5: '5.0.9' });
    expect(PATCHED_DEPENDENCY_FLOORS['js-yaml']).toEqual({ 3: '3.15.1', 4: '4.3.1', 5: '5.2.2' });
  });
});
