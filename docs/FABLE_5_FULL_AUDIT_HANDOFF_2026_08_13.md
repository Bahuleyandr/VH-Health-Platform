# VH Health Full Audit and Upgrade Handoff — 2026-08-13

This is the authoritative restart receipt for continuing the dependency-upgrade
and full-repository audit with Claude Fable 5. It records repository state, work
already integrated, verified gates, current failures, and the remaining order of
work. It is not deployment or merge authority.

## Authority and hard stops

- GitHub is the only publication target for this continuation.
- Forgejo work is explicitly deferred by the owner. Do not extend the Forgejo
  release-authority work. The immutable pin checks already present in the branch
  may remain, but Forgejo activation is outside this continuation.
- Do not merge the draft pull request without a new, explicit owner instruction.
- Do not deploy, sync Argo applications, activate a HELD component, change live
  tenant settings, rotate credentials, or invent missing owner evidence.
- Keep production application digests, operator applications, care-team
  enforcement, Patient minimum-version trust, universal links, and other
  documented activation gates HELD until their named evidence exists.
- Never reset, rebuild, migrate, or seed the shared `vhhealth_test` database.
  Database work must use a uniquely named scratch database and prove zero active
  sessions before cleanup.
- The requested deliverable remains one consolidated GitHub pull request. Multiple
  reviewable commits inside that pull request are intentional.

## Exact repository state at pause

- Repository: `D:\Dev\Projects\VH Health\VH-Health-Platform`
- Consolidated worktree:
  `D:\Dev\_codex\worktrees\VH-Health-Platform-full-audit-2026-08`
- Branch: `fix/full-repository-audit-2026-08`
- Paused content head before this handoff commit:
  `5533ba90a8bb1d22e81484a90e6378406b983b14`
- GitHub base: `github/main` at
  `9cc8b8903f2a4df370c37c2ec7714c563787d88e`
- Relationship at pause: GitHub main is an ancestor; the branch is 39 commits
  ahead and 0 behind, with 491 changed files.
- The consolidated worktree was clean before this document was added.
- No draft pull request existed for this branch before the pause publication.

Always fetch `github/main` and recheck ancestry before resuming. Do not use the
local `main` worktree as the publication base without first proving it matches
GitHub.

## Integrated remediation train

The following work is already in the consolidated branch and must not be
reimplemented or cherry-picked again:

1. Dependency baseline reconciliation, Melos 8.2.2, backend/Admin/Flutter
   dependency upgrades, and the durable dependency record.
2. Backend public Firebase health and progress-note tenant fixes.
3. Reminder delivery made provider-receipt-driven.
4. Admin P1 client contracts, build hygiene, PWA retirement, bundle and coverage
   ratchets.
5. Staff trusted-device/PIN/biometric contract, session teardown, singleton Code
   Blue handling, role parity, cache and catalog residuals.
6. Patient realtime consolidation, subscription authorization, logout fencing,
   cache/session authority, signed minimum-version policy substrate, deep-link
   routing, and dead-code removal.
7. Interface-engine runtime leasing, retry/replay truth, ingress source policy,
   activation guards, and canonical HL7/FHIR writes with migrations 665 and 666.
8. Care-team PHI guard/readiness substrate. Production remains in `shadow`; no
   tenant has been switched by this branch.
9. Migration/startup/RLS readiness gating and production worker migration
   verification.
10. Production image inventory and live digest verification.
11. Infrastructure bootstrap truthfulness and HELD operator-lifecycle manifests.
12. Redis Sentinel topology plus named least-privilege ACL identities,
   DB-authoritative replay claims, writable-primary readiness, awaited pub/sub,
   hashed rate-limit identifiers, and Redis 7.4.10.
13. Scheduler/notification tenant integrity and seed truth in migration 668.
14. Attempt-safe payroll documents, issuance, encrypted credential lifecycle,
   provider receipt gating, and owner-only password reveal in migration 669.
15. Staff and Admin self-service payslip password reveal clients.

The last integrated commits, newest first, are:

```text
5533ba90a feat(payroll): add explicit payslip password reveal
f0e008023 fix(infra): upgrade Redis 7.4 security patch
d5d5dbe25 fix(backend): make payroll delivery attempt-safe
6dfb40a23 fix(infra): add held operator lifecycle gate
2a96ed6a3 fix(redis): close failover security blockers
41ad6d68e fix(redis): enforce sentinel quorum topology
ae9af6f30 fix(backend): harden tenant jobs and schema integrity
afe2359d5 fix(ci): pin Forgejo supply chain inputs
addce0351 fix(staff): close residual audit gaps
9b01a5288 fix(patient): close residual audit gaps
57b4f5e57 fix(infra): make bootstrap fresh-cluster safe
ef1df4cc2 fix(infra): make deployment and topology status truthful
d192410dc fix(security): gate care-team PHI enforcement
```

