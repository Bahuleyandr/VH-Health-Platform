# Unified Care Pathways S1b-c1 — Exclusive Owner Routing Design

**Status:** implementation design; stacked on the dormant S1b-b execution-spine branch
**Grounding revision:** `0c731510b1470f93b6f278f9eb42431ed383cce9`
(`2026-07-21T03:42:03+05:30`)
**Branch:** `feat/care-pathways-s1b-c1-owner-routing`
**Migration reservation:** `585_care_pathway_exclusive_owner_integrity.sql`
**Program authority:** `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md`

## 1. Outcome and safety boundary

S1b-c1 closes the D10 ownership-masking defect before any pathway can activate. A pathway human-work
assignment has exactly one routing mode: one currently eligible named clinician **or** one route-capable
role queue. A role can no longer hide an inactive, deleted, clinically ineligible or otherwise unavailable
named owner, and membership in a fallback role cannot authorize work that has a named owner.

“Unavailable” in this slice is an account-integrity term: missing/cross-tenant identity, inactive account
or status, deleted identity, or ineligible current role. Roster coverage, on-leave state, specialty,
privilege, shift and physical availability remain pathway-specific owner/governance policy; S1b-c1 neither
infers nor claims them.

Every role already classified `group === 'clinical'` by the canonical role-policy graph remains eligible
to be a named pathway clinician. S1b-c1 makes those clinicians reachable through the dedicated
care-pathway and clinical-inbox mounts, then authorizes PHI only through an exact existing-instance owner
relationship. It does not narrow named-owner eligibility to the legacy staff-route set, widen generic
clinical mounts, or allow request data to manufacture an owner relationship.

This is a **stacked prerequisite sub-slice, not all of S1b-c**. It adds no pathway definition, registered
clinical handler, projector generation, scheduler, tenant setting change, activation capability,
notification, reminder, patient projection, clinical timing, escalation recipient or patient-visibility
policy. Production `active` execution remains fail-closed. The rest of S1b-c still owns the registered
reconciliation framework, per-rule breach reconciliation, evidence-versioned sweeps and metrics,
recovery workbench, allowlisted atomic domain-write capabilities and evidence-gated activation path.

Migrations 580–584 and their recorded evidence are frozen. S1b-c1 must not edit, rehash or restate their
bytes as new evidence. Migration 585 is an additive post-584 integrity layer with its own preflight and
conformance evidence.

## 2. D10 contract and this slice's coverage

D10, owner-approved on 2026-07-21, has these normative rules:

1. When a pathway or human task names an individual, that person is the exclusive owner. The identity
   must be in the same tenant, active, not deleted, non-patient and currently route-capable for pathway
   clinical work.
2. A role queue is legal only when no individual has been named. A role is dispatch, not a second owner
   and not a fallback hidden behind a UID.
3. If a named owner becomes unavailable, responsibility does not move automatically to a role or another
   clinician. An eligible covering clinician must explicitly accept an audited reassignment.
4. The source that supplies the initial named doctor is pathway-specific: pending inpatient results use
   the recorded primary/attending physician, Diagnostics uses the ordering physician, and Referral stays
   with the referring physician until the named receiver accepts.

S1b-c1 implements the structural and authorization prerequisites in rules 1–3: exclusive storage,
current-owner validation, no silent fallback and no role-based masking. It deliberately does **not** add
the covering-clinician acceptance command or the pathway-specific source resolvers. Until S2–S4 add those
flows, an unavailable named owner fails closed and appears in migration/readiness evidence; it is never
silently repaired. The absence of a transfer command is safe because no production definition or
production-active pathway exists.

The durable migration scope is pathway-linked human work plus the recognized typed human obligations
already governed by migration 580. Shared task creation prevents a dual UID/role shape for every new
task, but S1b-c1 does not classify every arbitrary generic non-pathway task as D10 clinical
accountability or retrofit active/clinical eligibility to all historical generic tasks. Any broader
generic clinical-task classification remains explicit follow-up work; the program-level D10 rule is not
narrowed by this bounded migration scope.

