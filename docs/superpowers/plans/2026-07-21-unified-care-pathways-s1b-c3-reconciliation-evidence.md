# Unified Care Pathways S1b-c3 Reconciliation and Activation Evidence — Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-21-unified-care-pathways-s1b-c3-reconciliation-evidence-design.md`
**Base:** `2acff17b662fa91e11ffa870e402e247c05db8a7`
**Intended branch:** `feat/care-pathways-s1b-c3-reconciliation-evidence`
**Migration:** `587_care_pathway_reconciliation_evidence.sql`
**Stack dependency:** S1b-c2 / migration 586

## Scope guard

Implement only the immutable reconciliation registry, transactional shadow observations, source-aware
opt-in SLA repair kernel, append-only evidence, explicit-threshold verdict command, bounded metrics and a
read-only admin evidence surface.

Keep every tenant/pathway setting unchanged and `off` by default. Keep the scheduler opt-in false, add no
production activation capability, pathway definition, clinical clock/threshold, escalation recipient,
notification, patient projection or deployment. The initial production registry must enumerate all six
canonical pathway keys but enable no live SLA repair descriptor until its exact source producer and owner
resolver have a separately reviewed registration. Do not touch Stroke/STEMI, OBGyn domain behavior,
S1b-r queue redrive or frozen migrations 578–586.

## Task 1 — Pin RED registry, evidence and mode tests

Files:

- add `apps/backend/src/tests/unit/pathwayReconciliationRegistry.test.js`
- add `apps/backend/src/tests/unit/pathwayReconciliationEvidence.test.js`
- add `apps/backend/src/tests/unit/pathwayReconciliationSchedulerWiring.test.js`

Steps:

1. Define the six-key exhaustive registry contract and prove missing keys, duplicate IDs, wildcard
   sources, unknown keys, unversioned handlers and unbranded registries are rejected.
2. Prove deterministic canonical manifests/checksums and immutability. Pin a required handler-version
   change whenever descriptor semantics change.
3. Define pass computation as a pure function: shadow mode, complete registry, nonzero fully covered
   governance set, expected equals executed and zero findings/repairs/errors.
4. Prove `off` is a no-op, `active` is a blocking fault, and no module can import/mint the executor's
   activation capability.
5. Add RED cases for checksum cohort changes, duplicate observations, sweep spacing and bounded
   PHI-free result shapes.

## Task 2 — Add migration 587 and Prisma parity

Files:

- add `apps/backend/src/migrations/587_care_pathway_reconciliation_evidence.sql`
- regenerate `apps/backend/prisma/schema.prisma`
- add `apps/backend/src/tests/care-pathway-reconciliation-migration-587.deep.test.js`
- extend migration ordering/frozen-hash and seed-completeness suites only where required

Steps:

1. Preflight the required tenant/composite-key and application-role contracts without rewriting clinical
   rows.
2. Create append-only `care_pathway_reconciliation_checks` with sweep identity, tenant/pathway/mode,
   registry and governance-set checksums, coverage/check counts, finding/repair/error counts, bounded
   result JSON and timestamps.
3. Add exact database pass constraints, unique sweep identity, latest/cohort indexes, composite tenant
   FK, application/sequence grants and Pattern-A RLS using both `USING` and `WITH CHECK`.
4. Add an update/delete rejection trigger. Do not add a retention exception, repair, backfill, seed,
   tenant-setting mutation or clinical timing value.
5. Apply through the QA migration runner, regenerate Prisma with `db pull`, and prove schema drift is
   zero. Existing migrations 578–586 must remain byte-for-byte unchanged.

## Task 3 — Build the complete immutable registry

Files:

- add `apps/backend/src/services/pathways/pathwayReconciliationRegistry.js`
- add `apps/backend/src/config/pathwayReconciliationConfig.js`
- add/extend registry unit and static-conformance tests
- modify `apps/backend/src/utils/validateEnv.js` only if new environment parsing requires validation

Steps:

1. Implement validated descriptors, WeakSet/provenance branding, deep freezing, exact lookups and a
   deterministic sorted manifest checksum.
2. Register all six pathway keys. Mark missing vertical domain adapters with an explicit blocking reason;
   never let an empty domain profile become clean.
