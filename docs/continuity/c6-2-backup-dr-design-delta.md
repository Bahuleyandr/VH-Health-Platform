# C6.2 immutable backup, restore proof, and warm-standby design delta

**Status:** Step 2 inert repository implementation cleared 2026-07-31;
activation remains blocked

**Scope:** `infra/kubernetes`, `infra/ansible`, `docs`, and the single stale
C1.1 manifest-validator assertion required by the C6.2 identity split

**Branch:** `infra/c6-2-backup-dr`

**Baseline:** `github/main` at
`1f5c94e36623c6c392f55f85f43e03eec480f57f` (fetched 2026-07-31)

**Release state:** inert; every production Argo CD Application remains
manual-sync

**Merge state:** never merge from this slice

## 1. Outcome, authority, and non-overlap

This slice establishes a strictly ordered disaster-recovery contract:

1. activate an approved retention lock on the off-site database backup chain
   and prove a timed, disposable point-in-time restore through
   application-level clinical reads; then
2. build the countersigned warm standby on top of the accepted Phase 1
   evidence.

The binding authority is:

- plan section 9, C6.2;
- design section 5.8 and the design section 10 C6 rollback contract;
- C-D1, C-D9, and the C-D10 retention partial record in
  `docs/continuity/c0-4-owner-decision-dossier.md`; and
- the C1.1 backup, reader, verification, and restore-proof substrate already
  present under `infra/kubernetes/base/cnpg`.

C-D9 is closed and is not reopened. A warm standby second site is selected,
targeting approximately one hour to service restoration and seconds of data
loss. Those are owner-selected **warm-standby promotion** targets, not measured
claims. Phase 1 instead measures **restore-only** RTO and RPO from immutable
backup. C-D1 ratifies the restore-only figures after the first timed restore;
C-D9's targets are ratified separately from a Phase 2 end-to-end promotion
drill. A Phase 1 restore that takes, for example, 12 hours does not mean C-D9
is unmet. It quantifies why the warm site is required. Evidence always records
the two scenarios as separate rows and never rolls them into one figure.

The concurrent C4.2 work in PR 660 is backend-only. C6.2 owns only
infrastructure and documentation paths. There is no file overlap, and this
slice does not duplicate or edit C4.2 application enforcement.

## 2. Hard phase gate

Phase 1 and Phase 2 are not parallel activation tracks.

Phase 1 is complete only when all of the following are available outside the
primary site:

1. legal and security approval for the production database lock policy;
2. passing evidence from a non-production R2 bucket-lock trial;
3. proof that backup write, read/restore, lock administration, and eligible
   object deletion are separately controlled;
4. a timed PITR into disposable infrastructure using only the DR reader
   identity;
5. checksum, provider-side decryption, data-checksum, role/ownership, schema,
   migration, and application-level clinical-read proof;
6. measured restore RTO and RPO with an unambiguous timer and recovery point;
7. off-site, integrity-protected drill evidence; and
8. C-D1 owner ratification of the measured figures.

Until that gate is recorded as accepted:

- no DR site is procured or provisioned;
- no site-specific Kubernetes overlay, inventory, address, credential, or
  replication source is created;
- no cross-site database stream is opened;
- no warm-standby `Cluster` is applied or synced;
- no tunnel or DNS failover path is activated; and
- no repository or CI result may be described as DR readiness.

After coordinator clearance, generic held templates, preflight checks, and
runbook contracts may be committed alongside Phase 1. They are not a warm
site. They remain unreferenced by production Kustomizations and cannot contain
a real site, address, jurisdiction, credential, or endpoint. The first
site-specific Phase 2 implementation remains blocked on the accepted Phase 1
evidence above.

## 3. Existing substrate and corrections

C6.2 extends C1.1 rather than creating a second backup stack.