Role-only queues receive structural exclusivity in this slice, but not a claim protocol: executor command
authorization still consumes the authenticated JWT role set instead of reloading the caller's current
role from the database. A compare-and-set queue claim/current-role revalidation operation remains a
mandatory pre-activation follow-up and must not be inferred from a clean S1b-c1 report.

Separate task-administrator, exact patient break-glass and registered-system authority may remain only
where an existing route already verifies and audits it. Those capabilities are not assignment fallback,
do not make a role co-own a named task and do not transfer clinical responsibility.

## 3. Verified baseline gap

The following are repository facts at the grounding revision; line numbers are evidence anchors for this
design, not permanent identifiers.

- Pathway start validates a named owner only as a same-tenant non-`PATIENT` user. It does not require
  `is_active`, current active status, non-deleted state or a route-capable role
  (`apps/backend/src/services/pathways/pathwayRuntimePersistence.js:59-123`).
- The executor gives the same human stage both routing forms. Its SLA receives
  `assignedUserUid=owning_clinician_uid` and a non-empty role-code array, and its task receives both
  `assignedToUid` and `assignedToRole`
  (`apps/backend/src/services/pathways/pathwayExecutorService.js:1092-1111,1122-1159`).
- Pathway command authorization is UID **or** any gathered instance, step, task or approval role, so a
  role holder can act for an instance that names someone else
  (`pathwayExecutorService.js:622-648`).
- The shared `CLINICAL_STAFF_ROUTE_ROLES` policy is a dispatch surface, not a named-clinician
  accountability policy: `getRolesForCapabilityGroups` includes platform admins by default, and the
  route set also includes non-clinical operational roles. Reusing it unchanged permits an ADMIN,
  SUPER_ADMIN, MEDICAL_RECORDS or ADMISSION_OFFICER identity to satisfy the named-clinician check
  (`apps/backend/src/config/routeRolePolicy.js:72-83`;
  `apps/backend/src/config/rolePolicyGraph.js:1245-1283`).
- Both dedicated pathway surfaces are mounted with that legacy staff audience. It omits some canonical
  `group === 'clinical'` roles, so an otherwise eligible named clinician can be rejected before route or
  patient-access authorization runs (`apps/backend/src/app.js:959-960`). The audience must be a union,
  not an intersection and not a replacement of the legacy staff audience.
- The clinical-workflow patient-access policies have only the generic capability groups and no exact
  pathway-owner relationship. A canonical named clinician outside those groups therefore cannot access
  their own existing instance, while trusting only the instance ID or request body would create a PHI
  authorization hole (`apps/backend/src/services/security/accessPolicyRegistry.js:173-188`;
  `apps/backend/src/services/security/accessDecisionService.js:1308-1320`).
- JWT actor construction does not reload the user's current status and role for each pathway command, so
  an unnamed role queue still needs a database-current role check or claim operation before activation
  (`apps/backend/src/middleware/jwtMiddleware.js:91-287`).
- Generic task creation and reassignment accept both assignment fields without enforcing exclusivity
  (`apps/backend/src/services/workflow/taskService.js:620-810,2317-2365`). Direct acknowledgement and
  inbox listing also use UID-or-role authorization, including the role branch when a UID is present
  (`taskService.js:1560-1574,1683-1720,2271-2303`).
- Migration 580's opening preflight and durable human-obligation validator accept a viable UID **or** a
  route-capable role. The role branch therefore masks an invalid UID
  (`apps/backend/src/migrations/580_care_pathway_execution_spine.sql:181-216,5960-5978`). Its user
  dependency trigger protects only the weaker predicate (`:6047-6114`).
- The migration-580 read-only readiness audit repeats the same OR predicate, so it can report a dual or invalid-named
  assignment as healthy when the role is viable
  (`apps/backend/scripts/audit-care-pathway-spine-readiness.mjs:250-287`).
