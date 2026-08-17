#!/usr/bin/env node
// Fails CI if package-lock.json loses the `libc` platform constraints on its
// linux glibc/musl variant packages.
//
// PR #878 (found and fixed in 83bbea121): a session added a `deepmerge-ts`
// override and regenerated apps/backend/package-lock.json with npm 11.14.1.
// That npm silently stripped `"libc"` from ALL 26 platform-specific optional
// packages (`@img/sharp-*`, `@unrs/resolver-binding-*`) — main had 26, the
// branch had 0. Nothing in CI could see it: backend jobs run on
// ubuntu-latest (glibc), and the Alpine image is built post-merge by
// .github/workflows/release-images.yml.
//
// Why it matters: the production image is `node:26.5.0-alpine` (musl) and
// apps/backend/Dockerfile runs `npm ci` (lines 9 and 24). `sharp` is a direct
// dependency (^0.35.3). Without `libc`, npm cannot distinguish a glibc variant
// from a musl one, so a musl install ALSO pulls `@img/sharp-linux-x64` and
// `@img/sharp-libvips-linux-x64` — glibc binaries — into the Alpine image.
//
// Two independent rules run, because either alone has a blind spot:
//
//   1. MANIFEST — every package in EXPECTED_LIBC must still be in the lockfile
//      carrying exactly its expected value. This is what catches the #878
//      regression (all 26 stripped at once) and any silent disappearance.
//   2. SWEEP — every lockfile entry whose *name* identifies it as a linux
//      glibc/musl variant must declare `libc`, whether or not it is in the
//      manifest. This catches a newly-added platform package that arrives
//      already stripped, which the manifest alone would never see.
//
// Behaviour is pinned by src/tests/unit/lockfileLibcGuard.test.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_LOCKFILE = path.join(BACKEND_ROOT, 'package-lock.json');

// The decisive reproduction — npm can simulate the target platform, so this
// answers "would the Alpine image get glibc binaries?" without building it.
export const REPRO_COMMAND =
  'cd apps/backend && npm ci --dry-run --ignore-scripts --os=linux --cpu=x64 --libc=musl';

// A correct lockfile selects ONLY these two for musl/x64. A stripped one
// additionally selects @img/sharp-linux-x64 and @img/sharp-libvips-linux-x64.
export const EXPECTED_MUSL_X64_SELECTION = [
  '@img/sharp-libvips-linuxmusl-x64',
  '@img/sharp-linuxmusl-x64',
];

// The 26 platform-specific optional packages that carry `libc` today, with the
// value each must carry. Restored by 83bbea121 after npm 11.14.1 stripped them.
//
// This list is deliberately explicit rather than derived: when a dependency
// upgrade legitimately adds or drops a platform, a human should see the diff
// while they are already regenerating the lockfile. Resolving a
// MISSING_FROM_LOCKFILE failure means running REPRO_COMMAND to confirm no
// glibc package leaks into a musl install, then editing this list in the same
// commit.
export const EXPECTED_LIBC = Object.freeze({
  '@img/sharp-libvips-linux-arm': ['glibc'],
  '@img/sharp-libvips-linux-arm64': ['glibc'],
  '@img/sharp-libvips-linux-ppc64': ['glibc'],
  '@img/sharp-libvips-linux-riscv64': ['glibc'],
  '@img/sharp-libvips-linux-s390x': ['glibc'],
  '@img/sharp-libvips-linux-x64': ['glibc'],
  '@img/sharp-libvips-linuxmusl-arm64': ['musl'],
  '@img/sharp-libvips-linuxmusl-x64': ['musl'],
  '@img/sharp-linux-arm': ['glibc'],
  '@img/sharp-linux-arm64': ['glibc'],
  '@img/sharp-linux-ppc64': ['glibc'],
  '@img/sharp-linux-riscv64': ['glibc'],
  '@img/sharp-linux-s390x': ['glibc'],
  '@img/sharp-linux-x64': ['glibc'],
  '@img/sharp-linuxmusl-arm64': ['musl'],
  '@img/sharp-linuxmusl-x64': ['musl'],
  '@unrs/resolver-binding-linux-arm64-gnu': ['glibc'],
  '@unrs/resolver-binding-linux-arm64-musl': ['musl'],
  '@unrs/resolver-binding-linux-loong64-gnu': ['glibc'],
  '@unrs/resolver-binding-linux-loong64-musl': ['musl'],
  '@unrs/resolver-binding-linux-ppc64-gnu': ['glibc'],
  '@unrs/resolver-binding-linux-riscv64-gnu': ['glibc'],
  '@unrs/resolver-binding-linux-riscv64-musl': ['musl'],
  '@unrs/resolver-binding-linux-s390x-gnu': ['glibc'],
  '@unrs/resolver-binding-linux-x64-gnu': ['glibc'],
  '@unrs/resolver-binding-linux-x64-musl': ['musl'],
});

// ★ The `*-gnueabihf` / `*-musleabihf` arm packages are NOT omissions here.
// `@unrs/resolver-binding-linux-arm-{gnueabihf,musleabihf}@1.12.2` publish no
// `libc` field at all — verified against the registry (`npm view … libc` returns
// nothing, while the sibling `…-x64-musl` returns 'musl'). The anchored `-gnu$`
// / `-musl$` patterns below therefore exclude them by construction. Do not
// "fix" those regexes to `gnu`/`musl` substrings: the sweep would then fail on
// a correct lockfile. The same is true of `@sentry/cli-linux-*`, which ships
// one static binary for several operating systems and declares no libc.
const MUSL_NAME = /(?:^|[-/])linuxmusl(?:[-/]|$)|-musl$/;
const GLIBC_NAME = /-gnu$/;