| Existing C1.1 surface | C6.2 treatment |
| --- | --- |
| `barman-cloud-object-store.yaml` | Preserve the Barman Cloud Plugin archive identity and 30-day database recovery policy; change credential and deletion enforcement only through the reviewed C6.2 contract |
| `scheduled-backup.yaml` | Keep it as the sole production base-backup schedule |
| `cnpg-backup-producer-credentials.sealed-secret.yaml.example` | Evolve the producer into an action-scoped writer contract; never place a deletion principal in the database namespace |
| `cnpg-dr-reader-credentials.sealed-secret.yaml.example` | Preserve the separate read-only verification/restore identity and add DR-site/evidence constraints |
| `r2-backup-hardening.yaml` and `verify-cnpg-backup.sh` | Preserve reader-only HEAD/GET verification and extend the evidence boundary; do not give the verifier write or delete authority |
| `dr-restore-drill.{yaml,sh}` | Preserve disposable, UID-preconditioned cleanup and extend it to approved target-time PITR, complete timing, and clinical application reads |
| `scheduled-restore-proof.{yaml,sh}` | Keep the quarterly schedule suspended; make it the operator-unlocked timed proof rather than adding a competing CronJob |
| `backup-network-policy.yaml` | Extend egress only for the exact evidence and DR contracts; do not expose PostgreSQL publicly |
| `pg18-upgrade-rehearsal.{yaml,sh}` | Preserve the separate upgrade qualification path; C6.2 does not duplicate it or imply that production has upgraded |
| C3.2b continuity-edge rules and C1.3 Alertmanager routing | Add C6.2 rule expressions with the existing `team` labels; do not create a receiver, route, or parallel delivery path |

Two older documents require explicit correction during implementation:

- `docs/DR_RESTORE_DRILL.md` currently presents unratified 5-minute/60-minute
  values as confirmed targets and leaves C6.2 controls deferred. It must state
  that the first timed drill produces the figures C-D1 then ratifies.
- `docs/CROSS_SITE_DR_FAILOVER_PLAN.md` predates C-D9 and describes
  backup-fed and replicated recovery as optional tracks. It must record warm
  standby as selected, make the Phase 1 precondition binding, and remove the
  stale assertion that RPO/RTO values are already leadership-approved.

The design-authoritative R2 wording is preserved:

> Object Lock (WORM): the S3 ObjectLock API remains unsupported on R2, but R2
> now provides native bucket locks (retention policies preventing
> overwrite/deletion for a period or indefinitely). Operator must verify
> availability on the actual account/bucket and trial on a non-production
> bucket before relying on it.

R2 object versioning is not a prerequisite and is not reintroduced.

## 4. Phase 1A — R2 bucket-lock activation path

R2 bucket locks are provider-side bucket configuration, not Kubernetes
resources. No production lock command or credential is committed.

The approved enablement path is:

1. create a dedicated non-production bucket containing synthetic Barman-shaped
   objects;
2. record the proposed rule ID, exact prefix, condition, duration, affected
   existing objects, lifecycle interaction, account, bucket, and jurisdiction
   header requirement;
3. obtain legal and security approval for the trial, including explicit
   acceptance that an effective lock prevents overwrite and deletion;
4. add the trial rule through the R2 dashboard's **Settings / Bucket lock
   rules**, a pinned Wrangler `r2 bucket lock add` or `r2 bucket lock set`
   invocation, or the reviewed Cloudflare
   `PUT /accounts/{account_id}/r2/buckets/{bucket_name}/lock` API;
5. retrieve the effective configuration independently and bind it to the
   evidence pack;
6. prove that new and already-covered synthetic objects cannot be overwritten
   or deleted while the rule applies;
7. prove the expected interaction with the synthetic lifecycle/removal job,
   including the strictest-rule behavior when rules overlap;
8. complete the trial through its approved expiry/removal procedure and retain
   the result off-site; and
9. submit a separate operator-reviewed production change using the approved
   database prefix and duration.

Cloudflare documents that bucket-lock rules apply to new and existing covered
objects, the strictest applicable rule wins, and a lock takes precedence over
lifecycle deletion. The implementation runbook must verify those behaviors on
the actual account rather than relying only on documentation.

Locked objects are intentionally **not rollback-deletable**. Pre-activation
rollback means not applying the production rule. After activation, rollback
may stop a future rule from covering later objects only through the approved
provider procedure; it does not promise deletion or overwrite of objects still
protected by an effective rule. Failure evidence and the recoverable backup
generation are retained.

References:

- <https://developers.cloudflare.com/r2/buckets/bucket-locks/>
- <https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/locks/>

## 5. Phase 1B — retention reconciliation

C-D10 does not assign one retention period to all continuity data.

