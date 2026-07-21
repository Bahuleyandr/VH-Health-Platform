# Unified Care Pathways S1b-c1 Exclusive Owner Routing — Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-21-unified-care-pathways-s1b-c1-exclusive-owner-routing-design.md`
**Base:** `0c731510b1470f93b6f278f9eb42431ed383cce9`
**Branch:** `feat/care-pathways-s1b-c1-owner-routing`
**Stacked PR base:** `feat/care-pathways-s1b-execution-spine` until the parent PR merges
**Migration:** `585_care_pathway_exclusive_owner_integrity.sql`

## Scope guard

Land one additive pre-activation ownership-integrity sub-slice. This is S1b-c1, **not the completion of
S1b-c**. Do not edit frozen migrations 580–584; seed or activate a pathway definition; register a
clinical handler; change projector generation; add a scheduler; flip a tenant; add notifications,
reminders or patient projection; implement per-rule breach reconciliation; invent a clinical timing,
recipient, threshold or visibility policy; or change Stroke/STEMI/cath/OBGyn behavior.

Implement D10's exclusive routing prerequisite: named owner means one eligible UID and no role; unnamed
queue means one route-capable role and no UID. A supplied but unavailable named owner fails closed and
never falls back. Preserve separately verified administrator, patient break-glass and registered trusted
workflow authority without turning them into assignment fallback. Do not add a covering-clinician claim
or transfer endpoint in this sub-slice; that later command must record explicit acceptance and immutable
audit evidence before live reassignment is possible. Do not claim database-current authorization for an
unnamed role queue: its executor path still relies on authenticated JWT role claims, so a compare-and-set
queue claim/current-role revalidation operation remains mandatory before activation. Keep production
`active` execution rejected.

Named pathway clinicians and unnamed dispatch queues are different policies. For this dormant slice,
restrict named eligibility to human roles already classified `group='clinical'` by the canonical role
policy graph; route/admin access alone never qualifies a named owner and this slice must not reclassify a
role. A role outside that existing clinical classification requires explicit owner/governance approval
before it can become a named pathway owner. Queue roles remain stage/rule-specific and may be broader.

Preserve that full canonical clinical named-owner set at the HTTP boundary. Union it with the legacy staff
audience for the dedicated care-pathway and clinical-inbox mounts only; do not intersect it with the
legacy set and do not widen generic clinical mounts. Route admission is not PHI authority: add one exact
existing-instance `care_pathway_owner` patient-access relationship, never a body/start-derived ownership
shortcut. The relationship must remain tenant-, instance-, patient-, actor- and current-role-bound and
must produce its own durable audited access source.

## Task 1 — Pin RED ownership tests and frozen-parent evidence

Files:

- modify `apps/backend/src/tests/unit/workflowHumanOwnerService.test.js`
- modify `apps/backend/src/tests/unit/taskService.test.js`
- modify `apps/backend/src/tests/unit/pathwayRuntimePersistence.test.js`
- modify `apps/backend/src/tests/unit/pathwayExecutorService.test.js`
- extend the relevant pathway deep/conformance tests

Steps:

1. Re-derive migration tail and confirm 585 is free.
2. Record the exact parent SHA and verify migrations 580–584 have no working-tree diff.
3. Add failing tests for UID-plus-role, invalid UID plus valid role, named-task role masking, pathway
   task/SLA dual materialisation and the weak start-owner predicate.
4. Add positive controls for valid UID-only and unnamed role-only assignments.
5. Keep RED-to-GREEN commands and outcomes for the stacked PR evidence; never weaken an assertion to
   accept a generic 500 or a dual-owner result.

## Task 2 — Add the strict pathway owner resolver

Files:

- modify `apps/backend/src/services/workflow/workflowHumanOwnerService.js`
- modify `apps/backend/src/tests/unit/workflowHumanOwnerService.test.js`

Steps:

1. Add transaction-only `resolvePathwayTaskOwnerTx` using the separate canonical named-clinician and
   queue-route policies.
2. For a supplied UID, require same tenant, `is_active=TRUE`, normalized active status, non-deleted
   state, non-patient role and the canonical named-clinician classification under `FOR SHARE`.
3. Return UID-only on success; return one non-enumerating typed conflict on any named-owner failure.
4. Evaluate role-only routing only when no UID was supplied; reject an absent or non-route-capable role.
5. Keep named-clinician and queue-role policies separate in application and SQL parity tests. Do not
   promote platform admin, records, admissions or other route-only roles into clinical accountability.
