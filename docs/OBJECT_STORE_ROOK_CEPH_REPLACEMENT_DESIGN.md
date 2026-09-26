# Rook/Ceph object-store replacement: decision and qualification design

> **Status: NOT QUALIFIED — design only.** The owner selected Rook/Ceph for
> investigation, not installation, migration, credential creation, cutover, or
> deployment. The local MinIO/Harbor configuration and new archive production
> are held pending qualification; the independent R2 archive verifier is
> retained. No configuration or production data is changed by this document.
> A green manifest render or S3 smoke test would not by itself qualify retention,
> restore, failure tolerance, or clinical use.

## Decision boundary and current repository evidence

The historical, non-composed repository manifest declares one MinIO Tenant
with one four-server pool, four
`local-path` 100 GiB volumes per server, EC:4, and **preferred**, not required,
host spreading (`infra/kubernetes/held/local-object-storage/minio/tenant.yaml:1-21,85-136`). On the
documented three-node cluster, one node can host two servers. Neither the MinIO
layout nor a three-node Ceph proposal can be called independent rack, power,
switch, room, or facility storage without measured placement and facilities
evidence. The manifest declares three buckets: `vhhealth-records` and
`vhhealth-backups` with Object Lock requested, and `harbor-registry` without it
(`tenant.yaml:163-180`). The manifest itself warns that the record bucket's
existing live instance may not have been created with Object Lock; inspect its
actual versioning, lock configuration, per-version retention and legal holds
before treating it as protected (`tenant.yaml:167-173`). Repository declarations
are not live-cluster receipts. The corresponding Harbor and MinIO manifests
are retained byte-identically under `infra/kubernetes/held/local-object-storage/`
and are excluded from active composition, not an installation recipe.
The Longhorn Helm values historically referenced a **fourth**, undeclared
`longhorn-backups` bucket and `longhorn-s3-secret` MinIO credential
(source: `git show 95baac6b534f611771d2f7a6d8ee9114b45dd086:infra/kubernetes/base/longhorn/longhorn-app.yaml`,
lines 63-68 and 139-149). Neither
that reference nor its example `mc mb` command proves the bucket or any backup
ever existed. Longhorn itself remains unqualified; its local backup target is
being held with this change rather than silently repointed to Rook.

**Absence evidence (2026-09-26):** the owner attested that VH Health MinIO and
Harbor have never been deployed elsewhere. A bounded inspection of root Dalek
Kubernetes metadata found no VH Health MinIO/Harbor resources; the unrelated
`khata-minio` is outside this program. That observation is not an all-cluster
or historical data inventory. There is presently no identified VH MinIO source
to migrate, so first-install qualification is the active design path. A
version-preserving source migration applies **only if** a future inventory
discovers a real source, with its own owner authorization and evidence. Neither
the attestation nor the metadata check proves Rook/Ceph fit for clinical data.