| Data class | Governing value | Reason |
| --- | --- | --- |
| Continuity packs | Purge 7 days after signed expiry; packs expire 24 hours after generation | Bounded edge working set for reconciliation and incident review, after which patient data is purged and not reconstructed |
| Edge access logs | 365 days | Existing operational-audit retention baseline |
| CNPG database base backups and WAL | Current Barman recovery policy is 30 days; the production bucket-lock rule may not be shorter and requires legal/security approval | A physical PITR recovery chain, not a continuity pack or access log; base backup and required WAL must remain recoverable together |
| Restore/failover evidence | Owner/legal retention input remains required | Evidence must outlive the affected-site incident and ratification process, but engineering does not invent a clinical/legal retention value |

The effective database object retention is the longer of:

- the C1.1 Barman eligibility boundary;
- every applicable bucket-lock rule; and
- any legal hold.

Syncing C6.2 stops automatic database-backup pruning because the production
`ObjectStore` no longer delegates deletion to the writer and the separate
retention-removal CronJob is suspended by default. R2 storage therefore
accumulates without bound until operators provision its scoped credential,
complete the required approvals, and activate the remover; this fail-safe
accumulation and its cost consequence are intentional.

A 30-day Barman policy therefore does not promise deletion at day 30. A longer
lock or hold intentionally postpones deletion. Conversely, the database lock
must not be shortened to the continuity-pack interval or replaced by the
365-day access-log value merely because those values are countersigned. They
govern different data and purposes.

Before production activation, legal, security, privacy, infrastructure, and
the backup/recovery owner approve the exact database prefix and lock duration.
C6.2 preserves the current 30-day recovery policy as repository truth but does
not silently convert it into legal approval.

The `7d` retention policy in
`infra/kubernetes/base/cnpg/pg18-upgrade-rehearsal.yaml` belongs only to a
disposable synthetic upgrade-rehearsal archive. It is neither the production
database policy nor C-D10's continuity-pack value, despite the coincidental
number, and must not be “harmonized” with either.

## 6. Phase 1C — identity and deletion-authority split

The target has four distinct principals. No workload mounts more than one.

| Principal | Allowed capability | Forbidden capability | Custody |
| --- | --- | --- | --- |
| Backup writer | Required list/head/read, put/copy, and multipart actions on the exact database archive prefix | `DeleteObject`, `DeleteObjects`, bucket configuration, evidence access outside its prefix | CNPG/Barman sidecar receives a short-lived, prefix- and action-scoped session credential |
| DR reader | List/head/get on the approved backup prefix | Write, overwrite, multipart upload, delete, bucket configuration | Restricted restore/verifier namespace at the primary site and separately sealed DR-site namespace |
| Retention remover | List/head/get plus delete only on objects already eligible under the approved Barman boundary and no longer locked | Put/overwrite, bucket-lock configuration, deletion of the only recoverable generation, deletion of evidence | Dedicated suspended removal workload; short-lived credential released only after the approval gate |
| Lock administrator | Read and update the exact bucket-lock configuration | S3 object read/write/delete and Kubernetes secret access | Legal/security-controlled provider API token outside database workloads |

Cloudflare R2 temporary credentials support a bucket, explicit object paths or
prefixes, a short lifetime, and locally signed action lists. The writer action
list includes only the operations proven necessary by the pinned Barman Cloud
Plugin and explicitly excludes both delete actions. The parent credential and
signing function are not placed in PostgreSQL pods. The Barman plugin must be
qualified with the `ACCESS_SESSION_TOKEN` path before the direct long-lived
producer token is retired.

The current C1.1 producer is bucket-scoped Object Read & Write because that was
the provider-supported long-lived token shape and Barman enforced retention
itself. C6.2 must not merely rename that credential and claim separation.
Activation requires:

1. a synthetic Barman backup and WAL archive using the action-scoped writer;
2. rotation before the temporary credential expires without losing WAL;
3. negative proof that writer and reader cannot delete;
4. negative proof that the retention remover cannot put or overwrite;
5. proof that the lock administrator cannot access S3 object data; and
6. proof that revoking a parent credential invalidates its issued sessions.

If the pinned Barman/plugin/session-token combination cannot pass those tests,
the identity-split gate remains failed. The existing C1.1 producer stays in
place, the production lock is not represented as fully activated, and C6.2
does not weaken healthy backup production to force the new shape through.

