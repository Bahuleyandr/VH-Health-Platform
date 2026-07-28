# CloudNativePG and PostgreSQL 18 qualification

Status: repository contract only; no live cluster, R2, secret, upgrade, restore,
or deployment action was performed by C1.1.

Baseline: `github/main` at
`5ee03f142b0048771ed8f1939eb483008be79be4`, fetched on 2026-07-28.

## Activation boundary

C1.1 makes the intended manifests internally consistent but does not activate
them. The four Argo CD Applications are manual-sync. The operator and Barman
Cloud Plugin are also installed outside the platform Application. Merging this
change therefore deploys nothing.

CloudNativePG 1.30 supports Kubernetes 1.34, 1.35, and 1.36. Production RKE2 is
currently Kubernetes 1.31.4, so activation is blocked on C1.2 upgrading the
cluster to Kubernetes 1.34 or newer. CloudNativePG 1.29.2 remains a mandatory
transient rung in the interleaved qualification ladder: it bridges Kubernetes
1.33 to 1.34. It is not the final activation target or the fallback target
because 1.29 reaches end of life on 2026-09-29. CloudNativePG 1.30 was released
on 2026-06-29, supports the C1.2 Kubernetes objective, and is supported until
approximately December 2026.

The production R2 endpoint is the following non-secret value, verified against
the bucket's **Settings -> S3 API** page:

```text
https://dbe488236c64499a3dfc797a750c912d.r2.cloudflarestorage.com
```

It is stored in the platform render's `vhhealth-env` as `R2_ENDPOINT` and
copied into the CNPG `ObjectStore`, verifier, and suspended restore proof by
native Kustomize replacements. The apps Application is a separate render root,
so its `vhhealth-backend-config` carries the same confirmed literal and
replaces the endpoint in both backend backup jobs. The repository contract
enforces equality across the two renders. No `envsubst`, SOPS
config-management plugin, or Argo CD config-management plugin is assumed.

Cloudflare R2 automatically encrypts every object and its metadata at rest
with provider-managed AES-256-GCM. Its S3 compatibility layer does not support
the `x-amz-server-side-encryption` header on `PutObject` or
`CreateMultipartUpload`, so the Barman `ObjectStore` deliberately omits
`wal.encryption` and `data.encryption`. Setting either field to `AES256` would
send an unsupported header and can stop WAL or base-backup uploads. This
provider-managed encryption is distinct from the client-side encryption used
for backend MinIO archives.

## Pinned releases and provenance

All registry digests below are multi-architecture manifest-list/index digests.
They were resolved on 2026-07-28 with:

```bash
docker buildx imagetools inspect IMAGE:TAG
```

The tag is retained beside each digest for human provenance while the digest is
the immutable runtime identity.

