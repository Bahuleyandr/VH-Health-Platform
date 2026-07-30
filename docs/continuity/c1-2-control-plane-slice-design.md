# C1.2 Control-Plane, Storage, and Scheduling Continuity Slice Design

**Status:** coordinator-cleared implementation delta

**Clearance date:** 2026-07-28

**Implementation baseline:** `github/main` at
`93e887f9b6db248bb898cd12479caf6c020ce73c`, fetched on 2026-07-29

**Scope:** `infra/ansible`, `infra/kubernetes`, and `docs` only. This slice has
no backend, application-code, database-migration, live-host, live-cluster,
Argo-sync, deployment, storage-migration, or fault-injection action.

**Authority:** the C1.2 tranche in
[`docs/superpowers/specs/2026-07-28-clinical-service-continuity-design.md`](../superpowers/specs/2026-07-28-clinical-service-continuity-design.md),
the execution rules and C1 plan in
[`docs/superpowers/plans/2026-07-28-clinical-service-continuity.md`](../superpowers/plans/2026-07-28-clinical-service-continuity.md),
and the coordinator-cleared C1.2 Step-1 delta dated 2026-07-28.

## 1. Outcome and activation boundary

C1.2 removes the documented node-1 dependency from normal RKE2 registration
and administration, makes scheduling promises match the three physical hosts
that actually exist, records the qualified RKE2 upgrade ladder, and supplies
operator-run templates and evidence procedures for control-plane and storage
continuity.

Everything lands inert:

- all four top-level production Argo CD Applications remain manual-sync;
- the Longhorn child Application becomes manual-sync;
- Ansible roles and playbooks change files only when an operator deliberately
  runs them against an inventory;
- the HA evidence collector is read-only and injects no failure;
- no storage migration is selected or executed; and
- no live host, cluster, sync, deployment, upgrade, restore, or migration
  action is part of repository validation.

A separate C3.1 backend lane is allowed to run in parallel. C1.2 must not
touch `apps/backend` or any other application path.

## 2. Control-plane VIP

The control-plane endpoint uses keepalived unicast VRRP, not kube-vip.
Keepalived can establish the endpoint before a local Kubernetes API or
kubeconfig exists, which removes a circular bootstrap dependency.

One virtual IP, `10.10.0.10`, is held by one locally healthy RKE2 server and
serves both:

- `https://10.10.0.10:6443` for the Kubernetes API; and
- `https://10.10.0.10:9345` for RKE2 registration.

There is no HAProxy layer. All servers start in `BACKUP` state, use
deterministic priorities and `nopreempt`, and advertise the VIP only while the
local readiness check passes. The check must use a strict-timeout HTTPS
`GET /readyz` against `127.0.0.1:6443` with certificate verification disabled,
plus a strict-timeout TCP probe of `127.0.0.1:9345`. A listening but wedged API
server must fail health. Keepalived fail/rise hysteresis prevents transient
failures from immediately moving the VIP.

The new
`infra/ansible/roles/control_plane_vip/` role contains defaults, tasks,
handlers, metadata, `keepalived.conf.j2`, and
`check-rke2-control-plane.sh.j2`. It validates before change that:

- the VIP is not any inventory node address;
- the interface and prefix length are set;
- the virtual-router ID is valid;
- each enabled host has a complete unicast peer set; and
- the local address and all peer addresses are distinct and complete.

Keepalived configuration validation precedes a serial reload. The site
playbook processes RKE2 servers one at a time so an existing VIP is never
dropped on every host together and so the existing simultaneous RKE2 restart
notify risk is removed.

The firewall permits:

- VRRP IP protocol 112 only between the declared cluster CIDRs on the selected
  control-plane interface; and
- Kubernetes API TCP 6443 from declared management CIDRs and declared cluster
  peers, which require internal API access.

The inventory contract is:

- `control_plane_vip_enabled`;
- `control_plane_vip_address`;
- `control_plane_vip_interface`;
- per-host `control_plane_vip_unicast_address`, normally the node address on
  that interface;
- `control_plane_vip_prefix_length`;
- `control_plane_vip_virtual_router_id`;
- `control_plane_api_dns_name`; and
- vault-backed `rke2_cluster_token`, with an explicit
  `rke2_cluster_token_mode`.

