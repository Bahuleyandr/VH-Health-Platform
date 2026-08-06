import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findDriftedVersions,
  parsePubspecDeps,
  runCheck,
  versionMatches,
} from './check-docs-plugin-versions.mjs';

/** Synthetic dep map. Never read the live pubspecs here — these cases must keep
 *  their meaning after PR #752 (and every later wave) changes the real ones. */
function deps(entries) {
  return new Map(Object.entries(entries).map(([k, v]) => [k, new Set([].concat(v))]));
}

const postBump = deps({
  flutter_local_notifications: '^22.2.0',
  record: '^7.1.1',
  permission_handler: '^12.0.0+1',
  device_info_plus: '^12.4.0',
});

test('flags the exact SMOKE_E2E_JOURNEYS regression', () => {
  // Verbatim from docs/SMOKE_E2E_JOURNEYS.md:73 as it stood before this change,
  // evaluated against post-#752 constraints.
  const doc = 'and was migrated to `flutter_local_notifications` 21.';
  const found = findDriftedVersions(doc, postBump);
  assert.equal(found.length, 1);
  assert.equal(found[0].plugin, 'flutter_local_notifications');
  assert.equal(found[0].stated, '21');
});

test('flags a re-added constraint table row', () => {
  // The regression this guard mainly exists to prevent: someone helpfully
  // reintroduces a version table outside a historical block.
  const doc = [
    '| Package                       | New constraint |',
    '| ----------------------------- | -------------- |',
    '| `flutter_local_notifications` | `^21.0.0`      |',
  ].join('\n');
  const found = findDriftedVersions(doc, postBump);
  assert.equal(found.length, 1);
  assert.equal(found[0].stated, '^21.0.0');
  assert.equal(found[0].line, 3);
});

test('accepts a version that agrees, exactly or by major', () => {
  assert.equal(findDriftedVersions('`record` ^7.1.1', postBump).length, 0);
  assert.equal(findDriftedVersions('`record` 7.1.1', postBump).length, 0);
  assert.equal(findDriftedVersions('use `record` v7 for audio', postBump).length, 0);
});

test('component-wise compare — "2" must not pass as a prefix of "22.2.0"', () => {
  const found = findDriftedVersions('`flutter_local_notifications` 2', postBump);
  assert.equal(found.length, 1, 'string-prefix matching would wrongly accept this');
});

test('ignores everything inside a historical block', () => {
  const doc = [
    '<!-- vh:historical-start P3 pass, commit ebd0204ed -->',
    '| `flutter_local_notifications` | `^21.0.0` |',
    '`record` 6.2.1 was what P3 applied',
    '<!-- vh:historical-end -->',
  ].join('\n');
  assert.equal(findDriftedVersions(doc, postBump).length, 0);
});

test('resumes checking after a historical block closes', () => {
  const doc = [
    '<!-- vh:historical-start x -->',
    '`record` 6.2.1',
    '<!-- vh:historical-end -->',
    '`record` 6.2.1',
  ].join('\n');
  const found = findDriftedVersions(doc, postBump);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 4);
});

test('an unclosed historical block is a structural failure, not a silent pass', () => {
  const doc = ['<!-- vh:historical-start x -->', '`record` 6.2.1'].join('\n');
  assert.throws(() => findDriftedVersions(doc, postBump), (e) => e.structural === true);
});

test('vh:upstream exempts only its own line', () => {
  const doc = [
    '- `device_info_plus` 13.x was recorded as blocked. <!-- vh:upstream -->',
    '- `device_info_plus` 13.x with no marker',
  ].join('\n');
  const found = findDriftedVersions(doc, postBump);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
});

test('requires backticks — the plugin `record` vs the English word', () => {
  const prose = 'Appointment documents and records list. 3 covered journeys.';
  assert.equal(findDriftedVersions(prose, postBump).length, 0);
  assert.equal(findDriftedVersions('The `record` plugin captures WAV.', postBump).length, 0);
});

test('parsePubspecDeps reads constraints and skips non-version entries', () => {
  const pubspec = [
    'name: patient',
    'dependencies:',
    '  flutter:',
    '    sdk: flutter',
    '  local_auth: ^3.0.1              # Updated from 2.1.6',
    '  permission_handler: ^12.0.0+1',
    '  vhhealth_core: any',
    'dependency_overrides:',
    '  geolocator_android:',
    '    path: local_plugins/geolocator_android',
    'dev_dependencies:',
    '  flutter_lints: ^6.0.0',
  ].join('\n');

  const parsed = parsePubspecDeps(pubspec);
  assert.deepEqual([...parsed.get('local_auth')], ['^3.0.1']);
  assert.deepEqual([...parsed.get('permission_handler')], ['^12.0.0+1']);
  assert.deepEqual([...parsed.get('flutter_lints')], ['^6.0.0']);
  assert.equal(parsed.has('flutter'), false, 'sdk entry has no constraint');
  assert.equal(parsed.has('vhhealth_core'), false, '`any` is not a version');
  assert.equal(parsed.has('geolocator_android'), false, 'overrides are not constraints');
});

test('versionMatches semantics', () => {
  assert.equal(versionMatches('^22.2.0', '^22.2.0'), true);
  assert.equal(versionMatches('22', '^22.2.0'), true);
  assert.equal(versionMatches('21', '^22.2.0'), false);
  assert.equal(versionMatches('2', '^22.2.0'), false);
  assert.equal(versionMatches('13.x', '^12.4.0'), false);
  assert.equal(versionMatches('12.0.0+1', '^12.0.0+1'), true);
  assert.equal(versionMatches('22.2.0.1', '^22.2.0'), false);
});

test('a plugin declared at different constraints in two apps accepts either', () => {
  const split = deps({ go_router: ['^17.3.0', '^17.4.0'] });
  assert.equal(findDriftedVersions('`go_router` ^17.4.0', split).length, 0);
  assert.equal(findDriftedVersions('`go_router` ^17.3.0', split).length, 0);
  assert.equal(findDriftedVersions('`go_router` ^16.0.0', split).length, 1);
});

test('the live repository tree passes', () => {
  const result = runCheck();
  assert.equal(result.status, 0, JSON.stringify(result.findings ?? result.message, null, 2));
});
