# Go-Live Readiness Gap Matrix

Snapshot: `github/main` `9e70d950d` on 2026-09-03. Earlier snapshots the same
day: `61e7dcf7a`, and `a4ffe9860` on 2026-09-02.

Status: **STOP / evidence reconciliation only.** This document describes the
current repository evidence and the owner decisions still required. It does not
authorize a release, tag, publication, secret operation, ArgoCD sync, migration,
deployment, or production change. Re-anchor every row to the exact proposed
release SHA before an activation review.

## Unsupported readiness claims corrected by this reconciliation

| Document claim | Why it was unsupported | Correct posture |
|---|---|---|
| `GO_LIVE_ACTIVATION_CHECKLIST.md` described all in-control code as complete and green and treated the remainder as operator-only. | The production app tree still contains zero-digest and admin-CIDR fail-closed placeholders; payroll-754 acceptance is blank; inventory readiness migration 756 is absent; migration-753 design questions remain open; and no live G1/DR/RLS evidence is attached. | The checklist now starts from STOP and requires exact release, owner, migration, and live-system receipts. |
| `GO_LIVE_ACTIVATION_CHECKLIST.md` said to pause and later resume ArgoCD auto-sync. | The four production Applications are manual-sync. A merge or poll may make them `OutOfSync`, but must not apply or prune production state. | Keep manual sync. An authorized operator reviews and syncs each exact revision explicitly. |
| `GO_LIVE_CRITICAL_PATH.md` said everything substantial was code-complete and merged and marked multiple steps `code-complete`. | Current repository and live evidence contain the holds listed below; PR #872 is still draft/HELD. | The critical path is an index of open evidence gates, not a completion declaration. |
| `RELEASE_READINESS.md` called the local runner canonical and GitHub-hosted minutes optional. | The current audit-program authority requires GitHub Actions as the sole test/CI execution environment, and the repository's protected merge boundary is the GitHub `Merge Gate` plus final `Full Merge Gate`. | Local commands are developer diagnostics only; release evidence must come from the exact GitHub release commit after authority is cleared. |
| `FIRST_TRIAL_DEPLOYMENT_READINESS.md` deferred Prometheus, Grafana, Loki, Tempo, and Alloy while saying the trial could proceed. | That profile can describe only the sanitized Dalekdefender engineering trial. It cannot satisfy production G1 or a real-PHI pilot gate. | Keep the engineering trial non-production and separately complete G1 before production pilot approval. |
| `GO_LIVE_RUNBOOK.md` assumed the code was already deployed and its Phase 1 evidence gate merely asserted alert routing was healthy. | Deployment, receiver ownership, secrets, sync, delivery, acknowledgement, resolution, off-site Watchdog, and rollback evidence are all external facts not proven by repository state. | The runbook now begins held and contains explicit migration and Alertmanager ceremonies with OWNER-INPUT blanks and stop lines. |
| `apps/backend/docs/DB-MIGRATION-PLAN.md` allowed direct apply/forced sync, described auto-sync, and promised a generic sub-ten-minute rollback by repointing one Secret. | Production is manual-sync; the canonical PreSync Job uses the complete backend Secret and tracker-driven raw migrations; forward schema/data changes are not undone by image or DSN rollback; partially applied work may require restore-to-new-cluster or additive fix-forward. | The migration runbook now sequences evidence capture, exact Job observation, hard stops, and the real rollback limits. |
| `DEPLOYMENT_GUIDE.md` treated every Application as expected to be Synced, described live PostgreSQL/backup state as qualified, and used `HIPAA-ready` language based on repository controls. | Manual-sync Applications may be intentionally held; repository manifests cannot prove live database/backup posture or regulatory compliance; legacy-host shutdown is destructive and lacked an explicit authority blank. | The guide now starts held, scopes sync checks to approved revisions, requires decommission authority, and labels compliance controls as requiring live qualification. |
| `GO_LIVE_CRITICAL_PATH.md` called the inactive Vault path code-complete, and `GO_LIVE_ACTIVATION_CHECKLIST.md` called the drug-knowledge interfaces ready for a licensed feed. | Repository configuration/interfaces do not prove live Vault qualification or feed procurement, source rights, compatibility, clinical acceptance, import, or activation. | Both are now described as repository preparation with explicit owner and live-evidence gates. |

## Current no-go evidence

