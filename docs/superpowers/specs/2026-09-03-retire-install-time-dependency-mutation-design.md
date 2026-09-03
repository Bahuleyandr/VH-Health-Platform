# Retire the install-time dependency mutation (OPEN-22)

**Date:** 2026-09-03
**Scope:** `apps/backend` and `apps/admin` dependency resolution, both Dockerfiles' install stages,
`scripts/security/check-infra-security-controls.mjs`
**Status:** implemented on `fix/retire-install-time-dependency-mutation` (off main `1d9f031d2`)
**Origin:** audit row OPEN-22; brief from the coordinating session.

## What was there

Both apps carried a global `overrides` entry forcing every `minimatch` consumer onto `10.2.5`, then
rewrote `node_modules` from `postinstall` so consumers written against other majors kept working:

- `patch-minimatch-compat.mjs` (byte-identical in both apps, enforced by the security gate) grafted a
  default export onto minimatch 10's CommonJS and ESM builds and type declarations, because
  consumers of major 3 (`eslint`, `@eslint/eslintrc`, `@eslint/config-array`, `eslint-plugin-*`,
  `test-exclude`) call `require('minimatch')` as a function;
- the same script rewrote `test-exclude/is-outside-dir-win32.js` to pass `windowsPathsNoEscape`,
  because minimatch 10 no longer treats a backslash as a separator while `test-exclude` 6 was
  written for minimatch 3, which does. That is why Windows coverage broke and was "fixed" in
  `879f0194e`;
- admin additionally forced `@redocly/openapi-core`'s `js-yaml` from its declared `4.3.1` to `5.2.3`
  and rewrote redocly's YAML schema setup to the js-yaml 5 API (`patch-redocly-js-yaml-compat.mjs`).

The Docker install stages copied the scripts into the build context before `npm ci`, and the
security gate pinned the exact postinstall strings, the byte identity of the two scripts, and the
COPY lines, so the arrangement could not drift; it also could not be removed piecemeal.

## Why native resolution is correct now

Every override existed to move a vulnerable major to a patched one. The advisory database (queried
2026-09-03) shows a patched release inside every major the consumers actually declare:

| package | majors declared by consumers | first patched release per major |
|---|---|---|
| minimatch | 3, 5, 9, 10 | 3.1.3, 5.1.8, 9.0.7, 10.2.3 (GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74) |
| brace-expansion | 1, 2, 5 | 1.1.18, 2.1.4, 5.0.9 (GHSA-rgw5-rvv9-x895 and predecessors) |
| js-yaml | 3, 4 | 3.15.1, 4.3.1 (GHSA-5p4m-2wfm-xmqj and predecessors) |

Letting npm resolve each consumer's own range yields the latest release in that range, which is at
or above every floor: minimatch 3.1.5 / 5.1.9 / 9.0.9 / 10.2.5, brace-expansion 1.1.18 / 2.1.4 /
5.0.9, and redocly's declared js-yaml 4.3.1 (the 5.x override postdated the 4.x fix by one day;
redocly 1.34.19 already pins the fixed 4.3.1). `npm audit --audit-level=high` stays clean in both
apps. With each consumer on its own major, both shims become unnecessary: `require('minimatch')`
from `test-exclude` or `eslint` is minimatch 3's function export, minimatch 3 handles Windows
separators itself, and redocly's schema code is written for the js-yaml 4 API it now receives.

## What changed

- `apps/backend/package.json`, `apps/admin/package.json`: no `postinstall`; no `minimatch`
  override; admin also drops the `@redocly/openapi-core` → `js-yaml` override.
- Both lockfiles gain the nested per-consumer copies of `minimatch`, `brace-expansion` and
  `balanced-match` (plus `concat-map` for admin) and nothing else. The entries were transplanted from
  an `npm install --package-lock-only` run into the committed lockfile rather than taking npm 11's
  output wholesale, because npm 11 re-serialises the admin lockfile and strips `libc` from optional
  platform entries (the #878 Alpine failure). Zero `libc` lines changed. The leftover forced
  `@redocly/openapi-core/node_modules/js-yaml@5.2.3` entry, which the lock-only run did not
  re-evaluate, was removed so redocly resolves the root `js-yaml@4.3.1` it declares.
- `apps/backend/Dockerfile` (both install stages) and `apps/admin/Dockerfile` (deps stage) copy only
  the manifests before `npm ci`.
- The three patch scripts are deleted, as is admin's `.prettierrc.json`, which existed only to
  style the patch script (added by the same commit).
- `scripts/security/dependency-floors.mjs` (new): the per-major floors above and a
  `dependencyViolations(lockfile, name)` checker that treats absence, prereleases, unparseable
  versions and majors without a patched release as violations.
- `scripts/security/check-infra-security-controls.mjs`: the check that pinned the mutation is
  replaced by three that assert its absence and the new invariant: no `postinstall` in either app
  and no `patch-*-compat.mjs` under either `scripts/`; every `npm ci` stage in both Dockerfiles
  copies exactly one line before installing, and that line is the manifests; no `minimatch` or
  redocly override remains and both lockfiles satisfy the patched floors.
- `docs/ROADMAP.md` OPEN-22 entry rewritten to the resolved state.

## Tests

- `apps/backend/src/tests/unit/minimatchNativeResolution.test.js` replaces
  `minimatchWindowsCoverageCompatibility.test.js`, which asserted the patch's own artefacts. It pins:
  no postinstall or override in either manifest; `test-exclude` and `eslint` resolve their own
  minimatch 3 while the direct dependency keeps 10; the installed minimatch 10 is exactly as
  published (an exports object, no grafted `module.exports`); minimatch 3 matches a repo-rooted
  path with the host's separator with no option; `test-exclude` instruments inside the backend root
  and refuses outside it from the unpatched helper; both ESLint compatibility layers load. It runs
  and asserts on both platforms with the separator the host uses.
- `apps/backend/src/tests/unit/dependencyFloors.test.js` mutation-tests the shared checker (a copy
  below its floor, a major with no patched release, an absent dependency, a prerelease) and asserts
  both real lockfiles are clean and backend resolves majors `[3, 5, 9, 10]`.
- `apps/admin/src/__tests__/lib/redoclyJsYamlNativeResolution.test.ts` pins that redocly resolves
  its declared js-yaml 4 and parses merge keys and dates through its own YAML layer unpatched.
- The gate's new checks were exercised negatively by hand before the change was committed: a
  re-added `postinstall`, a lockfile copy of minimatch edited below its floor (3.1.2), and an extra
  `COPY` line before `npm ci` each fail exactly the check that owns them, and the clean tree passes.

## Verification

Recorded in the pull request: fresh `npm ci` in both apps from the transplanted lockfiles;
`npm audit --audit-level=high` clean in both; the whole-backend `eslint .` (ESLint now on its own
minimatch 3); a coverage run instrumenting through `test-exclude` on Windows; the security runner's
gate; and the Docker install stages (`npm ci` in the builder stage and `npm ci --omit=dev` in the
production stage on the pinned `node:26.5.0-alpine` image, plus admin's deps stage).

## Revisit trigger

If a future advisory lands on one of these packages, bump the floor in `dependency-floors.mjs` and
let the lockfile follow through a normal in-range update; do not reintroduce a cross-major
override, and never rewrite `node_modules` at install time. If a consumer ever declares a major that
has no patched release, the floors checker rejects it and the consumer, not the package, is the
thing to upgrade.