/** Last path segment of a lockfile `packages` key (`node_modules/a/node_modules/b` → `b`). */
export function packageNameFromPath(lockfilePath) {
  const marker = 'node_modules/';
  const index = lockfilePath.lastIndexOf(marker);
  return index === -1 ? lockfilePath : lockfilePath.slice(index + marker.length);
}

/**
 * The libc a package name implies, or null when the name carries no marker.
 *
 * A plain `-linux-<cpu>` name only implies glibc when a `linuxmusl` sibling for
 * the same cpu exists in the same lockfile — that ambiguity is exactly what
 * `libc` is there to resolve. Without a sibling (`@sentry/cli-linux-x64`) the
 * name says nothing and the sweep stays silent.
 */
export function impliedLibc(name, presentNames) {
  if (MUSL_NAME.test(name)) return 'musl';
  if (GLIBC_NAME.test(name)) return 'glibc';
  if (name.includes('-linux-') && presentNames.has(name.replace('-linux-', '-linuxmusl-'))) {
    return 'glibc';
  }
  return null;
}

function sameLibc(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

/**
 * Every way the lockfile can have lost its libc constraints.
 *
 * @returns {Array<{package: string, kind: string, detail: string}>}
 */
export function collectViolations(lockfile, expected = EXPECTED_LIBC) {
  if (!lockfile || typeof lockfile.packages !== 'object' || lockfile.packages === null) {
    throw new Error('package-lock.json has no `packages` object — expected lockfileVersion 2 or 3.');
  }

  const byName = new Map();
  for (const [lockfilePath, entry] of Object.entries(lockfile.packages)) {
    if (!lockfilePath) continue; // the root project entry has an empty key
    byName.set(packageNameFromPath(lockfilePath), entry ?? {});
  }

  const violations = [];

  // Rule 1 — the manifest.
  for (const [name, expectedLibc] of Object.entries(expected)) {
    const entry = byName.get(name);
    if (!entry) {
      violations.push({
        package: name,
        kind: 'MISSING_FROM_LOCKFILE',
        detail: `expected libc ${JSON.stringify(expectedLibc)}, but the package is not in the lockfile`,
      });
    } else if (entry.libc === undefined) {
      violations.push({
        package: name,
        kind: 'LIBC_STRIPPED',
        detail: `expected libc ${JSON.stringify(expectedLibc)}, but the entry has no "libc" field`,
      });
    } else if (!sameLibc(entry.libc, expectedLibc)) {
      violations.push({
        package: name,
        kind: 'LIBC_CHANGED',
        detail: `expected libc ${JSON.stringify(expectedLibc)}, found ${JSON.stringify(entry.libc)}`,
      });
    }
  }

  // Rule 2 — the sweep, over packages the manifest does not already cover.
  const presentNames = new Set(byName.keys());
  for (const [name, entry] of byName) {
    if (Object.hasOwn(expected, name)) continue;
    if (entry.libc !== undefined) continue;
    const implied = impliedLibc(name, presentNames);
    if (!implied) continue;
    violations.push({
      package: name,
      kind: 'UNTRACKED_VARIANT_WITHOUT_LIBC',
      detail: `name implies libc ["${implied}"], but the entry has no "libc" field`,
    });
  }

  return violations;
}

export function formatReport(violations) {
  const lines = [
    '',
    'package-lock.json libc guard FAILED — platform constraints were lost.',
    '',
  ];

  const byKind = new Map();
  for (const violation of violations) {
    if (!byKind.has(violation.kind)) byKind.set(violation.kind, []);
    byKind.get(violation.kind).push(violation);
  }

  for (const [kind, entries] of byKind) {
    lines.push(`  ${kind} (${entries.length}):`);
    for (const entry of entries) {
      lines.push(`    - ${entry.package}: ${entry.detail}`);
    }
    lines.push('');
  }

  lines.push(
    'The production image is node:26.5.0-alpine (musl) and apps/backend/Dockerfile',
    'runs `npm ci`. Without "libc", npm cannot tell a glibc variant from a musl one,',
    'so a musl install also pulls glibc binaries such as @img/sharp-linux-x64 into',
    'the Alpine image. No other CI job can see this: backend jobs run on',
    'ubuntu-latest (glibc) and the Alpine image is built post-merge.',
    '',
    'Reproduce the real effect (npm simulates the target platform):',
    `  ${REPRO_COMMAND}`,
    '',
    `A correct lockfile selects ONLY ${EXPECTED_MUSL_X64_SELECTION.join(' and ')}.`,
    'A stripped one additionally selects @img/sharp-linux-x64 and',
    '@img/sharp-libvips-linux-x64.',
    '',
    'Most likely cause: the lockfile was regenerated by an npm that drops "libc"',
    '(npm 11.14.1 does — see PR #878, fixed in 83bbea121). Restore the field',
    'rather than accepting the regenerated file. If a dependency upgrade',
    'legitimately added or dropped a platform, run the command above to confirm no',
    'glibc package leaks into a musl install, then update EXPECTED_LIBC in',
    'scripts/check-lockfile-libc.mjs in the same commit.',
    '',
  );

  return lines.join('\n');
}

export function main(lockfilePath = DEFAULT_LOCKFILE) {
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  const violations = collectViolations(lockfile);

  if (violations.length) {
    console.error(formatReport(violations));
    return 1;
  }

  const tracked = Object.keys(EXPECTED_LIBC).length;
  console.log(
    `package-lock.json libc guard passed (${tracked} platform packages keep their libc constraint)`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_LOCKFILE));
}
