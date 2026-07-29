# C1.2 Storage Placement Gate

> **Status: NOT QUALIFIED.** This document is an operator evidence gate, not a
> migration procedure or approval. C1.2 selects and executes no storage
> migration, changes no bound PVC, and assigns no migration number. The
> production Longhorn PVC patch remains commented out.

## Current repository truth

| Topic | Current truth |
| --- | --- |
| CNPG data and WAL | Both explicitly use the `local-path` StorageClass in `infra/kubernetes/base/cnpg/cluster.yaml`. |
| Database durability | PostgreSQL streaming replication across the three CNPG instances provides the current replicated durability. A node-local PV is not independently replicated storage. |
| Longhorn StorageClass | The declared production class is `longhorn`, with three replicas and `Retain`; it is not the default class. |
| Longhorn release | `1.7.2` is an unqualified repository target. Repository pins and renders are not evidence that Longhorn is installed, healthy, or production-approved. |
| Production adoption | `infra/kubernetes/overlays/prod/longhorn-pvc-patch.yaml` is excluded by a commented entry in the production kustomization. No workload adopts Longhorn through that patch. |
| Argo CD behavior | The four top-level Applications are manual-sync. The Longhorn child Application is also manual-sync in this revision. A merge performs no sync or storage action. |
| Failure domains | Three Longhorn replicas mean three node copies. They do not prove three independent racks, power feeds, UPS paths, switches, rooms, or facilities. |

Longhorn upgrades must advance one supported minor at a time after compatibility
and restore qualification. Downgrade is not an accepted recovery path.

The Kubernetes prerequisite is the exact RKE2 objective
`v1.34.9+rke2r1` (Kubernetes `v1.34.9`) reached only through the ladder in
[`RKE2_1_34_QUALIFICATION.md`](RKE2_1_34_QUALIFICATION.md). The interleaved
CloudNativePG prerequisites and backup/restore gates are defined in
[`CNPG_POSTGRES_18_QUALIFICATION.md`](CNPG_POSTGRES_18_QUALIFICATION.md).

## Required pre-sync operator warning

> Syncing this revision is an operator action, not a merge side effect. It
> triggers a CNPG rolling re-schedule under required hostname anti-affinity,
> redeploys the backend under hard hostname spread, and changes the Longhorn
> child Application to manual-sync. Expect controlled pod movement and a
> deliberately OutOfSync Longhorn child. Abort before sync if node labels,
> capacity, CNPG quorum/replication, backend disruption budget/readiness, or
> the Longhorn ownership plan do not match the qualification evidence.

Before that sync, the operator must relabel the three existing nodes and align
their persistent RKE2 `node-label` configuration as described in
[`RKE2_1_34_QUALIFICATION.md`](RKE2_1_34_QUALIFICATION.md). RKE2 applies
configured node labels at registration; editing configuration alone does not
relabel an already registered node.

This warning concerns the scheduling and Argo CD policy changes in C1.2. It
does not authorize enabling the production Longhorn PVC patch.

## Named owners and thresholds

The evidence packet must name people, not only teams, for the window being
reviewed:

| Role | Required decision or evidence |
| --- | --- |
| Change commander | Owns the go, abort, and recovery calls; records the approved window and communication path. |
| Storage owner | Attests to Longhorn, disk, filesystem, capacity, rebuild, and upgrade evidence. |
| Database owner | Attests to CNPG quorum, synchronous replication, backup, restore, lag, and database acceptance checks. |
| Application owner | Approves synthetic read/write coverage, backend readiness, disruption budget, and error/latency thresholds. |
| Facilities owner | Attests to the observed rack, PDU, UPS, generator, cooling, and physical-cabling map. |
| Network owner | Attests to switch paths, link redundancy, loss-test boundaries, and expected convergence behavior. |
| Backup/recovery owner | Verifies immutable evidence for the backup used by the rehearsal and the disposable restore result. |

The packet must record owner-approved RTO, RPO, availability, latency,
replication-lag, capacity-headroom, and convergence thresholds where they apply.
This document does not invent those values. A missing owner, threshold, or
decision is `NOT QUALIFIED`.

## Evidence gate

Every receipt must identify the cluster, collection time, command or tool
version, exact Git revision, and named collector. Redact credentials, tokens,
patient data, direct personal identifiers, and storage encryption material.
Synthetic test data is required.