6. Strengthen the shared named-user lookup without changing the existing critical-result producer's
   legacy fallback and repair contract.
7. Prove blank, malformed, cross-tenant, inactive, deleted, patient and non-clinical named users never
   fall through to the role branch.

## Task 3 — Make shared task routing exclusive

Files:

- modify `apps/backend/src/services/workflow/taskService.js`
- modify `apps/backend/src/tests/unit/taskService.test.js`
- extend acknowledgement deep tests where their authority predicates are pinned

Steps:

1. Reject simultaneous UID and role assignment at task creation before SQL executes.
2. Treat reassignment as an atomic replacement: write the selected UID or role and clear the opposite
   column in the same UPDATE, then validate the complete resulting assignment.
3. Permit assignment-based role acknowledgement only when the current task UID is null, in both the
   resolver and the state-changing CAS predicate.
4. Restrict inbox role matching to `assigned_to_uid IS NULL`; named tasks remain visible to their exact
   assignee only.
5. Preserve administrator, exact patient break-glass and resource-bound trusted-workflow branches and
   their audit fields. Do not add a new text-reason override or implicit transfer.
6. Prove named UID authority, role-only authority, non-owner/non-role denial, role-mask denial,
   idempotent acknowledgement and existing cold-chain/critical-result regressions.

## Task 4 — Resolve pathway ownership once per transaction

Files:

- modify `apps/backend/src/services/pathways/pathwayRuntimePersistence.js`
- modify `apps/backend/src/services/pathways/pathwayExecutorService.js`
- modify the corresponding unit tests
- extend `apps/backend/src/tests/pathway-executor.deep.test.js`

Steps:

1. Replace the same-tenant/non-patient start check with the full current named-owner eligibility
   predicate, using the canonical clinical-accountability policy rather than queue route access.
2. Before task/SLA materialisation, resolve exactly one assignment. A named instance writes task UID
   only and an empty SLA role array; an unnamed instance writes task role only and a null SLA user UID.
   For an unnamed instance, that one task/SLA role must equal the resolved stage/accountable queue role;
   a merely route-capable alternative is not equivalent.
3. Roll the entire executor command back if owner resolution or either materialisation write fails.
4. In pathway command authorization, short-circuit on a named instance owner: only that UID or the
   existing sealed system actor may act. Do not aggregate instance, step, task or approval roles as
   fallback when a named owner exists.
5. Retain the existing authenticated-role authorization only for a genuinely unnamed role-queue
   instance, and pin its lack of database-current actor-role revalidation as an activation blocker.
6. Add no queue-claim/reassignment route and no automatic repair-to-role behavior.

## Task 5 — Integrate dedicated route access and exact owner PHI authority

Files:

- modify `apps/backend/src/config/rolePolicyGraph.js`
- modify `apps/backend/src/config/routeRolePolicy.js`
- modify `apps/backend/src/app.js`
- modify `apps/backend/src/services/security/accessPolicyRegistry.js`
- modify `apps/backend/src/services/security/accessDecisionService.js`
- modify `apps/backend/src/tests/unit/rolePolicyGraph.test.js`
- modify `apps/backend/src/tests/unit/routeRolePolicy.test.js`
- modify `apps/backend/src/tests/unit/accessPolicyRegistry.test.js`
- modify `apps/backend/src/tests/unit/accessDecisionService.test.js`
- modify `apps/backend/src/tests/unit/carePathwayRoutes.test.js`

Steps:

1. Export the complete canonical `group === 'clinical'` named-clinician role set. Do not derive it by
   intersecting with `CLINICAL_STAFF_ROUTE_ROLES` and do not promote legacy operational/admin roles into
   named clinical accountability.
2. Define dedicated care-pathway and clinical-inbox audiences as the union of the legacy staff audience
   and that full canonical set. Apply them only to `/api/v1/care-pathways` and
   `/api/v1/clinical-inbox`; assert that generic clinical mounts remain unchanged.
3. Add `care_pathway_owner` only to `PATIENT_CLINICAL_WORKFLOW_ACCESS` and
   `PATIENT_CLINICAL_WORKFLOW_WRITE`. Resolve it only for an existing `care_pathway_instance` whose exact
   tenant, instance ID, patient UID and `owning_clinician_uid` match the authenticated request.