| Gate | Repository evidence | Required closure |
|---|---|---|
| Release authority | PR #872, `INF-006`, was live-checked on 2026-09-02 as `OPEN`, `DRAFT`, merge state `DIRTY`, with the title and body explicitly saying `HELD` and `DO NOT MERGE` until the external containment ceremony is complete. | OWNER-INPUT — named release authority and retained containment receipt. A code review or green check does not substitute. |
| App image authority | `infra/kubernetes/apps/kustomization.yaml:55-61` pins all three production app images to all-zero digests. | Authorized signed release evidence and immutable digest pins after release authority clears. |
| Admin reachability | `infra/kubernetes/apps/kustomization.yaml:77-118` leaves both backend and admin `ADMIN_IP_ALLOWLIST` values empty and fail-closed. | OWNER-INPUT — reviewed hospital management CIDRs and rendered-manifest evidence. |
| Payroll migration 754 | `infra/kubernetes/apps/kustomization.yaml:77-89` leaves both acceptance values empty; `apps/backend/scripts/payroll-revision-754-preflight.mjs:249-277` fails closed on a non-empty legacy manifest without exact hash and named owner. | OWNER-INPUT — mode-0600 manifest receipt, exact hash, named payroll data owner, and protected acceptance change. |
| Inventory migration 753 | `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql` contains 82 `NOT VALID` occurrences and zero `VALIDATE CONSTRAINT`; at `:6287-6289` it defers validation to migration 756. As of main `61e7dcf7a` no `756_*` migration exists. The `755_*` slot is **no longer free**: `755_clinical_import_receipt_and_history_immutability.sql` landed in the 2026-09-03 wave and is unrelated clinical-import DDL carrying zero `VALIDATE CONSTRAINT` and zero `NOT VALID` — it is **not** a 753 readiness migration, so any forward readiness migration must take `763_*` or higher. No migration anywhere on main validates a migration-753 constraint: the only `VALIDATE CONSTRAINT` statements after 753 are `754_salary_revision_tenant_reconciliation.sql:1190,1224` (payroll) and `762_ledger_tenant_lineage_constraints.sql:142,145,148,151` (money ledger). | Additive readiness migration, zero-open or named accepted-exception receipt, and proof every applicable constraint is `convalidated=true`. Engineering must not invent the exception authority. |
| Migration design disposition | The two questions below remain unresolved. | OWNER-INPUT — explicit disposition. Any correction must be additive; migration 753 is immutable. |
| Alertmanager activation | Only `alertmanager-secrets.sealed-secret.yaml.example` exists; the real ciphertext resource is absent from `base/monitoring/kustomization.yaml`. Repository validation proves template/routing structure only. | Owner recipient map and credentials; private config validation; ciphertext-only SealedSecret; kustomization inclusion; explicit platform/monitoring sync; live delivery, acknowledgement, resolution, Watchdog, rollback, and off-site evidence. |
| Live operational proof | This repository contains no completed release-specific G1, restore, RLS, Kyverno-Enforce, load, clinical UAT, or production owner receipt. | Named owners execute the applicable runbooks against the exact target environment and retain redacted evidence outside the monitored site. |

## Migration-753 owner decisions

These are design questions, not accepted defects and not activation authority.
Lane D does not choose either disposition and does not edit migration 753.

### OPEN-QUESTION 753-D1 — Cath usage obligation model

The migration-753 contract returns early only for governed terminal
`not_applicable` rows (`apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:4371-4422`).
Every other usage must have a `cath_inventory_shortfall_v1` task,
`cath_consumable_inventory_reconciliation` SLA, and
`cath_inventory_shortfall` outbox record (`:4523-4569`), including an eventual
fully decremented usage (`:4653-4665`). The service currently materializes that
shortfall workflow for the initial clinical capture
(`apps/backend/src/services/clinical/cathLabService.js:4439-4448`) and later
lets a pharmacy operator complete it (`:3980-4045`).

OWNER-INPUT — choose and document one policy:

- ______ Every Cath consumable use intentionally enters a pharmacy
  reconciliation/shortfall task even when exact stock is available; retain the
  current mandatory obligation and approve its workflow/capacity semantics.
- ______ Ordinary exact-stock use is not a shortfall; separate routine
  reconciliation from actual shortfall through a new additive migration and
  corresponding service/evidence changes.

Until the owner decides and the selected path has independent verification,
inventory activation remains stopped.

### OPEN-QUESTION 753-D2 — malformed JSON scalar policy

Migration 753 calls `jsonb_array_elements(COALESCE(lines,'[]'))`
(`apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:2089-2120`).
Migration 757 intentionally normalizes only JSON `null` and explicitly leaves
all other non-array scalars to raise SQLSTATE `22023`
(`apps/backend/src/migrations/757_pharmacy_clinical_projection_json_null.sql:25-36,44-76`).
Because this projection participates in the pharmacy patient-safety update
trigger, a malformed legacy scalar can block an otherwise unrelated row update.

OWNER-INPUT — choose and document one policy:

- ______ Treat every non-array, non-null scalar as corrupt data that must block
  mutation; provide a pre-activation inventory/recovery worklist and prove zero
  unresolved rows before activation.
- ______ Normalize or explicitly reject malformed shapes at a narrower write
  boundary through a new additive migration/service change, preserving the
  safety-version fence without making unrelated lifecycle transitions
  unrecoverable.

Do not alter migrations 753 or 757 in place. Any selected correction requires a
new migration number and a separately reviewed operational recovery plan.
