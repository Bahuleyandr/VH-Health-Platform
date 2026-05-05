# Cross-Repo PR Convention

> **Superseded:** VH Health is now a single monorepo at
> `Bahuleyandr/VH-Health-Platform`. The old component repositories are
> archived and must not be used for new PRs, releases, package ownership, or
> deployment authority.

Current work should happen in one branch/PR against `VH-Health-Platform`.
When a change spans backend, admin, patient, staff, and shared Dart code,
validate the affected apps together in this monorepo rather than coordinating
separate repository merges.

The old stacked-PR process is intentionally removed from this document to avoid
accidental use of archived repositories.

Related:
- [`CI_REQUIRED_CHECKS.md`](./CI_REQUIRED_CHECKS.md)
- Root [`CLAUDE.md`](../../../CLAUDE.md)