4. Require the owning user to remain same-tenant, active, non-deleted, in active status, currently in the
   full clinical group, and to have a database role equal to the authenticated actor role.
5. Evaluate the relationship after PHI-rank and break-glass handling but before generic capability
   denial. An exact match is a direct relationship allow whose only bypass is the otherwise-applicable
   generic capability denial; it never bypasses insufficient PHI rank or break-glass rules.
6. Do not let pathway start, a request body/query owner or a prospective resource ID establish the
   relationship. Preserve the start route's existing patient relationship/capability guard and the
   transaction-time owner validator.
7. Audit successful access with `access_source='care_pathway_owner'` and the exact
   `care_pathway_instance_id` in metadata. Extend migration 585 and post-585 readiness to prove the source
   is admitted by `patient_access_audit_log_access_source_check`.
8. Prove exact read/write owner success; unchanged break-glass precedence; cross-instance, cross-tenant,
   cross-patient, stale DB-role/JWT-role, inactive/deleted and non-clinical denial; body/start spoof denial;
   exact audit provenance; full route-union parity; and unchanged generic mounts.
9. Keep the role-only queue branch on its existing JWT role contract and keep its missing compare-and-set
   claim/database-current-role revalidation as an explicit activation blocker.

## Task 6 — Add migration 585 and Prisma parity

Files:

- add `apps/backend/src/migrations/585_care_pathway_exclusive_owner_integrity.sql`
- verify `apps/backend/prisma/schema.prisma` terminal-schema parity; modify only for an introspectable
  schema delta
- modify `apps/backend/src/tests/unit/tasksWorkflowMigration.test.js`
- extend `apps/backend/src/tests/care-pathway-schema-conformance.deep.test.js`

Steps:

1. Add a fail-closed, aggregate, non-PHI preflight. Do not update, detach, delete or synthesize an owner
   to make it pass.
2. Cover every actionable pathway human task, including no-SLA tasks, and every actionable recognized
   typed human-SLA obligation. Leave generic tasks and immutable terminal receipts outside the new
   current-routing predicate.
3. Enforce exactly one valid routing shape: eligible UID-only or route-capable role-only.
4. Enforce exact owner agreement for **pathway** task/SLA pairs. UID mode requires equal task/SLA UIDs
   and zero SLA roles. Queue mode requires null task/SLA UIDs and one SLA role exactly equal to the
   task's resolved stage role; extra pathway roles are rejected.
5. Preserve rule-specific compatibility for recognized non-pathway typed rails: cold-chain may keep its
   multiple SLA alert roles while the task has one primary route. The critical-result producer must pass
   an explicit empty SLA owner declaration on start and clear legacy SLA owners on re-arm so its
   exclusively assigned task remains authoritative rather than inheriting migration-269's generic rule
   audience; mortuary legacy rows may also retain an empty declaration. Their actionable tasks still
   require one viable exclusive owner; do not claim full D10 convergence for these SLA shapes.
6. Enforce named pathway-instance source binding so its current human task is UID-only for the same
   user; an unnamed instance may use a role queue.
7. Supersede the migration-580 owner viability/dependency predicate for this scope. Reject user
   deactivation, deletion or route-role change that would strand an obligation, while permitting a
   valid same-transaction reassignment.
8. Replace `fk_care_pathway_instances_owner_tenant` with a deferrable `ON DELETE NO ACTION` form so a
   user delete cannot silently null a named instance owner.
9. Install the migration-585 owner predicates/assertions and deferred task, SLA, instance and user
   dependency triggers named by the design; do not patch them into migration 580.
10. Add `care_pathway_step_owner_dependency_constraint` plus deferred
    `trg_workflow_steps_exclusive_live_owner_update` and
    `trg_workflow_steps_exclusive_live_owner_delete` so an assigned-role change or step deletion cannot
    invalidate a live role-owned pathway task/SLA unless the same transaction leaves a valid graph.
11. Preflight and replace `patient_access_audit_log_access_source_check`, preserving every existing
    source and adding only `care_pathway_owner`; lock `patient_access_audit_log` with the other five
    owner-integrity tables and document the all-six-table maintenance fence.
12. Set bounded transaction-local lock and statement timeouts before the migration's six-table
    `ACCESS EXCLUSIVE` lock set so contention aborts the whole migration instead of waiting indefinitely.
