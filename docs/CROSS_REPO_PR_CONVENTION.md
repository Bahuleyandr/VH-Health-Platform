# Cross-repo PR convention

> When a change spans more than one VH Health repo (common: add a backend
> endpoint + wire the admin portal to it + add the Dart client call),
> merging each repo's PR independently can leave production in a half-baked
> state for anywhere from seconds to days. This doc is the convention for
> those cases until/unless the repos are consolidated into one monorepo
> (tracked as roadmap 5.1 — the Melos config has landed; the
> history-preserving `git subtree` migration has not).

## When to follow this convention

Any change that touches **two or more** of:
- `vh-health-backend`
- `VH-Health-Adminportal`
- `VH-health` (patient app)
- `vhhealth-staff`
- `vhhealth-core`

Single-repo changes are out of scope — follow each repo's standard PR flow.

## The "stacked PRs" convention

1. **Pick a topic identifier.** One short slug per stack, reused as the
   branch prefix in every repo — e.g. `mar-due-meds-2026-04`,
   `revenue-cycle-arg-aging`. Mirrors the commit-scope convention some
   monorepos use.
2. **Open one PR per repo**, each branch named `topic/<slug>`. In the PR
   description, list every sibling PR with its URL and say which order
   they need to merge in. Example in a patient-app PR description:
   ```
   Stack: backend-due-meds-2026-04
   - [x] https://github.com/Bahuleyandr/vh-health-backend/pull/NNN   ← merge first
   - [ ] (this PR) patient-app drop-in call
   - [ ] https://github.com/Bahuleyandr/VH-Health-Adminportal/pull/NNN  ← merge after
   ```
3. **Merge order matters.** Backend endpoint changes land first; clients
   that depend on the new contract land after. If a client ships first
   against a contract the backend hasn't rolled out, it will 404 in
   staging + prod for the gap window.
4. **Feature-flag the client side when the gap matters.** If merge order
   can't be perfectly synced (e.g. reviewers in different time zones),
   the client-side call should be behind a `feature_flags` check that
   defaults off until the backend side is deployed.
5. **One post-merge verification per stack.** After the last PR merges,
   the author runs the end-to-end flow manually against staging and
   posts the result to the stack's Discord thread.

## What to avoid

- **Squash-merging with a different commit scope in each repo.** Makes
  reverting painful — use the same subject line prefix
  (`feat(mar-due-meds): ...`) across the stack.
- **Bumping `vhhealth_core` without a compatible consumer PR.** Core
  is a `path:` dependency at dev time but published as a pinned version
  in CI via the codegen pipeline (see 5.3). Bumping core means bumping
  both Flutter apps in the same stack.
- **Merging admin portal changes before backend.** The admin portal's
  `fetchAdminAPI` calls the backend directly — a shape change on the
  backend that lags the admin portal merge will surface as a blank or
  broken page the moment the portal's Vercel deploy promotes.

## Why not just do a monorepo

Roadmap 5.1 proposes exactly that — history-preserving `git subtree` the
five repos into one. The migration isn't executed because it's a one-shot
operation that needs supervised downtime. Until then, this convention is
the practical substitute.

## Related

- [`docs/FINISH_BUILDING.md`](./FINISH_BUILDING.md) §5.1 — Melos monorepo
  plan (in progress).
- [`docs/MONOREPO_MIGRATION.md`](./MONOREPO_MIGRATION.md) (at the cross-repo
  root / `vhhealth-core/docs/`) — runbook for the one-shot migration when
  the team commits to it.
- [`docs/CI_REQUIRED_CHECKS.md`](./CI_REQUIRED_CHECKS.md) — what branch
  protection should enforce once GitHub Pro unlocks it.