The production example enables the control-plane VIP. Single-node development
disables it. C2.1 subsequently extends the role with a separately gated
internal-ingress instance, distinct address, virtual-router ID, peer ledger,
health check, and firewall contract. The C1.2 instance and endpoint contract
remain unchanged; see
[`c2-1-private-ingress-slice-design.md`](c2-1-private-ingress-slice-design.md).

## 3. Token custody and existing-cluster hard stop

Production uses one required, pre-shared RKE2 token held in Ansible Vault.
`vault.yml.example` documents the schema without containing a real token.
Bootstrap-host token reads are removed from the normal path.

Before the first operator apply to the existing cluster, the operator must
capture the exact live RKE2 token into Vault. Preflight compares the
vault-backed value with the live token on each existing server. Any mismatch,
missing value, placeholder value, or disagreement between servers is a hard
stop before configuration or service changes.

Existing production uses `steady_state_exact`, which accepts only the secure
`K10...::server:...` value read from the cluster. A brand-new self-signed
cluster may use `fresh_short` for its first run only; after bootstrap the
operator captures the persisted secure token into Vault and changes the mode
to `steady_state_exact` before any reapply. The role refuses `fresh_short` as
soon as datastore state exists.

Only the disabled-VIP, single-node development inventory uses
`development_short`, allowing RKE2's secure wrapper around its explicitly
non-production short token. There is no generated or silently defaulted
production token. Server and agent configuration reference root-only token
files so Ansible diffs and configuration backups do not expose the credential.

## 4. RKE2 and kubeconfig wiring

The bootstrap server receives the pre-shared token and no `server:` entry.
Every joining server uses:

```yaml
server: "https://10.10.0.10:9345"
```

Bootstrap waits until both VIP ports 6443 and 9345 are reachable before
joiners may start. Every server places the VIP and the optional
`control_plane_api_dns_name` in `tls-san`; its own hostname and node IP remain
SANs for break-glass access.

Every server's admin kubeconfig is rewritten to
`https://10.10.0.10:6443`. The agent role defaults to the VIP registration
URL, never a first inventory host or a node-1 example. Workstation guidance
retrieves a VIP-backed kubeconfig from any healthy server. The new Kubernetes
upgrade and node-replacement playbooks also use the VIP-backed kubeconfig.

No bootstrap, join, agent, kubeconfig, maintenance, or operator path may
select `groups['rke2_servers'][0]`, `groups['rke2_servers'] | first`, or an
equivalent first-inventory-host endpoint.

## 5. Failure-domain truth and scheduling

`inventory_region` and `inventory_zone` are required, non-empty inventory
facts. The RKE2 server template no longer silently substitutes `default`.
Until facilities evidence proves independent rack, power, and network failure
domains, the production example assigns the same truthful zone to all three
nodes. Distinct zones are permitted only after that evidence exists.

RKE2 node labels are registration-time configuration, so changing config does
not relabel the three live nodes. The HA runbook must give explicit operator
steps to:

1. inventory current node names and labels;
2. apply the truthful `topology.kubernetes.io/region` and
   `topology.kubernetes.io/zone` labels with `kubectl`;
3. verify all three live labels;
4. align each host's RKE2 config so a future registration keeps the same
   labels; and
5. abort before sync if live labels and configuration disagree.

Backend hostname spread becomes hard:

- `topologyKey: kubernetes.io/hostname`;
- `maxSkew: 1`; and
- `whenUnsatisfiable: DoNotSchedule`.

Zone spread remains best-effort. Comments promise node distribution, not
unproven facility isolation. The policy remains compatible with the HPA:
after one node is lost, replacement replicas may schedule on the two
survivors, while readiness and the PodDisruptionBudget remain authoritative.

The CNPG cluster uses required pod anti-affinity on
`kubernetes.io/hostname`. At most one database instance may run on a host.
After a node loss, a third instance remaining `Pending` is correct: the two
survivors preserve quorum and the configured synchronous standby rather than
creating a false third failure domain on an already occupied host.

## 6. RKE2 objective and qualified ladder

The exact-pin objective is RKE2 `v1.34.9+rke2r1`, Kubernetes v1.34.9, on the
stable channel. The only approved operator-executed RKE2 ladder is:

1. `v1.31.4+rke2r1`;
2. `v1.31.14+rke2r2`;
3. `v1.32.13+rke2r2`;
4. `v1.33.13+rke2r1`; and
5. `v1.34.9+rke2r1`.

It is interleaved with the C1.1 CNPG operator ladder:

| Kubernetes state | CNPG operator state |
| --- | --- |
| 1.31 | 1.27.4 |
| 1.32 | 1.28.4 |
| 1.33 | 1.29.2 |
| 1.34 | 1.30.0 |

CNPG 1.27.4 and 1.28.4 are past-end-of-life, transit-only states crossed in
one controlled campaign. They are never accepted parking states.

Every rung requires synthetic QA first, an immediately pre-rung etcd
snapshot, backup and disposable-restore proof, release-note review, and a
named owner window. Servers advance one at a time, etcd followers first and
the leader last; agents follow only after the server quorum passes.

Each rung records:

- VIP API and registration access;
- etcd membership, leader, and health;
- backend synthetic reads and writes;
- CNPG status and replication;
- storage health;
- CNI and DNS health;
- metrics and alert evaluation; and
- the approved rollback point.

`playbooks/upgrade-k8s.yml` rejects skipped minors, downgrades, targets not on
the approved ladder, missing pre-rung snapshot evidence, and degraded CNPG,
etcd, or storage state.

`docs/RKE2_1_34_QUALIFICATION.md` records the official release URL and release
date for every exact pin, especially the two pins that were externally
unconfirmed at clearance. RKE2 `v1.31.14+rke2r2` and
`v1.32.13+rke2r2` are SUSE Prime-only releases with no public artifacts;
authenticated Prime artifact access is a hard pre-rung gate, never a reason to
skip the minor. The qualification also records gates, evidence, rollback, and
the acceptance note that CNPG 1.31, expected around September 2026, will likely
make Kubernetes 1.35 the next objective as one additional rung rather than a
redesign.

## 7. Storage truth and placement gate

The current repository truth is:

- CNPG data and WAL use `local-path`;
- durability comes from PostgreSQL streaming replication across hosts;
- the declared Longhorn StorageClass is named `longhorn`;
- `longhorn-nvme` is a phantom name and must be removed from active guidance;
- the production Longhorn PVC patch remains commented out; and
- Longhorn 1.7.2 is an unqualified repository target, not a production fact.

The Longhorn child Argo CD Application becomes manual-sync. Manifest comments
must not prescribe destructive delete-and-restore migration. Three Longhorn
replicas mean three node copies, not three proven rack, power, network, or
facility failure domains. Longhorn upgrades move one minor version at a time;
downgrade is not accepted.

`docs/C1_2_STORAGE_PLACEMENT_GATE.md` blocks any storage migration until an
operator supplies:

- StorageClass, PV, PVC, access-mode, reclaim-policy, and affinity inventory;
- Longhorn volume, replica, engine, node, and disk health;
- NVMe, RAID, SMART, filesystem, usable-capacity, and headroom evidence;
- fsync latency, IOPS, throughput, replication lag, and network-loss tests;
- measured write amplification for the proposed stack;
- rack, PDU, UPS, and switch mapping;
- verified backups and a disposable restore;
- exact Kubernetes, Longhorn, CNPG, kernel, and filesystem compatibility; and
- a service-by-service migration, observation, abort, and recovery plan.

`playbooks/longhorn-prereqs.yml` is an operator-run prerequisite template
only. This slice selects no migration, changes no bound PVC, and invents no
migration number.

## 8. HA drill and evidence contract

`infra/kubernetes/qa/c1-2-ha-evidence.sh` is a read-only collector. It records:

- exact component releases;
- nodes, addresses, readiness, taints, and topology labels;
- the VIP owner and both VIP endpoints;
- the API endpoint used by the collector;
- etcd members, health, and leader;
- workload and database pod placement;
- CNPG status, primary, instances, and replication;
- StorageClasses, PVs, and PVCs; and
- Longhorn node, volume, replica, and engine state when installed.

It performs no drain, delete, stop, restart, switchover, cordon, network
change, or other fault injection.

