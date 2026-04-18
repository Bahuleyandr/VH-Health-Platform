# VH Health Monorepo

Flutter workspace for the VH Health platform. Contains the three
Dart/Flutter repos that used to live separately, now unified under Melos
so shared commands (`melos run pub_get`, `melos run analyze`,
`melos run test`, `melos run codegen`) cover every package in one pass.

## Packages

| Path | Upstream (archived) | Purpose |
|---|---|---|
| `packages/vhhealth_core` | `Bahuleyandr/vhhealth-core` | Shared types, API client, codegen target |
| `apps/patient` | `Bahuleyandr/VH-health` | Patient-facing Flutter app |
| `apps/staff` | `Bahuleyandr/VHhealth-staff` | Staff/clinical Flutter app |

## Sibling repos (still separate)

- `Bahuleyandr/VH-health-backend` — Node.js + Express API
- `Bahuleyandr/VH-Health-Adminportal` — Next.js admin portal

These are intentionally outside the monorepo (different stacks,
different deploy cadences). Cross-repo changes follow
[`VH-health-backend/docs/CROSS_REPO_PR_CONVENTION.md`](https://github.com/Bahuleyandr/VH-health-backend/blob/main/docs/CROSS_REPO_PR_CONVENTION.md).

## Quick start

```bash
dart pub global activate melos
melos bootstrap
melos run analyze
melos run test
```

See [`CLAUDE.md`](./CLAUDE.md) for the full workflow + migration notes.