Normal deletion is an automated retention action, not an operator browsing the
bucket:

- the database, backup/recovery, security, and legal owners approve the
  recurring removal policy and its evidence before the suspended remover may
  be activated;
- each run selects only objects beyond the approved Barman boundary whose
  effective provider lock has expired, proves another recoverable generation,
  records object identities and the rule state, and fails closed on ambiguity;
- ad hoc or early deletion requires a separately recorded two-person
  security/legal approval plus the backup/recovery owner; and
- no approval can make an actively locked object rollback-deletable.

References:

- <https://developers.cloudflare.com/r2/api/s3/temporary-credentials/>
- <https://cloudnative-pg.io/plugin-barman-cloud/docs/intro/>

## 7. Phase 1D — timed disposable PITR proof

The existing `cnpg-scheduled-restore-proof` remains scheduled quarterly and
`suspend: true`. It may be unsuspended only for a named, approved drill window
after the lock and identity preflight passes. It creates no credential and
never copies the producer or retention-remover Secret.

One run has this fixed sequence:

1. capture the source `Cluster`, exact PostgreSQL image, archive/server
   identity, selected base-backup ID, required WAL range, provider lock
   configuration, object metadata, and reader identity;
2. record an approved RFC 3339 recovery target that is earlier than the newest
   archived WAL and later than the selected base backup;
3. start the RTO timer immediately before the first restore action;
4. create a run-unique disposable namespace, reader `ObjectStore`, and CNPG
   recovery `Cluster` using only the DR reader;
5. perform a real target-time PITR, not merely recovery of the latest backup;
6. verify provider retrieval/decryption, sampled object SHA-256 values,
   PostgreSQL data checksums, application roles and ownership, extensions,
   schema checksum, and migration ledger;
7. run representative read-only application checks under the runtime/read
   role for tenants, admissions, the canonical clinical timeline, clinical
   audit, and migration state;
8. stop the RTO timer only after the candidate application reports ready and
   every mandatory clinical read passes;
9. derive RPO from the approved recovery target and the latest safely
   recoverable/validated clinical point, recording both timestamps and the
   relevant WAL/LSN evidence;
10. construct a checksummed evidence manifest containing command versions,
    timestamps, object/backup IDs, image digests, query definitions, bounded
    aggregate results, pass/fail outcomes, and approvers;
11. upload the evidence with a separate off-site evidence writer, read it back
    with a separate evidence reader, and record its effective retention/lock;
    and
12. delete only the run-created Kubernetes resources whose labels and UIDs
    still match. Keep credentials, backup objects, lock records, evidence, and
    the recoverable generation.

The clinical checks are gates, not plausibility-only decoration:

| Check | Passing rule |
| --- | --- |
| Tenants | Count and expected identifiers match the approved baseline |
| Admissions | Active census is reconciled with the baseline and downtime ledger; unexplained loss blocks acceptance |
| Canonical timeline | Maximum occurrence/creation point and aggregate count are within the selected recovery boundary and measured RPO |
| Clinical audit | Audit chain coverage and aggregate relationship to restored clinical writes pass the existing audit verifier |
| Migrations | Finished migration set and checksums match the candidate release; migrations run only through the normal migration job |
| Application clinical read | A synthetic or specifically approved test patient/encounter is readable through the normal application contract under tenant isolation |

No production traffic or write is sent to the disposable cluster. Evidence
contains aggregate or synthetic results and no direct patient identifiers.

This first timed drill is the **restore-only** measurement event C-D1 deferred
to. Repository CI, database-ready time alone, the existing latest-backup
script, or a synthetic manifest render cannot produce or ratify those
restore-only RTO/RPO numbers. It does not measure the separate C-D9
warm-standby promotion target.

## 8. Phase 1 acceptance record

The off-site evidence pack must state:

- exact source commit, rendered-manifest checksums, image digests, CNPG and
  Barman Plugin versions;
- account/bucket/prefix identifiers without credentials;
- bucket-lock rule and independent retrieval proof;
- backup ID, server/archive identity, base-backup time, target time, achieved
  recovery point, and WAL/LSN boundary;
