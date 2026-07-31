# C6.2 R2 lock and restore-only drill

**State:** repository contract only; no provider or cluster action is
authorized by this document.

This runbook completes Phase 1 before any site-specific warm-standby work.
Its result is an immutable-backup **restore-only** RTO/RPO measurement for
C-D1. It does not measure C-D9's separate warm-standby promotion target.

## Hard stops

Stop before a production action unless all of these are recorded:

1. named legal, privacy, security, infrastructure, and backup/recovery owners;
2. approved database archive account, bucket, prefix, jurisdiction header, lock
   rule ID, condition, and duration;
3. passing non-production lock trial;
4. qualified short-lived writer, reader, remover, evidence-writer, and
   evidence-reader credentials;
5. an approved disposable drill window and target time;
6. an approved PHI-free clinical-read fixture and baseline;
7. a protected off-site evidence destination and retention/lock decision; and
8. confirmation that `cnpg-scheduled-restore-proof` and
   `cnpg-retention-removal` are still suspended.

Repository merge, Kustomize render, or CI cannot satisfy a hard stop.

## Retention classes

These values are deliberately not one policy:

| Data | Boundary |
| --- | --- |
| Production CNPG base backups and required WAL | 30-day recovery boundary; effective retention is the longer of this boundary, every bucket-lock rule, and legal hold |
| Continuity packs | Purge 7 days after signed expiry under C-D10 |
| Continuity-edge access logs | 365 days under C-D10 |
| PG18 upgrade-rehearsal archive | Disposable synthetic `7d`; unrelated to both production database retention and the coincidental C-D10 pack value |
| Restore/failover evidence | Owner/legal input; no value is invented here |

A 30-day boundary is not a promise of deletion on day 30. A longer lock or
legal hold wins.

## Four database authorities

| Identity | Allowed | Explicitly denied |
| --- | --- | --- |
| Backup writer | Qualified list/head/read, put/copy, and multipart actions on `cluster/` | `DeleteObject`, `DeleteObjects`, lock configuration |
| DR reader | List/head/get on the approved archive | Put, multipart write, overwrite, delete, lock configuration |
| Retention remover | List/head/get/delete for exact approved eligible objects | Put, overwrite, lock configuration, evidence access |
| Lock administrator | Read/update exact bucket-lock configuration | S3 object read/write/delete and Kubernetes Secret access |

R2 temporary credentials carry `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, and
`ACCESS_SESSION_TOKEN`. The parent signing credential is never mounted in
CNPG, verifier, restore, or remover Pods. No workload mounts two database
authorities.

## Non-production bucket-lock trial

Use a dedicated synthetic bucket and a Barman-shaped synthetic prefix. Never
substitute the production bucket.

### Dashboard path

Open R2, choose the synthetic bucket, open **Settings**, find **Bucket lock
rules**, select **Add rule**, and enter the approved rule name, prefix, and
retention period. Save only in the approved trial window.

### Wrangler path

Pin the reviewed Wrangler version and capture it in evidence:

```bash
npx wrangler@<PINNED_VERSION> --version
npx wrangler@<PINNED_VERSION> r2 bucket lock add \
  <SYNTHETIC_BUCKET> <REVIEWED_OPTIONS>
npx wrangler@<PINNED_VERSION> r2 bucket lock list \
  <SYNTHETIC_BUCKET>
```

For a reviewed complete configuration:

```bash
npx wrangler@<PINNED_VERSION> r2 bucket lock set \
  <SYNTHETIC_BUCKET> --file <REVIEWED_LOCK_JSON>
