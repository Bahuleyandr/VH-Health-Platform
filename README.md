# VH Health Monorepo

Full-stack monorepo for the VH Health platform. It now contains:

- Flutter patient app (`apps/patient`)
- Flutter staff app (`apps/staff`)
- Shared Dart package (`packages/vhhealth_core`)
- Node/Express backend API (`apps/backend`)
- Next.js admin portal (`apps/admin`)

Flutter packages are unified under a Melos/Dart workspace so shared
commands (`melos run analyze`, `melos run test`, `melos run codegen`)
cover all Flutter packages in one pass.

## Packages

| Path | Upstream (archived) | Purpose |
|---|---|---|
| `packages/vhhealth_core` | `Bahuleyandr/vhhealth-core` | Shared types, API client, codegen target |
| `apps/patient` | `Bahuleyandr/VH-health` | Patient-facing Flutter app |
| `apps/staff` | `Bahuleyandr/VHhealth-staff` | Staff/clinical Flutter app |
| `apps/backend` | `Bahuleyandr/VH-health-backend` | Node.js + Express healthcare API |
| `apps/admin` | `Bahuleyandr/VH-Health-Adminportal` | Next.js admin/super-admin portal |

## Migration status

This repository was migrated from separate upstream repos. Legacy docs
or scripts may still reference old standalone-repo paths; prefer
paths under `apps/` and `packages/` in this monorepo.

## Quick start

```bash
dart pub global activate melos
melos bootstrap
melos run analyze
melos run test
```

See [`CLAUDE.md`](./CLAUDE.md) for the full workflow + migration notes.