- RTO start, database-ready, application-ready, mandatory-clinical-read, and
  teardown timestamps;
- measured RTO and RPO with calculation inputs;
- positive and negative identity tests;
- checksum, decryption, role/ownership, schema, migration, tenant, timeline,
  audit, and admission results;
- every operator and owner approval;
- evidence-object checksum, off-site location, and retention/lock state; and
- findings, aborted steps, cleanup receipts, and unresolved holds.

Its objective table always has two rows:

| Scenario | Evidence source | Decision authority | Status in Phase 1 |
| --- | --- | --- | --- |
| Immutable-backup restore-only RTO/RPO | Timed disposable PITR, ending after required application-role clinical reads | C-D1 | Measured in Phase 1 and submitted for ratification |
| Warm-standby service-restoration RTO/RPO | Phase 2 promotion drill, including fencing, promotion, secret/trust restoration, application validation, continuity-source transition, and traffic change | C-D9 | `NOT_RUN_PHASE_2`; never inferred from the restore-only row |

Any missing value is a failed gate, not `N/A`, unless the runbook names and
justifies that field as structurally inapplicable.

## 9. Phase 2 architecture — selected warm standby

After Phase 1 acceptance, the database topology is a CloudNativePG
**distributed topology replica cluster** at the approved second site.
Standalone promotion-only replica mode and restore-on-demand
"backup-fed warm standby" are not the selected steady state.

The selected transport is hybrid asynchronous continuous recovery:

- PostgreSQL physical streaming replication over the approved private link is
  the low-lag path needed to pursue the seconds-of-data-loss target; and
- the Phase 1-proven R2 Barman archive remains the bootstrap, WAL catch-up,
  PITR, and re-seed path.

Backup shipping alone cannot substantiate a seconds target. Streaming alone
would make the DR posture dependent on the primary site and private link.
Hybrid recovery keeps the immutable archive as an independent recovery source
while allowing measured low replication lag during normal operation.

The cross-site replica is asynchronous. The primary site's existing
synchronous three-node policy is not stretched across the site link, so a
private-link outage cannot block hospital commits. Consequently, zero data
loss is not claimed: the observed replay LSN/timestamp and last archived WAL
determine the achieved RPO.

CloudNativePG distributed topology is selected because it models a global
primary and supports controlled demotion/promotion with a promotion token.
An unplanned failover still requires the former primary to be treated as
diverged and rebuilt before it can rejoin.

Reference:
<https://cloudnative-pg.io/documentation/current/replica_cluster/>.

### 9.1 Site independence and private connectivity

The DR site has a separate Kubernetes/RKE2 control plane, etcd, storage,
Longhorn volumes, node disks, power, switching, and failure domain. It does not
stretch the primary site's etcd, local-path volumes, Longhorn replicas, VRRP,
or control-plane quorum across sites.

PostgreSQL streaming is reachable only across the owner-approved private link.
The design requires:

- mutually authenticated TLS with a dedicated replication role and
  site-specific certificate;
- exact source/destination address and port allowlists;
- no public PostgreSQL listener;
- monitored replication lag, WAL-receiver state, archive freshness, link
  health, and credential expiry;
- a rehearsed cyber-isolation control that can sever the stream without
  destroying the immutable backup path; and
- an independent incident communication path.

Private-link vendor, bandwidth, latency, procurement, addresses, and route
remain operator/executive inputs.

### 9.2 Secrets and trust

Git carries only non-secret desired state and site-specific SealedSecret
examples/ciphertext generated for the selected site's sealing key. The DR site
does not receive the primary Sealed Secrets controller private key merely to
make old ciphertext decrypt.

The activation inventory covers at least:

- database runtime, owner/migration, read-only, replication, DR reader, and
  evidence credentials;
- Barman Plugin trust and exact object-store endpoint;
- application encryption/signing keys and required historical generations;
- JWT, session, Firebase, FHIR/ABDM, messaging, and integration secrets needed
  by the approved recovery claim;
- internal CA trust, current/next certificate pins, service certificates, and
  tunnel/DNS credentials; and
- off-site secret-custody recovery references and rotation owners.

Each secret has a source of authority, site audience, restore order, freshness
rule, rotation/revocation procedure, and a non-secret verification method.
Copying every primary Secret is forbidden; omitting a load-bearing historical
key is also forbidden.