- The existing clinical-result owner helper returns one routing form, but when a requested clinician is
  unavailable it silently falls back to a role or `DUTY_DOCTOR`; its repair helper can automatically
  move an actionable critical-result task (`apps/backend/src/services/workflow/workflowHumanOwnerService.js:31-87,90-142`).
  That legacy producer behavior is not the D10 pathway contract and must not be reused for pathway
  ownership transfer.
- Comprehensive seed data contains dual-assigned pathway and critical-result task shapes, so test data
  would otherwise preserve the masking defect
  (`apps/backend/scripts/seed-comprehensive-test-data.mjs:1353-1365,1734-1769`).

These are dormant-spine defects, not evidence of a currently active pathway: S1b-b registers no active
production definition or clinical handler, and production `active` execution remains rejected.

## 4. Implementation contract

### 4.1 One owner resolver and one canonical shape

Add a pathway-specific transaction-only owner resolver backed by two deliberately separate canonical
policies:

- **Named pathway clinician:** use the canonical role-policy graph's existing `group === 'clinical'`
  classification. This conservative fail-closed set does not reclassify any role. Platform
  administration, records, admissions and other support/operational identities remain ineligible even if
  their routes can dispatch work; expanding the named-owner set requires explicit governance approval.
  Route access alone is never proof of named clinical accountability.
- **Unnamed queue:** use the broader pathway task route policy because queues may dispatch clinical or
  operational stage work. Queue membership does not make a role eligible as a named clinician.

The resolver then applies these branches:

- **UID supplied:** lock and resolve the exact tenant user. Require `is_active=TRUE`, normalized
  `status='active'`, `is_deleted=FALSE`, `deleted_at IS NULL`, role other than `PATIENT`, and the named
  pathway-clinician predicate. Return `{ assignedToUid: uid,
  assignedToRole: null }`. Missing, blank, malformed, cross-tenant, inactive, deleted, patient or
  clinically ineligible identities fail with the same typed unavailable-owner conflict. The resolver must not
  disclose which eligibility check failed to an untrusted caller.
- **No UID supplied:** require an explicit role satisfying the queue route-role policy and return
  `{ assignedToUid: null, assignedToRole: role }`. Missing or invalid roles fail closed.
- A supplied-but-invalid UID is never treated as “no UID,” and role fallback is never consulted in that
  branch.
- The application and migration named-clinician predicates are parity-tested separately from their queue
  predicates. Migration 585 may reuse migration-580's route predicate for queues and rule-specific typed
  obligations, but not as proof that a pathway instance's named person is a clinician.

The existing critical-result resolver remains a legacy rail for its existing producers. S1b-c1 may
strengthen its named-user lookup, but it must not silently change critical-result fallback/recovery
semantics or claim those flows now use D10 transfer acceptance.

### 4.2 Runtime and task authorization

Pathway start must validate the named instance owner with the complete eligibility predicate inside the
same tenant transaction that creates the run and instance. A named owner is revalidated again before
each executor command. Human task/SLA materialisation resolves one assignment once and writes that same
decision everywhere:

- a named instance owner produces a UID-only task and a UID-only SLA assignment with an empty role-code
  array;
- an unnamed instance produces a role-only task and role-only SLA assignment with a null user UID;
- the role-only task and singleton SLA role must equal the resolved stage role
  (`step.assigned_role || instance.accountable_role`), not any other merely route-capable role;
- a named pathway instance cannot materialise a role-only task for its current human stage;
- inability to resolve the owner rolls back the entire command, including task, SLA, runtime and
  transition evidence.

For pathway commands, a named instance owner takes precedence: only that currently revalidated UID or a
sealed registered system actor may execute the command. Instance, step, task, approval or JWT role
membership cannot mask the named owner. Existing role-claim authorization remains available only for a
genuinely unnamed, role-queue instance; its lack of database-current actor-role revalidation is a recorded
activation blocker, not a completed D10 claim/acceptance flow.

At the shared task boundary:

- task creation rejects simultaneous UID and role assignment;
- reassignment is an atomic assignment replacement that writes the selected owner and clears the
  opposite field, then validates the final stored shape;
- assignment-based acknowledgement authorizes a role only when `assigned_to_uid IS NULL`;
- inbox role matching applies only to role-only tasks, so a named task does not leak into another
  clinician's role queue;
- existing administrator, exact break-glass and resource-bound trusted-workflow authorization remains
  separately verified and audited; none is converted into an assignment or ownership transfer.

S1b-c1 adds no claim, delegate or reassignment endpoint. It also adds no automatic “repair to duty role.”
The later acceptance flow must be executor-owned, compare-and-set, idempotent and append immutable
prior-owner/new-owner/reason/actor evidence in the same transaction before it can change pathway
responsibility.

### 4.3 Dedicated route audiences and existing-instance PHI authority

Route reachability and patient-level authorization are separate gates:

- `PATHWAY_NAMED_CLINICIAN_ROUTE_ROLES` is the complete canonical role-policy-graph set whose current
  `group === 'clinical'`; it is not an intersection with `CLINICAL_STAFF_ROUTE_ROLES`.
- `CARE_PATHWAY_ROUTE_ROLES` and `CLINICAL_INBOX_ROUTE_ROLES` each union that full named-clinician set
  with the legacy staff audience. Only the `/api/v1/care-pathways` and `/api/v1/clinical-inbox` mounts use
  the new audiences. Every generic clinical mount keeps its existing audience unchanged.
- Membership in a dedicated route audience only permits the request to reach route middleware. It does
  not itself authorize patient PHI, establish ownership, or make a role clinically accountable.

For `PATIENT_CLINICAL_WORKFLOW_ACCESS` and `PATIENT_CLINICAL_WORKFLOW_WRITE` only, add the
`care_pathway_owner` relationship. It may allow access only when all of these facts are proven from the
database for an already-created resource:

1. the resource type is exactly `care_pathway_instance` and the resource ID resolves to an existing
   instance;
2. the instance tenant equals the authenticated request tenant and its `patient_uid` equals the resolved
   patient;
3. `owning_clinician_uid` equals the authenticated actor UID; and
4. the owning `users` row is same-tenant, active, not deleted, has active status, and its current database
   role equals the authenticated actor role and remains in the full canonical clinical group.

Evaluate this relationship after existing role PHI-rank and break-glass handling but before generic
capability denial. An exact match is a direct relationship allow whose only bypass is the otherwise-
applicable generic capability denial; it cannot bypass an insufficient PHI rank or replace break-glass.
A cross-instance, cross-tenant, cross-patient, stale-role, inactive, deleted or non-clinical match denies
with the ordinary non-enumerating patient-access response.

Pathway start has no existing instance from which this relationship can be proven. A body/query
`owning_clinician_uid`, patient identifier or prospective resource ID must never establish access; the
existing start-route patient relationship/capability guard and the transaction-time owner validator remain
authoritative. Likewise, a body owner cannot grant access to a different existing instance.

Successful relationship access is audited as `access_source='care_pathway_owner'`, with the exact
`care_pathway_instance_id` in audit metadata. Migration 585 must admit that source through the existing
`patient_access_audit_log_access_source_check`, and the separate readiness command must prove the schema
supports it before routes resume. This does not add a new audit table or activate any pathway.

The role-only queue branch remains unchanged: it still relies on JWT/current-role claims and does not use
the named-owner relationship. Its compare-and-set claim/database-current-role blocker remains explicit.

### 4.4 Migration 585 — additive integrity

`585_care_pathway_exclusive_owner_integrity.sql` must begin with a fail-closed, non-PHI aggregate
preflight and perform no ownership repair or clinical backfill. Any blocked row requires reviewed
evidence-based reconciliation before retrying.

Its durable checks cover:

1. every actionable pathway human task, including a pathway task without an SLA;
2. every actionable recognized typed human-SLA obligation already governed by the migration-580
   contract;
