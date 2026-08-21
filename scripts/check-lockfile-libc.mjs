#!/usr/bin/env node
// Fails CI if an app's package-lock.json loses the `libc` platform constraints
// on its linux glibc/musl variant packages.
//
//   node scripts/check-lockfile-libc.mjs <backend|admin|device-gateway> [lockfile-path]
//
// PR #878 (found and fixed in 83bbea121): a session added a `deepmerge-ts`
// override and regenerated apps/backend/package-lock.json with npm 11.14.1.
// That npm silently stripped `"libc"` from ALL 26 platform-specific optional
// packages (`@img/sharp-*`, `@unrs/resolver-binding-*`) — main had 26, the
// branch had 0. apps/admin/package-lock.json turned out to have the SAME
// defect live on main (68 entries stripped; repaired 2026-08-18 from
// exact-version registry manifests). Nothing in CI could see either: app jobs
// run on ubuntu-latest (glibc), and the Alpine images are built post-merge by
// .github/workflows/release-images.yml.
//
// Why it matters: both production images are `node:26.5.0-alpine` (musl) and
// both Dockerfiles run `npm ci`. Without `libc`, npm cannot distinguish a
// glibc variant from a musl one, so a musl install ALSO pulls glibc binaries
// (e.g. `@img/sharp-linux-x64` + `@img/sharp-libvips-linux-x64`) into the
// Alpine image. Measured on the pre-repair admin lockfile: a musl x64 install
// selected BOTH flavors of nine package families (sharp, @next/swc,
// oxc-parser, oxc-resolver, rollup, @tailwindcss/oxide, @unrs, lightningcss)
// plus the glibc-only @napi-rs/lzma binding.
//
// Three independent rules run, because each has a blind spot the others cover:
//
//   1. MANIFEST — every package in the app's EXPECTED_LIBC must still be in
//      the lockfile carrying exactly its expected value. Catches the #878
//      wholesale strip, value swaps, and silent disappearance — including
//      names the sweep cannot mark (e.g. @img/sharp-linux-arm has no
//      linuxmusl sibling, so nothing but the manifest would miss it).
//   2. SWEEP — every lockfile entry whose *name* identifies it as a linux
//      glibc/musl variant must declare `libc`, whether or not it is in the
//      manifest. Catches a newly-added platform package that arrives already
//      stripped, which the manifest alone would never see.
//   3. CARRIER — every lockfile entry that carries `libc` must be in the
//      manifest. Forces manifest updates through review when a dependency
//      upgrade adds a platform, so the manifest cannot silently rot.
//
// Behaviour is pinned by apps/backend/src/tests/unit/lockfileLibcGuard.test.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// The platform packages that carry `libc` in each app's committed lockfile,
// with the value each must carry — verified against the registry's
// exact-version manifests (backend restored in 83bbea121; admin repaired
// 2026-08-18).
//
// These lists are deliberately explicit rather than derived: when a dependency
// upgrade legitimately adds or drops a platform, a human should see the diff
// while they are already regenerating the lockfile. Resolving a
// MISSING_FROM_LOCKFILE or UNTRACKED_LIBC_CARRIER failure means running the
// app's repro command to confirm no glibc package leaks into a musl install,
// then editing the app's list here in the same commit.
const BACKEND_EXPECTED_LIBC = Object.freeze({
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

// device-gateway's ten are all dev-dep @unrs resolver bindings (jest), and its
// production image is Debian bookworm-slim (glibc) with `npm ci --omit=dev` —
// so a strip there is a lockfile-integrity signal rather than a prod breaker.
// Guarded anyway: it is the same npm-11 defect, and it must not land silently.
const DEVICE_GATEWAY_EXPECTED_LIBC = Object.freeze({
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

const ADMIN_EXPECTED_LIBC = Object.freeze({
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
  '@napi-rs/lzma-linux-x64-gnu': ['glibc'],
  '@next/swc-linux-arm64-gnu': ['glibc'],
  '@next/swc-linux-arm64-musl': ['musl'],
  '@next/swc-linux-x64-gnu': ['glibc'],
  '@next/swc-linux-x64-musl': ['musl'],
  '@oxc-parser/binding-linux-arm64-gnu': ['glibc'],
  '@oxc-parser/binding-linux-arm64-musl': ['musl'],
  '@oxc-parser/binding-linux-ppc64-gnu': ['glibc'],
  '@oxc-parser/binding-linux-riscv64-gnu': ['glibc'],
  '@oxc-parser/binding-linux-riscv64-musl': ['musl'],
  '@oxc-parser/binding-linux-s390x-gnu': ['glibc'],
  '@oxc-parser/binding-linux-x64-gnu': ['glibc'],
  '@oxc-parser/binding-linux-x64-musl': ['musl'],
  '@oxc-resolver/binding-linux-arm64-gnu': ['glibc'],
  '@oxc-resolver/binding-linux-arm64-musl': ['musl'],
  '@oxc-resolver/binding-linux-ppc64-gnu': ['glibc'],
  '@oxc-resolver/binding-linux-riscv64-gnu': ['glibc'],
  '@oxc-resolver/binding-linux-riscv64-musl': ['musl'],
  '@oxc-resolver/binding-linux-s390x-gnu': ['glibc'],
  '@oxc-resolver/binding-linux-x64-gnu': ['glibc'],
  '@oxc-resolver/binding-linux-x64-musl': ['musl'],
  '@rollup/rollup-linux-arm-gnueabihf': ['glibc'],
  '@rollup/rollup-linux-arm-musleabihf': ['musl'],
  '@rollup/rollup-linux-arm64-gnu': ['glibc'],
  '@rollup/rollup-linux-arm64-musl': ['musl'],
  '@rollup/rollup-linux-loong64-gnu': ['glibc'],
  '@rollup/rollup-linux-loong64-musl': ['musl'],
  '@rollup/rollup-linux-ppc64-gnu': ['glibc'],
  '@rollup/rollup-linux-ppc64-musl': ['musl'],
  '@rollup/rollup-linux-riscv64-gnu': ['glibc'],
  '@rollup/rollup-linux-riscv64-musl': ['musl'],
  '@rollup/rollup-linux-s390x-gnu': ['glibc'],
  '@rollup/rollup-linux-x64-gnu': ['glibc'],
  '@rollup/rollup-linux-x64-musl': ['musl'],
  '@tailwindcss/oxide-linux-arm64-gnu': ['glibc'],
  '@tailwindcss/oxide-linux-arm64-musl': ['musl'],
  '@tailwindcss/oxide-linux-x64-gnu': ['glibc'],
  '@tailwindcss/oxide-linux-x64-musl': ['musl'],
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
  'lightningcss-linux-arm64-gnu': ['glibc'],
  'lightningcss-linux-arm64-musl': ['musl'],
  'lightningcss-linux-x64-gnu': ['glibc'],
  'lightningcss-linux-x64-musl': ['musl'],
});

// Every consequenceNote must stay honest per app: backend and admin ship
// musl (Alpine) production images, so a strip there sends glibc binaries into
// prod; device-gateway ships glibc (bookworm-slim) with --omit=dev, so a strip
// there is caught for lockfile integrity, not as a prod breaker.
const ALPINE_CONSEQUENCE = (label) =>
  `The ${label} production image is node:26.5.0-alpine (musl) and its\n` +
  'Dockerfile runs `npm ci`. Without "libc", npm cannot tell a glibc variant\n' +
  'from a musl one, so a musl install also pulls glibc binaries into the Alpine\n' +
  'image. No other CI job can see this: app jobs run on ubuntu-latest (glibc)\n' +
  'and the Alpine image is built post-merge.';

export const APPS = Object.freeze({
  backend: {
    label: 'apps/backend',
    lockfilePath: path.join(REPO_ROOT, 'apps', 'backend', 'package-lock.json'),
    expected: BACKEND_EXPECTED_LIBC,
    reproCommand:
      'cd apps/backend && npm ci --dry-run --ignore-scripts --os=linux --cpu=x64 --libc=musl',
    consequenceNote: ALPINE_CONSEQUENCE('apps/backend'),
    // A correct lockfile selects ONLY these for musl/x64. A stripped one
    // additionally selects @img/sharp-linux-x64 + @img/sharp-libvips-linux-x64.
    selectionNote:
      'A correct lockfile selects ONLY @img/sharp-libvips-linuxmusl-x64 and\n' +
      '@img/sharp-linuxmusl-x64. A stripped one additionally selects\n' +
      '@img/sharp-linux-x64 and @img/sharp-libvips-linux-x64.',
  },
  admin: {
    label: 'apps/admin',
    lockfilePath: path.join(REPO_ROOT, 'apps', 'admin', 'package-lock.json'),
    expected: ADMIN_EXPECTED_LIBC,
    reproCommand:
      'cd apps/admin && npm ci --dry-run --ignore-scripts --os=linux --cpu=x64 --libc=musl',
    consequenceNote: ALPINE_CONSEQUENCE('apps/admin'),
    selectionNote:
      'A correct lockfile selects exactly one flavor per package family (e.g.\n' +
      '@img/sharp-linuxmusl-x64, @next/swc-linux-x64-musl,\n' +
      '@rollup/rollup-linux-x64-musl). The pre-repair lockfile selected BOTH the\n' +
      'musl and glibc variants of nine families on a musl target.',
  },
  'device-gateway': {
    label: 'apps/device-gateway',
    lockfilePath: path.join(REPO_ROOT, 'apps', 'device-gateway', 'package-lock.json'),
    expected: DEVICE_GATEWAY_EXPECTED_LIBC,
    reproCommand:
      'cd apps/device-gateway && npm ci --dry-run --ignore-scripts --os=linux --cpu=x64 --libc=musl',
    consequenceNote:
      'The apps/device-gateway production image is node:26.5.0-bookworm-slim\n' +
      '(glibc) built with `npm ci --omit=dev`, and its libc-constrained packages\n' +
      'are all dev-dep @unrs resolver bindings — so this is a lockfile-integrity\n' +
      'gate, not a prod-image breaker. A strip here is the same npm-11 defect\n' +
      'that DID send glibc binaries into the backend/admin Alpine images.',
    selectionNote:
      'A correct lockfile selects ONLY @unrs/resolver-binding-linux-x64-musl for\n' +
      'musl/x64. A stripped one additionally selects\n' +
      '@unrs/resolver-binding-linux-x64-gnu.',
  },
});

// ★ Packages whose names LOOK like libc variants but legitimately publish no
// `libc` field are NOT omissions in the manifests above, and the sweep must
// stay silent on them — a guard that cries wolf gets switched off:
//   - `@sentry/cli-linux-*` ships one static binary for several operating
//     systems and declares no libc.
//   - `@esbuild/linux-*` has no musl split at all (no linuxmusl siblings).
//   - The `*-gnueabihf` / `*-musleabihf` arm packages of @oxc-parser,
//     @oxc-resolver, @tailwindcss/oxide, @unrs and lightningcss publish no
//     libc (`npm view … libc` returns nothing, while their `…-x64-musl`
//     siblings return 'musl'). The anchored `-gnu$` / `-musl$` patterns below
//     exclude them by construction — do NOT loosen these to substring
//     matches, or the sweep fails on a correct lockfile.
//     (Rollup is the exception that proves the registry is the only safe
//     authority: @rollup/rollup-linux-arm-{gnueabihf,musleabihf} DO publish
//     libc, so they are manifest-tracked above.)
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
 * `libc` is there to resolve. Without a sibling (`@sentry/cli-linux-x64`,
 * `@esbuild/linux-x64`) the name says nothing and the sweep stays silent.
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
 * Every way the lockfile can have lost (or outgrown) its libc constraints.
 *
 * Iterates every `packages` entry rather than deduplicating by name, so a
 * nested copy (`node_modules/a/node_modules/@img/sharp-linux-x64`) is audited
 * independently of the top-level one — a stripped nested copy must not hide
 * behind a healthy hoisted copy.
 *
 * @returns {Array<{package: string, kind: string, detail: string}>}
 */
export function collectViolations(lockfile, expected) {
  if (!lockfile || typeof lockfile.packages !== 'object' || lockfile.packages === null) {
    throw new Error('package-lock.json has no `packages` object — expected lockfileVersion 2 or 3.');
  }

  const entries = [];
  for (const [lockfilePath, entry] of Object.entries(lockfile.packages)) {
    if (!lockfilePath) continue; // the root project entry has an empty key
    entries.push({ path: lockfilePath, name: packageNameFromPath(lockfilePath), entry: entry ?? {} });
  }
  const presentNames = new Set(entries.map(({ name }) => name));

  const violations = [];
  const at = (entryPath, name) =>
    entryPath === `node_modules/${name}` ? '' : ` (at ${entryPath})`;

  // Rule 1 — the manifest.
  for (const [name, expectedLibc] of Object.entries(expected)) {
    if (!presentNames.has(name)) {
      violations.push({
        package: name,
        kind: 'MISSING_FROM_LOCKFILE',
        detail: `expected libc ${JSON.stringify(expectedLibc)}, but the package is not in the lockfile`,
      });
    }
  }
  for (const { path: entryPath, name, entry } of entries) {
    const expectedLibc = Object.hasOwn(expected, name) ? expected[name] : undefined;
    if (!expectedLibc) continue;
    if (entry.libc === undefined) {
      violations.push({
        package: name,
        kind: 'LIBC_STRIPPED',
        detail: `expected libc ${JSON.stringify(expectedLibc)}, but the entry has no "libc" field${at(entryPath, name)}`,
      });
    } else if (!sameLibc(entry.libc, expectedLibc)) {
      violations.push({
        package: name,
        kind: 'LIBC_CHANGED',
        detail: `expected libc ${JSON.stringify(expectedLibc)}, found ${JSON.stringify(entry.libc)}${at(entryPath, name)}`,
      });
    }
  }

  // Rules 2 + 3 — over entries the manifest does not already cover.
  for (const { path: entryPath, name, entry } of entries) {
    if (Object.hasOwn(expected, name)) continue;
    if (entry.libc === undefined) {
      // `libc` is linux metadata: a name marker only counts when the entry
      // targets linux (or declares no `os` at all — conservative). Without
      // this gate the sweep fires on `@rollup/rollup-win32-x64-gnu`, whose
      // `-gnu` suffix is mingw toolchain naming on an os=["win32"] package
      // that publishes no libc (registry-verified).
      if (Array.isArray(entry.os) && !entry.os.includes('linux')) continue;
      const implied = impliedLibc(name, presentNames);
      if (!implied) continue;
      violations.push({
        package: name,
        kind: 'UNTRACKED_VARIANT_WITHOUT_LIBC',
        detail: `name implies libc ["${implied}"], but the entry has no "libc" field${at(entryPath, name)}`,
      });
    } else {
      violations.push({
        package: name,
        kind: 'UNTRACKED_LIBC_CARRIER',
        detail:
          `carries libc ${JSON.stringify(entry.libc)} but is not in this app's manifest — ` +
          `add it to the app's list in scripts/check-lockfile-libc.mjs${at(entryPath, name)}`,
      });
    }
  }

  return violations;
}

export function formatReport(violations, app) {
  const lines = [
    '',
    `${app.label}/package-lock.json libc guard FAILED — platform constraints were lost.`,
    '',
  ];

  const byKind = new Map();
  for (const violation of violations) {
    if (!byKind.has(violation.kind)) byKind.set(violation.kind, []);
    byKind.get(violation.kind).push(violation);
  }

  for (const [kind, kindEntries] of byKind) {
    lines.push(`  ${kind} (${kindEntries.length}):`);
    for (const entry of kindEntries) {
      lines.push(`    - ${entry.package}: ${entry.detail}`);
    }
    lines.push('');
  }

  lines.push(
    app.consequenceNote,
    '',
    'Reproduce the real effect (npm simulates the target platform):',
    `  ${app.reproCommand}`,
    '',
    app.selectionNote,
    '',
    'Most likely cause: the lockfile was regenerated by an npm that drops "libc"',
    '(npm 11.14.1 does — see PR #878, fixed in 83bbea121). Restore the field',
    'rather than accepting the regenerated file. If a dependency upgrade',
    'legitimately added or dropped a platform, run the command above to confirm no',
    'glibc package leaks into a musl install, then update this app\'s list in',
    'scripts/check-lockfile-libc.mjs in the same commit.',
    '',
  );

  return lines.join('\n');
}

export function main(appKey, lockfileOverride) {
  const app = APPS[appKey];
  if (!app) {
    console.error(
      `Unknown app ${JSON.stringify(appKey ?? null)} — usage: node scripts/check-lockfile-libc.mjs <${Object.keys(APPS).join('|')}> [lockfile-path]`,
    );
    return 2;
  }

  const lockfilePath = lockfileOverride ? path.resolve(lockfileOverride) : app.lockfilePath;
  // The admin working tree can be CRLF on Windows (no eol attribute); JSON.parse
  // does not care, but normalize anyway so behaviour is identical everywhere.
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8').replace(/\r\n/g, '\n'));
  const violations = collectViolations(lockfile, app.expected);

  if (violations.length) {
    console.error(formatReport(violations, app));
    return 1;
  }

  const tracked = Object.keys(app.expected).length;
  console.log(
    `${app.label}/package-lock.json libc guard passed (${tracked} platform packages keep their libc constraint)`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv[2], process.argv[3]));
}