Harbor's registry blob store is configured to use S3 bucket `harbor-registry`,
the MinIO API alias, and a distinct Secret
(`infra/kubernetes/held/local-object-storage/harbor/harbor-values.yaml:45`). Its historical S3 client
sets `secure: true` **and** `skipverify: true` because the MinIO alias is absent
from the operator certificate's SANs (`harbor-values.yaml:55-59`,
`tenant.yaml:30-35`). A Ceph cutover must not retain disabled certificate
verification. The backend's archive producer is configured to read the local
`vhhealth-records`
bucket through the MinIO endpoint covered by the operator-managed certificate,
stages a full source
copy, encrypts an archive, and uploads it to Cloudflare R2; its independent
verifier reads R2 (`infra/kubernetes/apps/backend/configmap.yaml:116`,
`infra/kubernetes/apps/backend/backup-cronjob.yaml:1`,
`infra/kubernetes/apps/backend/upload-archive.sh:109`,
`infra/kubernetes/apps/backend/backup-verification-cronjob.yaml:1`). The format is
currently named `vhhealth-minio-archive-v1`. The 10 GiB producer/verifier
staging limits and source-size preflight are activation constraints, not
promises that a larger Ceph source will fit
(`apps/backend/docs/DISASTER-RECOVERY.md:54`). The R2 encrypted archive is **not** a live mirror
and does not, merely by containing current object bytes, prove preservation of
all historical versions, legal holds, retention metadata, or delete markers
(`apps/backend/docs/DISASTER-RECOVERY.md:348`). The CloudNativePG Barman Cloud
Plugin is configured to send database base backups and WAL **directly to R2**,
separately from this local object-store migration
(`apps/backend/docs/DISASTER-RECOVERY.md:26`). Ordinary backend upload
code also has an R2 path (`apps/backend/src/utils/r2Storage.js:38-89`); trace
actual runtime writers/readers before claiming the local bucket is its sole
record authority. These configuration paths do not prove any producer is live;
new local-store archive production is held. The independent R2 encrypted
archive verifier remains retained for any existing archive and must not be
weakened or removed merely because the source producer is held.
The held MinIO manifest also describes an **out-of-band** `vhhealth-backups` to
R2 replication rule, including delete, delete-marker, and replica-metadata
synchronization (`tenant.yaml:307-325`). The owner attests that no VH MinIO
deployment existed, so this is not a live replication claim. If another
source is ever discovered, its target, state, lag, and restore role require
inspection. It is distinct from both the encrypted records archive and
CloudNativePG's direct-R2 backups; a future cutover cannot silently remove it.