3. exact task/SLA assignment agreement for pathway-linked work, plus rule-specific compatibility checks
   for the recognized non-pathway typed rails;
4. the pathway-instance source binding: a named instance owner requires a UID-only task for that same
   user; an unnamed instance may use only the exact resolved workflow-step/accountable role queue, and a
   later raw workflow-step role change/delete cannot invalidate that binding;
5. current named-user viability across update, role/status/deletion change and user deletion; and
6. the audit-log access-source constraint admits the exact `care_pathway_owner` source used by the
   existing-instance patient-access decision.

For this scope, valid ownership is exactly one of:

```text
named = UID present + role absent + current eligible tenant user
queue = UID absent + one route-capable role
```

Dual assignment, zero assignment, invalid named owner, named-source-to-role-only drift, invalid
rule-specific task/SLA compatibility and more than one actionable task for a human obligation are
blockers. A valid role queue does not require a currently staffed holder at schema-migration time;
current tenant staffing coverage is later activation evidence, not a durable row constraint.

Generic non-pathway tasks outside migration 580's recognized typed obligations and immutable terminal
receipts are outside this new clinical ownership predicate. A generic unassigned task remains legal, and
historical terminal evidence is never rewritten to satisfy a current routing rule. Existing migration-580
lifecycle, receipt, graph and task/SLA source constraints remain in force.

The user-dependency check must allow a valid same-transaction reassignment before a user is deactivated,
deleted or moved out of a route-capable role, while preventing the transaction from committing a stranded
actionable obligation. This database allowance is atomic integrity only; it is not proof that the future
covering clinician accepted. The application acceptance receipt remains required before any live pathway
uses such a transfer.

The migration's named integrity surface is:

- predicates `care_pathway_named_owner_is_viable`,
  `care_pathway_task_owner_is_exclusive_and_viable` and
  `care_pathway_task_sla_owner_agrees`;
- deferred assertions `care_pathway_assert_live_instance_owner` and
  `care_pathway_assert_actionable_task_owner`;
- constraint triggers `trg_tasks_exclusive_live_owner`,
  `trg_workflow_sla_exclusive_live_owner`,
  `trg_care_pathway_instances_exclusive_live_owner`,
  `trg_users_exclusive_live_owner_delete` and
  `trg_users_exclusive_live_owner_viability`, plus dependency function
  `care_pathway_step_owner_dependency_constraint` and its deferred
  `trg_workflow_steps_exclusive_live_owner_update` /
  `trg_workflow_steps_exclusive_live_owner_delete` triggers; and
- a deferrable `fk_care_pathway_instances_owner_tenant` with `ON DELETE NO ACTION`, replacing the
  migration-580 `ON DELETE SET NULL` behavior that could erase a named instance owner; and
- a preflighted replacement of `patient_access_audit_log_access_source_check` that preserves every
  existing source and adds only `care_pathway_owner`; and
- a scoped `CREATE OR REPLACE` of migration 580's
  `care_pathway_assert_human_sla_task_obligation`, so its already-installed deferred receipt triggers
  use the full clinical-accountability set for a governed pathway's named UID while retaining the
  narrower rule-specific policy for queues and non-pathway typed rails.

Every **pathway** SLA must carry an explicit owner shape. UID-owned pathway task/SLA pairs require the
same UID and zero SLA roles. Role-owned pathway pairs require a null SLA UID and a role array of
cardinality exactly one whose only normalized value equals the task's resolved stage queue role; extra
pathway SLA roles are forbidden fallback, not harmless metadata.

