// Pins the package-lock.json libc guard (repo-root scripts/check-lockfile-libc.mjs).
//
// PR #878: npm 11.14.1 regenerated apps/backend/package-lock.json and silently
// stripped `"libc"` from all 26 platform-specific optional packages — and
// apps/admin/package-lock.json turned out to carry the same defect live on
// main (68 entries, repaired 2026-08-18). Backend and admin ship
// node:26.5.0-alpine (musl) images whose Dockerfiles run `npm ci`, so without
// `libc` a musl install also pulls glibc binaries into the image; no CI job
// could see it — app jobs run on ubuntu-latest (glibc) and the Alpine images
// are built post-merge. device-gateway (bookworm-slim, glibc, --omit=dev) is
// guarded for lockfile integrity: same defect, lower stakes.
//
// Two properties matter and both are pinned here: the guard must fire on a
// stripped lockfile, and it must NOT fire on packages that legitimately carry
// no libc — otherwise it gets disabled the first time it cries wolf.
//
// This suite deliberately reads apps/admin's lockfile too (precedent:
// deepSuiteDbGuardConvention.test.js reads .github/workflows/): the admin
// manifest must track admin's committed lockfile, and backend's full-gate jest
// runs on every merge-bound PR, so the pin cannot be skipped by path filters.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPS,
  collectViolations,
  formatReport,
  impliedLibc,
  packageNameFromPath,
} from '../../../../../scripts/check-lockfile-libc.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', '..',
);

function readLockfile(appKey) {
  return JSON.parse(fs.readFileSync(APPS[appKey].lockfilePath, 'utf8').replace(/\r\n/g, '\n'));
}

/** A minimal lockfile whose `packages` keys are the given entries. */
function lockfileOf(entries) {
  const packages = { '': { name: 'fixture' } };
  for (const [name, entry] of Object.entries(entries)) {
    packages[`node_modules/${name}`] = entry;
  }
  return { lockfileVersion: 3, packages };
}

function kindsFor(violations, name) {
  return violations.filter((violation) => violation.package === name).map((v) => v.kind);
}

