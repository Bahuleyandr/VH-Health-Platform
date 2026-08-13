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