Do not force that new pathway shape onto the existing recognized non-pathway typed rails during this
compatibility slice. Cold-chain SLA alert routing intentionally may contain multiple roles while its task
has one primary role; its exact rule-specific compatibility predicate must preserve that behavior.
The critical-result compatibility producer deliberately keeps the SLA owner declaration empty, including
when it starts or re-arms a clock, so the exclusively assigned task remains the routing authority instead
of inheriting the generic migration-269 `DOCTOR`/`LAB_STAFF` rule audience. Mortuary legacy rows may also
retain an empty SLA owner declaration. Their actionable task must still have one viable exclusive owner,
but S1b-c1 does not call either non-pathway SLA shape full D10 convergence. Migration 585 adds the new
owner objects and supersedes the one migration-580 assertion in place; migration 580 itself remains
immutable.

No new table lands in this sub-slice. Existing tenant-qualified keys and Pattern-A RLS remain unchanged;
new helper functions/triggers must preserve tenant isolation, pinned search-path conventions where
privileged execution is required, and the existing non-locking task/SLA dependency direction so the
task↔SLA deadlock does not return.

### 4.5 Readiness and deterministic seed data

Do **not** extend or repurpose `audit-care-pathway-spine-readiness.mjs`. That report is migration-580
cutover evidence and must remain valid before 580 with its frozen semantics. Add a separate
`audit-care-pathway-owner-routing-readiness.mjs` command for the post-584 ownership boundary.

The new report must:

- run as an explicitly acknowledged repeatable-read, read-only primary scan;
- prove that migrations 580–584 and the repository migration tracker agree before it evaluates owner
  rows, and report whether it is running in the supported pre-585 or post-585 schema mode;
- mirror migration 585 with the seven bounded, non-PHI tenant issue classes
  `task_owner_dual_assignment`, `task_owner_missing_assignment`, `pathway_task_owner_invalid`,
  `human_sla_task_owner_invalid`, `pathway_task_owner_source_mismatch`,
  `task_sla_owner_mismatch` and `pathway_instance_owner_invalid`, applying the exact pathway or
  recognized rule-specific compatibility contract;
- evaluate exclusive branch precedence: when a UID is present, the UID must be eligible and the role
  must be null; role viability is considered only when the UID is absent;
- expose `schema_mode`, `tracker_coherent` and `owner_routing_ready` explicitly; and
- in post-585 mode, prove that `patient_access_audit_log` accepts the `care_pathway_owner` source required
  by the route/ABAC integration; and
- hard-code `care_pathway_production_activation_ready=false`, including when every ownership check is
  clean.

Expose it as package command `care-pathways:audit-owner-routing-readiness`. A tracker/schema mismatch or
any ownership finding exits blocked without altering owners. A clean result proves only compatibility
with S1b-c1 before 585, or continued conformance after 585; it is not a S1b-c reconciliation clean streak
and cannot authorize activation.

Update comprehensive seed rows to use UID-only named assignments or role-only queues. Do not seed an
active pathway definition, clinical handler, timing, recipient, notification policy or tenant activation.

## 5. Atomicity, concurrency and replay rules

- Owner eligibility is checked under a share lock in the same tenant transaction as pathway
  materialisation. A concurrent user deactivation/role change and pathway start cannot both commit an
  invalid named assignment.
- Pathway task and linked-SLA ownership are one decision, not two independent resolutions. Failure after
  either write rolls the full command back.
- Reassignment validates the final row under lock; concurrent UID-versus-role updates cannot combine into
  a dual assignment.
- A named task's authorization decision is rechecked by the state-changing compare-and-set predicate;
  changing a pre-read or JWT role cannot re-enable the masked role branch.
- Exact command replay retains the immutable committed snapshot and never re-resolves a different owner.
  A new owner requires the later typed acceptance command, not replay mutation.
- New dependency triggers preserve the established one-way lock order. Concurrency tests must reject an
  invalid commit without surfacing PostgreSQL `40P01` deadlocks.

## 6. Explicit non-goals

S1b-c1 does not deliver:

- the rest of S1b-c reconciliation registry, sweep scheduler, evidence table, metrics, clean-streak flip
  script, recovery workbench or allowlisted atomic domain-write capabilities;
- per-rule SLA breach reconciliation or any clock, grace period, business-hours or recipient value;
- a role-queue compare-and-set claim/current-database-role revalidation operation, or a
  covering-clinician acceptance/reassignment workflow;
