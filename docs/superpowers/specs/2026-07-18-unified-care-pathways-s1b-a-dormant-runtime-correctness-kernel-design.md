# Unified Care Pathways S1b-a: Dormant Runtime Correctness Kernel

**Status:** Approved for implementation

**Grounding revision:** `28470875658ededcde79bdd757ba0dbf5c3777de` (`2026-07-18T23:06:12+05:30`)

**Migration reservation:** `579_workflow_runtime_hardening.sql`
**Program authority:** `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md`

## 1. Outcome

S1b-a turns the dormant migration-118 workflow scaffold into a fail-closed correctness kernel. It
adds no clinical pathway definition, projector handler, automatic advancement, task, approval,
notification, patient projection or activation. The only pathway-specific runtime added here is a
read-only mode resolver whose safe answer is `off`.

This is deliberately not a complete pathway runtime. It establishes the transaction, tenancy,
definition and compare-and-set boundaries that the later deterministic executor can safely call.

## 2. Owner decisions now in force

- **D2:** `automation_rules` remains dormant and non-authoritative. Only registered, code-reviewed
  handlers may trigger pathway behavior.
- **D8:** Stroke and STEMI retain their domain-owned clocks. STEMI remains unchanged; Stroke ledger
  hardening is a separate scoped workstream.
- **D9:** OBGyn follows rails-first integration. OBGyn consumes the shared reminder/SLA/handoff rails;
  ANC and immunisation do not create a second pathway engine.

These decisions unblock the generic kernel but do not approve any pathway-specific clinical values,
closure semantics or patient-visibility policy.

## 3. Verified defects at the grounding revision

- Definitions are arbitrary JSON and default active
  (`apps/backend/src/migrations/118_tasks_workflow_foundation.sql:40-55`,
  `apps/backend/src/services/workflow/taskService.js:1094-1126`).
- Run creation and step materialisation are separate autocommit writes; malformed steps are skipped
  and duplicate keys are swallowed (`taskService.js:1175-1239`).
- Run and step transitions are blind enum-only updates (`taskService.js:1277-1368`).
- Generic task transitions read then update without a status predicate (`taskService.js:395-433`).
- Approval decisions read then update without row locking, caller-role authorization or a status CAS
  (`taskService.js:1422-1474`).
- The ADMIN route still trusts body actors for task creation and approval decisions
  (`apps/backend/src/routes/admin/tasksWorkflowRoutes.js:48-70,314-323`).
- The workflow foreign keys do not prove that linked rows belong to the same tenant
  (`118_tasks_workflow_foundation.sql:68-72,103-106,139-143,214-218`).
- No repository caller executes definitions beyond the ADMIN CRUD surface, and no workflow definition
  is seeded by the repository.

## 4. Scope

### 4.1 Migration 579

Migration 579 must:

1. fail closed if existing definition/run/step/task/approval links cross tenant boundaries;
2. add the composite uniqueness needed for tenant-qualified foreign keys;
3. add tenant-qualified foreign keys across definition to run, run to step, run/step to task and
   run/task to approval while preserving the existing delete semantics;
4. change only the **default for newly inserted** `workflow_definitions.is_active` rows to `false`;
   existing rows are not rewritten;
5. remain transactional and idempotent under the repository migration runner.

No new clinical table lands in this slice. The four care-pathway companion tables wait for S1b-b,
when their state/evidence services can land in the same change.

Migration 579 proves tenant ownership of each workflow link; it does not yet prove same-run graph
coherence when both optional links are present. Before executor or materialisation activation, S1b-b
must preflight and reject a task whose `workflow_run_id` differs from its workflow step's run, and an
approval whose `workflow_run_id` differs from its linked task's run, then enforce those invariants in
the service and database with real-database conformance cases.

### 4.2 Definition contract

Add a pure definition-contract module. Creation and start both validate the stored definition so a
legacy malformed row cannot bypass the new create-time check.

The contract requires:

- `steps` is an array containing at least one plain object;
- every step has a non-empty canonical key and a database-supported step kind;
- step keys are unique within a definition;
- optional display name, role, due time and metadata have the expected primitive/object shape;
- executable condition/action identifiers, if present in the accepted contract, must exist in an
  immutable in-code registry; stored JavaScript, expressions and arbitrary handler names are rejected;
- malformed, duplicate or unsupported steps fail the entire operation; nothing is silently skipped.

New definitions are inactive. S1b-a does not add an activation endpoint. An attempt to create an
active definition is rejected until S1b-b supplies approved governance and immutable publication.

### 4.3 Atomic start

`startWorkflowRun` becomes one `setTenantTx` operation:

1. load the tenant-owned definition inside the transaction;
2. require it to be active;
3. validate the complete stored definition;
4. insert the run;
5. insert every step;
6. return only after all rows commit.

Any lookup, validation or insert failure rolls back the run and every step. Duplicate step errors are
never swallowed. This function remains reachable only from the existing ADMIN router in S1b-a.

Because no definition can be newly activated in this slice and no repository definition is seeded,
the start path is correctness infrastructure, not newly enabled clinical behavior.

