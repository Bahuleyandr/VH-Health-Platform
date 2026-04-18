# CLAUDE.md — VH Health Monorepo

Melos workspace unifying the three Flutter repos:

| Path | Package name | Role |
|---|---|---|
| `packages/vhhealth_core` | `vhhealth_core` | Shared types, API client, codegen target |
| `apps/patient` | `vhhealth` | Patient-facing Flutter app |
| `apps/staff` | `vhhealth_staff` | Staff/clinical Flutter app |

The Node backend (`VH-health-backend`) and Next.js admin portal
(`VH-Health-Adminportal`) stay in their own GitHub repos — cross-stack
coordination uses
[`CROSS_REPO_PR_CONVENTION.md`](https://github.com/Bahuleyandr/VH-health-backend/blob/main/docs/CROSS_REPO_PR_CONVENTION.md).

## Workflow

```bash
# One-time setup
dart pub global activate melos

# Every clone / after pulling
melos bootstrap              # pub get across all three packages in parallel

# Daily commands
melos run analyze            # flutter analyze everywhere
melos run test               # flutter test everywhere (skips packages with no test/)
melos run format             # dart format --set-exit-if-changed (CI-safe)
melos run format-fix         # dart format with writes
melos run codegen            # build_runner in packages that declare it
melos run clean              # flutter clean everywhere
```

`melos exec -- "<any command>"` runs an ad-hoc command in every package.
Scope with `--scope="vhhealth_core"` etc.

## Per-package docs

Each package keeps its own `CLAUDE.md` next to its `pubspec.yaml`:

- [`packages/vhhealth_core/CLAUDE.md`](packages/vhhealth_core/CLAUDE.md)
- [`apps/patient/CLAUDE.md`](apps/patient/CLAUDE.md)
- [`apps/staff/CLAUDE.md`](apps/staff/CLAUDE.md)

Those files predate the monorepo so sibling-repo path references
(e.g. `../vhhealth-core`, `../vhhealth-backend`) point at the
old separate-repo layout. The actual dependency wiring is correct —
each `pubspec.yaml` now uses `path: ../../packages/vhhealth_core`.

## Path-dep invariant

Both apps depend on `vhhealth_core` via relative path from the monorepo
layout:

```yaml
vhhealth_core:
  path: ../../packages/vhhealth_core
```

Moving a package (e.g. renaming `apps/patient` to `apps/mobile`)
requires updating every consumer's path. `melos bootstrap` will fail
loudly if the path breaks.

## History

Created 2026-04-18 from three separate repos via `git subtree add`:

```bash
git subtree add --prefix=packages/vhhealth_core \
  https://github.com/Bahuleyandr/vhhealth-core.git main
git subtree add --prefix=apps/patient \
  https://github.com/Bahuleyandr/VH-health.git main
git subtree add --prefix=apps/staff \
  https://github.com/Bahuleyandr/VHhealth-staff.git main
```

Full pre-monorepo history is preserved — `git log apps/patient/` and
friends walk every commit from the original repos.

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`:

1. Install Flutter stable
2. `dart pub global activate melos`
3. `melos bootstrap`
4. `melos run analyze`
5. `melos run test`
6. `melos run format`

Per-package `.github/workflows/*.yml` files under `apps/*` /
`packages/*` are inert in a monorepo (GitHub only reads from the root
`.github/workflows/`). They're retained for reference and will be
removed once the staging-deploy workflows are ported to the root.

## Follow-ups after migration

- Port `apps/patient/.github/workflows/deploy-staging.yml` and
  `apps/staff/.github/workflows/deploy-staging.yml` to root workflows
  once staging secrets are configured on this repo.
- Archive the three upstream repos (held off per owner request).
- Consider `pubspec_overrides.yaml` at root to force shared-dep
  versions across the apps (e.g. `go_router`, `shared_preferences`)
  if they ever drift.