### 1. StorageClass, PV, PVC, and placement inventory

Retain machine-readable output and a reviewed summary that covers:

- every StorageClass, including provisioner, parameters, default annotation,
  expansion behavior, binding mode, and reclaim policy;
- every PV and PVC, including namespace, workload owner, capacity, access mode,
  StorageClass, phase, node affinity, finalizers, reclaim policy, and actual
  node attachment;
- StatefulSet and CNPG volume-claim templates, pod affinity/anti-affinity,
  topology spread, node selectors, taints, tolerations, and disruption budgets;
- current pod-to-node placement and the truthful
  `topology.kubernetes.io/region`, `topology.kubernetes.io/zone`, and
  `kubernetes.io/hostname` labels; and
- orphaned, Released, Pending, undersized, overcommitted, or unexpectedly
  default-class volumes.

The three production nodes remain in the same truthful zone until facilities
evidence proves independent rack, power, and network domains. Labels must
describe observed infrastructure; they must not manufacture independence.

### 2. Longhorn readiness and provenance

Before any placement decision, retain:

- the exact Longhorn chart, manager, engine, instance-manager, CSI, and UI
  versions and image digests;
- the upstream release and upgrade notes for the installed version and every
  proposed one-minor upgrade;
- CRD establishment, controller/CSI readiness, webhook readiness, and
  Longhorn system pod placement;
- node and disk eligibility, schedulability, tags, allocated and available
  space, over-provisioning, minimal-available-space settings, and eviction
  state;
- volume, replica, engine, snapshot, recurring-job, attachment, rebuild, and
  backup state, including every degraded or faulted object; and
- proof that replica anti-affinity produces separate node copies for the
  proposed workload.

No healthy dashboard screenshot alone is sufficient. Evidence must include the
underlying objects and metrics. Three healthy replicas still prove only three
node copies unless the facilities and network evidence below proves more.

### 3. NVMe, RAID, filesystem, and capacity

For every proposed Longhorn disk, record:

- server, controller, NVMe/SSD model, serial or stable asset identifier,
  firmware, endurance rating, power-loss-protection capability, and warranty;
- RAID level and members, controller firmware, cache and battery/capacitor
  state, write-cache policy, patrol/scrub result, and current rebuild state;
- SMART/NVMe health, media/data-integrity errors, unsafe shutdowns, percentage
  used, spare, temperature, and error-log results;
- filesystem type, feature set, mount options, block size, discard policy,
  encryption layer, and kernel/device-mapper path;
- raw, RAID-usable, filesystem-usable, Longhorn-schedulable, allocated,
  reserved, and free capacity; and
- growth forecast, snapshot/backup/rebuild reserve, failure-mode reserve, and
  owner-approved headroom threshold.

Capacity must be modeled with full Longhorn replicas, snapshots, rebuild
workspace, and workload-native replication. Logical PVC size is not the
physical-capacity requirement.

### 4. Performance, replication, and failure testing

Run the proposed layout first on synthetic QA hardware and data. Retain workload
definitions, raw results, percentiles, timestamps, and node/network metrics for:

- durable-write/fsync latency and p50/p95/p99 latency under representative
  PostgreSQL mixed read/write load;
- random and sequential IOPS, throughput, queue depth, saturation, CPU, memory,
  and network utilization;
- CNPG write, flush, and replay lag while healthy, rebuilding, and under the
  approved network-loss test;
- Longhorn replica rebuild duration, degraded duration, resynchronization,
  snapshot behavior, and post-rebuild checksum/application verification;
- one bounded network-loss scenario approved by the network and database
  owners, including packet-loss scope, fencing assumptions, convergence, and
  recovery; and
- backend synthetic reads/writes, storage, CNI, DNS, metrics, and alert
  evaluation throughout the test.

Quantify write amplification from application writes through PostgreSQL data
and WAL, CNPG streaming, Longhorn replication, RAID, and physical-device writes.
Do not substitute the configured replica counts or a theoretical multiplier for
measured host and device write totals.

Any owner-threshold breach, CNPG loss of quorum or synchronous-standby health,
Longhorn fault, unexplained checksum difference, or incomplete convergence is
an abort signal and leaves the placement `NOT QUALIFIED`.