3. Register shared structural checks once and require exact coverage of every current effective
   governance/definition tuple.
4. Define exact `(rule_code, source_table)` repair descriptors and explicit owner-authorized domain-clock
   exclusions. Add no wildcard, fallback or table-wide handler.
5. Ship the production registry with no live repair-enabled rule descriptor in this slice. Use a sealed
   test-only registry to prove repair mechanics without granting production authority.
6. Default `CARE_PATHWAY_RECONCILIATION_ENABLED` and any rule-repair gate to false. Do not add a production
   environment override in Kubernetes manifests.

## Task 4 — Implement transactional shadow observations

Files:

- add `apps/backend/src/services/pathways/pathwayReconciliationService.js`
- add `apps/backend/src/tests/unit/pathwayReconciliationService.test.js`
- add `apps/backend/src/tests/care-pathway-reconciliation.deep.test.js`

Steps:

1. Add `runCarePathwayReconciliationSweep({ now, registry })` and per-tenant/pathway execution under
   `setTenantTx` at serializable isolation.
2. Capture one database time and acquire a deterministic transaction advisory fence for each
   tenant/pathway. Treat contention as non-clean/skipped evidence, not success.
3. Resolve mode inside the transaction. Skip `off`; observe-only in `shadow`; block and emit
   `ACTIVE_WITHOUT_ACTIVATION_AUTHORITY` for `active`.
4. Compute the governance-set checksum from every currently startable approved tuple, not one latest
   definition. Require an exact registered domain match for every tuple.
5. Run each expected common/domain check exactly once and collect only stable codes and aggregate counts.
   Checks receive the tenant transaction and cannot open their own transaction or enqueue side effects.
6. Insert one evidence row in the same transaction. Evidence failure must roll back all state. After an
   aborted transaction, append only a sanitized non-pass technical-error row in a fresh tenant
   transaction.
7. Prove one bad tenant/pathway does not stop the remaining sweep and no patient/task/resource IDs,
   clinical text, SQL message or stack trace reaches evidence or logs.

## Task 5 — Implement the source-aware breach-repair kernel

Files:

- extend `apps/backend/src/services/pathways/pathwayReconciliationService.js`
- extend registry/service unit tests
- extend `apps/backend/src/tests/care-pathway-reconciliation.deep.test.js`

Steps:

1. Accept repair authority only from a branded descriptor matching the exact rule and source table.
2. Lock and revalidate the SLA plus source contract, then CAS only overdue `active`, incomplete rows to
   `breached` using the sweep's database time.
3. Require the source descriptor to resolve D10 ownership and call that domain's existing strict,
   transaction-aware task materializer. Never insert a generic task or silently choose DUTY fallback.
4. Make the SLA transition, task materialization and non-clean evidence one atomic transaction. A lost
   CAS re-reads state and cannot duplicate a task.
5. Treat unknown rules/sources, terminal/missing sources and owner mismatches as findings without
   mutation. Never mutate Stroke, STEMI, porter or pending-target clocks.
6. Prove repairs always set `repair_count>0` and `passed=false`; only a later unchanged zero-drift sweep
   may pass.
7. Keep every production repair descriptor disabled. A later vertical/domain PR must add the exact live
   handler, tests and registry-version bump.

## Task 6 — Wire the opt-in scheduler safely

Files:

- modify `apps/backend/src/utils/scheduler.js`
- extend `apps/backend/src/tests/unit/pathwayReconciliationSchedulerWiring.test.js`
- update `apps/backend/.env.example` only with disabled/documented configuration

Steps:

1. Register `care-pathway-reconciliation` under `withJobLock`; await the complete job and isolate
   per-tenant/pathway failures.
2. Require exact environment opt-in and preserve false as the default. Treat cadence as operational
   collection only, never a clinical or activation threshold.
3. Retain the inner transaction advisory fence because the cluster-level lock can fail open when its
   dedicated connection fails.
4. Prove concurrent scheduler invocations cannot create overlapping tenant/pathway observations or
   inflate a clean streak.
5. Do not modify tenant settings, pathway projector enablement or Kubernetes production configuration.

## Task 7 — Add the explicit-threshold read-only verdict command

Files:

- add `apps/backend/scripts/care-pathway-reconciliation-evidence.mjs`
- add a package script in `apps/backend/package.json`
- add `apps/backend/src/tests/unit/carePathwayReconciliationEvidenceScript.test.js`

Steps:

1. Require tenant ID, pathway key, minimum clean sweeps, minimum clean span, minimum sweep separation,
   maximum gap and maximum age. Supply no defaults.
2. Load the current branded registry checksum, current governance-set checksum and current mode without
   mutating any row.
3. Evaluate only the newest contiguous exact-checksum cohort. Deduplicate too-close observations, break
   on a failure/repair/error/incomplete row or excessive gap, and require fresh shadow evidence.
4. Recheck projector generation/backfill/dead/retired debt and fail closed on a missing registry or
   definition adapter.
5. Print bounded evidence IDs/checksums and exact failure codes. Exit zero only for
   `FLIP-READY FOR OWNER REVIEW`; otherwise exit nonzero.
6. Add static tests proving the command contains no settings write, SQL `UPDATE` or activation-capability
   import.

## Task 8 — Add bounded metrics and alerts

Files:

- modify `apps/backend/src/observability/reliabilityMetrics.js`
- extend `apps/backend/src/tests/unit/reliabilityMetrics.test.js`
- extend `apps/backend/src/tests/reliability-metrics.deep.test.js`
- modify `infra/kubernetes/base/monitoring/backend-reliability-alerts.yaml`
- update `docs/RUNBOOK_ONCALL.md`

Steps:

1. Add fixed `pathway_key` gauges for failing tenants, technical-error tenants, current findings/repairs,
   latest-compatible-evidence age and active-without-authority tenants.
2. Set all six label values on every collection, including zero. Never label by tenant, check, rule,
   source, patient or resource.
3. Alert on technical errors and active-without-authority. Surface projector dead/retired debt through
   the existing bounded projector series.
4. Export evidence age without inventing an alert threshold. Do not page on expected pre-pilot
   not-ready findings.
5. Document read-only diagnosis and typed escalation paths. Do not document raw SQL reset or bare queue
   redrive as recovery.

## Task 9 — Add the read-only admin workbench surface

Files:

- add `apps/backend/src/routes/admin/carePathwayReconciliationRoutes.js`
- modify `apps/backend/src/routes/admin/index.js`
- extend `apps/backend/scripts/openapi/schemas/carePathways.mjs`
- regenerate `apps/backend/src/docs/openapi.json` and synced core contract if required
- add `apps/backend/src/tests/unit/carePathwayReconciliationRoutes.test.js`

Steps:

1. Expose ADMIN/SUPER_ADMIN GET-only latest/history evidence under
   `/api/v1/admin/care-pathways/reconciliation`.
2. Tenant-scope ordinary admin reads; require explicit authorized cross-tenant context for SUPER_ADMIN.
3. Return only mode, checksums, stable codes, counts and timestamps. Do not return patient identifiers,
   clinical text, raw candidate rows or database errors.
4. Add pagination and bounded limits. Add no dismiss, pass, retry, redrive, reassign, SLA reset or mode
   change operation.
5. Prove authorization, tenant isolation, pagination and PHI-free response shape. Keep mutating recovery
   in separately reviewed typed domain/S1b-r slices.

## Task 10 — Run the full bounded-slice gate

Run focused tests first, then:

1. QA migration apply/re-run and migration 587 deep tests.
2. Prisma generate/validate and `npm --prefix apps/backend run check:schema-drift`.
3. `npm --prefix apps/backend run lint` and the raw-parameter/security static checks.
4. OpenAPI generation, drift and core-sync checks.
5. Registry, service, scheduler, CLI, route, metrics and cross-tenant deep suites.
6. All authoritative backend Jest shards, smokes, FHIR conformance and security scans.
7. Static assertions that production registry has no live repair-enabled descriptor, all modes remain
   unchanged, reconciliation defaults off and production activation capability remains absent.

Run independent schema/RLS, concurrency/atomicity, clinical-ownership and activation-safety reviews over
the final diff. Commit and push one bounded branch, open one PR, wait for required GitHub checks, and
merge only with the reviewed head SHA while deployment is disabled. Verify that no deployment ran, then
restore the deployment workflow and resync local `main`. Do not sync Forgejo or deploy.
