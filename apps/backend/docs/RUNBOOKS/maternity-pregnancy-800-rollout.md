# Migration 800 pregnancy-domain inspection and rollout stop lines

This is a read-only evidence procedure, not permission to apply a migration,
change a clinical record, publish, merge, deploy, or approve a release. It does
not alter migration 800, add an acceptance flag, or wire an automatic rollout
gate. The named operator and clinical-records authority retain their decisions.

## Scope and prerequisites

The three domains were declared in `155_maternity_workflow.sql`: EDD method,
booking status and pregnancy status. The baseline already created the table,
so migration 155's `CREATE TABLE IF NOT EXISTS` is not proof that its inline
CHECKs exist. Inspect `pg_constraint`, not migration text alone.

Use the exact reviewed helper source on Node 26.5.0 with PostgreSQL 17. Obtain
explicit authorization for all-tenant inspection of the named primary database.
Supply an existing inspection credential with SELECT privileges and effective
superuser or BYPASSRLS visibility. This procedure never grants that privilege.
Do not use a tenant-filtered runtime DSN or a read replica as rollout evidence.
The existing maternity-duplicate report answers a different question and cannot
replace this domain/catalog inspection.

Record these separately in protected operator evidence; do not place secrets or
patient information in a PR:

- Operator, authorized database/environment identity and access receipt: ______.
- Exact candidate commit, image digest, migration-800 filename and independently
  calculated SHA256, helper commit/hash: ______.
- Approved observation window, backup/restore evidence and protected export
  location/access control: ______.

The helper deliberately has no default DSN, tenant selector, repair mode,
acceptance switch or automatic deployment hook. The DSN is supplied through
`MIGRATION_800_PREFLIGHT_DATABASE_URL`, not a command-line argument. Do not copy
it into logs or shell transcripts. Configure trusted TLS for remote inspection;
the helper does not disable certificate verification.

From `apps/backend`, in the explicitly authorized environment:

```bash
node scripts/maternity-pregnancy-800-preflight.mjs \
  --ack-all-tenant-read-only --export /protected/new-maternity-800-report.json
```

Choose a new file in an existing owner-controlled directory. The export uses
exclusive creation and mode 0600, refusing an existing file or symlink. On
Windows, mode bits do not replace NTFS ACLs: the operator must verify directory
and file ACLs. Standard output is also an aggregate report; retain it only in
approved evidence storage. Even aggregate clinical counts need controlled
access. The helper does not output patient IDs, tenant IDs, row values or DSNs.

## What the report proves, and what it does not

The helper establishes one repeatable-read, read-only primary snapshot, confirms
read-only execution and effective unfiltered visibility, and sets
`row_security=off` so filtering cannot silently turn an incomplete scope into
zero rows. ACCESS SHARE locks pin the pregnancy and tracker relations during
inspection. Ordinary reads/writes can continue; concurrent exclusive DDL may
wait or cause the report's five-second lock limit to fail. Connection timeout is
five seconds, statement timeout thirty seconds, client query timeout thirty-five
seconds, and idle-in-transaction timeout thirty seconds. A timeout is incomplete
evidence, never a zero population or permission to increase a production budget.

The report includes exact relation/column metadata, target constraint names,
their deparsed definitions and validation states, equivalent differently named
domain checks, migration-800 tracker/checksum state, and all-row counts using
the same `IS FALSE` predicates as migration 800. Nullable EDD is not a violation;
the other two columns must retain their existing NOT NULL shape. Counts are
decimal strings so a large population is not rounded by JavaScript.

Missing tables, missing permissions, wrong column shape, inheritance/partition
scope, unexpected named predicates, incomplete counts and invalid tracker
checksums stop the command. Differently named equivalent constraints require
lineage review before applying a second constraint. An already-tracked migration
does not bypass catalog or population inspection. A truly empty table is reported
as empty, not as evidence of a validated clinical journey.

`report_only` and exit zero mean the report completed, not that rollout is
approved. `candidate_checksum_verified` is always false: compare the observed
tracker checksum with the independently reviewed candidate bytes when tracked;
pending migration 800 has no tracker checksum to compare. The helper does not
read a migration file from an unrelated worktree or infer identity from a
possibly stale remote. Its report hash fingerprints the produced report, not a
signed owner receipt or an atomic acceptance mechanism.

## Required stop lines before an operator rollout

- Any inspection error, missing expected population, unexpected definition,
  lineage alias or checksum discrepancy: STOP and review. Do not drop/re-add a
  constraint, reset the tracker, widen a predicate or mark an exception accepted.
- Any historical domain violations: STOP for named clinical-records and operator
  review. Migration 800 preserves those rows and leaves newly added CHECKs NOT
  VALID when any of its three counts is nonzero. That does not disable the
  checks: a later INSERT or UPDATE must satisfy them, including an unrelated
  update to an existing invalid row. Decide the affected workflow and recovery
  plan explicitly; this report never relabels historical clinical facts.
- Zero violations: still require operator acceptance of the exact image,
  migration, lock window and rollback plan. This snapshot can become stale as
  soon as its transaction ends. It is not the payroll-754 same-transaction
  accepted-manifest gate, and it cannot provide that gate's race protection.
- Confirm the deployed migration executor's actual timeout behavior. At base
  `f43a5f310`, migration 800 has explicit `BEGIN`; the self-managed CI executor
  branch does not itself install the ordinary 15s/120s limits. Fresh-chain
  inherited settings are not proof of incremental production limits. A separate
  executor correction must be reviewed and proven on its final source; this
  helper does not repair or activate it.
- Keep clinical, operator and release approvals explicit and separate. Approval
  receipt, scope, expiration and named decision-maker: ______.

Adding a CHECK takes ACCESS EXCLUSIVE locking. Migration 800 adds constraints,
counts history, and conditionally validates in one transaction; a lock acquired
for an ADD remains held through the transaction. Do not describe its scan as
online merely because a standalone VALIDATE would use a weaker lock. A lock
timeout bounds waiting, not the time already spent holding a lock. See
[PostgreSQL 17 ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html)
and [client timeout semantics](https://www.postgresql.org/docs/17/runtime-config-client.html).

## Rollout evidence and failures

Follow the existing [go-live checklist](../../../../docs/GO_LIVE_ACTIVATION_CHECKLIST.md)
and [database restore runbook](db-restore.md). Production ArgoCD synchronization
remains manual. Relevant backend main pushes separately trigger the configured
Dalekdefender rig deployment; publishing this helper does not authorize that
deployment or make any merge generally inert.

Record the actual rendered Job/config hashes, effective role and session
settings, observed pre/post catalog definitions and `convalidated` flags, tracker
checksums, and every retained attempt log. Both configured migration Jobs have
a 900-second deadline; production allows two retries, the rig one. Capture logs
before TTL, resync or deadline handling removes evidence. A Job deadline is not
proof that a database lock was harmless.

The runner commits earlier migration files separately. A failure at 800 can
leave the database ahead of the previous image even if 800 itself rolled back;
nontransactional predecessor files can also leave untracked partial effects.
Do not reset checksums or treat a previous image as a database rollback. Preserve
evidence, stop automatic progression, and obtain operator/database-owner direction
for forward repair or the approved restore-to-new-cluster procedure. A green
preflight, CI run or Job does not close clinical exceptions or authorize release.