### 5. Rack, power, UPS, and switch map

Provide an as-built map for all three nodes and their storage/network paths:

- rack and room;
- PSU A/B to PDU, PDU to UPS, UPS bypass and generator path;
- NIC port to switch, switch peer/stack/MLAG relationship, and uplink path;
- storage traffic VLAN/bonding path and any shared controller or cable;
- maintenance ownership and monitoring for each component; and
- the correlated failures caused by losing each rack, PDU, UPS, switch, link,
  room, or facility.

The map must explicitly state which components are shared. Identical zone
labels or three servers in one room are not independent facility failure
domains.

### 6. Backup and disposable restore proof

Before proposing data movement:

- identify the exact pre-test backup and immutable archive identity;
- retain backup custom-resource status, Barman backup identifier, timestamps,
  object metadata, checksums, encryption/authentication evidence, retention,
  and the producer identity used;
- prove recovery with a separate read-only identity into a disposable
  namespace or cluster using synthetic data;
- verify ownership, schema, extensions, row counts, checksums, representative
  queries, and application reads after restore; and
- record cleanup of only UID- and label-verified disposable resources.

The repository's Barman Cloud Plugin and Cloudflare R2 configuration is inert.
It does not count as a successful backup, restore, credential, or endpoint
proof. A backup without a verified disposable restore does not pass this gate.

### 7. Exact compatibility matrix

The reviewed packet must record and link the exact:

- RKE2/Kubernetes current pin, every approved ladder pin, and objective;
- Longhorn current/proposed chart and component versions;
- CloudNativePG operator and PostgreSQL image versions;
- CSI components, open-iscsi, multipath/device-mapper, cryptsetup, and kernel;
- operating system, filesystem, RAID/controller firmware, and NVMe firmware;
  and
- backup plugin, object-store API, and restore tooling.

The matrix must cite upstream support and upgrade notes for every adjacent
pair. RKE2 may advance only through
[`RKE2_1_34_QUALIFICATION.md`](RKE2_1_34_QUALIFICATION.md). The interleaved
CNPG states follow
[`CNPG_POSTGRES_18_QUALIFICATION.md`](CNPG_POSTGRES_18_QUALIFICATION.md).
Longhorn advances one minor at a time and never uses downgrade as rollback.

### 8. Service-by-service migration and abort plan

The proposal must cover CNPG data and WAL, Redis, Vault, step-ca, MinIO, Harbor
jobservice/Trivy data, and every additional PVC discovered by the inventory.
For each service, provide:

1. current owner, StorageClass, PV/PVC set, replicas, data authority, and
   dependency map;
2. approved availability, RTO/RPO, latency, data-loss, lag, and convergence
   thresholds;
3. exact backup, checksum, and disposable-restore evidence;
4. a synthetic rehearsal using the same source/target versions and storage
   behavior;
5. a reviewed change unit that moves only that service, with an explicit hold
   point before the next service;
6. readiness, replication, application, metrics, and alert checks during a
   named observation period;
7. objective abort signals and the commander who calls the abort;
8. a recovery procedure that preserves the source and evidence until the
   target passes; and
9. the criteria and separate authorization for retiring old storage.

A blanket patch, generic destructive replacement instruction, or untested
one-sequence-fits-all plan does not pass. CNPG, MinIO, Vault, Redis, step-ca,
and Harbor have different authorities and recovery contracts.

## Decision record

The reviewing owners may record only one of these outcomes:

- `NOT QUALIFIED`: evidence or owner decisions are missing, inconsistent, or
  outside threshold;
- `PLACEMENT QUALIFIED`: the proposed placement passed the evidence gate, but
  no migration is yet authorized; or
- `CHANGE APPROVED`: a separately reviewed service-by-service plan, named
  window, abort authority, and recovery receipts authorize only the stated
  service and revision.

C1.2 itself remains `NOT QUALIFIED` for migration because it intentionally
contains no live environment evidence and selects no migration.

## Rollback boundary

For this inert repository slice, rollback is a Git revert before manual sync.
Because no storage migration occurs, there is no cutback operation to claim.

A later approved migration must use the per-service recovery plan and preserve
the previous source until acceptance. Longhorn downgrade is never accepted as
rollback; stop at the last qualified version or restore through the
service-specific, previously proven recovery path.