13. Preserve tenant-qualified integrity, the existing one-way task/SLA lock direction and all
    migration-580 lifecycle/receipt constraints. Add concurrency tests that never accept `40P01`.
14. Apply 585 after a fresh 580–584 tail and verify Prisma validate/generate plus schema drift. Confirm
    580–584 remain byte-untouched.

Database permission for a same-transaction reassignment is not proof of covering-clinician acceptance.
No live service may use that path until a later executor-owned command supplies the required immutable
acceptance evidence.

## Task 7 — Make readiness and seeds tell the truth

Files:

- add `apps/backend/scripts/audit-care-pathway-owner-routing-readiness.mjs`
- add `apps/backend/src/tests/unit/carePathwayOwnerRoutingReadinessAudit.test.js`
- modify `apps/backend/package.json`
- modify `apps/backend/scripts/seed-comprehensive-test-data.mjs`
- add `apps/backend/src/tests/unit/carePathwaySeedOwnership.test.js`

Steps:

1. Keep `audit-care-pathway-spine-readiness.mjs` and its migration-580 test byte-untouched; it must remain
   valid as pre-580 evidence.
2. Add the separate post-584 owner-routing audit and package command
   `care-pathways:audit-owner-routing-readiness`.
3. Require coherent migration-tracker/schema state and report the supported pre-585 or post-585
   `schema_mode` before evaluating ownership.
4. Add the seven bounded non-PHI tenant blocker classes: dual owner, missing owner, invalid pathway
   named owner, invalid recognized typed-SLA owner, pathway-source mismatch, task/SLA mismatch and live
   instance invalid. Apply exact singleton equality to pathway SLA rows and the existing rule-specific
   compatibility predicate to recognized non-pathway typed rails. Branch by presence of UID: UID present
   requires an eligible UID and null role; role viability is considered only when UID is absent.
5. Preserve acknowledged repeatable-read/read-only primary enforcement and blocked exit behavior. Expose
   `tracker_coherent`, `owner_routing_ready` and an unconditional
   `care_pathway_production_activation_ready=false`.
6. In post-585 mode, prove `patient_access_audit_log_access_source_check` admits
   `care_pathway_owner`; treat an absent or incoherent source contract as blocked.
7. Change actionable named-pathway and current critical-result seed tasks to UID-only; use role-only only
   where no individual is named. Retain or add an isolated legacy dual-assigned **terminal receipt**
   positive control so migration 585 proves historical evidence is accepted without rewrite.
8. Run the new readiness command twice on clean seeded data in its applicable schema mode and prove each
   blocker class plus tracker/schema mismatch on controlled bad data. Do not call the result activation
   evidence.

## Task 8 — Regression and full gates

1. Run focused owner-helper, task-service, runtime-persistence and executor unit suites.
2. Run real-PostgreSQL migration/schema conformance, pathway executor, pathway transition evidence and
   the separate owner-routing readiness suite.
3. Prove start, ordinary-command and registered-domain-evidence replay all authorize the locked current
   named owner before returning the prior PHI snapshot; former/reassigned or unavailable owners are
   denied, sealed systems still require owner viability, and successful replay performs no mode,
   compile, effect or mutation work. Keep the role-only JWT-current-role gap explicit.
4. Run the dedicated route-audience and patient-access suites. Prove the full canonical clinical union,
   unchanged generic mounts, exact existing-instance read/write ownership, authorization ordering,
   cross-instance/tenant/patient and stale-role denials, start/body spoof denial, and exact audit source
   plus instance metadata.
5. Re-run the authoritative acknowledgement deep suites plus critical-result, cold-chain and mortuary
   regressions because shared task authorization changed.
6. Run touched-file ESLint, raw-parameter and PHI/static checks, Prisma validate/generate, migration and
   schema-drift gates, and `git diff --check`.
7. Run the repository's proportional/backend sharded gate.
8. Obtain independent integration and security review; resolve every P0/P1/P2 finding.
9. Confirm no active definition, production handler, scheduler, tenant flip, notification or policy
   value entered the diff.

## Task 9 — Publish as a stacked draft without activation

1. Confirm the worktree contains only S1b-c1 changes and migrations 580–584 are untouched.
2. Commit intentionally and push `feat/care-pathways-s1b-c1-owner-routing`.
3. Open one **draft** PR based on `feat/care-pathways-s1b-execution-spine`, clearly marked as stacked on
   its parent PR and as only the exclusive-routing prerequisite—not all S1b-c.
