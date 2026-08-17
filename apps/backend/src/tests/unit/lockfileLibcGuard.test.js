// Pins the package-lock.json libc guard (scripts/check-lockfile-libc.mjs).
//
// PR #878: npm 11.14.1 regenerated apps/backend/package-lock.json and silently
// stripped `"libc"` from all 26 platform-specific optional packages. The
// production image is node:26.5.0-alpine (musl) and the Dockerfile runs
// `npm ci`, so without `libc` a musl install also pulls glibc binaries
// (@img/sharp-linux-x64, @img/sharp-libvips-linux-x64) into the image. No CI
// job could see it — backend jobs run on ubuntu-latest (glibc) and the Alpine
// image is built post-merge.
//
// Two properties matter and both are pinned here: the guard must fire on a
// stripped lockfile, and it must NOT fire on packages that legitimately carry
// no libc — otherwise it gets disabled the first time it cries wolf.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_LOCKFILE,
  EXPECTED_LIBC,
  REPRO_COMMAND,
  collectViolations,
  formatReport,
  impliedLibc,
  packageNameFromPath,
} from '../../../scripts/check-lockfile-libc.mjs';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const realLockfile = JSON.parse(fs.readFileSync(DEFAULT_LOCKFILE, 'utf8'));

/** A minimal lockfile whose `packages` keys are the given entries. */
function lockfileOf(entries) {
  const packages = { '': { name: 'vh-health-backend' } };
  for (const [name, entry] of Object.entries(entries)) {
    packages[`node_modules/${name}`] = entry;
  }
  return { lockfileVersion: 3, packages };
}

function kindsFor(violations, name) {
  return violations.filter((violation) => violation.package === name).map((v) => v.kind);
}

