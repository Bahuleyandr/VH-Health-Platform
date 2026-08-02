# Escalation fairness — SQL page advancement and reachability-first tenant-ranked recipients

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
2. capped role-recipient pages preserve the existing reachability invariant,
   then use tenant-configured staff-label rank inside each reachability bucket,
   while every unranked candidate remains eligible.

The implementation preserves escalation rule meanings, thresholds, action
kinds, role-family fallback, notification channels, the recipient fan-out cap,
its exact `COUNT(*) OVER ()` dropped count, the Winston warning, and both
existing Prometheus counters. Bounded-label diagnostics make ranking failures
and per-rank shedding visible. The slice does not activate a feature or add an
admin application area.

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

### 2.5 Dated amendment — 2026-08-03 adversarial ordering review

This amendment was refreshed at `2026-08-03T05:23:35+05:30`. It supersedes the
original strict rank-first recipient order and designation-first resolution;
the page-advancement design in section 3 is unchanged. Live repository evidence
confirms that:

- `escalationRecipientFanout.deep.test.js` pins the PR #682 invariant that the
  cap sheds least-reachable, never-signed-in clinicians first;
- `staff.on_leave` already exists and is populated/consumed by staff dashboard
  and scheduling optimization paths;
- `last_sign_in_at` is written on staff sign-in, so it is a plausible-presence
  proxy rather than a heartbeat or duty-roster assertion; and
- runtime staff administration and SCIM paths maintain `staff.position`, while
  no backend writer maintains `staff.designation` (the similarly named
  `staff_salary.designation` is a different field).

The branch intentionally remains on the recorded Step-1 baseline until build
GO. Since the original preflight, PR #712 merged and `github/main` advanced to
`456578b914f4c62b5db91f61862406be0c14983f`; #713 remains the only other open
chip, with no direct planned-path collision. The C6.1-E PRs #711/#703/#704/
#705/#706/#709 remain open and still own the queued 611–616 migration stack.
Therefore the DDL/Prisma verdict and fresh migration-number rule are unchanged:
the build migration is at least 617 and is derived again only at coordinator
GO after the serialized backend slot is clear.

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

## 4. Decision 2 — reachability-first, tenant-configured staff-label priority

### 4.1 Carrier ruling

Use a **tenant-scoped staff-label-to-rank mapping table** plus a small control
object in the existing `tenants.settings` JSONB administration surface. The
table accepts mappings for the only two available labels, `position` and
`designation`. Resolution uses maintained `position` first and legacy
`designation` only when position is absent, blank, or unrecognized.

The alternatives are rejected as follows:

| Carrier | Ruling | Reason |
|---|---|---|
| `staff.escalation_rank` column | Reject | It turns a hospital hierarchy into a per-person attribute, requires bulk restamping when policy changes, and lets equal designations drift to different ranks. |
| Global or code-owned role-family priorities | Reject | Hospitals order roles differently, and the exact-role recipient arm contains only one `users.role`, so it cannot express seniority within that arm. |
| Tenant staff-label mapping | Select | One tenant can rank its own terminology centrally; changing policy changes ordering without mutating every staff row; unknown labels remain safely unranked. |

Supporting both label kinds avoids abandoning older tenant data while refusing
to treat the stale field as authoritative. `position` is the primary signal
because staff administration and SCIM create and update it. `designation` is a
legacy fallback only. If both fields have recognized but different ranks, the
recognized position wins. No inference is made from hire date, join date, user
ID, or text patterns.

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
- `priority_rank SMALLINT NOT NULL`, constrained to 1 through 100, where a
  lower number pages first and equal numbers form one tier;
- nullable `created_by` and `updated_by` actor UIDs; and
- `created_at` and `updated_at` timestamps.

The database enforces nonblank normalized values, canonical normalization, a
non-default tenant, valid source kind/rank, and uniqueness on
`(tenant_id, source_kind, normalized_source_value)`. The table contains no
patient data or notification content.

The existing `tenants.settings` column carries
`escalation_recipient_ranking`, a non-secret control object with
`configured`, `revision`, `presence_window_minutes`,
`expected_mapping_count`, `last_replaced_at`, and `last_replaced_by`. The rank
bound keeps both validation and the Prometheus rank-label domain finite. No
default ranks are seeded.

The control object distinguishes all three operational states:

1. key absent: the tenant has never configured ranking;
2. `configured=true` and `expected_mapping_count=0`: an audited explicit empty
   replacement; and
3. `configured=true` and `expected_mapping_count>0`: ranking is expected to be
   active and a zero/partial mapping read is an observable failure.

States 1 and 2 both reproduce today's ordering exactly, but GET and audit
history distinguish them. The expected count is updated atomically with the
mapping replacement and is deliberately independent of the mapping-table
read, so wiped rows or an incorrectly filtered read cannot masquerade as a
correctly unconfigured tenant.

### 4.3 Recipient query and ordering

Both exact-role and family-fallback query arms retain `users` as the candidate
source. A `LEFT JOIN LATERAL` computes at most one effective rank per user from
active, non-archived, same-tenant staff rows and same-tenant mappings:

1. minimum matching position rank, if any;
2. otherwise minimum matching designation rank, if any;
3. otherwise `NULL`.

The aggregate lateral join is required because `staff.user_id` is indexed but
not database-unique. It prevents duplicate staff profiles from duplicating a
recipient or inflating `COUNT(*) OVER ()`.

The query also reduces active staff rows to one leave fact. `BOOL_OR(on_leave)`
is conservative: any affirmative active profile prevents the user from being
classified as plausibly present. No active staff row is **not** evidence of
leave. Such a user remains a candidate with `effective_rank=NULL` and can
still enter the plausible-presence bucket from a recent sign-in. A duty doctor
without a staff profile is therefore not systematically cut behind a stale or
never-signed-in ranked clinician.

The plausible-presence window is tenant-configurable through the control
object. Its default is **720 minutes (12 hours)**, with accepted values from 15
through 2880 minutes. Twelve hours covers a common hospital shift and handoff
without pretending a sign-in timestamp is live presence. One sweep captures a
single database clock and classifies:

- bucket 0, plausibly present: `last_sign_in_at >= sweep_clock - window` and no
  active staff row has `on_leave=true`; and
- bucket 1, less reachable: stale/null sign-in or an affirmative active
  `on_leave=true` profile.

When `expected_mapping_count > 0`, the behavioral order after candidate
filtering is:

```sql
ORDER BY presence_bucket ASC,
         effective_rank ASC NULLS LAST,
         u.last_sign_in_at DESC NULLS LAST,
         u.id ASC
```

Consequences are binding:

- plausible presence always outranks seniority, so a recent, not-on-leave
  junior pages before a stale, never-signed-in, or on-leave consultant;
- rank orders users only within a presence bucket, and tied ranks use today's
  recency/ID order;
- null, blank, missing, or unrecognized position/designation never removes a
  user and sorts last only within its presence bucket;
- absent configuration or an audited explicit-empty configuration bypasses
  both bucketing and ranking, making the full order exactly
  `last_sign_in_at DESC NULLS LAST, id ASC`; and
- tenant A's labels can never rank tenant B's users.

The capped query uses a one-row-per-user CTE with the order's row number and
the existing exact `COUNT(*) OVER ()`. A summary CTE aggregates rows beyond the
cap by normalized rank label (`1` through `100`, or `unranked`), while the
recipient page still contains only the first `cap` rows. This computes tail
composition rather than guessing it from the returned page.

`finishRecipients()`, exact total matched/notified/dropped values, the existing
Winston warning, `vhhealth_escalation_recipients_trimmed_total`, de-duplication,
fan-out cap, exact-role-first behavior, and role-family fallback remain. The
warning additionally includes `droppedByRank` (and presence-bucket totals), and
`vhhealth_escalation_recipients_trimmed_by_rank_total{role,arm,rank}` reports
the exact bounded per-rank drop counts. The sum of the per-rank increments must
equal the existing dropped increment.

Ranking failure is visible. When `expected_mapping_count > 0`, the service
compares it with the observed same-tenant mapping count and records how many
candidates resolved a rank. It emits a Winston warning and
`vhhealth_escalation_recipient_ranking_failures_total{role,arm,reason}` when:

- observed mappings differ from expected (`mapping_count_mismatch`); or
- the candidate population is nonempty but zero candidates resolved a rank,
  regardless of whether the mapping read returned zero or nonzero rows
  (`zero_ranked_candidates`).

The warning carries tenant ID, expected/observed/matched counts, control
revision, and presence window; tenant ID is not a metric label. These bounded
reason labels make a wiped table, normalization mismatch, and RLS-filtered read
distinguishable from a tenant that intentionally has no ranking.

### 4.4 Existing administration and audit surface

No new admin application area is created. The backend extends the existing
SUPER_ADMIN, step-up, IP-allowlisted tenant configuration route family under
`/api/v1/admin/tenants/:tenantId/*` with:

- `GET /escalation-recipient-rankings`; and
- `PUT /escalation-recipient-rankings` for an atomic full replacement.

The `PUT` body contains a bounded `mappings[]` list of `{ sourceKind,
sourceValue, priorityRank }` plus `presenceWindowMinutes`, defaulting to 720 on
the tenant's first replacement. The service normalizes labels, rejects
case/whitespace duplicates and invalid ranks/window values, and accepts an
empty list to restore exact legacy ordering.

The service pins the target tenant with `setTenantTx(tenantId, ...)` even
though the HTTP caller is a super-admin. The mapping replacement, control
object revision/count/timestamps, and existing tenant settings update commit
atomically. The old and new mappings and control values plus actor identity are
written in the same transaction to the existing tenant-scoped `audit_logs`
surface using action
`ESCALATION_RECIPIENT_RANKINGS_REPLACED`. A configuration change therefore
cannot commit without its audit record. Existing system-audit readers can show
the event; no separate audit UI or parallel audit store is added.

GET returns the control state explicitly, including `configured=false` for an
absent key and `configured=true, explicitEmpty=true` after an empty PUT. Empty
replacement never deletes the marker. This makes an accidental empty full
replacement observable through current configuration and immutable audit
history instead of silently becoming indistinguishable from never configured.