- roster/on-leave, specialty, privilege, shift or physical-availability policy for a structurally valid
  named account;
- D3 inpatient primary-physician source resolution, D4/D5 Diagnostics result disposition, D6 Referral
  acceptance transfer or D7 surgical sign-in enforcement;
- any pathway definition, clinical handler, projector behavior, patient/staff UI, reminder,
  notification, patient acknowledgement meaning or external-provider communication policy;
- any widening of generic clinical route mounts, generic patient-access capability bypass, or
  start/body-derived pathway-owner access;
- any Stroke/STEMI/cath or OBGyn domain behavior;
- any tenant flip, activation, deployment or production data rewrite.

## 7. Rollout and rollback strategy

This branch is stacked on S1b-b and must remain independently reviewable. While the parent PR is open,
its PR base is the S1b-b feature branch; after the parent merges, rebase or retarget onto current main and
re-run every database gate. S1b-c1 must never merge ahead of migrations 580–584.

Before any future deployment:

1. run `care-pathways:audit-owner-routing-readiness` against the primary as the explicitly acknowledged
   privileged audit actor and require coherent post-584/pre-585 schema-tracker evidence;
2. reconcile every blocker from authoritative clinical evidence—never by deleting a task/SLA, clearing a
   named UID or manufacturing a role fallback;
3. deploy the backward-compatible exclusive-owner writer build so old dual-shape writers can be drained,
   but keep every pathway off and forbid named-owner route traffic throughout this bounded pre-585
   window;
4. establish a non-rolling version fence and drain every API replica, scheduler and worker that can write
   `users`, `workflow_steps`, `workflow_sla_instances`, `care_pathway_instances`, `tasks` or
   `patient_access_audit_log`; the old executor can write the dual shape that 585 rejects, and the audit
   table must be quiescent for its constraint replacement;
5. set bounded transaction-local lock and statement timeouts, then apply 585 only after the exact frozen
   580–584 tail is present. Migration 585 takes `ACCESS EXCLUSIVE` locks on those six tables; a timeout
   aborts the whole migration rather than waiting indefinitely;
6. repeat the owner-routing audit in coherent post-585 mode, prove that the new audit source is admitted,
   and run focused conformance checks before writers or named-owner routes resume; and
7. resume only the reviewed exclusive-owner writer build and dedicated route audiences; mixed old/new
   replicas are forbidden.

If an unexpected exact-owner request reaches the new build during the forbidden pre-585 window, its
`care_pathway_owner` audit INSERT cannot satisfy the old access-source CHECK. The existing durable file
fallback records the audit failure, but that degraded path is an emergency trace, not an acceptable
steady state or permission to serve named-owner traffic before 585.

No deployment occurs in this slice. If application code must be rolled back before 585 applies, no
database rollback is needed. After 585 applies, keep the integrity migration in place, leave every
pathway `off`, and roll only to code that writes the exclusive shape; dropping the constraint or restoring
silent fallback is not a safe rollback. A migration problem is handled by pausing affected writers and
shipping a reviewed forward correction. Because 585 performs no automatic ownership rewrite, it creates
no generated clinical ownership to undo.

## 8. Verification contract

Unit and real-PostgreSQL tests must prove:

- named UID-only and unnamed role-only success;
- dual and zero owner rejection in the scoped actionable contracts;
- supplied invalid/blank/cross-tenant/inactive/deleted/patient/non-clinical-accountability UID fails
  without role fallback;
- a valid role cannot mask a bad named UID;
- a named pathway instance cannot emit a role-only or differently named task;
- named pathway owners reject platform-admin/support/operational identities even when those identities
  belong to a route-capable queue; named-clinician and queue-role policy sets stay separately parity-tested;
- the dedicated care-pathway and clinical-inbox mount audiences each equal the union of the legacy staff
  audience and the full canonical `group === 'clinical'` set, while every generic clinical mount remains
  unchanged;
