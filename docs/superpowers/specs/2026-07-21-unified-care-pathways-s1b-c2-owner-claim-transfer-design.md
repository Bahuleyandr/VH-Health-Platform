# Unified Care Pathways S1b-c2 — Owner Claim and Accepted Transfer Design

**Status:** implementation design
**Grounding revision:** `2acff17b662fa91e11ffa870e402e247c05db8a7`
(`2026-07-21T13:19:50+05:30`)
**Branch:** `feat/care-pathways-s1b-c2-owner-acceptance`
**Migration reservation:** `586_care_pathway_owner_acceptance.sql`
**Program authority:** `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md`
**Dependency:** S1b-c1 / migration 585

## 1. Outcome and safety boundary

S1b-c2 completes the pre-activation D10 ownership operation that S1b-c1 intentionally left absent.
There are two, and only two, ways for responsibility to become a named clinician after pathway start:

1. a member of an unnamed role queue explicitly claims the work for themself while their current database
   identity still holds that exact queue role; or
2. the exact clinician named in a covering-transfer request explicitly accepts it.

Both operations are tenant-scoped, compare-and-set, idempotent and atomic across the pathway instance,
every actionable pathway task, every linked live SLA and immutable canonical transition evidence. A role,
request, elapsed time, account lifecycle event, administrator action or text reason never transfers
clinical responsibility by itself.

This is still a dormant-spine safety slice. It creates no clinical pathway definition or handler, changes
no clinical timing or escalation recipient, flips no tenant mode, enables no production `active` pathway,
changes no patient visibility policy and deploys nothing. Stroke/STEMI remain authoritative and unchanged.

## 2. Verified baseline defects

Repository facts at the grounding revision:

- role-only pathway commands trust roles decoded from a JWT instead of reloading the actor's current user
  state (`apps/backend/src/services/pathways/pathwayExecutorService.js:655-686`;
  `apps/backend/src/middleware/jwtMiddleware.js:190-203,272-283`);
- the clinical inbox exposes role-queue tasks using those token roles
  (`apps/backend/src/services/workflow/taskService.js:2290-2308`), so a stale token can disclose queued PHI;
- role acknowledgement likewise selects authorization from token roles and its write predicate rechecks
  only the task assignment, not current user eligibility
  (`apps/backend/src/services/workflow/taskService.js:1573-1600,1698-1705`);
- a pathway queue claim cannot update only one task: migration 585 requires a named pathway's actionable
  tasks and SLAs to use that same exclusive UID (`apps/backend/src/migrations/585_care_pathway_exclusive_owner_integrity.sql:372-539,972-1099`);
- `care_handoff_instances` already has the request/recipient/status/timestamp/idempotency shape needed for
  an accepted transfer, and the immutable transition ledger already supports handoff evidence
  (`apps/backend/src/migrations/580_care_pathway_execution_spine.sql:4242-4550`);
- a proposed transfer recipient is not yet the pathway owner. Existing patient-access policy has no exact
  handoff-recipient relationship, so an acceptance route either fails closed or would have to over-broaden
  PHI access (`apps/backend/src/services/security/accessDecisionService.js:327-340,992-1038`).

## 3. Current-actor contract

All inbox reads, role acknowledgements, claims, transfer reads, requests, acceptances, declines and
cancellations use one
transaction-only current-actor resolver. It loads the same-tenant `users` row under a database lock and
requires `is_active=TRUE`, normalized `status='active'`, `is_deleted=FALSE`, `deleted_at IS NULL`, a
non-patient current role and presence of that exact current role in the authenticated role context.

The resolver returns the database role as evidence. It never treats a stale token role as current and
never reports which eligibility predicate failed on a PHI-bearing route. Named pathway claims and
transfer acceptances additionally require the current role to remain in the canonical clinical
accountability set. Queue claims require equality with the canonical queued role while also requiring
exact raw token-role parity with the current database row; ADMIN/SUPER_ADMIN,
break-glass or generic route access cannot claim clinical responsibility unless that actor's own current
database role is the exact eligible queue role.

Inbox listing joins through this current identity. A stale, inactive, deleted, cross-tenant or role-moved
actor receives an empty/denied result and no queued PHI. A named task remains visible only to its exact
assignee. A role task is visible only while the actor currently holds that exact role.

## 4. Role queue claims