4. Include grounding SHA, D10 boundary, migration/readiness evidence, RED-to-GREEN results, explicit
   non-activation scope and remaining accepted-reassignment/S1b-c work.
5. Wait for authoritative hosted checks and address actionable failures.
6. Do not mark ready, merge, retarget, deploy or flip a tenant without separate authorization. After the
   parent merges, rebase or retarget onto current main and repeat the affected gates before review.

## Future deployment gate (not executed by this plan)

1. Deploy the backward-compatible exclusive-owner writer build so old dual-shape writers can be drained,
   but keep every pathway off and forbid named-owner route traffic throughout this bounded pre-585
   window.
2. Establish an exact version fence and drain every API, scheduler and worker writer for `users`,
   `workflow_steps`, `workflow_sla_instances`, `care_pathway_instances`, `tasks` and
   `patient_access_audit_log`; mixed writers are forbidden and all six tables must be quiescent for the
   migration lock set.
3. Run the owner-routing audit in coherent pre-585 mode and reconcile every blocker from authoritative
   evidence.
4. With bounded lock/statement timeouts, apply 585 in the maintenance window. A lock timeout aborts the
   entire transaction.
5. Run the audit in coherent post-585 mode, prove `care_pathway_owner` is admitted by the audit-log CHECK,
   and run the focused conformance gates.
6. Resume writers and the dedicated named-owner routes only on the exact reviewed exclusive-owner build.
   This sequence requires separate deploy authorization and is not performed by the stacked PR.

An unexpected exact-owner request during the forbidden pre-585 window cannot insert the new
`care_pathway_owner` value through the old audit-log CHECK. The existing durable file fallback records
that audit failure, but this degraded trace is not an acceptable steady state and does not permit route
traffic before migration 585.

## Exit evidence

- Migrations 580–584 have no diff; 585 is next and applies cleanly after them.
- Every scoped actionable human task is UID-only with an eligible named owner or role-only with a
  route-capable queue; pathway-linked SLAs agree exactly and recognized non-pathway typed SLAs satisfy
  their rule-specific compatibility contract.
- Named pathway eligibility uses the existing canonical human-clinical classification, separate from the
  broader queue route set; no route-only admin/operational role is silently reclassified.
- The dedicated care-pathway and clinical-inbox audiences union the legacy staff audience with every
  canonical clinical named-owner role; generic clinical mounts remain unchanged.
- Exact existing-instance patient-access read/write authority requires matching tenant, instance, patient,
  owning UID and active current clinical database role. It runs after PHI-rank/break-glass handling and
  before generic capability denial; start/body ownership cannot establish access.
- Cross-instance, cross-tenant, cross-patient and stale-role attempts deny, and allowed access records
  `care_pathway_owner` plus exact instance metadata. Migration 585 and post-585 readiness prove that audit
  source before routes resume.
- Pathway queue task/SLA pairs have exactly one identical resolved stage role and no extra fallback
  roles; recognized non-pathway typed rails retain their documented compatibility shapes and remain
  broader convergence work.
- A named pathway task cannot be listed, acknowledged or commanded through role membership.
- A bad named UID cannot be masked by a valid role in runtime, database or readiness evidence.
- Start, ordinary-command and registered-domain-evidence replay revalidate the locked current named owner
  and actor before returning a prior PHI snapshot; former/reassigned or unavailable owners are denied,
  sealed systems require owner viability, and authorized replay performs no mode/compile/effect/mutation
  work. Role-only replay retains the explicit JWT-current-role/queue-claim activation blocker.
- User lifecycle and concurrent reassignment tests preserve one valid owner without `40P01`.
- The separate owner-routing audit proves coherent pre/post-585 tracker/schema state, emits only bounded
  non-PHI blocker evidence, proves the post-585 owner audit source, and always reports
  `care_pathway_production_activation_ready=false`; the migration-580 readiness audit is unchanged.
- Generic unassigned tasks, terminal receipts and existing audited override rails remain valid.
- No silent owner fallback, automatic transfer, new clinical policy or active pathway behavior exists.
- The missing role-queue compare-and-set claim/current-database-role revalidation operation remains an
  explicit pre-activation blocker rather than a claimed S1b-c1 capability.
- Focused and authoritative gates are green, with no unresolved P0/P1/P2 review finding.
- The PR remains a stacked draft and production `active` remains fail-closed.
