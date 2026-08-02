# Escalation fairness — SQL page advancement and tenant-ranked recipients

**Status:** Step 1 design delta; owner decisions recorded 2026-08-02; runtime
build remains blocked on coordinator GO and a freshly clear backend slot<br>
**Scope:** backend service, one migration, regenerated Prisma schema, existing
tenant-admin route family, and backend tests only<br>
**Branch:** `feat/escalation-fairness`<br>
**Step-1 baseline:** `github/main` at
`92996925b2d41bc58453207651ef9f5827615863`
(`2026-08-03T04:43:57+05:30`)<br>
**Release state:** design only; no migration, runtime, activation, deployment,
or notification-channel change in Step 1<br>
**Merge state:** never merge from this lane

## 1. Outcome and binding boundary

This slice implements both recorded owner decisions in one backend change:

1. candidate pages exclude tasks for which the current rule already fired, so
   a head block of completed escalation work cannot starve later task IDs; and
2. capped role-recipient pages use a tenant-configured staff-label rank before
   the existing recency and ID tiebreaks, while every unranked staff member
   remains eligible.

The implementation preserves escalation rule meanings, thresholds, action
kinds, role-family fallback, notification channels, the recipient fan-out cap,
its exact `COUNT(*) OVER ()` dropped count, the Winston warning, and both
existing Prometheus counters. It does not activate a feature or add an admin
application area.

## 2. Step-0 preflight

### 2.1 Live baseline and data-model verdict

The preflight was refreshed at `2026-08-03T04:55:26+05:30`. During the
preflight, PR #714 merged; the lane was therefore created from the new
`github/main` head `92996925b2d41bc58453207651ef9f5827615863`
rather than the earlier observed head.

The repository confirms the owner's data warning:

- `apps/backend/prisma/schema.prisma` model `staff` has nullable free-text
  `designation VARCHAR(100)` and `position VARCHAR(100)` fields;
- `users` has `role` and `last_sign_in_at`, but no rank, grade, or seniority;
- neither `staff` nor `users` has an escalation rank column; and
- there is no tenant ranking or staff-label ranking table.

The existing staff administration service creates and updates `position` but
does not make either free-text label a safe global rank. The design must
therefore add tenant-owned configuration rather than infer seniority from text
or hard-code one hospital's hierarchy.

### 2.2 DDL and Prisma verdict

**DDL is required for recipient ordering, but not for page advancement.** The
recipient change adds one tenant-scoped mapping table,
`escalation_recipient_rank_mappings`. The starvation fix continues to use the
existing `tasks.metadata.escalations[]` fired marker and needs no new task
column or firing table.

**Prisma regeneration is required.** Raw SQL migrations are authoritative in
this repository, and the new table must also appear in the regenerated
`apps/backend/prisma/schema.prisma`; the migration and schema will commit
together in Step 2. The runtime may use raw SQL, but that does not exempt the
new relation from schema-drift checks.

No migration number is reserved in Step 1. The committed baseline ends at
`610_hl7_outbound_recovery.sql`. The open C6.1-E stack claims 611 through 616,
so the expected number is at least 617. At coordinator GO, the builder must
re-fetch `github/main`, inspect every committed and open migration, and select
`max(existing and queued migration number) + 1`. A new chip that takes 617
therefore moves this slice to 618 or later.

### 2.3 Open C6.1-E overlap

| PR | Claimed migration | Direct overlap with this build |
|---|---:|---|
| #711, I05 HL7v2 | 611 | `apps/backend/prisma/schema.prisma` and migration sequencing only |
| #703, I05 CSV | 612, cumulative after 611 | `apps/backend/prisma/schema.prisma` and migration sequencing only |
| #704, I05 JSON | 613, cumulative after 612 | `apps/backend/prisma/schema.prisma` and migration sequencing only |
| #705, I05 FHIR JSON | 614, cumulative after 613 | `apps/backend/prisma/schema.prisma` and migration sequencing only |
| #706, I05 OTHER | 615, cumulative after 614 | `apps/backend/prisma/schema.prisma` and migration sequencing only |
| #709, I06 study links | 616, cumulative after 615 | `apps/backend/prisma/schema.prisma` and migration sequencing only |