`docs/runbooks/C1_2_HA_DRILL.md` defines four operator-led drills:

1. one node loss;
2. etcd leader and/or VIP-owner loss;
3. CNPG primary switchover; and
4. one storage member loss.

Each drill names a commander, uses synthetic data, captures before/during/after
evidence, records observed impact and recovery, and retains receipts. Fault
injection is manual. Owner-approved thresholds are required inputs; missing
RTO, RPO, availability, data-loss, or convergence thresholds produce
`NOT QUALIFIED`. The runbook never invents an RTO or RPO.

## 9. Pre-sync operator warning

The qualification, storage gate, drill runbook, deployment guidance, and pull
request body must carry the C1.1-style warning:

> Syncing this revision is an operator action, not a merge side effect. It
> triggers a CNPG rolling re-schedule under required hostname anti-affinity,
> redeploys the backend under hard hostname spread, and changes the Longhorn
> child Application to manual-sync. Expect controlled pod movement and a
> deliberately OutOfSync Longhorn child. Abort before sync if node labels,
> capacity, CNPG quorum/replication, backend disruption budget/readiness, or
> the Longhorn ownership plan do not match the qualification evidence.

The operator must first relabel the three existing nodes and align RKE2 config
as described in section 5. A merge or CI result is not activation evidence.

## 10. Complete implementation ledger

The coordinator clearance packet labels `playbooks/upgrade-k8s.yml`,
`playbooks/node-replace.yml`, and `playbooks/longhorn-prereqs.yml` as **Add**.
The pinned `github/main` baseline already contained stubs at those exact paths,
so C1.2 replaces and modifies the stubs rather than creating new paths. They
remain under **Add** below solely to preserve the coordinator's exact 43-path
ledger.

Add:

- `infra/ansible/roles/control_plane_vip/defaults/main.yml`;
- `infra/ansible/roles/control_plane_vip/tasks/main.yml`;
- `infra/ansible/roles/control_plane_vip/handlers/main.yml`;
- `infra/ansible/roles/control_plane_vip/meta/main.yml`;
- `infra/ansible/roles/control_plane_vip/templates/keepalived.conf.j2`;
- `infra/ansible/roles/control_plane_vip/templates/check-rke2-control-plane.sh.j2`;
- `infra/kubernetes/qa/c1-2-ha-evidence.sh`;
- `docs/RKE2_1_34_QUALIFICATION.md`;
- `docs/C1_2_STORAGE_PLACEMENT_GATE.md`;
- `docs/runbooks/C1_2_HA_DRILL.md`;
- `infra/ansible/playbooks/upgrade-k8s.yml`;
- `infra/ansible/playbooks/node-replace.yml`;
- `infra/ansible/playbooks/longhorn-prereqs.yml`;
- `infra/ansible/tests/c1_2_contract.yml`; and
- this design document.

Modify:

- `infra/ansible/inventories/group_vars/all/main.yml`;
- `infra/ansible/inventories/prod.yml.example`;
- `infra/ansible/inventories/dev.yml`;
- `infra/ansible/inventories/group_vars/all/vault.yml.example`;
- `infra/ansible/playbooks/site.yml`;
- `infra/ansible/roles/rke2_server/defaults/main.yml`;
- `infra/ansible/roles/rke2_server/templates/config.yaml.j2`;
- `infra/ansible/roles/rke2_server/tasks/preflight.yml`;
- `infra/ansible/roles/rke2_server/tasks/token.yml`;
- `infra/ansible/roles/rke2_server/tasks/bootstrap.yml`;
- `infra/ansible/roles/rke2_server/tasks/join.yml`;
- `infra/ansible/roles/rke2_server/tasks/install.yml`;
- `infra/ansible/roles/rke2_server/tasks/post-install.yml`;
- `infra/ansible/roles/rke2_agent/defaults/main.yml`;
- `infra/ansible/roles/rke2_agent/templates/config.yaml.j2`;
- `infra/ansible/roles/rke2_agent/tasks/main.yml`;
- `infra/ansible/roles/firewall/defaults/main.yml`;
- `infra/ansible/roles/firewall/templates/nftables.conf.j2`;
- `infra/ansible/README.md`;
- `infra/kubernetes/apps/backend/deployment.yaml`;
- `infra/kubernetes/base/cnpg/cluster.yaml`;
- `infra/kubernetes/base/longhorn/longhorn-app.yaml`;
- `infra/kubernetes/base/longhorn/storageclass.yaml`;
- `infra/kubernetes/overlays/prod/longhorn-pvc-patch.yaml`;
- `infra/kubernetes/overlays/prod/kustomization.yaml`;
- `docs/DEPLOYMENT_GUIDE.md`;
- `docs/HARDWARE_REQUIREMENTS.md`; and
- `docs/PRODUCTION_DB_HARDENING.md`.