### 4.4 Legal transitions and concurrency

Define explicit legal transition maps for workflow runs and workflow steps. Existing task transitions
continue to use their map. Each mutation must perform a tenant-qualified compare-and-set whose `WHERE`
clause includes the expected current status. A missing row and a lost race are distinguished without
revealing another tenant's row.

- Terminal run and step states cannot return to active states.
- Exactly one concurrent transition from the same state wins.
- Task transition uses the same compare-and-set rule, removing its read/update race.
- A terminal task transition and its already-existing linked-SLA completion commit in the same tenant
  transaction for both supplied-transaction and standalone callers; a failed SLA write rolls the task
  transition back.
- Approval decisions execute in a tenant transaction, lock the approval row, require `pending`, verify
  the server-derived caller against the required role where one exists, serialize quorum updates and
  make the terminal decision immutable.
- The generic runtime refuses approval kinds owned by a dedicated domain workflow on both create and
  decide. `credential_privilege_grant` remains exclusively owned by credentialing's two-person,
  atomic activation service. A pending approval whose database-derived `expires_at <= NOW()` is
  rejected before mutation.

No new generic SLA behavior is introduced here. S1b-a only makes the existing linked-SLA completion
atomic; typed per-task acknowledgement-versus-work-completion semantics land with S1b-b.

### 4.5 Actor provenance

Actors come only from authenticated server context:

- task creation uses `req.user.uid`, never `body.created_by`;
- approval decisions use `req.user.uid`, never `body.approver_uid`;
- run, step and task ADMIN routes pass `actorUid` from the authenticated caller. Run/step mutations
  require it because the ADMIN route is their only production caller. The generic task service keeps
  its trusted in-process system-caller path for the live escalation, cold-chain and results-inbox
  producers; those callers cannot be broken before durable user/system transition provenance exists.

S1b-a does not add transition evidence storage, so actor input is validated and carried through the
user-facing service boundary in preparation for S1b-b. It must not be falsely claimed as durable audit
history yet. S1b-b makes explicit user-or-registered-system provenance mandatory when it appends the
transition event.
The already-shipped clinical-inbox acknowledgement authorization and transactional SLA/comment
behavior must remain unchanged.

### 4.6 Default-off pathway mode

Add `services/pathways/pathwayMode.js` with:

- the six canonical program pathway keys;
- modes `off`, `shadow`, `active`;
- `resolvePathwayMode(tenantId, pathwayKey)` reading only
  `tenants.settings.care_pathways[pathwayKey]` through the existing tenant service;
- `off` for a missing tenant row, missing/malformed setting, unknown value or lookup failure;
- `requireTenantId` failure for absent tenant context;
- no environment-wide active fallback.

This resolver is read-only and has no caller that mutates clinical state in S1b-a. Later flip tooling
must preserve sibling settings with atomic `jsonb_set`/CAS and account for the tenant service's
per-process 60-second cache; `updateTenant` is not a safe fleet-wide pathway flip.

## 5. Explicitly deferred

- deterministic executor advancement/dispatch;
- pathway instances, transition evidence, handoffs and definition governance tables/services;
- projector handlers and event-to-pathway projection;
- task/approval materialisation and typed task-to-SLA semantics;
- same-run graph-coherence preflight and enforcement for task/run/step and approval/run/task links;
- per-rule SLA breach reconciliation;
- pathway routes, patient access guard, PHI logging and patient projection;
- conditional exception branches, child fan-out and domain-evidence handlers;
- duplicate pathway episode guard and start idempotency key;
- reconciliation evidence writer/scheduler/activation script;
- event-outbox lease, stale-processing reaper and audited redrive bundle.

The last item is a separate live-pipeline hardening change: a bare `failed -> pending` endpoint is
explicitly prohibited.

## 6. Verification contract

Unit tests prove definition validation, route actor provenance, transition maps and mode fail-closed
behavior. Real PostgreSQL conformance tests prove:

- migration preflight rejects cross-tenant links;
- same-tenant foreign keys accept valid links and reject mismatched tenants;
- an induced step-materialisation failure leaves zero run/step rows;
- inactive and malformed definitions cannot start;
- concurrent run, step and task transitions have exactly one winner; approval contributions serialize,
  and only one conflicting terminal approval decision wins;
- terminal states are immutable;
- approval quorum is serialized and required-role authorization is enforced;
- tenant isolation and generic not-found behavior;
- new definitions default inactive;
- the existing acknowledgement authorization/deep suites remain green.

Required gates are focused unit/deep tests, backend lint for touched files, Prisma validate/generate,
schema drift, raw-parameter checks, `git diff --check`, then the repository's authoritative sharded
backend gate in CI. No deployment belongs to this slice.

## 7. Exit condition

S1b-a is complete only when the dormant workflow scaffold is structurally tenant-safe, definitions
fail closed, start is all-or-nothing, concurrent state changes are CAS-safe, actors cannot be supplied
by the request body, and all pathway modes still resolve to `off` unless an existing tenant setting
explicitly says otherwise. Completion of S1b-a does **not** mean a unified care pathway is active.