| Component | Immutable reference or release asset | Provenance and verification |
| --- | --- | --- |
| CloudNativePG operator | `ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0@sha256:a2701eb97cdd2a34b1fdb2cb51987f544b706e40bec72ae7146cd8580efefebb` | Latest 1.30.x GitHub release was `v1.30.0`, published 2026-06-29. The upstream `cnpg-1.30.0.yaml` release asset is `sha256:f8bede43fe4ee0d478c2355b204a36876b2ae4faac60f2a9452280b293da3b88`. Cosign verification passed with GitHub Actions issuer and identity regexp `^https://github.com/cloudnative-pg/cloudnative-pg/`. |
| Barman Cloud Plugin | controller `ghcr.io/cloudnative-pg/plugin-barman-cloud:v0.13.0@sha256:71589dbac582333442812b07b31f7ea4d00324a8358aac7ca507dabf9f4b6c96`; injected sidecar `ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.13.0@sha256:990361af3319f9e23aafa0f6d7981f99bf1f69b4e6a85cf1bc7d71d6f09bb288` | Latest GitHub release was `v0.13.0`, published 2026-06-10. The upstream `manifest.yaml` release asset is `sha256:d2e71e7b06822448f1a421f05781846cfdb9cc621e7ef32eef5e20c5133213b0`. Upstream requires CNPG 1.26+ and recommends 1.27+; no concrete CNPG 1.30 blocker was found. Neither image published a cosign signature (`cosign verify` returned `no signatures found`), so activation must verify the downloaded release-asset digest and both image digests independently. |
| PostgreSQL | `ghcr.io/cloudnative-pg/postgresql:18.4-standard-bookworm@sha256:0ec6b32ab5b644aa51da58443c5ac2c1724d97de0d2a88961920d437b71b9ad8` | PostgreSQL 18.4 was released 2026-05-14 with fixes for 11 security vulnerabilities and more than 60 bugs. The resolved image SBOM includes pgvector 0.8.5; runtime qualification still proves the files, extension bootstrap, and queries rather than trusting the package list. Cosign verification passed with GitHub Actions issuer and identity regexp `^https://github.com/cloudnative-pg/postgres-containers/`. |
| MinIO | `quay.io/minio/minio:RELEASE.2024-11-07T00-52-20Z@sha256:ac591851803a79aee64bc37f66d77c56b0a4b6e12d9e5356380f4105510f2332` | Existing production tag resolved through the Quay registry. This is a behavior-preserving digest pin, not a version upgrade. No cosign signature was published for this digest. |
| Ollama | `docker.io/ollama/ollama:0.5.4@sha256:18bfb1d605604fd53dcad20d0556df4c781e560ebebcd923454d627c994a0e37` | Existing production tag resolved through Docker Hub. This is a behavior-preserving digest pin, not a version upgrade. No cosign signature was published for this digest. |
| BusyBox | `docker.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662` | Existing production tag resolved through Docker Hub. This is a behavior-preserving digest pin, not a version upgrade. No cosign signature was published for this digest. |
| AWS CLI | `docker.io/amazon/aws-cli:2.34.53@sha256:cf53765c0de54ad3a8ea21818f1c4c845a8cf7ca87831c078a00fef244031493` | Existing backup-job tag resolved through Docker Hub. This is a behavior-preserving digest pin required by the literal-render gate. No cosign signature was published for this digest. |
| Alpine OpenSSL | `docker.io/alpine/openssl:3.5.7@sha256:045a40a53b8e283cff95052e0c39f256b7467d48c7445260d4f180fc0e767999` | Backup archive crypto/tar phase image. The multi-architecture index digest was resolved from Docker Hub with `docker buildx imagetools inspect` on 2026-07-28. Cosign verification returned `no signatures found`, so activation must independently re-resolve the digest before use. |
| curl | `docker.io/curlimages/curl:8.11.1@sha256:c1fe1679c34d9784c1b0d1e5f62ac0a79fca01fb6377cdd33e90473c6f9f9a69` | Suspended restore-proof runner image. The multi-architecture index digest was resolved from the official `curlimages/curl` Docker Hub repository with `docker buildx imagetools inspect` on 2026-07-28. Cosign verification returned `no signatures found`, so activation must independently re-resolve the digest before use. |

Cosign verification used cosign `v3.1.2` and required the Fulcio issuer
`https://token.actions.githubusercontent.com`. A missing signature is recorded
as provenance evidence, not treated as a successful signature verification.

Authoritative release references:

- <https://github.com/cloudnative-pg/cloudnative-pg/releases/tag/v1.30.0>
- <https://cloudnative-pg.io/docs/1.30/release_notes/v1.30/>
- <https://cloudnative-pg.io/docs/devel/supported_releases/>
- <https://github.com/cloudnative-pg/plugin-barman-cloud/releases/tag/v0.13.0>
- <https://cloudnative-pg.io/plugin-barman-cloud/docs/intro/>
- <https://www.postgresql.org/about/news/postgresql-184-1710-1614-1518-and-1423-released-3297/>
- <https://github.com/cloudnative-pg/postgres-containers>
- <https://developers.cloudflare.com/r2/api/s3/api/>
- <https://developers.cloudflare.com/r2/reference/data-security/>

## Required pre-sync operator sequence

Before the next manual Argo CD sync, an operator must complete these steps in
order:

1. Before Argo prunes the retired self-owned `vhhealth-pg-nightly`
   `ScheduledBackup`, export every `Backup` CR it owns, preserve its status and
   object evidence, then remove only that schedule's `ownerReference` from each
   retained `Backup` CR. Verify that no retained Backup still names
   `vhhealth-pg-nightly` as an owner. This is a hard blocker: deleting a
   `ScheduledBackup` with `backupOwnerReference: self` can otherwise trigger
   Kubernetes garbage collection of the Backup CRs and their evidence.