None of those PRs touches
`apps/backend/src/services/workflow/escalationEngineService.js`, the planned
ranking service, tenant routes, or escalation tests. They all regenerate
Prisma and cumulatively carry migration files, so the overlap is real but
serialized rather than semantic: Step 2 must start after the coordinator says
the backend slot is clear and must regenerate from the merged stack, never
resolve `schema.prisma` by taking either side wholesale.

### 2.4 Other open chip overlap

At the same preflight moment the other open PRs were #712 and #713:

- #712 changes patient/staff tenant-stamp release wiring, client code, core
  tenant config, tests, and its design document. It has no planned-path
  overlap with this backend slice.
- #713 changes continuity-edge metrics, monitoring rules/runbooks, and
  `apps/backend/src/observability/continuityMetrics.js`. It does not touch
  `escalationMetrics.js`, the escalation engine, Prisma, or migrations.

PR #714 was no longer an open chip: it merged during preflight and is included
in this lane's baseline. No open chip had a direct source-file collision at
the time of this Step-0 record. This conclusion must be refreshed at Step-2
kickoff because the queue is intentionally serialized.

## 3. Decision 1 — page advancement in SQL

### 3.1 Current defect

For each tenant and rule, both candidate queries currently order all
plausibly eligible tasks by `t.id ASC`, apply `LIMIT`, and only then call the
JavaScript `alreadyFired()` guard. Once the first page has fired, those rows
remain SQL-eligible and occupy the same page forever. Raising the limit only
moves the starvation boundary.

### 3.2 Query change

Both the `sla_breach` and `pending_too_long` candidate queries add a
rule-specific `NOT EXISTS` predicate over
`tasks.metadata.escalations[]` before `ORDER BY` and `LIMIT`. The predicate
must:

- treat a missing, null, or non-array `escalations` value as an empty array;
- match the stored integer `rule_id` contract and its canonical text form;
- bind the current rule ID as a parameter; and
- retain the JavaScript `alreadyFired()` check as a defense-in-depth guard,
  not as the normal filtering layer.

The intended query shape is:

```sql
AND NOT EXISTS (
  SELECT 1
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(t.metadata -> 'escalations') = 'array'
          THEN t.metadata -> 'escalations'
        ELSE '[]'::jsonb
      END
    ) AS fired(entry)
   WHERE fired.entry ->> 'rule_id' = $rule_id::text
)
ORDER BY t.id ASC
LIMIT $limit::int
FOR UPDATE OF t SKIP LOCKED
```

The exact placeholder numbers differ between the two query arms because the
SLA query also binds `now`; both must remain raw-parameter-lint compliant.

No `match_filter`, trigger window, status, SLA, or action semantics move in
this slice. A task that has not fired for the current rule enters the same
JavaScript `matchesFilter()` and `triggerHolds()` checks as before.

### 3.3 Concurrent-sweep guarantee

Moving the marker test into SQL is necessary but not sufficient. Two direct
or multi-replica sweep calls could otherwise read the same unmarked task before
either writes its marker. Both candidate queries therefore lock selected task
rows with `FOR UPDATE OF t SKIP LOCKED`.

The lock and predicate work together under the existing per-tenant
transaction:

1. the first sweep locks an unmarked task;
2. a concurrent sweep skips that row rather than firing it again;
3. the first sweep writes the rule marker and commits; and
4. later statements/sweeps see the marker in SQL and exclude the task.

If the owning transaction rolls back, no marker is committed; a later sweep
may correctly retry the task. This is not a double-fire. The scheduler's
existing job lock remains useful, but correctness no longer depends on every
caller entering through that scheduler.

The once-per-rule identity remains `(tenant_id, task_id, rule_id)`. Different
rules/tiers may still fire once each against the same task, exactly as today.
This slice does not redefine transport delivery semantics after an external
provider accepts an outbox or webhook; it prevents the engine from executing
the same rule twice in successful sequential or concurrent sweeps.

### 3.4 Meaning of the retained page-full signal

