// Patched-release floors for dependencies the platform used to force onto a
// single major with a global `overrides` entry and an install-time rewrite of
// node_modules. Native resolution lets every consumer keep the major it
// declares; the invariant that replaces the override is that EVERY resolved
// copy, hoisted or nested, sits at or above the first patched release of its
// major. `check-infra-security-controls.mjs` enforces this on both lockfiles
// in CI; `apps/backend/src/tests/unit/dependencyFloors.test.js` mutation-tests
// the checker itself.
//
// Floors are `first_patched_version` from the GitHub Advisory Database
// (queried 2026-09-03), one entry per major that has a patched release. A
// major with no entry has no patched release and is rejected outright.
//   minimatch:       GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74 (2026-02-26)
//   brace-expansion: GHSA-rgw5-rvv9-x895 (2026-08-03) and predecessors
//   js-yaml:         GHSA-5p4m-2wfm-xmqj (2026-08-06) and predecessors
export const PATCHED_DEPENDENCY_FLOORS = Object.freeze({
  minimatch: Object.freeze({
    3: '3.1.3',
    4: '4.2.5',
    5: '5.1.8',
    6: '6.2.2',
    7: '7.4.8',
    8: '8.0.6',
    9: '9.0.7',
    10: '10.2.3',
  }),
  'brace-expansion': Object.freeze({
    1: '1.1.18',
    2: '2.1.4',
    3: '3.0.6',
    // 4.x has no patched release (GHSA-rgw5-rvv9-x895 fixes >=4 at 5.0.9).
    5: '5.0.9',
  }),
  'js-yaml': Object.freeze({
    3: '3.15.1',
    4: '4.3.1',
    5: '5.2.2',
  }),
});

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

function releaseTuple(version) {
  const match = RELEASE.exec(String(version ?? ''));
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(actual, floor) {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > floor[index]) return true;
    if (actual[index] < floor[index]) return false;
  }
  return true;
}

/** Every lockfile entry that installs `dependencyName`, hoisted or nested. */
export function dependencyEntries(lockfile, dependencyName) {
  const suffix = `/node_modules/${dependencyName}`;
  return Object.entries(lockfile?.packages ?? {})
    .filter(([packagePath]) => packagePath === `node_modules/${dependencyName}` || packagePath.endsWith(suffix))
    .map(([packagePath, metadata]) => ({ packagePath, version: metadata?.version }));
}

/**
 * Violations of the patched floors for one dependency in one lockfile. Empty
 * when every copy is a plain release at or above its major's floor. Absence,
 * prereleases, unparseable versions and majors without a patched release are
 * all violations: this must never be quietly satisfiable.
 */
export function dependencyViolations(lockfile, dependencyName, floors = PATCHED_DEPENDENCY_FLOORS[dependencyName]) {
  if (!floors) throw new Error(`No patched floors are defined for ${dependencyName}`);
  const entries = dependencyEntries(lockfile, dependencyName);
  if (entries.length === 0) return [`${dependencyName} is absent from the lockfile`];
  return entries.flatMap(({ packagePath, version }) => {
    const actual = releaseTuple(version);
    if (!actual) return [`${packagePath} resolved ${version ?? '<missing>'} (unparseable)`];
    const floorVersion = floors[actual[0]];
    if (!floorVersion) return [`${packagePath} resolved ${version} (no patched release in major ${actual[0]})`];
    if (!atLeast(actual, releaseTuple(floorVersion))) return [`${packagePath} resolved ${version} (floor ${floorVersion})`];
    return [];
  });
}