2. Rehearse the operator and Kubernetes ladder in the following interleaved
   order. A Kubernetes transition is allowed only while the installed operator
   supports both the old and new Kubernetes minor:

   | Stage | Kubernetes | CloudNativePG action | Supported Kubernetes range |
   | --- | --- | --- | --- |
   | A | 1.31 | `1.24.1 -> 1.24.4 -> 1.25.4 -> 1.26.3 -> 1.27.4` | 1.24: 1.28-1.31; 1.25: 1.29-1.32; 1.26: 1.30-1.33; 1.27: 1.31-1.33 |
   | B | 1.31 -> 1.32 | Keep 1.27.4 installed during the Kubernetes transition | 1.27 supports both 1.31 and 1.32 |
   | C | 1.32 | Upgrade to 1.28.4 | 1.28 supports 1.32-1.35 |
   | D | 1.32 -> 1.33 | Keep 1.28.4 installed during the Kubernetes transition | 1.28 supports both 1.32 and 1.33 |
   | E | 1.33 | Upgrade to 1.29.2 | 1.29 supports 1.33-1.35 |
   | F | 1.33 -> 1.34 or newer | Keep 1.29.2 installed during the Kubernetes transition | 1.29 supports both 1.33 and 1.34 |
   | G | 1.34 or newer | Upgrade to the final 1.30.0 pin | 1.30 supports 1.34-1.36 |

   The whole ladder must never be attempted on Kubernetes 1.34 or newer:
   CloudNativePG 1.24 is unsupported there. Stop at the last qualified
   operator/Kubernetes pair if any rung or transition fails.
3. Install the Barman Cloud Plugin `v0.13.0` from a manifest patched to the
   pinned controller and injected-sidecar digests. Verify the downloaded
   `manifest.yaml` SHA-256 and both pinned image digests, wait for its
   Deployment, and confirm that
   `objectstores.barmancloud.cnpg.io` is established.
4. Create and seal the bucket-scoped CNPG producer credentials, separate
   bucket-scoped read-only DR credentials, and backup-archive crypto material
   using the committed example schemas. The ObjectStore destination prefix is
   workload routing, not token scope. Never copy the producer identity into
   verifier or restore workloads.
5. Render production locally and confirm that `R2_ENDPOINT` equals the
   production value above in `vhhealth-env`, the Barman `ObjectStore`, and both
   backend backup jobs.

Skipping step 1 can garbage-collect the retired schedule's Backup CR evidence.
Skipping steps 2 or 3 can leave the Cluster rejected or unreconciled. In
particular, syncing the platform Application before the plugin's `ObjectStore`
CRD exists makes the Application unsyncable on an unknown kind. Skipping step 4
stops the producer, verifier, and proof jobs. Skipping step 5 directs jobs at no
valid backup target. None of these failures is an acceptable reason to
reintroduce the literal account placeholder, duplicate schedule, broad backend
Secret imports, or writer/reader credential reuse.

## Credential and archive identities

The database backup producer uses only
`cnpg-backup-producer-credentials`. It is a Cloudflare R2 token scoped to the
database bucket with Object Read & Write permission because Barman retention
requires deletion authority. The Barman destination path routes this workload
under its configured prefix, but the long-lived token is not prefix-scoped.

Verification and recovery use only `cnpg-dr-reader-credentials`, a separate
Object Read-only identity. Ordinary long-lived R2 tokens are Read & Write or
Read-only; they are not prefix-scoped or true object-put-only credentials.
Brokered prefix/put-only enforcement, bucket-lock governance, and
retention/deletion separation are deferred to C6.2.

PostgreSQL 18 archives use the server identity `vhhealth-pg18`, distinct from
the historical PostgreSQL 17 identity `vhhealth-pg`. Successful conversion
must never append PostgreSQL 18 WAL to the PostgreSQL 17 archive identity.

Backend upload archives use disjoint identities:

- `minio-backup-source-reader` reads the source MinIO upload bucket;
- `offsite-backup-producer` writes the encrypted, HMAC-authenticated off-site
  archive;
- `offsite-backup-reader` verifies the archive HMAC before decryption;
- `backup-crypto` supplies independent high-entropy `BACKUP_ENCRYPTION_KEY` and
  `BACKUP_HMAC_KEY` values, which must differ.

HMAC-SHA256 authenticates the canonical format, SHA-256, creation
timestamp/epoch, source bucket, object count, encryption identifier, content
length, archive key, and ciphertext. Generate the two keys independently.
During rotation, deploy one reviewed new pair to producer and verifier together.
Retain the prior pair while its archives remain required, and require new
archive, HMAC verification, decryption, and restore evidence before retiring
it.

No backup pod may import the broad backend Secret.

## Qualification ladder and evidence