### 9.3 Object-storage access from DR

The DR cluster gets its own sealed read-only R2 credential and exact egress
policy. It never receives the primary backup writer, retention remover, lock
administrator, or credential-issuer principal.

Object-store preflight proves the selected jurisdictional endpoint, DNS, TLS,
HEAD/GET/list for the approved archive, Barman server identity, base-backup
catalogue, WAL reachability, and reader-denied write/delete. A second-provider
or air-gapped copy remains an owner/security decision; this delta does not
silently choose one.

### 9.3.1 Continuity-edge source transition

The continuity edge remains pull-only during site failover. After the DR site
is promoted and its application publication path passes the clinical and
signature gates, the DR site becomes the authoritative continuity-pack
publication and pull source. DNS/tunnel routing changes only after that
publication proves the same logical facility identity, trusted signing chain,
monotonic manifest/policy/revocation generations, and an access revision not
below the edge's persisted floor.

Changing site or transport identity does **not** reset edge state. The edge
retains its highest accepted manifest, policy, revocation, access-revision, and
trusted-time floors, along with its last valid signed set. It rejects a DR
publication that rolls any floor backward, even if the TLS endpoint or
publication host is new. A source change uses an owner-approved endpoint and
trust mapping; it never bootstraps a new empty anti-rollback ledger.

If neither site is reachable, the edge continues serving only its last
cryptographically valid set and only until that set's signed expiry. It stops
serving the expired set; loss of both pull sources does not extend
`fresh_until`, reset access revision, or authorize a local override. The
promotion evidence records the old and new source identities, source-switch
time, preserved floors, first accepted DR manifest, and any interval in which
the edge was serving its last valid set.

### 9.4 C1.2 and C2.1 at the second site

C1.2's control-plane VIP and C2.1's internal-ingress VIP are **duplicated per
site, not extended across sites**.

- The DR RKE2 servers have a distinct site-local control-plane VIP, VRID,
  unicast peer set, interface, source addresses, and bootstrap host.
- The DR internal ingress has its own controller identity, site-local VIP,
  VRID, client CIDRs, firewall ledger, certificate, EndpointSlice/monitoring
  identity, and held-route contract.
- VRRP packets, etcd membership, and Longhorn replication never cross the
  inter-site link.
- Split-horizon DNS and the Cloudflare tunnel/load-balancer path select which
  site's ingress is active. A DNS/tunnel change never attempts to move a LAN
  VIP between sites.
- The DR internal route preserves C2.1's explicit host ledger, header
  sanitization, tenant Host contract, TLS/pin contract, and held classes.

The site-specific addresses, DNS behavior, certificate material, and tunnel
credentials remain activation inputs. No defaults are invented.

## 10. Promotion runbook contract

Every planned exercise and incident uses the same recorded state machine.
Traffic is the last step.

1. Declare the incident, invoke the downtime procedure, name the incident
   commander and clinical lead, and start the total-service timer.
2. Establish a fencing decision for the primary writer. If the primary cannot
   be proven stopped or isolated, promotion is blocked unless incident
   authority explicitly accepts the split-brain risk in the evidence.
3. Capture both sites' CNPG state, LSNs/timestamps, replication lag, archive
   freshness, private-link state, and selected promotion mode.
4. For a planned switchover, demote the old primary and bind the resulting
   promotion token to the simultaneous DR topology change. For an unplanned
   failover, record that the old primary must be re-cloned.
5. Restore and verify the site-specific secret/trust inventory without
   exporting or reusing prohibited primary-site credentials.
6. Promote the DR database and prove one writable global primary, the new
   timeline, archive continuity, and the absence of an old writable primary.
7. Sync application manifests manually. Run migrations only through the
   normal PreSync migration Job; no hand-written production SQL is permitted.
8. Validate application readiness, authentication, WebSockets, object
   storage, and required integrations.
9. Run the tenant, migration, timeline, audit, admission, and
   application-clinical-read invariants. Any unexplained failure blocks
   traffic.
10. Change the approved Cloudflare tunnel/load-balancer and split-horizon DNS
    path. Record TTL, resolver, certificate/pin, route, and rollback evidence.
11. Run external and hospital-LAN clinical reads, then the explicitly approved
    bounded write probe. Confirm one-writer behavior and audit/timeline
    creation.