Use `git log github/main..HEAD` for the complete 39-commit train.

## Verified gates on the consolidated tree

The following claims were read from completed commands on the consolidated
branch, not inferred from isolated lane results:

- Backend full lint and guardrails passed: raw-parameter, status assertion,
  tenant/RLS, default-tenant, clinical-AI, vital-bound, and secret checks.
- Backend OpenAPI source/core drift and lint budget passed with 3,526 known
  warnings, zero errors, zero new warnings, and zero stale warnings.
- Prisma's combined schema validates.
- Security CI passed, including the repository secret checks, Gitleaks,
  Semgrep, and the configured security contracts.
- Infrastructure CI passed. Six Kustomize roots rendered; production rendered
  179 resources with zero validation errors; 25 active image pins were verified
  against live registries; exactly six deliberate application zero-digest
  occurrences remained HELD.
- Admin clean install and audit passed with zero vulnerabilities.
- Admin lint passed with zero errors; full type-check and E2E type-check passed.
- Admin Jest passed 102 suites and 1,175 tests.
- Admin production Next.js 16.3 build passed. Its existing middleware-to-proxy
  deprecation warning remains non-blocking.
- Full Melos code generation followed by full workspace analysis passed:
  core had zero issues, Patient had one pre-existing info, and Staff had 17
  pre-existing infos.
- Staff's full Flutter test suite passed 1,057 tests with one skip.
- Redis-focused combined tests passed 11 suites and 111 tests. Static topology,
  render, deterministic failover-harness, and full infra gates passed. A live
  three-node Docker failover/partition/restart/credential-rotation drill was not
  possible because the Docker daemon was unavailable and remains unproven.
- Migration 668 was proven through a fresh scratch chain, deep tests, seed
  idempotence, contracts, schema drift, Prisma generation, and cleanup.
- Migration 669 was proven on a fresh ordered 668-to-669 chain with deep payroll
  tests, schema drift, OpenAPI, lint, independent review, and scratch cleanup.

Do not claim a fully green repository yet. The release blockers below remain.

## Current test failures and incomplete final gates

1. The full Patient Flutter suite is not green. Seven failures/timeouts were
   concentrated in:
   - `apps/patient/test/core/navigation/backend_session_authority_test.dart`
   - `apps/patient/test/core/services/logout_teardown_paths_test.dart`

   The failure included a ten-minute timeout and a `pumpAndSettle` timeout.
   The interrupted fix worktree below is clean; no speculative patch was saved.
   Root-cause this without weakening the PAT-003 offline lease, session authority,
   realtime generation fence, or final logout disconnect.

2. Backend audit reruns passed 34 suites and 379 tests but one suite failed at
   module load: `interfaceEngineSchedulerWiring.test.js` mocks Prisma's default
   export but omits the named `setTenant` export now imported by
   `tenantFanout.js`. Correct the mock and rerun the exact suite plus adjacent
   scheduler tests.

3. The Admin post-build checks `check:clinical-ai-bundle`,
   `check:pwa-retirement`, and `format:check` should be rerun on resume because
   their last combined output was not retained in the pause transcript.

4. A final source-complete `[full-ci]` marker has not been created. It must be
   the last no-source-change commit only after every remaining source change is
   integrated and the required local gates are green.

## Validated open findings at the pause head

### P1 release or activation blockers

1. `HL7_INBOUND_ENABLED=false` is not authoritative. Production declares HL7
   ingress off, but `/api/v1/hl7` is mounted unconditionally and accepts an
   active database credential or retained legacy secret without checking the
   flag. Gate the actual ingress and test false-with-valid-credential behavior.

2. Generic interface-engine inbound activation can approve `http_inbound`
   without a usable canonical backend adapter. The only registered HL7 adapter
   is the forbidden preview adapter. Require a concrete registered adapter in
   both service and database activation boundaries, or keep inbound activation
   unavailable.

3. Care-team relationship denials remain non-blocking in production because the
   posture is `shadow`. The readiness audit is fail-closed and currently blocked
   on live tenant evidence; no CI or PreSync admission gate changes that. This is
   intentionally HELD until owner-reviewed tenant evidence exists. Do not flip
   it merely to make the repository look green.

4. The production backend runtime image removes `npm`, while the Argo PreSync
   migration Job invokes `npm run db:ensure-pgvector`. The Job therefore cannot
   reach migrations in the actual image. Replace the command with an executable
   present in the image or otherwise make the image/Job contract truthful, then
   add an image-command regression test.

5. GitHub Patient/Staff staging and Android release workflows invoke bare
   `sdkmanager` without provisioning Android command-line tools. Recent GitHub
   runs 31662939426 and 31662939423 failed with `sdkmanager: command not found`
   and exit 127. Add deterministic, pinned SDK provisioning to all four GitHub
   workflows. Forgejo is excluded.