No file outside this ledger may change without returning to the coordinator.

## 11. Validation ledger

The implementation retains command output as review receipts for:

- `git diff --check`;
- `ansible-lint infra/ansible`;
- dev and production-example `ansible-inventory` parsing;
- Ansible syntax checks for `site.yml`, `upgrade-k8s.yml`,
  `node-replace.yml`, and `longhorn-prereqs.yml`;
- offline rendering of bootstrap, joining-server, agent, and all three
  keepalived peer configurations;
- assertions that all join URLs, kubeconfigs, and agent defaults use the VIP,
  every server contains the VIP in `tls-san`, and no path selects the first
  inventory host;
- `shellcheck` for the keepalived health and HA evidence scripts;
- development and production Kustomize renders plus `kubeconform`;
- the existing C1.1 manifest contract, including four manual-sync top-level
  Argo CD Applications and the new manual-sync Longhorn child; and
- truth sweeps for `node-1`, `longhorn-nvme`, fictitious zone isolation,
  automatic-sync claims, and storage-migration wording.

The complete file ledger intentionally prevents this slice from editing older
guidance outside its boundary. Truth-sweep receipts therefore classify the
pre-existing automatic-sync text in `docs/SYSTEM-ARCHITECTURE.md`,
`docs/GO_LIVE_ACTIVATION_CHECKLIST.md`,
`docs/PHASE0_OPERATOR_ACTIONS_2026-06-10.md`, and
`infra/kubernetes/base/argocd/README.md`, plus the older zone comments in
`infra/kubernetes/base/cloudflare-tunnel/cloudflared.yaml` and
`infra/kubernetes/base/redis/redis-sentinel.yaml`, as non-authoritative legacy
exceptions requiring a coordinator-approved ledger expansion. They are not
operator authority for C1.2; the manual-sync and shared-zone contracts in this
document and the linked C1.2 runbooks control.

The repository CI entrypoint is:

```powershell
node scripts/ci/run.mjs --only=infra
```

`scripts/local-ci.mjs` is used only if it is the repository's aggregate wrapper
around that entrypoint. CI never claims a live HA drill result.

## 12. Rollback

Repository rollback is a Git revert while the Applications remain
manual-sync.

For an operator-run VIP rollout, restore the previous keepalived configuration
one server at a time. Repoint operator kubeconfigs to a verified healthy
per-node SAN before withdrawing the VIP, and preserve all evidence.

For scheduling, manual-sync the prior pinned revision. For RKE2, stop at the
last qualified rung. Previous-minor rollback is permitted only with the
matching pre-rung etcd snapshot, binary rollback on every server, and
datastore restore; per-node binary downgrade alone is forbidden.

CNPG uses the C1.1 operator and backup rollback for the last supported
Kubernetes/CNPG pair. Because C1.2 performs no storage migration, there is no
storage cutback; Longhorn downgrade is never accepted.

After a drill, restart or rejoin the deliberately failed member, prove quorum
and convergence, and uncordon only after health passes. Retain all receipts.

## 13. Coordinator conditions

Implementation acceptance additionally requires all six clearance conditions:

1. Record the official release URL and date for every RKE2 ladder pin.
2. Probe real local API `/readyz` plus TCP 9345 before advertising the VIP.
3. Mark CNPG 1.27.4 and 1.28.4 past-EOL transit-only.
4. Document live-node relabel plus RKE2 config alignment.
5. Put the pre-sync rolling-reschedule/backend-redeploy/Longhorn-manual warning
   in both documentation and the pull request body, including expected
   behavior and the abort signal.
6. Run `node scripts/ci/run.mjs --only=infra` as the CI entrypoint.
