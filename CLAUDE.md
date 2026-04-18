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
dart pub global activate melos 7.5.1

# Every clone / after pulling
dart pub get                 # resolves the pub workspace (all 3 packages share a lockfile)
melos bootstrap              # generates IDE files + runs post-bootstrap hooks

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

## Pub workspace invariant

This is a Dart pub workspace (Melos 7 + Dart 3.6+). All packages share
one `pubspec.lock` at the repo root. Consequences:

- Sub-packages depend on `vhhealth_core` by **name**, not path:
  ```yaml
  vhhealth_core: any
  ```
  The workspace resolver finds it because it's listed under
  `workspace:` in the root `pubspec.yaml`.
- Every dep must resolve to a single version across all workspace
  members. If you introduce a version conflict (e.g. patient on
  `firebase_core ^4` and staff on `^3`), `dart pub get` refuses. Align
  the versions or move the odd-one-out out of the workspace.
- Melos scripts live under the `melos:` key in `pubspec.yaml`, not in
  a separate `melos.yaml` file.

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