### 4.1 Generic/typed inbox task

`POST /api/v1/clinical-inbox/tasks/:id/claim` requires `Idempotency-Key` and an authenticated user. In one
tenant transaction it:

1. locks the task without disclosing it;
2. rejects pathway-linked work so only the pathway executor can change whole-runtime ownership;
3. verifies that the task is actionable, role-only and that the actor currently holds that exact role;
4. compare-and-set updates `assigned_to_uid` to the actor and clears `assigned_to_role`;
5. if an incomplete linked SLA exists, compare-and-set updates it to that same UID and an empty role array;
6. appends one state-change comment with the prior role, claimant and idempotency receipt.

An exact retry by the winner returns the same claim. A different actor or changed assignment receives a
generic conflict/forbidden result without task PHI. Claim does not acknowledge or complete the task/SLA.
Role-based acknowledgement revalidates the same current actor and atomically records the caller as the
named assignee before changing acknowledgement state, preserving existing one-action clinical-inbox
behavior without leaving a role-owned acknowledged task. For a legacy role-owned acknowledgement that
already records an actor, only that recorded actor may claim/repair it (an administrator retains the
existing audited task-administration path); another holder of the same role cannot overwrite the receipt.

### 4.2 Pathway instance

`POST /api/v1/care-pathways/instances/:id/claim` requires `Idempotency-Key`. The executor locks the pinned
runtime, verifies a live unnamed instance, derives the exact current queue from the current workflow step
and its actionable task (`step.assigned_role || instance.accountable_role`), and verifies the actor's
current database role against it. It then atomically:

- compare-and-set sets `care_pathway_instances.owning_clinician_uid` from null to the actor;
- replaces role ownership with that UID on every actionable task in the workflow run;
- replaces role ownership with that UID on each corresponding incomplete SLA;
- appends an immutable `pathway_owner_claimed` transition carrying prior role, new UID, database role,
  actor, idempotency key and affected task/SLA identities.

Terminal task/SLA rows remain historical evidence. No role fallback is retained. A racing claimant loses
the instance compare-and-set and cannot partially reassign a task or SLA.

## 5. Covering-clinician transfer

### 5.1 Request

`POST /api/v1/care-pathways/instances/:id/owner-transfer-requests` requires an exact proposed clinician
UID, a nonblank reason and `Idempotency-Key`. Only the current named owner may request a transfer. The
target is revalidated as an active same-tenant clinically eligible user, but responsibility remains with
the current owner.

The transaction inserts one `care_handoff_instances` row with
`handoff_type='covering_clinician_reassignment'`, a user recipient, the current pathway/run/step as both
sending and receiving context, a null policy due time and a non-clinical sentinel urgency. It creates one
UID-only review task for the intended recipient outside the pathway workflow run, links it to the handoff,
and appends immutable `pathway_owner_transfer_requested` evidence. One partial unique index permits only
one live covering request per pathway. No SLA is invented for the acceptance task.

The request reason is clinical-operational evidence, not authorization. This slice adds no administrator,
role, system or break-glass request path; those require an owner-approved policy.

### 5.2 Exact-recipient PHI authority

The transfer routes use three narrowly scoped patient-access relationships: role-queue claimant,
transfer recipient and transfer-decline recipient. Each is available only for the exact same-tenant
task/handoff/pathway/patient binding and while the current database identity remains active and
clinically eligible. Recipient read and decline do not broaden the general clinical-workflow policy.
Accept still passes the existing write guard, then the ownership service independently requires the
exact recipient. Every relationship records the handoff/pathway identifiers and its exact access source
in the PHI access audit. Request data alone cannot manufacture one of these relationships.

`GET /api/v1/care-pathways/handoffs/:handoffId` is the recipient's minimal review surface. It returns
only the pathway identity/status, sender, intended recipient, nonblank request reason, and request or
terminal timestamps after rechecking the complete task/handoff/pathway binding. It does not return the
full pathway runtime, review-task metadata, unrelated patient data or another recipient's request.

### 5.3 Acceptance

`POST /api/v1/care-pathways/handoffs/:handoffId/accept` requires `Idempotency-Key`. Only the exact current
recipient may call it. Under locks in one tenant transaction it revalidates the handoff, source pathway,
unchanged prior owner, current recipient eligibility and task binding, then:

- compare-and-set changes the instance owner from the recorded prior owner to the recipient;
- changes every actionable pathway task and incomplete linked SLA from the prior UID to the new UID;
- compare-and-set marks the handoff accepted with `accepted_at` and `accepted_by_uid`;
- completes the recipient's acceptance task;
- appends immutable `pathway_owner_transfer_accepted` evidence containing prior UID, new UID, request
  reason, request actor, accepting actor, database role, handoff ID and affected task/SLA identities.

The immutable event is written in the same transaction as state. Request, acknowledgement, silence and
elapsed time do not transfer ownership. A stale request, changed owner, ineligible recipient or partial
binding fails closed. Exact replay returns the accepted state only after current recipient authorization
is re-established.

Completed linked SLAs are immutable historical receipts and retain their original owner. Acceptance
moves only actionable pathway tasks and linked incomplete SLAs in `active`, `breached` or `escalated`
state. This deliberately narrows migration 585's owner-equality assertion only for completed pathway
SLAs; all live task/SLA ownership invariants remain enforced.

### 5.4 Decline and cancellation

`POST /api/v1/care-pathways/handoffs/:handoffId/decline` permits only the exact intended recipient and
requires a nonblank reason plus `Idempotency-Key`. It leaves the current owner unchanged, cancels the
review task with the same reason, marks the handoff declined, and appends immutable
`pathway_owner_transfer_declined` evidence atomically. Decline remains available after the pathway moves
to a later stage so the recipient can close a stale request explicitly.

`POST /api/v1/care-pathways/handoffs/:handoffId/cancel` permits only the recorded sender, requires a
nonblank reason plus `Idempotency-Key`, leaves ownership unchanged, cancels the review task and handoff,
and appends immutable `pathway_owner_transfer_cancelled` evidence atomically. The route resolves the
source pathway only to apply the existing patient write guard and returns a generic denial for an
unknown or inaccessible handoff. There is no expiry, automatic cancellation, automatic reassignment or
administrator shortcut in this slice.

## 6. Migration 586

Migration 586 is additive and preflighted. It:

- adds immutable `request_reason`, `request_fingerprint` and `accepted_by_uid` evidence to
  `care_handoff_instances`, including a same-tenant accepting-user FK;
- adds the dedicated transfer-review task kind and admits exact recipient-read, recipient-decline and
  role-queue-claim sources to the existing patient-access audit constraint;
- adds a covering-transfer CHECK requiring a user recipient, same sending/receiving pathway/run/step
  tuple, pathway source identity, nonblank request reason, a SHA-256 request fingerprint, an exact
  UID-only review-task binding and coherent accepted/declined/cancelled evidence;
- adds one-live-covering-request partial uniqueness and recipient lookup indexes;
- installs deferred handoff/pathway/task dependency constraints so no transaction can commit only one
  side of the lifecycle;
- preserves completed SLA owner history while retaining exact owner equality for live pathway work; and
- blocks on pre-existing noncanonical rows; it never repairs, guesses or backfills clinical ownership.

Prisma is regenerated from the raw migration. Existing migrations 580-585 remain byte-for-byte frozen.

## 7. Verification contract

Tests must prove:

- stale JWT role, inactive/deleted user and cross-tenant actor cannot list, claim, acknowledge or accept;
- exact current-role queue claim, exact replay, racing claim and linked-SLA atomicity;
- pathway claim updates instance + every actionable task/SLA + canonical evidence or rolls all back;
- only a current named owner can request/cancel, only the exact intended clinician can read/accept/decline,
  and request alone never changes ownership;
- acceptance replay, owner-change race, recipient lifecycle race, task/SLA mismatch and forced canonical
  write failure all fail without partial state;
- request replay survives later target deactivation without creating a second request; that target can no
  longer read or decide it, while the sender can still cancel it;
- acceptance requires the same current human stage; decline and cancellation can explicitly close a
  request after stage advancement;
- completed SLA ownership never rewrites while live tasks and incomplete SLA ownership move together;
- PHI relationship is exact to tenant, patient, handoff, pathway, recipient and current database role;
- migration/RLS/schema/Prisma conformance and frozen migration hashes;
- OpenAPI exposes only the seven intended additions (generic claim; pathway claim; request; recipient
  read; accept; decline; cancel) and raw-parameter checks remain clean.

Production pathway mode remains off and active execution remains fail-closed after this slice.