12. Stop the service-restoration timer only when the approved clinical surface
    is usable. Retain measured RTO/RPO and all receipts off-site.

An approximately one-hour RTO and seconds-level RPO are evaluated against this
end-to-end timer and recovery point. Database promotion time alone is not RTO.

## 11. Failback runbook contract

Failback is separately approved and rehearsed. It is not assumed to be the
promotion sequence in reverse.

After an unplanned promotion, the former primary is considered divergent even
if it returns apparently healthy. It is fenced, its incident evidence is
preserved, and it is rebuilt as a replica of the new primary using the
Phase 1-proven backup/archive plus streaming catch-up. Its old data volumes are
not reattached as authoritative.

Failback then requires:

1. a new immutable backup and restore verification from the current DR
   primary;
2. a clean replica bootstrap at the recovered original site;
3. sustained zero/approved lag and full secret, trust, application, ingress,
   and clinical-invariant proof;
4. a new change window and explicit primary/destination names;
5. controlled demotion, promotion-token transfer, and promotion;
6. application and DNS/tunnel cutback only after the same clinical gates; and
7. evidence that the temporary DR-primary role is removed without creating
   two writers.

If the old site cannot be rebuilt cleanly, DR remains primary. Time pressure
does not authorize symmetric failback, timeline rewind, dual primary, or
pointing traffic at stale storage.

## 12. Data residency boundary

The platform posture is India-first. The jurisdiction, operator, and physical
location of the second site and every backup/evidence copy are owner,
privacy/legal, and security decisions.

This delta records no city, provider, region, R2 jurisdiction, cross-border
transfer, or adequacy determination. A missing jurisdiction decision blocks
site-specific Phase 2 work; engineering does not select a location by
convenience.

## 13. Operator and executive holds

The repository may define validation shape, but the following remain outside
engineering authority:

- second-site selection and jurisdiction;
- hardware, hosting, support, and recurring operating budget/procurement;
- private-link vendor, bandwidth, routes, addresses, and activation;
- production bucket-lock prefix/duration and legal/security approval;
- credential-issuer and evidence-retention custody;
- named drill windows for PITR, promotion, and failback;
- DNS, tunnel, and primary-fencing authority; and
- C-D1 ratification of the Phase 1 measured RTO/RPO, followed by evaluation of
  warm-standby promotion measurements against C-D9's approximate targets.

Unfilled owner fields remain explicit blockers. Repository placeholders are
not defaults.

## 14. Step 2 file ledger after clearance

Step 1 adds only this document. No implementation file is changed.

After coordinator clearance, the intended inert implementation ledger is:

### Modify

- `infra/kubernetes/base/cnpg/barman-cloud-object-store.yaml`;
- `infra/kubernetes/base/cnpg/cnpg-backup-producer-credentials.sealed-secret.yaml.example`;
- `infra/kubernetes/base/cnpg/cnpg-dr-reader-credentials.sealed-secret.yaml.example`;
- `infra/kubernetes/base/cnpg/r2-backup-hardening.yaml`;
- `infra/kubernetes/base/cnpg/backup-network-policy.yaml`;
- `infra/kubernetes/base/cnpg/dr-restore-drill.yaml`;
- `infra/kubernetes/base/cnpg/dr-restore-drill.sh`;
- `infra/kubernetes/base/cnpg/scheduled-restore-proof.yaml`;
- `infra/kubernetes/base/cnpg/scheduled-restore-proof.sh`;
- `infra/kubernetes/base/cnpg/kustomization.yaml`;
- `infra/kubernetes/base/monitoring/alert-rules.yaml`;
- `scripts/check-c1-1-manifest-contract.mjs` (validator-only: move the 30-day
  assertion from Barman's writer-owned deletion field to C6.2's external
  remover boundary);
- `infra/ansible/README.md`;
- `docs/DR_RESTORE_DRILL.md`;
- `docs/CROSS_SITE_DR_FAILOVER_PLAN.md`;
- `docs/qa-findings/cross-site-dr-promotion-template.md`; and
- this design delta, status/receipt updates only.

### Add

