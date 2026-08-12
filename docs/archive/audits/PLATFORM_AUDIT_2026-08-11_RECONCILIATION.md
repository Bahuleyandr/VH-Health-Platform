# VH Health Platform Audit #3 — Corrected Residual Reconciliation

> Corrected engineering reconciliation of the 2026-08-11 full-platform audit.
> This is an evidence record, not deployment, activation, credential, or live-data authority.

## Identity and correction

- Original full-read audit baseline: `a64a5dd80122637849d9cb0c80e28a4966e19341`.
- Original draft ledger: [PR #846](https://github.com/Bahuleyandr/VH-Health-Platform/pull/846),
  head `125f38a550294baa70747095771885fdd20d8dd5`.
- P0-P10 integration merge: [PR #863](https://github.com/Bahuleyandr/VH-Health-Platform/pull/863),
  merge `a4227ed9386243067440a5575e4aa3908be68c3a`.
- Residual-review base: `github/main` at
  `831dbc86c8f4194cb41f690abf567050c35c98cc`.
- Residual-remediation branch: `fix/audit3-residual-remediation`.
- Reconciliation date: 2026-08-13.

The previous version of this document said there was no remaining High,
Medium, or Low code blocker and marked Audit #3 engineering remediation
complete. That was too broad. A live re-read of the merged tree found nine
still-actionable residual finding families, three held surfaces that needed a
stronger fail-closed boundary, and several operator-only consequences. This
document supersedes that completion claim.

## Executive outcome

The P0-P10 train fixed most of the original audit. It did not fix everything.
The consolidated residual PR closes the code-actionable remainder without
activating held capabilities:

1. staff messaging requires server idempotency and no longer converts a
   post-commit notification failure into a retryable message failure;
2. external recovery retries reclaim stale leases and finish durable pending
   items instead of returning authoritative pending success indefinitely;
3. the broken duplicate daily appointment reminder engine is removed;
4. automated payroll is disabled by default and, when explicitly enabled,
   fans out strictly by tenant with tenant-consistent keys and foreign keys;
5. patient walks persist a secure checkpoint, reconcile after lifecycle loss,
   and stop idempotently without awarding points twice;
6. patient routing and biometric resume require a JWT-shaped backend session;
7. Firebase bootstrap uses the shared unauthenticated transport and App Check
   path rather than raw `package:http`;
8. Admin pathology reads and mutations render failures instead of empty or
   silent-success states; and
9. Staff Web and the device gateway fail closed while their activation designs
   remain unapproved.

This still does **not** make the platform production-authorized. Live synthetic
account consequence checks, runtime-role proof, signed images, retention
decisions, environment drills, and held-surface activation remain outside code
authority.

## Corrected finding matrix

Status vocabulary:

- `MERGED`: fixed on the residual-review base before this PR.
- `PR-FIXED`: represented by code and regression evidence in the consolidated
  residual PR; not considered merged until the PR lands.
- `CONTAINED / HELD`: the unsafe surface is unreachable or fail-closed, but its
  production activation design is not complete.
- `OPERATOR`: live state or external authority is required; code cannot close it.

| ID | State on `831dbc86c` | Consolidated residual disposition | Remaining condition |
| --- | --- | --- | --- |
| AUG11-C1 | `MERGED / OPERATOR` | Production seed paths now fail closed; no additional code change here. | Inspect live identities and migration logs, disable any synthetic accounts, revoke sessions, and rotate exposed credentials. |
| AUG11-H1 | `MERGED / OPERATOR` | Owner-only migration direction is represented in code. | Prove the live runtime role is NOCREATE and that all workers boot after owner PreSync at the exact migration tip. |
| AUG11-H2 | `MERGED` | Purpose-specific patient search authorization, minimization, and audit paths are present. | Preserve the policy/route regression gates. |
| AUG11-H3 | `MERGED` | Patient-owned specialty resources resolve patient context and enforce the care-team decision. | Care-team enforce-mode activation remains separately governed. |
| AUG11-H4 | `MERGED` | Authenticated profile completion is wired and covered. | None in this audit. |
| AUG11-H5 | `MERGED` | Source contracts, per-stream durable receipts, retry honesty, and ingestion idempotency landed in the prior train. | Monitor real-device replay before broad rollout. |
| AUG11-H6 | `MERGED` | Code Blue uses the FCM token contract and authenticated-session provider lifecycle. | Physical terminated-device notification drill remains operator-owned. |
| AUG11-H7 | `MERGED` | Staff blood-bank DTO/backend contract and patient selection were aligned. | None in this audit. |
| AUG11-H8 | `MERGED` | Authenticated-session reset clears/cancels account-owned providers and caches. | Retain the account-A/logout/account-B regression matrix. |
| AUG11-H9 | `MERGED` | Alert acknowledgement is server-result-authoritative and retryable. | None in this audit. |
| AUG11-H10 | `OPEN` | `PR-FIXED`: `/messaging/send` and `/broadcast` require idempotency; optional notification failure cannot overturn a committed message. | Merge only after protected CI; retain commit-then-notify fault coverage. |
| AUG11-H11 | `OPEN` | `PR-FIXED`: all live I01/I02/I09/FHIR callers use one fenced enqueue/process operation; exact retries take over stale leases and active leases return an explicit conflict. | Operate backlog-age/lease alerts before external-interface activation. |
| AUG11-H12 | `MERGED` | Static-before-parameter reachability was corrected and guarded. | Continue the repository-wide route-order guard. |
| AUG11-H13 | `CONTAINED / HELD` | No activation change. Placeholder/held images continue to prevent accidental delivery. | Approved signed digests and activation receipts are required. |
| AUG11-H14 | `PARTIAL` | `PR-FIXED`: canonical backend response work already existed; this PR adds explicit worklist, turnaround, detail, accession, and mutation failure states. | Add browser-to-database pathology fault injection as a release hardening item. |
| AUG11-M1 | `MERGED` | Device inventory fails loudly on arbitrary database errors. | None in this audit. |
| AUG11-M2 | `MERGED` | Audit/system log reads and exports preserve failure rather than authoritative empty success. | None in this audit. |
| AUG11-M3 | `OPEN` | `PR-FIXED`: the broken daily reminder and standalone duplicate script are deleted; the result-gated hourly engine is authoritative. | Monitor hourly delivery receipts and idempotency. |
| AUG11-M4 | `OPEN` | `PR-FIXED`: payroll crons default off, use strict tenant fan-out and explicit tenant writes; migration 664 adds composite tenant keys/FKs and aborts on mismatches. | Two-tenant operational enablement and payroll-owner approval are required before setting the flag true. |
| AUG11-M5 | `OPEN` | `PR-FIXED`: secure walk checkpoints survive lifecycle loss; start resumes an active backend session; duplicate stop cannot award points twice. | Add physical process-kill/device exercise before rewards expansion. |
| AUG11-M6 | `OPEN` | `PR-FIXED`: cached phone and Firebase identity are not backend route authority; splash/biometric resume require a JWT-shaped token. | Preserve stale-phone/access/refresh matrix coverage. |
| AUG11-M7 | `OPEN` | `PR-FIXED`: Firebase login uses `VHHttpClient` unauthenticated mode with App Check and shared transport controls. | App Check enforcement remains a separately staged backend rollout. |
| AUG11-M8 | `MERGED` | Lock-screen copy is privacy-minimized and sensitive detail is deferred to authenticated UI. | Verify device-level notification presentation in UAT. |
| AUG11-M9 | `MERGED` | Realtime notification ownership and unread-state wiring landed in the prior train. | Retain reconnect/logout regression coverage. |
| AUG11-M10 | `HELD` | `CONTAINED / HELD`: Staff Web exits to a non-clinical activation-hold app before auth, reconciliation, storage, or offline startup. | Implement an approved HttpOnly/BFF or equivalent ephemeral browser-session design before activation. |
| AUG11-M11 | `HELD` | `CONTAINED / HELD`: the same early gate prevents unsupported native SQLite/offline durability claims on Web. | Implement approved IndexedDB durability or explicitly ship Web without offline capability. |
| AUG11-M12 | `HELD` | `CONTAINED / HELD`: zero enrollments are not ready; unmatched legacy frames are rejected; production can never enable legacy mode through the environment flag. | Require at least one approved enrollment; if legacy is ever approved, add global source/cardinality/dead-letter quotas and a flood soak first. |

## New gaps and debt discovered during the residual pass

These are not hidden behind a green claim:

1. **Prisma generation is locally pathological.** `prisma validate` passes,
   and fresh migration application passes, but `prisma generate` consumed about
   5.4 GB and remained CPU-bound beyond a 15-minute local ceiling. Protected CI
   must complete this gate on the PR before merge. The payroll runtime no longer
   depends on a newly named generated compound selector.
2. **Admin lint debt is large.** The app has zero ESLint errors but 2,540
   repository-wide warnings under `--max-warnings=0`. The changed pathology code
   adds no new error, passes TypeScript, focused tests, and production build, but
   the warning baseline needs its own mechanical lane.
3. **Staff analyzer debt remains.** The PR-local Staff Web code is clean; the
   app-wide analyzer still exits nonzero on 17 pre-existing informational lints.
4. **Dependency upgrades are available.** Flutter reports 42 packages with
   newer versions outside current constraints. They should not be mixed into a
   clinical/tenant-correctness remediation PR.
5. **Forgejo is stale.** At reconciliation time, `github/main` is
   `831dbc86c...` while `origin/main` is still the original audit baseline
   `a64a5dd8...`. Synchronizing that remote is an owner-authorized publication
   action, not part of this GitHub PR.

## Verification on the residual branch

Completed locally on 2026-08-13:

- backend full lint/static/security guard suite: pass;
- fresh PostgreSQL test database: migrations `000` through `664` pass;
- external recovery, payroll, steps, and tenant-fanout deep suites: 62/62 pass;
- residual backend unit/contract suites: 28/28 pass;
- device gateway: 90/90 pass and lint pass;
- patient focused tests: 7/7 pass and `flutter analyze` clean;
- Staff Web hold tests: 2/2 pass;
- Admin pathology tests: 2/2 pass, TypeScript pass, production build pass with
  an explicit non-secret `NEXT_PUBLIC_ALLOWED_ORIGIN`;
- Prisma schema validation and fresh-database drift check: pass; and
- `git diff --check`: pass.

Evidence limitations:

- local `prisma generate` exceeded 15 minutes as described above;
- Staff app-wide analysis remains nonzero only on the 17 pre-existing infos;
- Admin app-wide zero-warning lint remains nonzero only on the 2,540 existing
  warnings; and
- protected GitHub CI is required on the eventual immutable PR head.

## Corrected rating

The scores are engineering judgments, not certifications. They describe the
repository and checked-in delivery posture, not a deployed hospital.

| Area | Original audit | Base before residual PR | Residual PR candidate | Rationale |
| --- | ---: | ---: | ---: | --- |
| Clinical/product breadth | 8.5 | 8.7 | 8.7 | The platform is unusually broad; activation proof, not feature count, is the constraint. |
| Security and tenant design | 6.0 | 8.2 | 8.6 | Prior trust fixes are substantial; messaging, recovery, browser and gateway boundaries are now tighter. |
| Data/workflow correctness | 5.0 | 7.4 | 8.4 | Payroll tenant integrity, walk recovery, durable recovery takeover, and reminder de-duplication close real loss/corruption paths. |
| Client/backend contracts | 4.5 | 7.8 | 8.6 | Patient auth bootstrap/session authority and Admin failure semantics are wired and tested. |
| Operations/deployment | 3.5 | 6.2 | 6.5 | Stronger fail-closed gates exist, but live roles, images, retention, drills, and remote parity remain open. |
| Maintainability | 5.5 | 7.1 | 7.5 | Duplicate reminder code is removed and invariants are centralized; the monorepo and lint debt remain large. |
| Test/CI posture | 7.0 | 8.7 | 8.8 | Deep local coverage is strong; protected CI and expensive Prisma generation still matter. |
| **Overall monorepo** | **5.7** | **7.4** | **8.1/10** | Strong architecture and breadth, with the known residual code gaps closed or explicitly held rather than declared complete. |
| **Production readiness** | **3.0** | **6.2 — HOLD** | **6.5/10 — HOLD** | Credible release-candidate code is not the same as operator evidence or activation authority. |

## Upgrade path

### Gate 0 — merge truthfully

1. Land this residual scope as one reviewed PR only after protected CI passes on
   its immutable head.
2. Do not mark the audit complete while any `OPERATOR` or `HELD` condition is
   presented as satisfied by code.
3. Restore Forgejo parity through the repository owner's publication process.

### Gate 1 — close live consequences

1. Inspect/disable synthetic identities and revoke/rotate affected credentials.
2. Prove owner PreSync plus NOCREATE runtime-worker startup at the exact tip.
3. Decide migration-660 retention under approved change control.
4. Approve signed images, backups/PITR, alert delivery/deadman, clinical UAT,
   and applicable ABDM/DPDP/CERT-In evidence.

### Gate 2 — activate held surfaces deliberately

1. Staff Web: approved browser-session architecture, explicit offline design,
   XSS/storage/logout tests, signed image, and manual activation.
2. Device gateway: approved enrollments, strict ingress, backend identity proof,
   global spool/dead-letter limits if legacy is retained, and a soak test.
3. Multi-tenant payroll: two-tenant dry run, owner sign-off, alerting, and only
   then enable `ENABLE_AUTOMATED_PAYROLL_CRONS`.

### Gate 3 — reduce structural debt

1. Bring Admin and Staff lint baselines to zero without mixing mechanical edits
   into clinical behavior PRs.
2. Profile and fix Prisma generation memory/time before the next schema-growth
   wave.
3. Upgrade one ecosystem at a time: Node/Prisma/PostgreSQL tooling, Admin/Next,
   Flutter/Dart/plugins, then infrastructure controllers. Pin, regenerate,
   canary outside PHI, and retain rollback digests for every lane.

## Definition of done

A code finding is closed only when its invariant is represented by regression
evidence, focused and protected gates pass, and the change is merged. A live
consequence is closed only with its operator receipt. A held capability is not
production-ready merely because it now fails closed.