```

Do not paste a production command from this runbook. Resolve
`<REVIEWED_OPTIONS>` from the pinned CLI help and bind its output to the
change record.

### API path

The reviewed API operation is:

```text
PUT /client/v4/accounts/<ACCOUNT_ID>/r2/buckets/<BUCKET_NAME>/lock
```

Its JSON body contains the complete `rules` collection. The lock-administrator
token needs only the exact R2 bucket-configuration permission. If the bucket
has a jurisdictional restriction, include the approved `cf-r2-jurisdiction`
header. Retrieve the configuration independently after the update.

### Required trial proof

1. Record objects before the rule.
2. Apply the rule to the exact synthetic prefix.
3. Prove the rule covers both existing and new objects.
4. Prove overwrite and delete are denied while effective.
5. Prove the strictest/longest rule wins when rules overlap.
6. Prove the lock takes precedence over lifecycle/removal.
7. Exercise the approved rule-removal/expiry procedure.
8. Confirm removing a rule does not promise deletion of objects still covered
   by another effective rule.
9. Retain provider responses, audit records, object metadata, hashes, and
   approvers off-site.

Locked objects are intentionally **not rollback-deletable**. Pre-activation
rollback is “do not add the production rule.” After activation, do not promise
overwrite or deletion before the effective rule permits it.

## Credential qualification

Against synthetic data:

1. run a base backup and continuous WAL archive with the action-scoped writer;
2. rotate it before temporary-credential expiry without losing WAL;
3. prove writer and reader cannot delete;
4. prove reader cannot write;
5. prove remover cannot put or overwrite;
6. prove the lock administrator cannot read an object;
7. prove the remover receives only an exact, checksum-bound inventory; and
8. prove locked deletion fails without widening any principal.

The production Barman `ObjectStore` has no `retentionPolicy` because its writer
has no delete action. The `30d` annotation records the eligibility boundary.
Only the suspended `cnpg-retention-removal` workload executes exact approved
deletes. Its approval ConfigMap is intentionally absent from Git, execution
defaults false, and a wildcard key is rejected.

## Timed disposable PITR

The scheduled proof remains quarterly and `suspend: true`. Before a named
window, replace every `OWNER_INPUT` in
`infra/kubernetes/base/cnpg/scheduled-restore-proof.yaml`, seal namespace-local
temporary credentials, and record the manifest digest. Never commit the
resolved values.

One run performs:

1. DR-reader object listing, encrypted-object retrieval, metadata and sampled
   checksum verification;
2. an approved RFC3339 target-time PITR into the fixed isolated restore
   namespace;
3. PostgreSQL image, data-checksum, role, schema checksum, migration, tenant,
   active-admission, clinical-timeline, and clinical-audit checks;
4. a read-only application clinical probe using a synthetic or specifically
   approved test record;
5. RTO timing from the first restore action through the passing application
   probe;
6. restore-only RPO calculation from the captured source safe point and
   approved target;
7. PHI-free evidence construction;
8. off-site upload through the evidence writer and checksum readback through
   the separate evidence reader; and
9. UID-preconditioned deletion of only run-created Jobs, Cluster, and
   ObjectStore.

The manual workstation path is:

```bash
infra/kubernetes/base/cnpg/dr-restore-drill.sh
```

It requires all target, baseline, application-probe, lock-proof, source-commit,
run-ID, and protected evidence-output variables. Its output must then be
uploaded and independently read back with the separated evidence identities.

No production traffic or writes reach the disposable candidate.

## Two objective rows

Every evidence record includes both rows and never merges them:

| Scenario | Measurement | Authority |
| --- | --- | --- |
| Immutable-backup restore-only | Measured by this PITR through the application clinical-read gate | C-D1 ratifies |
| Warm-standby promotion | `NOT_RUN_PHASE_2` in this run; target remains approximately one hour and seconds of loss | C-D9 is evaluated later by an end-to-end promotion drill |

A 12-hour restore-only result does not mean C-D9 failed. It is quantified
evidence supporting the warm site's necessity.

## Alert delivery

C6.2 adds Prometheus rules with `team: backup` for lock, restore-proof, and
retention-removal signals, and `team: database` for cross-site replication
lag. C1.3's existing Alertmanager routing tree and receivers are reused.
C6.2 creates no receiver, route, credential, or delivery activation.

## Acceptance and cleanup

Copy
`docs/qa-findings/c6-2-restore-evidence-template.md`, complete every required
field, checksum it, upload it off-site, and read it back independently. C-D1
ratification is required before Phase 1 is accepted.

Cleanup removes only disposable Kubernetes resources whose expected labels and
created UIDs still match. It never deletes database backup objects, lock
records, credentials, or evidence. Failure to clean up is recorded; it is not
hidden by deleting evidence.

References:

- <https://developers.cloudflare.com/r2/buckets/bucket-locks/>
- <https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/locks/>
- <https://developers.cloudflare.com/r2/api/s3/temporary-credentials/>