The existing warning and
`vhhealth_escalation_candidate_page_full_total` counter stay unchanged.
`page full` can still legitimately occur after the fix whenever at least
`limit` not-yet-fired SQL candidates exist for a tenant and rule. It now means
that this invocation evaluated a full capacity page and later candidates were
deferred to another sweep; it no longer means that already-fired head rows can
pin the page indefinitely.

The query remains a bounded evaluator, not a durable cursor. A repeatedly full
page can still reveal sustained inflow or candidates that repeatedly fail the
unchanged JavaScript rule filter/window. The warning remains the operator's
safety net for that pressure. The approved behavior change is specifically
that fired rows no longer consume page capacity.

## 4. Decision 2 — tenant-configured staff-label priority

### 4.1 Carrier ruling

Use a **tenant-scoped staff-label-to-rank mapping table**. It accepts mappings
for the only two available labels, `designation` and `position`, and resolves
designation first with position as a fallback when designation is absent or
unrecognized.

The alternatives are rejected as follows:

| Carrier | Ruling | Reason |
|---|---|---|
| `staff.escalation_rank` column | Reject | It turns a hospital hierarchy into a per-person attribute, requires bulk restamping when policy changes, and lets equal designations drift to different ranks. |
| Global or code-owned role-family priorities | Reject | Hospitals order roles differently, and the exact-role recipient arm contains only one `users.role`, so it cannot express seniority within that arm. |
| Tenant staff-label mapping | Select | One tenant can rank its own terminology centrally; changing policy changes ordering without mutating every staff row; unknown labels remain safely unranked. |

Supporting both label kinds avoids pretending the two legacy free-text fields
are interchangeable. `designation` is the primary seniority signal;
`position` is the deterministic fallback because it is already maintained by
the staff administration and SCIM paths. If both fields have recognized but
different ranks, the recognized designation wins. No inference is made from
hire date, join date, user ID, or text patterns.

### 4.2 Mapping-table contract

Step 2 adds `escalation_recipient_rank_mappings` with:

- `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`;
- `tenant_id UUID NOT NULL` with an explicit foreign key to `tenants(id)` and
  no default;
- `source_kind VARCHAR(20) NOT NULL`, constrained to `designation` or
  `position`;
- `source_value VARCHAR(100) NOT NULL` for the administrator-visible label;
- `normalized_source_value VARCHAR(100) NOT NULL`, using the same trim,
  whitespace-collapse, and lowercase normalization as the resolver;
- `priority_rank SMALLINT NOT NULL`, constrained to 1 through 32767, where a
  lower number pages first and equal numbers form one tier;
- nullable `created_by` and `updated_by` actor UIDs; and
- `created_at` and `updated_at` timestamps.

The database enforces nonblank normalized values, canonical normalization, a
non-default tenant, valid source kind/rank, and uniqueness on
`(tenant_id, source_kind, normalized_source_value)`. The table contains no
patient data or notification content.

An empty mapping set is a valid and intentional configuration. No default
ranks are seeded: absent tenant configuration must reproduce today's order
exactly.

### 4.3 Recipient query and ordering

Both exact-role and family-fallback query arms retain `users` as the candidate
source. A `LEFT JOIN LATERAL` computes at most one effective rank per user from
active, non-archived, same-tenant staff rows and same-tenant mappings:

1. minimum matching designation rank, if any;
2. otherwise minimum matching position rank, if any;
3. otherwise `NULL`.

The aggregate lateral join is required because `staff.user_id` is indexed but
not database-unique. It prevents duplicate staff profiles from duplicating a
recipient or inflating `COUNT(*) OVER ()`.

The only behavioral SQL change after candidate filtering is:

```sql
ORDER BY effective_rank ASC NULLS LAST,
         u.last_sign_in_at DESC NULLS LAST,
         u.id ASC
```

Consequences are binding:

- ranked staff page before unranked staff;
- tied ranks use today's recency/ID order;
- null, blank, missing, or unrecognized designation/position never removes a
  user from the candidate set and always sorts in the unranked tail;
- no mapping rows means every effective rank is null, making the full order
  exactly `last_sign_in_at DESC NULLS LAST, id ASC`; and
- tenant A's labels can never rank tenant B's users.