- both clinical-workflow read and write policies allow an exact current named owner of an existing
  tenant+instance+patient relationship only after PHI-rank/break-glass handling and before generic
  capability denial; break-glass precedence remains unchanged;
- cross-instance, cross-tenant, cross-patient, stale database-role/JWT-role, inactive, deleted and
  non-clinical owner candidates are denied without PHI enumeration;
- pathway start and existing-instance commands cannot derive owner access from a body/query owner,
  patient or resource identifier;
- an allowed exact-owner decision writes `access_source='care_pathway_owner'` and the exact
  `care_pathway_instance_id` in audit metadata, while migration 585 and post-585 readiness prove that
  source is supported;
- role-only **pathway** task/SLA assignments carry exactly one identical resolved stage role and reject
  extra fallback roles, while cold-chain/critical-result/mortuary compatibility fixtures retain their
  explicitly documented non-pathway SLA shapes;
- named tasks are absent from other role holders' inbox results and role membership cannot acknowledge or
  command them;
- role-only queues remain listable and actionable under the existing authenticated-role contract, while
  tests and readiness keep the missing database-current claim/revalidation flow visible as an activation
  blocker;
- all three idempotent replay branches—start, ordinary command and registered-domain-evidence—lock the
  current instance and revalidate the current named owner's eligibility plus actor authority **before**
  returning the prior PHI-bearing snapshot; a former/reassigned or unavailable named owner is denied,
  and sealed-system replay still requires the named owner to remain viable;
- an authorized replay returns only the immutable committed snapshot and performs no pathway-mode
  resolution, definition compilation, handler/effect execution or state mutation; role-only replay keeps
  the separately documented JWT-current-role/queue-claim activation gap;
- administrator, exact break-glass and trusted-workflow authorization regressions remain green without
  becoming assignment fallback;
- create and reassignment validate the final exclusive shape, including concurrent partial updates;
- user deactivation, deletion or route-role removal is rejected unless the transaction first leaves a
  valid assignment; no `40P01` appears;
- workflow-step assigned-role change or deletion cannot invalidate a live role-owned pathway task/SLA;
  a valid same-transaction graph update may commit, and no `40P01` appears;
- no-SLA pathway human tasks are covered while generic unassigned tasks and terminal receipts remain
  valid;
- the separate owner-routing readiness command reports every blocker class without PHI, blocks on
  tracker/schema disagreement, exits clean twice for conforming data and always reports production
  activation false; the frozen migration-580 readiness audit remains byte-untouched;
- live/actionable seed data carries no dual assignment, while an isolated legacy dual-assigned terminal
  receipt remains a positive control proving historical terminal evidence is accepted without rewrite;
- migrations 580–584 are byte-untouched, 585 applies after them on a fresh database, Prisma matches the
  terminal schema, and schema drift is clean;
- the existing pathway executor, task acknowledgement, critical-result, cold-chain, mortuary,
  migration-580 and full pathway conformance suites remain green.

Required gates are focused unit/deep tests, touched-file ESLint, raw-parameter and PHI/static checks,
Prisma validate/generate, migration/schema drift, `git diff --check`, then the authoritative sharded
backend CI. An independent integration and security review must report no unresolved P0/P1/P2 finding
before the stacked PR leaves draft.

## 9. Exit condition

S1b-c1 is complete only when a role can no longer mask a named pathway owner in storage, readiness,
inbox visibility, acknowledgement or executor authorization; every canonical named clinician can reach
the two dedicated mounts without widening generic clinical routes; exact existing-instance PHI access is
tenant-, patient-, owner- and current-role-bound and audited; every new actionable pathway human task and
its linked SLA, when present, share one exclusive owner decision; and unavailable named clinicians fail
closed without automatic transfer. Completion does **not** mean D10's accepted-reassignment workflow
exists, S1b-c is complete, the role-queue current-role/claim gap is closed, or any pathway is safe to
activate.