The four top-level production Argo CD Applications are manual-sync
(`infra/kubernetes/base/argocd/applications/`). The C1.2 storage placement gate
is **NOT QUALIFIED**; its Longhorn target is not evidence of installation or
fitness, and it requires host/storage/network/facilities, backup, and
service-specific restore proofs (`docs/C1_2_STORAGE_PLACEMENT_GATE.md`). A Ceph
proposal does not silently select Longhorn for OSDs or approve a CNPG/Harbor
PVC move. The historical pinned MinIO image at `tenant.yaml:74` falls within the affected
range of [GHSA-hv4r-mvr4-25vw](https://github.com/minio/minio/security/advisories/GHSA-hv4r-mvr4-25vw),
which describes an unauthenticated-write path with a known valid access key.
The advisory names a patched **AIStor** line; it is not authority to swap that
image into the present MinIO Tenant. Maintain the existing restricted network
and credential posture while a separate security owner manages interim risk.

## Candidate architecture, not an approved manifest

| Candidate | Assessment required before selection |
| --- | --- |
| Rook-managed Ceph on separately inventoried raw host devices | A `CephCluster` with explicit node/device selection, mons, OSDs, Ceph metadata/data pools, and a `CephObjectStore`/RGW S3 gateway. Inventory devices and prove they are unbound and reserved; never use automatic all-device consumption. Establish truthful CRUSH host placement, pool size/minimum write availability, gateway redundancy, TLS SANs, resource headroom, monitoring, upgrade path, and object-store backups. This is a candidate, not a claim that the existing three hosts or disks can run it. |
| Rook-managed Ceph with PVC-backed OSDs | Identify the backing StorageClass and its own data/replica semantics. Do not layer Ceph replication on unqualified Longhorn, claim independent copies from nested replicas, or consume existing MinIO/CNPG PVCs. Apply the C1.2 evidence gate and measure total write amplification, recovery capacity, and failure behavior first. |
| External Ceph cluster consumed through Rook | Evaluate only if the owner can provide a separately qualified Ceph service, support, endpoint, credential, network, failure-domain, restore, and operating agreement. Rook also needs a distinct privileged RGW admin-ops identity to manage buckets and users; name its owner, isolate its Secret, and qualify rotation and revocation separately from bucket-scoped application keys. It cannot be assumed to exist. |

Rook's [Ceph cluster options](https://rook.io/docs/rook/v1.19/CRDs/Cluster/ceph-cluster-crd/)
include host devices, PVC-backed OSDs, and external Ceph. Its
[object-store guide](https://rook.io/docs/rook/v1.19/Storage-Configuration/Object-Storage-RGW/object-storage/)
shows distinct metadata and data pools, the RGW service endpoint, `CephObjectStoreUser`,
and TLS endpoint/SAN requirements. These examples are not sizing decisions for
VH Health. Host/OSD placement must be measured: the Rook
[pool documentation](https://rook.io/docs/rook/v1.17/CRDs/Block-Storage/ceph-block-pool-crd/)
warns that an insufficient host/OSD set can permit pool creation but stall
writes. Do not translate MinIO EC:4 into a Ceph chunk count or promise
continued writes after a node loss without a completed fault drill.

For any candidate, keep the S3 API internal behind TLS and namespace/pod-scoped
network policy. Give Harbor, clinical-record writers/readers, archive source
readers, and any backup writer **separate** bucket-scoped credentials; reserve
lock administration, retention removal, and restore identities for named
operators. Rook can create users and generated credentials, but secret
distribution, rotation, and least privilege must be reviewed across namespaces
([Rook object-store users](https://rook.io/docs/rook/v1.19/Storage-Configuration/Object-Storage-RGW/object-storage/)).
The same [Rook external-object-store guide](https://rook.io/docs/rook/v1.19/Storage-Configuration/Object-Storage-RGW/object-storage/#connect-to-an-external-object-store)
requires a privileged RGW admin-ops user and Kubernetes Secret in external
mode; least-privilege workload keys cannot replace that management identity.
Ceph's [bucket-policy support](https://docs.ceph.com/en/reef/radosgw/bucketpolicy/)
is a subset of AWS policy semantics and is release-dependent. A policy that
renders is not proof that denied operations are denied. No credentials or
SealedSecrets are supplied by this design.

## Compatibility contract to prove, not infer

Ceph RGW documents S3 bucket versioning and Object Lock configuration, and
per-object retention/legal-hold operations
([bucket operations](https://docs.ceph.com/en/latest/radosgw/s3/bucketops/),
[object operations](https://docs.ceph.com/en/reef/radosgw/s3/objectops/)).
Those documents establish candidate APIs, **not** that the chosen pinned
Rook/Ceph release or VH Health callers behave identically to MinIO. Record the
selected release and test its exact RGW image. Ceph's
[Squid release notes](https://docs.ceph.com/en/latest/releases/squid/)
show that even the ability to enable Object Lock on an existing versioned
bucket changed in a point release; design new target buckets and prove their
configuration rather than rely on a generic S3 compatibility label.

For `vhhealth-records` and `vhhealth-backups`, owner-approved rules must specify
whether each target bucket enables versioning and Object Lock at creation, the
default/per-object retention mode and duration, legal-hold procedure, policy
principal separation, lifecycle rules, and retention-removal authority. None
of those values is selected here. Prove that a protected **version ID** cannot
be deleted, overwritten in place, or have retention shortened by the ordinary
writer; prove governance-bypass privilege is absent unless explicitly granted;
prove legal holds; and inspect both current and noncurrent versions. A simple
unversioned `DELETE` may create a delete marker and hide a protected version
from ordinary GET while not destroying it; test visibility and recovery, not
only an expected HTTP status. These are S3 semantics described by
[AWS Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html),
and must be verified against RGW. For `harbor-registry`, keep Object Lock off
unless Harbor and registry garbage-collection owners deliberately approve a
different retention model.

Exercise the **actual** clients: AWS CLI used by the archive producer,
`@aws-sdk/client-s3`/signed URLs where applicable, Harbor's S3 distribution
driver, all direct backend R2 paths that must remain on R2, and the approved
restore tooling. Test path-style versus virtual-host-style requests, TLS chain
and SAN validation, signed PUT/GET, multipart upload and abort, range GET,
metadata/content type, conditional requests, pagination, list versions,
delete markers, clock skew, 403/404 handling, network timeouts, retries, and
idempotent replay. Capture API traces without PHI or credentials. A passing
generic `PutObject`/`GetObject` pair is insufficient.

## Acceptance matrix — each row requires a recorded result

| Surface | Synthetic acceptance evidence | Failure or stop condition |
| --- | --- | --- |
| Records bucket | For a new installation, create a locked synthetic target bucket under the approved rule and prove signed/internal reads plus negative delete/overwrite/shorten tests. Only if a real source is discovered, inventory and map its keys **and versions**, metadata, checksum, retention and holds. | Any weaker lock, unauthorized read/write, broken URL, or (if migration applies) missing version leaves `NOT QUALIFIED`. |
| Backups bucket | For a new installation, exercise a synthetic backup object through approved writer/reader identities, lock policy, retention expiry boundary, and disposable restore. Only if a real legacy source is found, inventory its bucket and out-of-band R2 replication target, flags, state/lag, and restore ownership; qualify replacement or obtain named retirement approval. | A declared bucket alone or unproven restore does not count. Do not redirect CNPG's separate direct-R2 backup path. |
| Longhorn backup target | Treat `longhorn-backups` as a historical, undeclared MinIO consumer, not a live backup. Keep its target and credential unavailable while C1.2 is unqualified. Any future target requires a separately selected object store, Longhorn-owner backup and disposable restore proof, credential scope, retention decision, and reconciliation of the missing bucket declaration. | A Helm value, example bucket-creation command, or empty target is not backup evidence; do not infer Longhorn protection. |
| Harbor registry | Using a synthetic image and chart, push, pull by immutable digest, restart registry, re-pull, perform authorized tag deletion and garbage collection, then prove referenced blobs survive. Require a trusted CA and matching RGW endpoint SAN, `secure: true`, and `skipverify: false`; show an untrusted certificate is rejected. Test loss and restoration of the RGW endpoint. | An unreadable signed image, digest drift, incomplete GC, disabled certificate verification, or loss of registry recovery path blocks cutover. |
| Backend archive → R2 | Rehearse existing producer/verifier with a synthetic Ceph source, including nonempty source, inventory, staging-size preflight, ciphertext SHA-256 and authenticated HMAC metadata, independent reader verification, and decrypted disposable restore. Confirm the current archive format's source-bucket identity and key naming remain valid or specify an independently reviewed format transition. | Do not silently relabel source from MinIO, increase the 10 GiB staging bound, or claim current-object archive preserves WORM history. A missing verifier receipt or size over bound blocks activation. |
| Off-cluster records recovery | Name an independently held, version-aware recovery target and custodian outside the Ceph failure domain. Using synthetic data, lose the disposable Ceph cluster and restore current and noncurrent versions, delete markers, retention dates/modes, legal holds, metadata, and checksums into a fresh cluster; prove unauthorized shortening and deletion still fail. Record recovery time and point against owner-approved limits. | The existing current-object R2 archive is not this proof. No qualified off-cluster history and lock recovery blocks clinical writes. |
| Database and disaster recovery | Re-prove direct CNPG→R2 base backup/WAL and reader-only PITR independently; then restore synthetic local object data while applications and archive jobs are quiesced, following the DR ordering. | Object-store migration cannot impair database backup or substitute for its R2 restore proof. |
| Failure and operations | Capture RGW/OSD/mon health, capacity, recovery/repair, alerts, certificate rotation, credential rotation, one approved host/network-loss test, full-object checksums, and measured read/write latency and recovery time against owner-set limits. | No chosen thresholds, unclean health, stalled writes, unexpected data movement, or inability to restore means `NOT QUALIFIED`. |

## Rehearsal, cutover, and rollback gates

1. **Confirm the first-install boundary and decide.** Record the owner's
   no-deployment attestation, the bounded Dalek metadata result, the three
   declared bucket purposes plus undeclared Longhorn backup target, R2 archive
   identities, and who would own
   each future writer and reader. Only if a real MinIO source is later found,
   inventory its tenant/buckets, object and version counts, bytes, lock
   policies, legal holds, lifecycle, network paths, image digest, and the
   backup-bucket replication rule's target, status, flags, lag, and restore
   role. Obtain clinical/legal retention and deletion rulings, security
   credentials/policy, Harbor GC requirements, backup/RTO/RPO targets, and
   physical host/drive ownership. Never enumerate real PHI into a design
   artifact.
2. **Build only a separate synthetic qualification environment after
   authorization.** Pin mutually supported RKE2/Kubernetes, Rook, Ceph,
   CSI/OSD, Harbor, SDK, and tooling versions/digests; prove cluster placement,
   usable capacity, resource reservations, alerts, TLS, policies, and failure
   behavior. Maintain the C1.2 storage gate as an independent prerequisite.
3. **Rehearse a new installation first.** With synthetic objects and no VH
   MinIO source, prove bucket creation, Object Lock, versioning, each client
   contract, and off-cluster recovery. Do not create a fictitious migration
   receipt from an empty source. **Only if** later inventory finds a real
   source, separately rehearse version-aware migration: take source and target
   inventories, sample hashes and object metadata before/after, and map each
   current and noncurrent version, legal hold, retention mode/date, and delete
   marker or document a reviewed exception. Do not assume `aws s3 sync` or
   the existing encrypted R2 archive preserves these. Include interrupted
   copy, duplicate key/version, in-flight writes, retry, and resumability,
   using no production data in the rehearsal.
4. **Prepare a separate change proposal.** It must include exact manifests and
   rollback patch, secret/CA/network-policy changes, Harbor certificate
   verification and negative TLS test, staged consumer-by-consumer endpoint
   updates, an immutable synthetic target-baseline receipt, monitoring,
   operator window, named go/abort authority, and a separately qualified
   Ceph-specific recovery runbook with off-cluster version/retention/hold
   restoration. Add source/target inventory receipts, a backup-replication
   disposition, an updated MinIO-specific disaster-recovery runbook, and a
   rollback preserving the source **only if** a real MinIO source is
   discovered. Do not reactivate the held
   Tenant pin or target the `minio-api`
   alias as a transparent Ceph swap; endpoint identity, certificate, credentials,
   S3 behavior, bucket rules, and data history all change.
5. **At a separately approved first activation or conditional cutover only:**
   keep any discovered live writers, Harbor GC, archive producer/verifier, and
   public ingress quiesced according to a reviewed per-service sequence. For
   a first installation, verify the synthetic target baseline. Only if a
   real source is discovered, capture its final inventory and migrate deltas.
   Verify target versions/locks/checksums, then enable one consumer at a time under
   manual Argo CD sync and named observation period. Re-run archive and restore
   proofs, including full off-cluster records recovery, before admitting
   clinical writes. Any negative acceptance result aborts and preserves any
   discovered old source.
6. **Rollback is not a Git revert after writes diverge.** Before writes reopen,
   endpoint cutback to an unchanged *discovered* MinIO source may be possible only with
   verified source continuity. After target-only writes, stop writes and use a
   separately rehearsed reverse-reconciliation or restore procedure that
   preserves all versions and retention evidence; never silently repoint to a
   stale source or delete either cluster. Retirement of old storage requires a
   separate legal, clinical, backup, security, and operator decision.

## Required owner decisions and evidence ledger

Record a named person, decision, date, accepted evidence reference, and exact
configuration revision for each: platform/change commander; storage/Ceph
operator; facilities and network owners; security/PKI/secret owner; Harbor
registry owner; backend/R2 archive owner; database/backup/restore owner;
clinical data custodian; legal/records-retention authority; release authority.
Required unresolved decisions are the hardware/failure-domain and Ceph
architecture choice; approved versions and support path; capacity, latency,
RTO/RPO and observation thresholds; bucket-by-bucket retention/lock and
legal-hold semantics; conditional source historical-version treatment;
credentials and encryption/KMS posture; Harbor GC; Longhorn backup target
disposition; R2 archive format/size scaling; any newly discovered MinIO state;
conditional backup-bucket replication disposition; external RGW
admin-ops credential ownership if selected; and migration/cutover/retirement
authorization. An owner name or threshold left blank is a stop line, not
implied approval.

**Current outcome: NOT QUALIFIED.** This document has no live Rook/Ceph
cluster, no synthetic rehearsal, no bucket or WORM test receipts, no capacity or
fault drill, no approved retention values, and no operator, clinical, legal, or
release sign-off. It authorizes no activation or deployment.