`COUNT(*) OVER ()` remains over the same active-user candidate population and
is computed before the unchanged fan-out `LIMIT`. `finishRecipients()`, the
exact dropped count, Winston warning, Prometheus counter, de-duplication,
fan-out cap, exact-role-first behavior, and role-family fallback are unchanged.

### 4.4 Existing administration and audit surface

No new admin application area is created. The backend extends the existing
SUPER_ADMIN, step-up, IP-allowlisted tenant configuration route family under
`/api/v1/admin/tenants/:tenantId/*` with:

- `GET /escalation-recipient-rankings`; and
- `PUT /escalation-recipient-rankings` for an atomic full replacement.

The `PUT` body is a bounded `mappings[]` list of `{ sourceKind, sourceValue,
priorityRank }`. The service normalizes labels, rejects case/whitespace
duplicates and invalid ranks before writing, and accepts an empty list to
restore exact legacy ordering.

The service pins the target tenant with `setTenantTx(tenantId, ...)` even
though the HTTP caller is a super-admin. The old and new mapping arrays plus
actor identity are written in the same transaction to the existing
tenant-scoped `audit_logs` surface using action
`ESCALATION_RECIPIENT_RANKINGS_REPLACED`. A configuration change therefore
cannot commit without its audit record. Existing system-audit readers can show
the event; no separate audit UI or parallel audit store is added.

## 5. Section 6.8 integrity and privilege posture

The new table follows the shared integrity contract:

- **Tenant scope:** `tenant_id` is non-null, has no implicit/default tenant,
  rejects `00000000-0000-4000-8000-000000000001`, references `tenants(id)`,
  and participates in every uniqueness/index key.
- **Facility and clinical references:** not applicable. Ranking configuration
  has no facility, patient, encounter, admission, task, or domain-resource
  reference; adding one would require a separate same-tenant/facility design.
- **RLS:** `ENABLE` and `FORCE ROW LEVEL SECURITY`; a permissive tenant match
  plus a restrictive explicit-context policy. Unset, empty, and `bypass`
  context cannot read or write this table. The sweep and admin service both
  use an exact pinned tenant transaction.
- **Privileges:** revoke all from `PUBLIC`. Existing runtime roles receive only
  `SELECT, INSERT, UPDATE, DELETE`, the verbs required by sweep reads and the
  atomic replacement endpoint; explicitly revoke `TRUNCATE`, `REFERENCES`,
  and `TRIGGER`. UUID IDs require no sequence grant.
- **Retention:** rows are current operational configuration and have no TTL.
  Replacement/deletion is allowed only through the audited admin mutation;
  before/after history follows the existing `audit_logs` retention policy.
- **No activation:** migration presence creates an empty configuration and
  therefore preserves legacy ordering for every tenant.

Raw-`pg` tests, not Prisma mocks, must prove:

1. sentinel/default tenant, blank/noncanonical label, invalid source/rank, and
   duplicate normalized label inserts fail at database constraints;
2. runtime role under tenant A cannot select, insert, update, or delete tenant
   B rows;
3. unset, empty, and `bypass` tenant contexts fail closed;
4. runtime roles have the enumerated verbs and cannot truncate or alter the
   table; and
5. a same-tenant valid mapping remains readable and writable through the
   exact pinned context.

## 6. Required behavior proofs

### 6.1 Sweep advancement and exact-once

Focused unit and real-PostgreSQL tests cover:

- an unmarked task that fired before the change still fires with the same
  action and marker;
- a page consisting of `limit` already-fired low-ID tasks no longer occupies
  the result, and a later matching task is evaluated and fires;
- the same `(task, rule)` does not fire on a second sequential sweep;
- two concurrent direct sweep calls create one rule marker and one action
  effect for the same task/rule;
- concurrent sweeps may divide different unlocked tasks without duplicate
  markers;
- a rolled-back owner does not leave a committed marker and the next sweep can
  retry; and
- a full genuine page still emits the existing warning and increments the
  existing counter exactly once for that query.

The SQL-shape unit assertions prove both trigger-condition arms contain the
fired-marker predicate before `LIMIT` and `FOR UPDATE OF t SKIP LOCKED`.

### 6.2 Ranked recipient paging without eviction

Extend `escalationRecipientFanout.deep.test.js` and focused units to prove:

- configured rank tiers page in ascending rank, with recency then ID inside a
  tier;
- a recognized designation outranks a conflicting recognized position, while
  position is used when designation is null, blank, or unrecognized;
- null, blank, unrecognized, and missing staff profiles remain in the result
  and sort after ranked users;
- an all-unranked tenant with no mapping rows returns the identical ordered ID
  page produced by today's query;
- a tenant whose configuration matches none of its staff also retains the same
  candidate set and legacy within-unranked order;
- duplicate staff rows cannot duplicate one user or inflate `total_matched`;
- exact-role and family-fallback arms apply the same ordering;
- cross-tenant mappings have no effect; and
- over-cap ranked/unranked cohorts still report the exact original matched,
  notified, and dropped counts through the unchanged warning and metric.

### 6.3 Administration and audit

Route/service tests prove:

- existing SUPER_ADMIN route protections remain the authorization boundary;
- GET and atomic PUT are tenant-scoped;
- invalid or duplicate input commits neither mappings nor audit;
- successful replacement commits mappings and one before/after audit record;
- empty replacement removes configuration and restores legacy order; and
- a database/audit failure rolls back the entire replacement.

## 7. Step-2 implementation ledger

Expected paths, subject to the mandatory kickoff overlap refresh:

- `apps/backend/src/services/workflow/escalationEngineService.js`;
- `apps/backend/src/services/workflow/escalationRecipientRankingService.js`;
- `apps/backend/src/routes/admin/tenantRoutes.js`;
- `apps/backend/src/migrations/NNN_escalation_recipient_rank_mappings.sql`,
  where `NNN` is derived fresh and is at least 617;
- `apps/backend/prisma/schema.prisma` regenerated from the migrated database;
- `apps/backend/src/tests/unit/escalationEngineService.test.js`;
- `apps/backend/src/tests/escalationRecipientFanout.deep.test.js`;
- focused ranking service/route tests;
- one real-PostgreSQL sweep-concurrency/advancement test; and
- one raw-`pg` migration/RLS/grant negative suite.

No client, admin frontend, notification provider/channel, C6.1 recovery,
activation, infrastructure, or deployment path belongs in the ledger.

## 8. Step-2 kickoff gate and receipts

Implementation begins only after an explicit coordinator GO. At kickoff the
builder must:

1. refresh open PRs and both remotes;
2. confirm the serialized backend slot is clear;
3. rebase this branch on the current merged `github/main`;
4. repeat the C6.1-E and chip path/migration overlap;
5. derive the next free migration number rather than assuming 617;
6. confirm the Step-2 ledger still has no unexpected owner; and
7. stop and report any collision instead of guessing through it.

Standard Step-2 receipts retain exact commands, exit codes, and log paths for:

- baseline, open-PR, migration-number, worktree, and changed-path ledgers;
- migration fresh apply, re-run, constraint, RLS, grant, and raw-`pg` negative
  tests;
- Prisma `db pull` regeneration and schema-drift check;
- focused unit/deep, concurrency, ranking, route, and audit suites;
- backend formatting, lint, raw-parameter lint, Swagger/OpenAPI, and full Jest
  shards;
- applicable dependency, secret, Semgrep, and CodeQL gates;
- `git diff --check`, clean worktree, exact baseline/implementation SHAs, and
  `git diff --name-status github/main...HEAD`; and
- branch push and CI links/status.

The lane may commit and push after the required gates. It never merges and
never deploys.

## 9. Rollback and non-goals

Runtime rollback restores the two recipient `ORDER BY` clauses and the two
candidate query shapes while leaving the inert mapping table and its audit
history intact. A follow-up migration may stop new mapping writes, but rollback
does not erase configuration or audit evidence.

Explicit non-goals are:

- no new admin UI area;
- no notification channel, provider, template, or delivery-policy change;
- no C6.1 recovery or reconciliation surface;
- no escalation rule, threshold, trigger-window, tier, or action change;
- no inferred default rank or global hospital hierarchy;
- no exclusion of unranked users;
- no duty/on-call roster integration;
- no activation, merge, or deployment; and
- no Step-2 runtime work before coordinator GO.
