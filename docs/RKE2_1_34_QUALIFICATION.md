# RKE2 1.34 Qualification and Upgrade Ladder

**Status:** repository qualification contract only

**Baseline:** `github/main` at
`93e887f9b6db248bb898cd12479caf6c020ce73c`, fetched 2026-07-29

**Objective:** RKE2 `v1.34.9+rke2r1` (Kubernetes `v1.34.9`), channel
`stable`, with the exact pin authoritative

**Activation boundary:** C1.2 performs no live host, cluster, Argo CD sync,
deployment, upgrade, restore, migration, or fault-injection action. The four
top-level Argo CD Applications remain manual-sync, the Longhorn child
Application becomes manual-sync, and Ansible changes do nothing until an
operator deliberately runs a playbook.

This document qualifies one controlled route from the current
`v1.31.4+rke2r1` state to the objective. It does not authorize a floating
channel upgrade. `stable` identifies the intended release track; the exact
version sequence below is the only authority for this campaign.

## Release pins and provenance

The RKE2 release URLs and published timestamps were checked against the
official `rancher/rke2` GitHub release records on 2026-07-29. A visible release
page is provenance, not proof that a production node can retrieve a
Prime-restricted artifact.

| Order | Exact RKE2 pin | Kubernetes | Official release and published time (UTC) | Access gate |
| ---: | --- | --- | --- | --- |
| 0 | `v1.31.4+rke2r1` | `v1.31.4` | [RKE2 release](https://github.com/rancher/rke2/releases/tag/v1.31.4%2Brke2r1), 2024-12-18 22:48:08Z | Current starting pin; 74 public assets; not an upgrade target |
| 1 | `v1.31.14+rke2r2` | `v1.31.14` | [RKE2 release](https://github.com/rancher/rke2/releases/tag/v1.31.14%2Brke2r2), 2026-03-18 17:37:25Z | **Prime-only**; zero public assets |
| 2 | `v1.32.13+rke2r2` | `v1.32.13` | [RKE2 release](https://github.com/rancher/rke2/releases/tag/v1.32.13%2Brke2r2), 2026-05-27 13:06:11Z | **Prime-only**; zero public assets |
| 3 | `v1.33.13+rke2r1` | `v1.33.13` | [RKE2 release](https://github.com/rancher/rke2/releases/tag/v1.33.13%2Brke2r1), 2026-06-25 00:53:20Z | Standard release; 74 public assets |
| 4 | `v1.34.9+rke2r1` | `v1.34.9` | [RKE2 release](https://github.com/rancher/rke2/releases/tag/v1.34.9%2Brke2r1), 2026-06-25 01:56:03Z | Final exact objective; 74 public assets |

`v1.31.14+rke2r2` and `v1.32.13+rke2r2` are mandatory rungs even though
their release notes identify them as Prime-only. Before scheduling the
campaign, the owner must prove the hospital's current Rancher Prime
entitlement, authenticated artifact access from synthetic QA and every
production node, the retrieved artifact identity/checksum, and the approved
offline or mirror path if used. Missing or expired entitlement, an inaccessible
artifact, or an unverifiable artifact is a hard stop. Do not substitute a
different patch, use an untrusted mirror, or skip either rung.

Store the authenticated Prime Artifacts URL only as
`vault_rke2_prime_artifact_url`; production maps it to the protected
`rke2_install_artifact_url` installer input. Never pass the URL on the command
line, print it, or retain it in evidence. Leave it empty for a public-release
install. A Prime-only target with an empty protected URL is a hard stop. The
same gate renders and verifies
`system-default-registry: registry.rancher.com` before a Prime node restarts;
an absent or different registry is also a hard stop.

The YAML files are authoritative only when the stock RKE2 systemd unit invokes
`/usr/local/bin/rke2 server` or `agent` without alternate inputs. Before a
restart and again against the live process, the playbook rejects unit
drop-ins, a non-stock fragment or `ExecStart`, unexpected `EnvironmentFile`
directives, any `RKE2_*` manager or service environment override, and any
additional live command-line argument. This prevents `RKE2_CONFIG_FILE`,
`RKE2_SYSTEM_DEFAULT_REGISTRY`, CLI flags, or an equivalent token, URL, label,
or taint environment value from silently outranking the reviewed YAML.

The pre-start gate pins the complete stock systemd fragment, not selected
lines. The following SHA-256 values were independently re-fetched from the
official tagged RKE2 source on 2026-07-29:

| RKE2 pins | Server unit SHA-256 | Agent unit SHA-256 | Official tagged units |
| --- | --- | --- | --- |
| `v1.31.4+rke2r1`, `v1.31.14+rke2r2` | `caf5e4ff923c968d15494d984320b9ab4be13504fe9d37b968ca52ecd8e4ffcb` | `ce3962d986a360e11d175de9fa8d9ae0a55cb227f41ed576e93fcbc817d8a103` | [`v1.31.4`](https://github.com/rancher/rke2/tree/v1.31.4%2Brke2r1/bundle/lib/systemd/system), [`v1.31.14`](https://github.com/rancher/rke2/tree/v1.31.14%2Brke2r2/bundle/lib/systemd/system) |
| `v1.32.13+rke2r2`, `v1.33.13+rke2r1`, `v1.34.9+rke2r1` | `30cb868bfbc40d69b3c3b7553493c50c17538f3a550c89ff2300d13bb66a61b1` | `7c574199fc688205f313c451255fffcc139b8092326de8c706d50e2d3058c608` | [`v1.32.13`](https://github.com/rancher/rke2/tree/v1.32.13%2Brke2r2/bundle/lib/systemd/system), [`v1.33.13`](https://github.com/rancher/rke2/tree/v1.33.13%2Brke2r1/bundle/lib/systemd/system), [`v1.34.9`](https://github.com/rancher/rke2/tree/v1.34.9%2Brke2r1/bundle/lib/systemd/system) |

The Kubernetes ladder is interleaved with the already-cleared C1.1
CloudNativePG operator ladder. These release records make the bridge pins
reviewable:

| Kubernetes state | Required CNPG operator state | Official release and published time (UTC) | Qualification status |
| --- | --- | --- | --- |
| 1.31 | `1.27.4` | [CNPG release](https://github.com/cloudnative-pg/cloudnative-pg/releases/tag/v1.27.4), 2026-04-01 08:57:49Z | **Past EOL; transit-only** |
| 1.32 | `1.28.4` | [CNPG release](https://github.com/cloudnative-pg/cloudnative-pg/releases/tag/v1.28.4), 2026-06-29 15:38:44Z | **Past EOL; transit-only** |
| 1.33 | `1.29.2` | [CNPG release](https://github.com/cloudnative-pg/cloudnative-pg/releases/tag/v1.29.2), 2026-06-29 16:06:03Z | Bridge state |
| 1.34 | `1.30.0` | [CNPG release](https://github.com/cloudnative-pg/cloudnative-pg/releases/tag/v1.30.0), 2026-06-29 16:36:13Z | Final C1.1 operator pin |

CNPG `1.27.4` and `1.28.4` are past-EOL transit-only states. Cross both in
one owner-controlled campaign; neither is an accepted parking, handoff, or
fallback state. Follow the complete intra-CNPG sequence and compatibility
evidence in
[`CNPG_POSTGRES_18_QUALIFICATION.md`](CNPG_POSTGRES_18_QUALIFICATION.md);
the abbreviated bridge table above does not remove its earlier operator
rungs.

### Authoritative supporting references

- [RKE2 manual upgrades](https://docs.rke2.io/upgrades/manual) documents
  exact-version installation, server-before-agent order, channels, and the
  upstream version-skew warning.
- [RKE2 automated upgrades](https://docs.rke2.io/upgrades/automated)
  documents serial server/agent plans and explicitly warns that upstream
  automation does not itself prevent skipped minors or downgrades. C1.2 uses
  the stricter Ansible ladder gates instead of a floating plan.
- [RKE2 rollback](https://docs.rke2.io/upgrades/roll-back) requires binary
  rollback together with a datastore snapshot from the target minor.
- [RKE2 1.31 release notes](https://docs.rke2.io/release-notes-old/v1.31.X)
  identify `v1.31.14+rke2r2` as Prime-only.
- [RKE2 1.32 release notes](https://docs.rke2.io/release-notes-old/v1.32.X)
  identify `v1.32.13+rke2r2` as Prime-only.
- [SUSE Rancher Prime RKE2 quickstart](https://documentation.suse.com/external-tree/en-us/cloudnative/rke2/latest/en/install/quickstart.html)
  documents the authenticated Prime Artifacts URL and exact-version
  installer input. Release-page visibility is not a substitute for this
  authenticated access.

## Mandatory campaign order

Run the complete campaign in synthetic QA first. Production may start only
after that rehearsal passes with the same pins, topology, CNI, storage
classes, CNPG configuration, and playbook revision.

1. While Kubernetes remains at `1.31`, follow the C1.1 CNPG sequence through
   `1.27.4`.
2. Advance RKE2 from `v1.31.4+rke2r1` to
   `v1.31.14+rke2r2`.
3. With CNPG `1.27.4` healthy, advance RKE2 to
   `v1.32.13+rke2r2`; then advance CNPG to `1.28.4`.
4. With CNPG `1.28.4` healthy, advance RKE2 to
   `v1.33.13+rke2r1`; then advance CNPG to `1.29.2`.
5. With CNPG `1.29.2` healthy, advance RKE2 to
   `v1.34.9+rke2r1`; only then advance CNPG to `1.30.0`.

Each RKE2 target must be the immediate next exact pin. The operator-run
`infra/ansible/playbooks/upgrade-k8s.yml` rejects skipped minors, downgrades,
off-ladder targets, missing pre-rung snapshot evidence, and degraded etcd,
CNPG, or storage state. Declaring source and target variables does not
override those gates.

Before each RKE2 rung, identify the current etcd leader. Upgrade servers one
at a time: etcd followers first and the leader last. Do not begin the next
server until the current server is Ready, its local services are healthy, and
quorum and workload checks pass. Upgrade agents only after all servers pass,
also one at a time.

## Per-rung entry gates

Every rung needs a named owner, commander, approved window, and written abort
decision. Attach the following receipts before the playbook may change a
server:

- synthetic-QA evidence for this exact source/target pair;
- release-note review and disposition for RKE2, Kubernetes, embedded etcd,
  containerd, the configured CNI, ingress, metrics-server, and any enabled
  packaged component;
- Rancher Prime entitlement and artifact-access proof for the two Prime-only
  rungs;
- a fresh, immediately pre-rung etcd snapshot, including its name, creation
  time, checksum or immutable identity, local location, off-site status, and
  the exact source RKE2 version;
- a current application-data backup and successful disposable restore proof;
- healthy etcd membership, endpoints, leader, alarms, and quorum;
- healthy CNPG Cluster status, synchronous replication, backup/WAL status,
  and no unexpected replica lag;
- healthy StorageClasses, bound production PVCs, storage nodes/volumes where
  applicable, and no degraded or rebuilding production volume;
- the control-plane VIP serving an HTTPS `GET /readyz` on port 6443 and RKE2
  registration on port 9345;
- healthy CNI, cluster DNS, metrics collection, and alert evaluation; and
- passing backend synthetic reads and writes against named synthetic records.

The playbook requires non-empty `synthetic-qa.txt`,
`pre-rung-etcd-snapshot.txt`, `backup-restore-proof.txt`,
`release-note-review.txt`, `owner-window.txt`, `cnpg-replication.txt`,
`storage-health.txt`, `cni-dns.txt`, and `metrics-alerts.txt` receipts in the
declared absolute evidence directory. `synthetic-qa.txt` must identify the
backend synthetic read/write proof rather than merely naming a test suite.
Set the snapshot evidence age limit to fit the approved window; passing an
old-but-present file does not satisfy the immediately pre-rung requirement.

A missing receipt, an ambiguous owner, a degraded dependency, or an active
unexplained alert is `NO-GO`. Do not turn a warning into an acceptance by
waiver inside the playbook.

The release-note disposition must explicitly cover the Prime-only restriction
on the 1.31 and 1.32 pins. The `v1.33.13+rke2r1` and
`v1.34.9+rke2r1` release notes also warn of a Traefik chart provider-name
breaking change. Record whether Traefik is enabled; if it is not, retain the
configuration evidence that makes the warning non-applicable.

## Per-rung exit evidence

After each server and again after the complete rung, capture:

| Area | Required evidence |
| --- | --- |
| Version | Source and target pins, playbook commit, node versions, API `/version`, start/end times |
| VIP | Current owner; VIP-backed kubeconfig endpoint; 6443 `/readyz`; TCP 9345; fail/rise state |
| etcd | Member list, endpoint health/status, leader, alarms, quorum before and after each server |
| Nodes | Ready conditions, taints, region/zone labels, cordon state, server order, agent order |
| Backend | Synthetic record identifiers, write/read result, bounded checksums, readiness and PDB state |
| CNPG | Operator pin, Cluster status, primary, instances, synchronous standby, replication/backup/WAL evidence |
| Storage | StorageClasses, PV/PVC state, capacity, and Longhorn health if installed |
| Platform | CNI, DNS queries, metrics freshness, alert state, and relevant events/logs |
| Decision | Named owner, observed impact, `GO`/`STOP`, approved rollback point, receipt locations |

VIP access alone is not sufficient: the API must answer `/readyz`, not merely
hold a TCP listener. CI and the read-only C1.2 evidence collector can validate
contracts and collect state, but they do not constitute a live failure drill
or a production rung result.

## Existing-node failure-domain alignment

RKE2 `node-label` configuration is applied at node registration; changing the
file does not relabel an existing Kubernetes Node. Before the first manual
sync, the operator must align all three live nodes:

1. Using the VIP-backed kubeconfig from any healthy server, export all current
   node names and `topology.kubernetes.io/region` and
   `topology.kubernetes.io/zone` labels.
2. Obtain the truthful region and zone from the facilities owner. Until
   independent rack, power, network, UPS/PDU, and switch domains are proven,
   assign the same truthful zone to all three nodes.
3. Relabel each live node with `kubectl label node <live-node> ... --overwrite`
   and verify all three labels through the VIP endpoint.
4. Set matching, non-empty `inventory_region` and `inventory_zone` values for
   each inventory host, render the RKE2 configuration, and verify its
   `node-label` entries exactly match the live labels.
5. Abort before sync if any live label, inventory value, or rendered RKE2
   label disagrees. Preserve the before/after output.

Do not infer independent zones from three hostnames. Distinct zones become
permitted only after facilities evidence proves the corresponding independent
failure domains.

## Pre-sync operator warning

> Syncing this revision is an operator action, not a merge side effect. It
> triggers a CNPG rolling re-schedule under required hostname anti-affinity,
> redeploys the backend under hard hostname spread, and changes the Longhorn
> child Application to manual-sync. Expect controlled pod movement and a
> deliberately OutOfSync Longhorn child. Abort before sync if node labels,
> capacity, CNPG quorum/replication, backend disruption budget/readiness, or
> the Longhorn ownership plan do not match the qualification evidence.

The operator must complete the existing-node relabel and configuration
alignment above before sync. A merge, green CI result, or successful manifest
render is not activation evidence.

## Stop and rollback

If a gate fails, stop at the last completely qualified Kubernetes/CNPG pair.
Do not continue to escape a transit-only state without first restoring the
failed dependency to health and obtaining a new owner decision.

- Leave a failed node cordoned until API readiness, etcd quorum, CNPG
  replication, storage, CNI, DNS, metrics, alerts, and synthetic reads/writes
  pass.
- A previous-minor RKE2 rollback is allowed only with the matching pre-rung
  etcd snapshot, binary rollback on **every** server, and datastore restore.
  Never perform a per-node binary downgrade in place.
- Roll CNPG back only by the C1.1 operator/backup procedure to the last
  supported Kubernetes/CNPG pair.
- Restore prior keepalived configuration serially. Before withdrawing the
  VIP, repoint operator kubeconfigs to a verified healthy per-node SAN and
  preserve the evidence.
- Repository rollback is a Git revert while Applications remain manual-sync.
  Scheduling rollback is an operator manual-sync of the prior pinned
  revision.
- C1.2 selects no storage migration, so there is no storage cutback.
  Longhorn downgrade is not accepted.

## Next objective

CloudNativePG 1.31 is expected around September 2026 and will likely make
Kubernetes 1.35 the next RKE2 objective. Treat that as one additional
qualified rung: one more rung, not a rework of this ladder. The expectation
is not an approved pin: qualify the actual CNPG and RKE2 releases,
compatibility, provenance, gates, and rollback before adding the rung.

## Repository validation

The authoritative infra CI entrypoint is:

```powershell
node scripts/ci/run.mjs --only=infra
```

Use `scripts/local-ci.mjs` only when it is the repository aggregate wrapper
that invokes this entrypoint. CI proves repository contracts only; it must not
claim a live upgrade, restore, sync, migration, or HA drill.