## 5. Section 6.8 integrity and privilege posture

The new table and control object follow the shared integrity contract:

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
- **Control-object posture:** `tenants` is the control-plane root and has no
  `tenant_id` on which to apply the tenant-match RLS policy; this slice does
  not pretend otherwise or add RLS to that existing table. Its ranking key is
  read by an exact tenant-ID join and updated with `WHERE id = tenantId` only
  inside the same pinned transaction and protected tenant-admin route as the
  mapping replacement. The new mapping table's forced RLS independently fails
  closed.
- **Privileges:** revoke all from `PUBLIC`. Existing runtime roles receive only
  `SELECT, INSERT, UPDATE, DELETE`, the verbs required by sweep reads and the
  atomic replacement endpoint; explicitly revoke `TRUNCATE`, `REFERENCES`,
  and `TRIGGER`. UUID IDs require no sequence grant. Updating the control
  object uses the already-granted tenant-settings mutation path and adds no
  broader `tenants` privilege.
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
   exact pinned context; and
6. with the control object's expected count left intact, direct SQL deletion
   or cross-tenant/RLS-hidden reads produce a count mismatch instead of an
   apparent unconfigured fallback.

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

- the unchanged PR #682 no-configuration case returns the identical ordered ID
  page produced by today's query and still drops never-signed-in accounts
  first;
- with ranking active, presence buckets precede rank, rank is ascending only
  inside a bucket, and recency then ID resolves an equal-rank tier;
- the default 720-minute window, a tenant override, and the exact threshold
  boundary use one captured sweep clock;
- a recent on-leave consultant sorts behind a recent not-on-leave junior, and a
  never-signed-in consultant cannot page ahead of a junior active four minutes
  ago;
- a recognized position outranks a conflicting stale recognized designation,
  while designation is used when position is null, blank, or unrecognized;
- null, blank, and unrecognized labels remain in the result at the unranked
  tail of their own presence bucket;
- a user with no active staff row resolves no rank but is not treated as on
  leave: a recent duty doctor remains in the plausible-presence bucket, while
  its stale/never-signed-in counterpart remains in the less-reachable bucket;
- an all-unranked tenant with no configuration and an audited explicit-empty
  tenant each page IDs exactly as today's query, while GET/audit distinguish
  those two configuration states;
- a configured tenant whose mappings match none of its candidates retains the
  full candidate set and legacy recency/ID within each unranked bucket, while
  emitting the zero-ranked warning and counter;
- duplicate staff rows cannot duplicate one user or inflate `total_matched`;
- exact-role and family-fallback arms apply the same ordering;
- cross-tenant mappings have no effect; and
- an over-cap 600-doctor cohort contains 100 recent rank-1 consultants, 180
  recent rank-2 doctors, 220 recent rank-3 junior residents, 20 never-signed-in
  rank-1 consultants, 40 recent-but-on-leave unranked doctors, and 40
  never-signed-in unranked doctors. At cap 500, exactly the 20 rank-1 and 80
  unranked less-reachable doctors are dropped; no recent junior is dropped.
  The old exact total warning/counter remains 100 dropped, the added rank
  breakdown is `{ "1": 20, "unranked": 80 }`, and its sum is exactly 100.

Focused observability tests also prove expected-versus-observed mapping count
mismatch and zero-ranked-candidate paths increment each applicable
bounded-reason counter and emit a tenant-bearing ranking-failure warning. A
wiped/RLS-hidden read triggers both reasons; a normalization mismatch with rows
visible triggers `zero_ranked_candidates`; never-configured and explicit-empty
tenants emit neither failure signal.

### 6.3 Administration and audit

Route/service tests prove:

- existing SUPER_ADMIN route protections remain the authorization boundary;
- GET and atomic PUT are tenant-scoped;
- invalid or duplicate input commits neither mappings nor audit;
- successful replacement atomically commits mappings, presence window,
  expected count/revision, and one before/after audit record;
- empty replacement removes mappings, preserves an explicit configured-empty
  marker, increments its revision, records the audit, and restores legacy
  order;
- GET distinguishes never configured from explicitly emptied;
- a database/audit failure rolls back the entire replacement.

## 7. Step-2 implementation ledger

Expected paths, subject to the mandatory kickoff overlap refresh:

- `apps/backend/src/services/workflow/escalationEngineService.js`;
- `apps/backend/src/services/workflow/escalationRecipientRankingService.js`;
- `apps/backend/src/observability/escalationMetrics.js`;
- `apps/backend/src/routes/admin/tenantRoutes.js`;
- `apps/backend/src/migrations/NNN_escalation_recipient_rank_mappings.sql`,
  where `NNN` is derived fresh and is at least 617;
- `apps/backend/prisma/schema.prisma` regenerated from the migrated database;
- `apps/backend/src/tests/unit/escalationEngineService.test.js`;
- `apps/backend/src/tests/unit/escalationMetrics.test.js`;
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
candidate query shapes while leaving the inert mapping table, settings control
object, and audit history intact. A follow-up migration may stop new mapping
writes, but rollback does not erase configuration or audit evidence.

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