describe('package-lock.json libc guard', () => {
  it('passes against the committed lockfile', () => {
    expect(collectViolations(realLockfile)).toEqual([]);
  });

  it('resolves to the real backend lockfile by default', () => {
    expect(DEFAULT_LOCKFILE).toBe(path.join(backendRoot, 'package-lock.json'));
  });

  // The manifest is the guard's authority, so it must stay complete: if a
  // dependency upgrade introduces a new libc-carrying package, this fails and
  // a human updates EXPECTED_LIBC while they are already regenerating the lock.
  it('tracks every package that carries libc in the committed lockfile', () => {
    const carryingLibc = Object.entries(realLockfile.packages)
      .filter(([, entry]) => entry?.libc !== undefined)
      .map(([lockfilePath]) => packageNameFromPath(lockfilePath))
      .sort();

    expect(carryingLibc).toEqual(Object.keys(EXPECTED_LIBC).sort());
    expect(carryingLibc).toHaveLength(26);
  });

  it('declares only glibc or musl expectations', () => {
    for (const value of Object.values(EXPECTED_LIBC)) {
      expect(['glibc', 'musl']).toContain(value[0]);
      expect(value).toHaveLength(1);
    }
  });

  it('fires on every manifest package when npm strips libc wholesale', () => {
    const stripped = structuredClone(realLockfile);
    for (const entry of Object.values(stripped.packages)) {
      if (entry?.libc) delete entry.libc;
    }

    const violations = collectViolations(stripped);
    expect(violations).toHaveLength(Object.keys(EXPECTED_LIBC).length);
    expect(new Set(violations.map((v) => v.kind))).toEqual(new Set(['LIBC_STRIPPED']));
    expect(kindsFor(violations, '@img/sharp-linux-x64')).toEqual(['LIBC_STRIPPED']);
    expect(kindsFor(violations, '@img/sharp-linuxmusl-x64')).toEqual(['LIBC_STRIPPED']);
  });

  it('distinguishes a stripped field from a changed one and from a vanished package', () => {
    const mutated = structuredClone(realLockfile);
    delete mutated.packages['node_modules/@img/sharp-linuxmusl-x64'].libc;
    mutated.packages['node_modules/@img/sharp-linux-x64'].libc = ['musl'];
    delete mutated.packages['node_modules/@unrs/resolver-binding-linux-x64-gnu'];

    const violations = collectViolations(mutated);
    expect(kindsFor(violations, '@img/sharp-linuxmusl-x64')).toEqual(['LIBC_STRIPPED']);
    expect(kindsFor(violations, '@img/sharp-linux-x64')).toEqual(['LIBC_CHANGED']);
    expect(kindsFor(violations, '@unrs/resolver-binding-linux-x64-gnu'))
      .toEqual(['MISSING_FROM_LOCKFILE']);
    expect(violations).toHaveLength(3);
  });

  // The manifest alone cannot see a package it has never heard of, so the sweep
  // covers variants a future dependency adds — arriving already stripped is the
  // exact shape of the #878 defect.
  it('sweeps untracked linux variants that arrive without libc', () => {
    const violations = collectViolations(
      lockfileOf({
        '@rollup/rollup-linux-x64-musl': { os: ['linux'], cpu: ['x64'], optional: true },
        '@rollup/rollup-linux-x64-gnu': { os: ['linux'], cpu: ['x64'], optional: true },
        '@next/swc-linuxmusl-x64': { os: ['linux'], cpu: ['x64'], optional: true },
      }),
      {},
    );

    expect(violations.map((v) => v.package).sort()).toEqual([
      '@next/swc-linuxmusl-x64',
      '@rollup/rollup-linux-x64-gnu',
      '@rollup/rollup-linux-x64-musl',
    ]);
    expect(new Set(violations.map((v) => v.kind)))
      .toEqual(new Set(['UNTRACKED_VARIANT_WITHOUT_LIBC']));
  });

  it('stays silent on packages that legitimately declare no libc', () => {
    // @sentry/cli-linux-x64 ships one static binary for several operating
    // systems; @unrs/resolver-binding-linux-arm-{gnueabihf,musleabihf}@1.12.2
    // publish no libc field at all (verified against the registry). A guard
    // that failed on these would be turned off, so this is load-bearing.
    expect(
      collectViolations(
        lockfileOf({
          '@sentry/cli-linux-x64': { os: ['linux', 'freebsd', 'android'], cpu: ['x64'] },
          '@unrs/resolver-binding-linux-arm-gnueabihf': { os: ['linux'], cpu: ['arm'] },
          '@unrs/resolver-binding-linux-arm-musleabihf': { os: ['linux'], cpu: ['arm'] },
          'onnxruntime-node': { os: ['win32', 'darwin', 'linux'] },
        }),
        {},
      ),
    ).toEqual([]);
  });

  it('requires libc on a plain -linux- name only when a musl sibling exists', () => {
    const withSibling = new Set(['sharp-linux-x64', 'sharp-linuxmusl-x64']);
    expect(impliedLibc('sharp-linux-x64', withSibling)).toBe('glibc');
    expect(impliedLibc('sharp-linuxmusl-x64', withSibling)).toBe('musl');

    const alone = new Set(['@sentry/cli-linux-x64']);
    expect(impliedLibc('@sentry/cli-linux-x64', alone)).toBeNull();
    expect(impliedLibc('@unrs/resolver-binding-linux-arm-musleabihf', alone)).toBeNull();
    expect(impliedLibc('@unrs/resolver-binding-linux-arm-gnueabihf', alone)).toBeNull();
    expect(impliedLibc('express', alone)).toBeNull();
  });

  it('reads the package name from the innermost node_modules segment', () => {
    expect(packageNameFromPath('node_modules/@img/sharp-linux-x64')).toBe('@img/sharp-linux-x64');
    expect(packageNameFromPath('node_modules/a/node_modules/@img/sharp-linuxmusl-x64'))
      .toBe('@img/sharp-linuxmusl-x64');
  });

  it('names the offending packages and prints the npm dry-run repro', () => {
    const report = formatReport([
      {
        package: '@img/sharp-linux-x64',
        kind: 'LIBC_STRIPPED',
        detail: 'expected libc ["glibc"], but the entry has no "libc" field',
      },
    ]);

    expect(report).toContain('@img/sharp-linux-x64');
    expect(report).toContain('LIBC_STRIPPED (1)');
    expect(report).toContain(REPRO_COMMAND);
    expect(report).toContain('--libc=musl');
    expect(report).toContain('node:26.5.0-alpine');
    expect(report).toContain('EXPECTED_LIBC');
  });

  it('refuses a lockfile with no packages map instead of passing vacuously', () => {
    expect(() => collectViolations({ lockfileVersion: 1 }))
      .toThrow(/no `packages` object/);
    expect(() => collectViolations(null)).toThrow(/no `packages` object/);
  });
});