6. PG18 is actively composed in production even though the deployment guide says
   the live PG17 and PG18 definitions must not sync together. Make PG18 a
   separately governed HELD path and keep the active production graph on its
   declared database generation until the qualification/cutover authority exists.

7. Ollama's pending-GPU Phase 4 is actively composed. Its preflight is a normal
   failing Job rather than a deployment hook, so the active graph is neither
   cleanly held nor safely deployable. Move the capability outside the active
   barrel and make activation explicit and fail-closed.

### P2 residuals

1. Payroll generation publishes a user-visible “payslip ready” notification
   before owner approval and issuance. Move it after issuance or make the earlier
   message accurately non-actionable.
2. FHIR AllergyIntolerance pagination reads all active rows from two stores and
   slices in memory. Replace it with deterministic database-side union,
   deduplication, and bounded pagination.
3. Migration 668's durable scheduler receipt covers tenant-fanned jobs but not
   direct critical jobs such as audit-chain verification and results-inbox
   escalation. Move fleet jobs behind a durable receipt/failure boundary.

The fresh final Client and horizontal audits were interrupted at the owner's
pause request and did not deliver complete ledgers. Resume them after the known
P1/test blockers are fixed; do not treat absence of a final message as no
findings.

## Clean interrupted worktrees

The following newly assigned lanes were stopped before any change. At pause,
each branch was clean at `5533ba90a`:

- `D:\Dev\_codex\worktrees\VH-Health-Platform-audit4-patient-final-gate`
  (`fix/audit4-patient-final-gate-local`)
- `D:\Dev\_codex\worktrees\VH-Health-Platform-audit4-backend-migration-image`
  (`fix/audit4-backend-migration-image-local`)
- `D:\Dev\_codex\worktrees\VH-Health-Platform-p1-activation-truth`
  (`fix/p1-activation-truth-pg18-ollama`)

They contain no uncommitted implementation to recover. Reuse or remove them only
after checking their status yourself.

## Required resumption order

1. Fetch GitHub and prove the draft branch still contains current `github/main`.
2. Root-cause and fix the Patient final-gate failures; rerun the two focused files,
   adjacent authority/logout tests, Patient analysis, and the full Patient suite.
3. Fix the backend migration image/PreSync command mismatch.
4. Fix all four GitHub Android `sdkmanager` workflow paths.
5. Make PG18 and Ollama truthfully HELD/uncomposed and rerun the canonical infra
   gate plus production renders.
6. Close the HL7 flag and interface-adapter P1s and the broken interface scheduler
   test. Preserve care-team shadow as an explicit external-evidence hold.
7. Address the three backend P2s or record a precise, owner-approved deferral.
8. Resume the fresh Client, horizontal, and GitHub/infra audits on the new exact
   head. Revalidate findings rather than copying old line numbers.
9. Update `docs/FULL_REPOSITORY_AUDIT_2026_08.md`; its original 4.8 rating and
   `IN PROGRESS` table are historical and do not describe this branch after the
   remediation train. Give a new evidence-calibrated rating and separate fixed,
   open, HELD, deferred, and environment-unproven work.
10. Run the full backend, Admin, Flutter/Melos, security, infrastructure, OpenAPI,
    schema/migration, seed, and dependency gates appropriate to the final diff.
11. Create the final empty `[full-ci]` commit only after source is frozen. Push the
    draft branch and wait for all GitHub checks. Do not merge without explicit
    owner authority.

## Upgrade path still intentionally deferred

The dependency upgrade itself is integrated. Remaining majors are compatibility
programs rather than safe one-line bumps:

- Flutter 3.47+ followed by the Android Gradle Plugin 9 migration.
- The coordinated secure-storage, device-info, sharing, Windows, and related
  Flutter plugin cohort.
- ESLint 10 plus compatible import/tooling plugins.
- TypeScript 7 plus the compatible `typescript-eslint` ecosystem.
- Further Prisma generator/runtime performance investigation; generation was
  functionally successful but pathologically slow on this Windows host.
- Live Kubernetes/operator and Redis HA qualification only after the HELD
  prerequisites in the runbooks are satisfied.

See `docs/DEPENDENCY_UPGRADE_2026_08.md` and
`docs/FLUTTER_PLUGIN_MAJOR_MIGRATIONS.md` for the detailed compatibility record.

## Document precedence

For continuation status, use this handoff first. The earlier
`FULL_REPOSITORY_AUDIT_REMEDIATION_CHECKPOINT_2026_08_13.md` is a historical
mid-remediation pause receipt. `FULL_REPOSITORY_AUDIT_2026_08.md` is the original
audit ledger and must be reconciled before the pull request is declared complete.
