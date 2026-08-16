# Consolidated Dependency Upgrade — 2026-08-13

This is the durable record for the single dependency pass based on the merge of
PR #865 (`361af1c95385a8f0e5b6820460fbeccdb65bdb53`). Package manifests and
lockfiles remain the source of truth for current versions; version numbers in
this document describe this pass and are not floating recommendations.

<!-- vh:historical-start 2026-08-13 consolidated dependency pass -->

## Scope completed

- Backend and Admin direct dependencies and lockfiles were advanced to every
  version compatible with their current peer graphs.
- The device gateway was checked and was already current.
- The read-only PostgreSQL MCP utility and on-prem checks utility were advanced
  to their current compatible SDK and PostgreSQL client releases.
- The Patient, Staff, shared-core, and workspace Flutter graphs were upgraded,
  including Melos 8.2.2 and the local Lucide package's lint tool.
- Every GitHub and Forgejo Flutter workflow now activates Melos 8.2.2.
- Patient and Staff Android builds now use compile SDK 37, Android Gradle Plugin
  8.13.2, Gradle 8.14.5, and Kotlin 2.3.20. Their deploy and release workflows
  install Android platform and build-tools 37 explicitly.

The remaining manifests contain no floating runtime dependencies: the Patient
Node manifest is metadata-only, the continuity-edge verifier uses only Node
built-ins, and the vendored geolocator/lifecycle packages are maintained source
forks rather than independent application dependency graphs.

## Deliberate compatibility ceilings

- Backend and Admin remain on ESLint 9 because `eslint-plugin-import` does not
  currently declare ESLint 10 compatibility.
- Admin remains on TypeScript 6 because the current `@typescript-eslint` line
  declares TypeScript support below 6.1. TypeScript 7 must move with that parser
  and plugin family.
- Flutter SDK-owned and Win32-cohort ceilings are recorded in
  [Flutter Plugin Major Migrations](./FLUTTER_PLUGIN_MAJOR_MIGRATIONS.md).
- AGP 9 was tested and rejected on the pinned Flutter release. Upstream plugins
  already assume Flutter's built-in Kotlin integration under AGP 9, while that
  migration is available only from Flutter 3.47. The repository therefore uses
  the newest tested AGP 8 bridge instead of forcing a partially wired AGP 9
  build. See Flutter's
  [built-in Kotlin migration guide](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers).

## Verification performed

- Backend: clean install, zero-vulnerability audit, lint and repository static
  controls, Prisma client generation, OpenAPI drift/core sync/Spectral budget,
  fresh PostgreSQL 18 plus pgvector migrations, seed coverage, database
  contracts, and schema drift checks.
- Backend coverage set: 49 suites and 1,151 tests pass. Istanbul collection is
  unavailable on the Windows Node 26 ESM path (`0/0`); the same mainline gate is
  healthy on Ubuntu, so the final immutable-head hosted full-CI run remains the
  authoritative coverage result.
- Admin: clean install, zero-vulnerability audit, lint, type-check, 94 Jest
  suites (1,130 tests), and production Next.js build.
- Flutter: dependency resolution, code generation, formatting, analyzer, all
  workspace tests, vital-bound contract, both Android debug APKs, and both
  production web builds.
- MCP and on-prem utilities: clean installs, zero-vulnerability audits, empty
  `npm outdated` results, and Node syntax checks.

Prisma client generation took about 19 minutes on this Windows host. It remains
inside the hosted 35-minute generation timeout, but should be profiled again on
the next Prisma change rather than assumed to be harmless.

## Next upgrade order

1. Upgrade Flutter to 3.47 or newer, rerun every platform build, and migrate to
   built-in Kotlin before moving AGP/Gradle to the 9.x line.
2. Advance the stable Win32 plugin cohort together when `file_picker` publishes
   a compatible stable line; then attempt the deferred device, package-info,
   share, secure-storage, and geolocator versions as one resolver change.
3. Move ESLint 10 only after the import plugin peer range supports it; move
   TypeScript 7 with a compatible `@typescript-eslint` parser/plugin release.
4. Re-profile Prisma generation and preserve the generated-client CI cache. If
   uncached hosted generation approaches the timeout, split or optimize schema
   generation before another Prisma upgrade.
5. Re-evaluate whether the two Patient Android source forks can return to their
   upstream packages; do not silently refresh vendored sources without porting
   and testing the repository-specific patches.

<!-- vh:historical-end -->

## 2026-08-16 execution pass

<!-- vh:historical-start 2026-08-16 upgrade-order execution pass -->

Item 1 of the upgrade order was executed: the pinned Flutter toolchain moved
from 3.44.0 to stable 3.47.0 (Dart 3.13.0) across the workspace pubspecs, the
GitHub and Forgejo workflow pins, and `apps/staff/Dockerfile.web`. The resolver
required no plugin cohort movement — only SDK-held transitives advanced — and
the full workspace gate (codegen, format, analyze, tests, staff web build) is
green on the new SDK. Because `ghcr.io/cirruslabs/flutter` publishes no stable
tag past 3.44.0, the staff web image now installs the official sha256-pinned
Flutter tarball on a digest-pinned `debian:12-slim` base.

Items re-checked against the npm registry on 2026-08-16 and still blocked, in
each case by the exact precondition this document states:

- **ESLint 10** — `eslint-plugin-import` latest (2.32.0) still declares
  `eslint: ^2 || ^3 || ^4 || ^5 || ^6 || ^7.2.0 || ^8 || ^9`; no ESLint-10
  compatible release exists (its `next` dist-tag is a stale 2.0.0 beta). Every
  other plugin in both lint graphs already admits ESLint 10.
- **TypeScript 7** — `@typescript-eslint` latest (8.67.0) still declares
  `typescript: >=4.8.4 <6.1.0` and no 9.x line exists. TypeScript's last 6.x
  release is 6.0.3, which Admin already uses, so there is nothing newer to
  adopt inside the supported range.
- **AGP 9** — Flutter 3.47.0 provides the built-in Kotlin prerequisite, but the
  migration remains unvalidated: it requires a live Android Gradle build
  (Android SDK + platform 37), which the hosted verification environment does
  not provide. Do not bump AGP without building both Android apps.
- **Win32 plugin cohort, Prisma re-profile, vendored Android forks** — not
  re-attempted this pass; their recorded preconditions are unchanged.

<!-- vh:historical-end -->