- `infra/kubernetes/base/cnpg/cnpg-retention-remover-credentials.sealed-secret.yaml.example`;
- `infra/kubernetes/base/cnpg/cnpg-restore-evidence-credentials.sealed-secret.yaml.example`;
- `infra/kubernetes/base/cnpg/c6-2-retention-removal.yaml`;
- `infra/kubernetes/base/cnpg/c6-2-retention-removal.sh`;
- `infra/kubernetes/held/c6-2-warm-standby/kustomization.yaml`;
- `infra/kubernetes/held/c6-2-warm-standby/cluster-template.yaml`;
- `infra/kubernetes/held/c6-2-warm-standby/network-policy.yaml`;
- `infra/kubernetes/qa/c6-2-backup-dr-contract.mjs`;
- `infra/ansible/playbooks/c6-2-dr-site-preflight.yml`;
- `infra/ansible/tests/c6_2_contract.yml`;
- `docs/runbooks/C6_2_R2_LOCK_AND_RESTORE_DRILL.md`;
- `docs/runbooks/C6_2_WARM_STANDBY_PROMOTION_FAILBACK.md`; and
- `docs/qa-findings/c6-2-restore-evidence-template.md`.

The held warm-standby Kustomization is rendered and validated directly but is
not referenced by `base`, `overlays/prod`, or an Argo Application. It contains
sentinel values only and cannot provision a site. The Ansible playbook is
assert/read-only preflight; it does not install RKE2, change a route, open a
link, or restore a snapshot.

If implementation discovery proves that a listed file is unnecessary or that
the pinned Barman/CNPG API needs a different in-scope file, work stops for a
coordinator-visible ledger amendment rather than silently widening scope.

## 15. Validation and receipt contract

Step 2 repository receipts must include:

- `git diff --check`;
- direct Kustomize renders for every changed production source and the held DR
  template;
- strict `kubeconform` over the rendered resources, with only documented CRD
  schema exceptions;
- the C6.2 contract test;
- `ansible-lint`, syntax checks, and positive/negative DR preflight fixtures;
- `node scripts/ci/run.mjs --only=infra`;
- assertions that all production Argo Applications remain manual-sync;
- assertions that the restore and retention-removal schedules remain
  suspended;
- assertions that evidence contains distinct C-D1 restore-only and C-D9
  warm-promotion rows, with Phase 1 unable to populate the C-D9 row;
- assertions that C6.2 alerts use C1.3's existing `backup`/`database` team
  routes and add no receiver or routing resource;
- assertions that the held DR template is unreferenced by production;
- assertions that no real credential, site, jurisdiction, IP address, private
  link, DNS change, tunnel token, bucket-lock activation, or automatic sync is
  present;
- negative credential tests proving writer/reader deletion denial and remover
  overwrite denial in the non-production trial contract; and
- `git diff --stat github/main...HEAD`,
  `git diff --name-status github/main...HEAD`, and the reviewed three-dot
  intent diff.

Repository validation does not execute:

- a Cloudflare API or Wrangler mutation;
- a live R2 read, write, delete, or lock operation;
- a Kubernetes apply/sync;
- a real credential mint or rotation;
- a PITR, promotion, DNS/tunnel change, or failback;
- an Ansible change against a host; or
- any DR-site provisioning.

Green repository receipts prove only that the inert contract renders and fails
closed. They do not satisfy either phase's operator gate.

## 16. Rollback and non-goals

Before activation, rollback is a repository revert. Manual-sync Argo state
keeps the committed artifacts inert.

After Phase 1 activation:

- stop future backup/removal jobs only through the approved operational
  procedure;
- preserve healthy WAL archiving and the last recoverable generation;
- do not delete evidence or credentials required to prove recovery;
- rotate a compromised principal without combining writer, reader, remover,
  and lock-admin authority; and
- accept that an effective bucket lock prevents overwrite/deletion until its
  governing condition permits it.

After Phase 2 activation, failback follows section 11 and is never treated as a
manifest revert.

This slice does not:

- touch a live cluster, host, bucket, DNS zone, tunnel, or provider account;
- create or use real credentials;
- enable a production bucket lock;
- provision a DR site or private link;
- activate replication, ingress, DNS, or applications;
- change clinical policy or C4.2 backend behavior;
- infer a data-residency jurisdiction;
- claim measured or ratified RTO/RPO; or
- merge the branch.