C1.1 repository validation performs no live cluster, R2, secret, upgrade, or
restore action. During later operator-owned activation, the interleaved
Kubernetes/CNPG ladder and the pre-upgrade PostgreSQL 17 backup proof run
against the current infrastructure with the database major unchanged. The
offline PostgreSQL 17-to-18 conversion/data rehearsal, run-unique PG18
synthetic-QA archive, and PG18 restore proof use isolated synthetic data and
must not use the production R2 bucket, production credentials, or production
database.

### 1. Inventory the source

Capture the exact current PostgreSQL 17 image digest, operating-system family,
CNPG operator version, extension inventory and versions, shared preload
libraries, roles and role attributes, database/schema ownership, collations,
tablespaces, installed pgvector version, row counts, schema digest, application
read checks, and checksums for a bounded synthetic fixture.

The PostgreSQL 17 pre-upgrade floor is the current secure PG17 minor at
execution time: 17.10 as of 2026-07-28, not 17.6. Re-derive the floor immediately
before activation.

### 2. Prove restore before upgrade

Take a PG17 backup with the qualified source image and restore it into a new
disposable PG17 cluster using only the DR reader identity. Prove roles, schema,
row counts, checksums, pgvector queries, and representative backend reads.
Retain the Backup CR status, object metadata, logs, and check output.

### 3. Rehearse the operator ladder without a major change

Follow the interleaved operator/Kubernetes stages in the pre-sync table while
the database remains on the qualified PG17 image. The evidence must name every
operator/Kubernetes pair and each Kubernetes transition. At each operator rung,
wait for rollout and cluster health, check replication and WAL archiving, run a
base backup, and prove an application read. At each Kubernetes transition,
prove that the operator version held during the transition supports both
adjacent minors and repeat the same health checks. Only the final 1.30.0
activation occurs on Kubernetes 1.34 or newer. A failure stops at the last
qualified operator/Kubernetes pair.

### 4. Align operating systems before physical `pg_upgrade`

Physical `pg_upgrade` is permitted only when the source and target image
operating-system/library assumptions are explicitly supported and the
qualification environment reproduces them. Align the PG17 source image to
Bookworm and re-run the PG17 backup/restore evidence before the major upgrade.

If the source operating system cannot be aligned safely, do not force a
physical upgrade. Use a rehearsed logical dump/restore or logical-replication
cutover instead and repeat all data, extension, application, backup, and restore
gates for that method.

### 5. Run the offline PG18 upgrade

Use the exact PostgreSQL image from the pin table everywhere:

```text
ghcr.io/cloudnative-pg/postgresql:18.4-standard-bookworm@sha256:0ec6b32ab5b644aa51da58443c5ac2c1724d97de0d2a88961920d437b71b9ad8
```

Run the offline upgrade against synthetic data. Capture start/end time,
downtime, operator and instance logs, `pg_upgrade` checks/output, and the final
image IDs. Prove all of the following before acceptance:

- role existence, attributes, membership, and ownership;
- database, schema, table, index, constraint, sequence, and extension inventory;
- row counts and the pre-recorded checksums;
- representative clinical application reads through the runtime role;
- PostgreSQL server version and image digest;
- a run-unique synthetic PG18 WAL archive identity such as
  `vhhealth-pg18-qa-<run-id>`, distinct from both the PostgreSQL 17 identity and
  fixed production `vhhealth-pg18`; no archive reuse or retargeting;
- `ANALYZE` completion and fresh planner statistics.

Role equality is limited to the explicit VH Health application roles
`vhhealth`, `vhhealth_app`, `vhhealth_runtime`, and `vhhealth_readonly`, their
attributes, memberships, and owned database objects. It must not checksum all
of `pg_roles`: PostgreSQL 18 adds the documented predefined role
`pg_signal_autovacuum_worker`. Qualification records the complete predefined
role inventory before and after, permits exactly that addition with no removal,
and compares the PostgreSQL 18 inventory again after restore.

If CNPG's major-upgrade procedure emits
`$PGDATA/update_extensions.sql`, execute it as the PostgreSQL superuser before
acceptance. Then require every installed extension, including `vector`, to have
`pg_available_extensions.installed_version =
pg_available_extensions.default_version`. Representative application reads
must execute with effective role `vhhealth_runtime`, not `postgres`.

### 6. Prove the exact pgvector image

The `vector` extension remains in `bootstrap.initdb.postInitApplicationSQL`,
which CNPG executes as superuser. Before accepting the image, prove:

1. `vector.control` exists in the PostgreSQL 18 extension directory;
2. the PostgreSQL 18 `vector.so` exists and loads;
3. `pg_available_extensions` lists `vector`;
4. bootstrap `CREATE EXTENSION IF NOT EXISTS vector` succeeds;
5. vector casts and distance operators return expected results;
6. the same vector rows, indexes, casts, and distance results survive the
   PG17-to-PG18 rehearsal and a fresh PG18 backup/restore.