describe('package-lock.json libc guard', () => {
  it.each(['backend', 'admin', 'device-gateway'])(
    'passes against the committed %s lockfile',
    (appKey) => {
      expect(collectViolations(readLockfile(appKey), APPS[appKey].expected)).toEqual([]);
    },
  );

  it('resolves each app config to its real lockfile and repro command', () => {
    expect(APPS.backend.lockfilePath)
      .toBe(path.join(repoRoot, 'apps', 'backend', 'package-lock.json'));
    expect(APPS.admin.lockfilePath)
      .toBe(path.join(repoRoot, 'apps', 'admin', 'package-lock.json'));
    expect(APPS['device-gateway'].lockfilePath)
      .toBe(path.join(repoRoot, 'apps', 'device-gateway', 'package-lock.json'));
    for (const app of Object.values(APPS)) {
      expect(app.reproCommand).toContain('--libc=musl');
      expect(app.reproCommand).toContain(app.label);
    }
  });

  // The manifests are the guard's authority, so they must stay complete: if a
  // dependency upgrade adds or drops a libc-carrying package, this fails and a
  // human updates the app's list while already regenerating the lockfile.
  it.each([
    ['backend', 26],
    ['admin', 68],
    ['device-gateway', 10],
  ])('tracks every package that carries libc in the committed %s lockfile', (appKey, count) => {
    const carryingLibc = Object.entries(readLockfile(appKey).packages)
      .filter(([, entry]) => entry?.libc !== undefined)
      .map(([lockfilePath]) => packageNameFromPath(lockfilePath))
      .sort();

    expect(carryingLibc).toEqual(Object.keys(APPS[appKey].expected).sort());
    expect(carryingLibc).toHaveLength(count);
  });

  it('declares only glibc or musl expectations', () => {
    for (const app of Object.values(APPS)) {
      for (const value of Object.values(app.expected)) {
        expect(['glibc', 'musl']).toContain(value[0]);
        expect(value).toHaveLength(1);
      }
    }
  });

  it.each(['backend', 'admin', 'device-gateway'])(
    'fires on every %s manifest package when npm strips libc wholesale',
    (appKey) => {
      const stripped = readLockfile(appKey);
      for (const entry of Object.values(stripped.packages)) {
        if (entry?.libc) delete entry.libc;
      }

      const violations = collectViolations(stripped, APPS[appKey].expected);
      expect(violations).toHaveLength(Object.keys(APPS[appKey].expected).length);
      expect(new Set(violations.map((v) => v.kind))).toEqual(new Set(['LIBC_STRIPPED']));
      // The @unrs x64 pair is present in all three manifests.
      expect(kindsFor(violations, '@unrs/resolver-binding-linux-x64-gnu'))
        .toEqual(['LIBC_STRIPPED']);
      expect(kindsFor(violations, '@unrs/resolver-binding-linux-x64-musl'))
        .toEqual(['LIBC_STRIPPED']);
    },
  );

  it('distinguishes a stripped field from a changed one and from a vanished package', () => {
    const mutated = readLockfile('backend');
    delete mutated.packages['node_modules/@img/sharp-linuxmusl-x64'].libc;
    mutated.packages['node_modules/@img/sharp-linux-x64'].libc = ['musl'];
    delete mutated.packages['node_modules/@unrs/resolver-binding-linux-x64-gnu'];

    const violations = collectViolations(mutated, APPS.backend.expected);
    expect(kindsFor(violations, '@img/sharp-linuxmusl-x64')).toEqual(['LIBC_STRIPPED']);
    expect(kindsFor(violations, '@img/sharp-linux-x64')).toEqual(['LIBC_CHANGED']);
    expect(kindsFor(violations, '@unrs/resolver-binding-linux-x64-gnu'))
      .toEqual(['MISSING_FROM_LOCKFILE']);
    expect(violations).toHaveLength(3);
  });

  // A stripped nested copy must not hide behind a healthy hoisted copy.
  it('audits nested duplicate entries independently', () => {
    const lockfile = lockfileOf({
      '@img/sharp-linux-x64': { cpu: ['x64'], os: ['linux'], libc: ['glibc'] },
    });
    lockfile.packages['node_modules/host/node_modules/@img/sharp-linux-x64'] = {
      cpu: ['x64'],
      os: ['linux'],
    };

    const violations = collectViolations(lockfile, { '@img/sharp-linux-x64': ['glibc'] });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('LIBC_STRIPPED');
    expect(violations[0].detail).toContain('node_modules/host/node_modules/@img/sharp-linux-x64');
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

  // Completeness is self-enforcing: a new libc-carrying package fails the
  // guard until it is added to the app's manifest, so the manifest cannot rot.
  it('flags a libc-carrying package the manifest does not track', () => {
    const violations = collectViolations(
      lockfileOf({
        'new-binding-linux-x64-gnu': { os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
      }),
      {},
    );

    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('UNTRACKED_LIBC_CARRIER');
    expect(violations[0].detail).toContain('scripts/check-lockfile-libc.mjs');
  });

  it('stays silent on packages that legitimately declare no libc', () => {
    // @sentry/cli-linux-x64 ships one static binary for several operating
    // systems; @esbuild/linux-* has no musl split; the oxc/unrs/tailwind/
    // lightningcss *-gnueabihf/*-musleabihf arm packages publish no libc field
    // (verified against the registry — though rollup's DO, which is why they
    // are manifest-tracked instead). A guard that failed on these would be
    // turned off, so this is load-bearing.
    expect(
      collectViolations(
        lockfileOf({
          '@sentry/cli-linux-x64': { os: ['linux', 'freebsd', 'android'], cpu: ['x64'] },
          '@esbuild/linux-x64': { os: ['linux'], cpu: ['x64'] },
          '@unrs/resolver-binding-linux-arm-gnueabihf': { os: ['linux'], cpu: ['arm'] },
          '@unrs/resolver-binding-linux-arm-musleabihf': { os: ['linux'], cpu: ['arm'] },
          '@tailwindcss/oxide-linux-arm-gnueabihf': { os: ['linux'], cpu: ['arm'] },
          'onnxruntime-node': { os: ['win32', 'darwin', 'linux'] },
        }),
        {},
      ),
    ).toEqual([]);
  });

  // `-gnu` on a Windows binary is mingw toolchain naming, not a libc marker:
  // @rollup/rollup-win32-x64-gnu is os=["win32"] and publishes no libc
  // (registry-verified). The sweep must gate name inference on the entry
  // actually targeting linux.
  it('ignores -gnu/-musl names on entries that do not target linux', () => {
    expect(
      collectViolations(
        lockfileOf({
          '@rollup/rollup-win32-x64-gnu': { os: ['win32'], cpu: ['x64'], optional: true },
          '@rollup/rollup-win32-x64-msvc': { os: ['win32'], cpu: ['x64'], optional: true },
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
    for (const app of Object.values(APPS)) {
      const report = formatReport(
        [
          {
            package: '@img/sharp-linux-x64',
            kind: 'LIBC_STRIPPED',
            detail: 'expected libc ["glibc"], but the entry has no "libc" field',
          },
        ],
        app,
      );

      expect(report).toContain('@img/sharp-linux-x64');
      expect(report).toContain('LIBC_STRIPPED (1)');
      expect(report).toContain(app.reproCommand);
      expect(report).toContain('--libc=musl');
      // The consequence paragraph is embedded verbatim and must stay honest
      // per app (alpine/musl for backend+admin, bookworm/glibc for gateway).
      expect(report).toContain(app.consequenceNote);
      expect(report).toContain(app.label);
      expect(report).toContain('scripts/check-lockfile-libc.mjs');
    }
  });

  it('refuses a lockfile with no packages map instead of passing vacuously', () => {
    expect(() => collectViolations({ lockfileVersion: 1 }, {}))
      .toThrow(/no `packages` object/);
    expect(() => collectViolations(null, {})).toThrow(/no `packages` object/);
  });
});