Only if this exact image fails those checks may `imageName` change to a signed,
digest-pinned pgvector-bearing PostgreSQL 18 Bookworm image. Any alternative
image must repeat the complete qualification; PostgreSQL 17 is not retargeted
in this slice.

### 7. Prove fresh PG18 backup and recovery

After conversion, create a fresh plugin `Backup` under a run-unique synthetic
archive identity such as `vhhealth-pg18-qa-<run-id>`. Never use or retarget the
fixed production `vhhealth-pg18` identity for qualification. Record the exact
named Backup CR, require its creation and completion timestamps to follow the
successful upgrade, and read its exact Barman `status.backupId`. Create a
separate synthetic reader identity and reader `ObjectStore` against that same
run-unique synthetic-QA archive, then restore a separately provisioned
disposable cluster with `bootstrap.recovery.recoveryTarget.backupID` set to
that exact ID. A restore that merely selects the latest available backup is not
evidence for this gate.

Repeat roles, ownership, schema, row counts, checksums, extension, pgvector, and
runtime-role application-read checks. Retain the Backup CR status, Barman ID,
reader identity name, and restore evidence. The synthetic rehearsal must not
use the committed production `cnpg-dr-reader-credentials`, production bucket,
or suspended `cnpg-scheduled-restore-proof`; that inert CronJob is reserved for
later operator-owned production activation and drill evidence. Record cleanup
of only label-and-UID-verified disposable synthetic resources.

## Repository gates

The C1.1 repository slice is accepted only when:

- production render has no declarative `${...}`, `FILL_ME`, placeholder
  ciphertext, or tag-only image;
- the three documented all-zero application image digests are the sole literal
  exception;
- example SealedSecrets are excluded from backend and admin renders;
- there is exactly one CNPG schedule: `vhhealth-pg-daily` at 20:30 UTC,
  `target: prefer-standby`, `method: plugin`;
- CNPG, the operator marker, restore templates, and upgrade qualification use
  the exact pins in this document;
- the Cluster plugin and `ObjectStore` agree on name, archive identity,
  credentials, endpoint, provider encryption behavior, compression, and
  retention;
- producer and reader secret names are disjoint, and verifier/restore workloads
  do not reference a producer secret;
- each backup/proof workload has explicit service account, least-privilege RBAC
  where Kubernetes API access is needed, and explicit egress policy;
- archive scripts prove checksum, HMAC authenticity before decryption,
  metadata, independent crypto keys, and suspended restore contracts;
- the manifest validator recognizes the Barman `ObjectStore` CRD without a
  false pass or false failure;
- no dangling `IngressClassParameters` reference remains.

Required repository-only commands are:

```bash
git diff --check
node --test scripts/check-c1-1-manifest-contract.test.mjs
node --test scripts/c1-1-backup-scripts.test.mjs
bash -n infra/kubernetes/base/cnpg/verify-cnpg-backup.sh
bash -n infra/kubernetes/base/cnpg/scheduled-restore-proof.sh
bash -n infra/kubernetes/base/cnpg/pg18-upgrade-rehearsal.sh
bash -n infra/kubernetes/base/cnpg/dr-restore-drill.sh
bash -n infra/kubernetes/apps/backend/upload-archive.sh
bash -n infra/kubernetes/apps/backend/verify-upload-archive.sh
node scripts/validate-kubernetes-manifests.mjs
node scripts/ci/run.mjs --only=infra
```

These gates do not claim any live backup, restore, upgrade, R2, secret, or
deployment evidence.

## Rollback

Before activation, rollback is `git revert`; manual Argo sync keeps merge inert.

During operator qualification, stop at the last passing rung. On a failed PG18
upgrade, restore the exact qualified PG17 image and retain all failure evidence.
After a successful conversion, never image-downgrade the converted cluster:
restore the qualified PG17 backup into a new cluster or fix forward.

Suspend a broken verifier or proof job without stopping a healthy WAL/base
backup stream. Remove only labeled disposable restore resources. Keep old and
new credential generations until backup, verification, and synthetic
QA-restore evidence all pass.

Never delete R2 objects, Backup custom resources, checksums, drill evidence, or
the only recoverable backup generation during rollback. Never restore the
broken endpoint placeholder, duplicate schedule, writer/reader reuse, broad
backend Secret imports, or tag-only images.
