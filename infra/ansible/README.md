# VH Health Platform — Ansible / RKE2

Production-grade Ansible tree that turns three fresh **Ubuntu 24.04 LTS
Server** machines into a hardened, highly available **RKE2** Kubernetes
control plane for an on-premises hospital deployment (India-first, DPDP /
HIPAA aligned).

Repository changes are inert. Nothing in this tree contacts or changes a host
until an operator deliberately runs a playbook against an inventory. A merge
does not run Ansible, sync Argo CD, deploy a workload, upgrade RKE2, or migrate
storage.

---

## Purpose

Given:

* 3 bare-metal or hypervisor VMs running a fresh Ubuntu 24.04 LTS
* SSH access as a sudo-capable user
* A hospital LAN + outbound internet (for RKE2 binaries + etcd snapshot upload)

…`ansible-playbook playbooks/site.yml` produces a working RKE2 cluster with:

* Embedded etcd 3-node quorum
* CIS Kubernetes Benchmark `profile: cis` enabled
* CIS Ubuntu host hardening subset (auditd, AIDE, fail2ban, pam_faillock,
  hardened sshd, nftables)
* API-server audit logging with HIPAA-grade retention (90 days on-disk)
* 6-hourly etcd snapshots, offsited to Cloudflare R2
* `canal` CNI (flannel + Calico NetworkPolicy)
* A keepalived unicast-VRRP control-plane VIP at `10.10.0.10`, serving the
  Kubernetes API on 6443 and RKE2 registration on 9345
* Deterministic, truthful node region/zone labels; the labels do not claim
  independent facility failure domains without facilities evidence
* Admin user `vhhealth` with passwordless sudo, SSH-key-only, root locked

The tree is deliberately opinionated — a hospital SRE who has never seen this
cluster before can run it on a replacement node and end up with the same
posture as the original.

---

## Tree layout

```
infra/ansible/
├── ansible.cfg
├── requirements.yml
├── .ansible-lint
├── .gitignore
├── README.md
├── inventories/
│   ├── dev.yml                          # single-node sandbox
│   ├── prod.yml.example                 # 3-node hospital template
│   └── group_vars/
│       └── all/
│           ├── main.yml                 # shared non-secret contract
│           └── vault.yml.example        # ansible-vault placeholders
├── playbooks/
│   ├── site.yml                         # full bootstrap
│   ├── upgrade-k8s.yml                  # gated exact-ladder RKE2 upgrade
│   ├── node-replace.yml                 # replace a failed node
│   ├── longhorn-prereqs.yml             # operator-run host prerequisites
│   └── disaster-recover.yml             # legacy; not approved for full loss
└── roles/
    ├── common/                          # OS baseline
    ├── hardening/                       # CIS subset
    ├── firewall/                        # nftables
    ├── control_plane_vip/               # keepalived unicast VRRP
    ├── rke2_server/                     # RKE2 server install + join
    └── rke2_agent/                      # RKE2 worker (growth-path, no-op today)
```

---

## Prerequisites

| Tool / artefact           | Minimum                                              |
| ------------------------- | ---------------------------------------------------- |
| Ansible (control node)    | 2.16+                                                |
| Python on target nodes    | 3.10 (ships with Ubuntu 24.04)                       |
| Collections               | `ansible.posix`, `community.general`, `ansible.utils` |
| Target OS                 | Ubuntu 24.04 LTS Server (Noble)                       |
| SSH                       | Key-based, bootstrap user with sudo                  |
| Control-node access       | Outbound 443 to `get.rke2.io`, `github.com`          |
| Target-node access        | Outbound 443 to `get.rke2.io`, `registry-1.docker.io`, R2 endpoint |
| Upgrade entitlement       | Rancher Prime access for the mandatory 1.31.14 and 1.32.13 rungs |

Install collections:

```bash
cd infra/ansible
ansible-galaxy collection install -r requirements.yml
export ANSIBLE_STDOUT_CALLBACK=default
```

Keep `ANSIBLE_STDOUT_CALLBACK=default` in the controller environment for the
inventory, syntax-check, contract, and operator-run commands below. Current
`community.general` releases no longer provide the legacy `yaml` callback
named by this repository's pre-existing `ansible.cfg`; the built-in `default`
callback is supported and changes output formatting only.

---

## Control-plane endpoint

Production uses keepalived unicast VRRP, not kube-vip, because the endpoint
must exist before a local Kubernetes API or kubeconfig is available. There is
no HAProxy layer. The healthy holder advertises one VIP:

- `https://10.10.0.10:6443` for the Kubernetes API; and
- `https://10.10.0.10:9345` for RKE2 registration.

Every server starts in `BACKUP` state with a deterministic priority and
`nopreempt`. A server may advertise only while its local health script gets a
successful, strict-timeout HTTPS `GET /readyz` from `127.0.0.1:6443` with
certificate verification disabled and a strict-timeout TCP connection to
`127.0.0.1:9345`. Fail/rise hysteresis prevents a transient failure from
moving the VIP. A wedged API process that merely holds its listener cannot
retain the address.

Preflight rejects a VIP that equals a node address and incomplete interface,
prefix, router-ID, local-address, or peer inputs. Keepalived reloads and RKE2
server work are serial. The firewall allows VRRP IP protocol 112 only between
`cluster_cidrs` on the selected control-plane interface. API TCP 6443 is
reachable from `management_cidrs` and from declared cluster peers that require
internal API access.

The designated bootstrap server has the pre-shared token and no `server:`
entry. Every joining server and agent uses
`https://10.10.0.10:9345`. Every server includes the VIP and optional
`control_plane_api_dns_name` in `tls-san`; its hostname and node IP remain
SANs for break-glass access. Admin kubeconfigs on every server use
`https://10.10.0.10:6443`.

---

## Quickstart — fresh production cluster

```bash
cd infra/ansible

# 1. Copy the inventory template and edit in real values.
cp inventories/prod.yml.example inventories/prod.yml
$EDITOR inventories/prod.yml
#   - replace ansible_host for each node with the real IP
#   - replace management_cidrs with the hospital IT LAN
#   - replace cluster_cidrs with the cluster subnet
#   - replace admin_ssh_key with the SRE public key
#   - confirm VIP/interface/prefix and optional API DNS name
#   - set required inventory_region and inventory_zone for every node
#
# Until rack, power, UPS/PDU, switch, and network independence is proven,
# give all three nodes the same truthful zone.

# 2. Create the Vault file and encrypt it.
cp inventories/group_vars/all/vault.yml.example \
   inventories/group_vars/all/vault.yml
$EDITOR inventories/group_vars/all/vault.yml
#   - paste the real Cloudflare R2 access key + secret
#   - for the existing cluster, keep rke2_cluster_token_mode at
#     steady_state_exact and use the exact live secure token described below
#   - for a brand-new self-signed cluster only, set the local inventory mode
#     to fresh_short and use one approved high-entropy short token for the
#     first run
#   - before a Prime-only rung, set vault_rke2_prime_artifact_url to the
#     authenticated SUSE Prime Artifacts URL ending in /rke2; leave it empty
#     for public-release installs
ansible-vault encrypt inventories/group_vars/all/vault.yml

# 3. For the EXISTING cluster's first C1.2 apply, securely read the live
#    token from any healthy server and place that exact value in Vault.
#    Compare all existing servers without printing the token into receipts.
#    A missing value, placeholder, server disagreement, or Vault/live
#    mismatch is a hard stop before any config or service change.

# 4. Smoke-test connectivity.
ansible -i inventories/prod.yml rke2_servers -m ping

# 5. Apply baseline + bring up or reconcile the cluster. Servers are
#    processed serially.
ansible-playbook -i inventories/prod.yml playbooks/site.yml \
  --ask-vault-pass

# 6. For a brand-new cluster, immediately compare the persisted secure token
#    on every server without printing it, replace the Vault token with that
#    exact value, and restore rke2_cluster_token_mode: steady_state_exact.
#    Do this before any reapply; fresh_short is a one-run state.
#
# 7. Pull the VIP-backed admin kubeconfig from ANY healthy server.
scp vhhealth@<healthy-server>:.kube/config ~/.kube/vhhealth-prod.yaml
export KUBECONFIG=~/.kube/vhhealth-prod.yaml
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}{"\n"}'
# Expected: https://10.10.0.10:6443
kubectl get nodes -o wide
```

Production uses a required, pre-shared `rke2_cluster_token` backed by
`vault_rke2_cluster_token`. Bootstrap and joining servers receive the same
value; no normal path reads a token from another inventory host. The first
apply to an existing cluster deliberately fails before change unless the
Vault value exactly matches the live token on every existing server.
`steady_state_exact` requires the secure `K10...::server:...` representation.
A new self-signed cluster may use `fresh_short` once, but its persisted secure
token must be promoted into Vault before the next run. Root-only token files
keep the credential out of normal configuration diffs and backups.

### Dev / single-node

The committed development inventory explicitly disables the control-plane VIP
and uses `development_short` with an unmistakably non-production pre-shared
token. That single-node-only mode accepts RKE2's secure wrapper on later
idempotent applies; production never does.

```bash
ansible-playbook -i inventories/dev.yml playbooks/site.yml
```

## Pre-sync operator warning

> Syncing this revision is an operator action, not a merge side effect. It
> triggers a CNPG rolling re-schedule under required hostname anti-affinity,
> redeploys the backend under hard hostname spread, and changes the Longhorn
> child Application to manual-sync. Expect controlled pod movement and a
> deliberately OutOfSync Longhorn child. Abort before sync if node labels,
> capacity, CNPG quorum/replication, backend disruption budget/readiness, or
> the Longhorn ownership plan do not match the qualification evidence.

Relabel the three existing nodes and align their RKE2 `node-label`
configuration before sync. All four top-level Applications remain
manual-sync. A merge or CI result does not activate Ansible or Kubernetes
changes.

---

## What each playbook does

| Playbook | When to run | Behaviour |
| --- | --- | --- |
| `playbooks/site.yml` | Initial cluster bootstrap or reviewed drift repair | Applies the host baseline, firewall, RKE2, and keepalived configuration serially |
| `playbooks/upgrade-k8s.yml` | One approved RKE2 ladder rung | Rejects off-ladder, skipped, downgrade, missing-snapshot, or degraded-state attempts; processes one node at a time |
| `playbooks/node-replace.yml` | A node failed and replacement hardware is ready | Uses the VIP-backed kubeconfig and an explicitly selected healthy maintenance server |
| `playbooks/longhorn-prereqs.yml` | After the storage placement gate passes, before a separately approved Longhorn activation | Installs and verifies host packages/modules only; it does not install Longhorn or migrate a PVC |
| `playbooks/disaster-recover.yml` | Never for full-cluster loss | Legacy draft; token and snapshot semantics remain unapproved |

---

## Idempotency notes

* Every task uses Ansible modules (not `shell`) wherever a module exists.
* The one `command:` call that runs `rke2-install.sh` is gated on a
  version comparison — it only fires if `rke2 --version` differs from
  the pinned `rke2_version`.
* Handlers are used for all service restarts; re-running after no config
  changes triggers zero restarts.
* Server plays and keepalived reloads are serial, so a template change cannot
  simultaneously restart RKE2 or withdraw an existing VIP on every server.
* The non-secret `config.yaml` is backed up, while the root-only token and etcd
  credential drop-ins disable logs, diffs, and backups.
* Firewall rules are atomically reloaded via `nft -f /etc/nftables.conf`;
  only the role-owned `table inet vhhealth` is replaced, preserving
  kube-proxy and CNI tables.

---

## Rolling upgrade runbook

The only approved RKE2 route is:

```text
v1.31.4+rke2r1
  -> v1.31.14+rke2r2
  -> v1.32.13+rke2r2
  -> v1.33.13+rke2r1
  -> v1.34.9+rke2r1
```

`v1.31.14+rke2r2` and `v1.32.13+rke2r2` are Prime-only releases.
Prove current Rancher Prime entitlement and artifact access from synthetic QA
and all production nodes before opening the window. They cannot be skipped or
replaced with an arbitrary public patch.

Interleave those transitions with the C1.1 CNPG operator ladder:

1. On Kubernetes 1.31, advance CNPG through its complete C1.1 sequence to
   `1.27.4`.
2. Cross to Kubernetes 1.32 with CNPG `1.27.4`, then advance CNPG to
   `1.28.4`.
3. Cross to Kubernetes 1.33 with CNPG `1.28.4`, then advance CNPG to
   `1.29.2`.
4. Cross to Kubernetes 1.34 with CNPG `1.29.2`, then advance CNPG to
   `1.30.0`.

CNPG `1.27.4` and `1.28.4` are past-EOL transit-only states crossed in one
owner-controlled campaign. Never park or hand off the cluster at either state.
The authoritative pins, release provenance, gates, evidence table, and full
interleaving order are in
[`docs/RKE2_1_34_QUALIFICATION.md`](../../docs/RKE2_1_34_QUALIFICATION.md)
and
[`docs/CNPG_POSTGRES_18_QUALIFICATION.md`](../../docs/CNPG_POSTGRES_18_QUALIFICATION.md).

For every rung:

1. Pass the complete campaign in synthetic QA first.
2. Review and disposition release notes, name the owner/window, take a fresh
   immediately pre-rung etcd snapshot, and attach current backup plus
   disposable-restore proof.
3. Prove the VIP, etcd, CNPG replication, storage, CNI, DNS, metrics, alerts,
   and backend synthetic reads/writes are healthy.
4. Identify the etcd leader. Upgrade servers one at a time, followers first
   and leader last; upgrade agents only after all servers pass.
5. Stop at the first failed gate. Record each node's evidence before moving
   to the next.

The first operator invocation names the exact source and next pin, an
explicit healthy maintenance server, and the absolute directory containing
the required evidence receipts:

```bash
ansible-playbook -i inventories/prod.yml playbooks/upgrade-k8s.yml \
  -e rke2_upgrade_from_version=v1.31.4+rke2r1 \
  -e rke2_upgrade_to_version=v1.31.14+rke2r2 \
  -e rke2_upgrade_maintenance_host=<healthy-rke2-server> \
  -e rke2_upgrade_evidence_dir=/secure/evidence/c1-2/rung-1 \
  -e rke2_upgrade_evidence_max_age_hours=1 \
  -e rke2_upgrade_authorized=true \
  --ask-vault-pass
```

The authenticated Prime URL comes from `vault_rke2_prime_artifact_url`,
mapped to `rke2_install_artifact_url`; never put it on the command line or in
an evidence receipt. The Prime-only rungs hard-stop when the protected URL is
missing or `system-default-registry` is not exactly `registry.rancher.com`.
They also hard-stop on RKE2 unit drop-ins, a non-stock `ExecStart`, unexpected
environment-file directives, any inherited `RKE2_*` variable, or extra live
process arguments. Remove and review that drift before continuing; environment
or CLI values must never outrank the Vault-bound token and rendered config.
Choose the snapshot receipt age limit to fit the approved owner window;
presence alone is not freshness.

After each qualified rung, verify every node through the VIP-backed
kubeconfig and update the inventory pin to that exact qualified version:

```bash
kubectl get nodes -o wide
kubectl get --raw /version
```

Do not pass any target other than the immediate next pin. The playbook rejects
skipped minors, downgrades, off-ladder targets, missing pre-rung snapshot
evidence, or degraded CNPG, etcd, or storage.

### Rollback

If a node or rung fails, stop at the last fully qualified
Kubernetes/CNPG pair and leave the failed node cordoned until health and
convergence pass. A previous-minor RKE2 rollback is permitted only with the
matching pre-rung etcd snapshot, binary rollback on **every** server, and a
datastore restore. Never run a per-node binary downgrade. CNPG rollback uses
the C1.1 operator and backup procedure for the last supported pair.

---

## Disaster recovery runbook

Scenario: all three nodes lost (hospital power incident + UPS failure).
You have a fresh etcd snapshot in R2 and fresh Ubuntu 24.04 installs
on the replacement hardware.

1. Power up the new hardware and confirm SSH + sudo for `vhhealth`.
2. Update `inventories/prod.yml` with the new IPs if they changed.
3. Follow the proven manual full-loss sequence in
   [`apps/backend/docs/DISASTER-RECOVERY.md`](../../apps/backend/docs/DISASTER-RECOVERY.md#scenario-5--full-cluster-loss).
   Keep every server stopped before reset. Use the exact original
   vault-backed, pre-shared RKE2 token, restore the S3 snapshot on the
   operator-designated recovery server, validate that server, then wipe and
   rejoin the remaining servers serially. Do not select a recovery server by
   inventory order.

   `playbooks/disaster-recover.yml` is **not approved for full-cluster
   recovery**. It does not yet preserve the required pre-shared/reset token
   semantics or distinguish an S3 snapshot name from a downloaded local path.
   Do not execute it for this scenario.

4. Restore application data:
    * **CNPG Postgres** — restore from a base backup using
      [`docs/DR_RESTORE_DRILL.md`](../../docs/DR_RESTORE_DRILL.md) and
      [`apps/backend/docs/RUNBOOKS/db-restore.md`](../../apps/backend/docs/RUNBOOKS/db-restore.md).
      An etcd snapshot is not an application-data backup.
    * **Loki chunks** — objects live in R2; Loki re-indexes on first read.
    * **Grafana dashboards** — Git-synced; redeploy via Argo CD.

5. Verify Cloudflare Tunnel reconnects and an external probe URL resolves.
   The internal controller, VIP, and LAN DNS path are separate
   [C2 work](../../docs/superpowers/plans/2026-07-28-clinical-service-continuity.md#5-c2--full-hospital-lan-service);
   this recovery procedure does not assume or validate an ingress
   `LoadBalancer` IP.

---

## Day-2 ops

### Rotate admin SSH key

1. Update `admin_ssh_key` in `inventories/prod.yml` with the new public key.
2. Re-run:

   ```bash
   ansible-playbook -i inventories/prod.yml playbooks/site.yml \
     --tags hardening --ask-vault-pass
   ```

3. The new key is appended (not replacing) — so the old key still works
   mid-rotation. Once the operator has tested the new key, remove the old
   one from `~vhhealth/.ssh/authorized_keys` manually (a dedicated
   revoke playbook is a TODO).

### Add a new server node

1. Add an entry under `all.children.rke2_servers.hosts` with a unique
   hostname and required, non-empty `inventory_region` and `inventory_zone`.
   Use the existing truthful shared zone unless facilities evidence proves
   independent rack, power, network, UPS/PDU, and switch domains. **Do NOT set
   `rke2_bootstrap: true`** on the new node.
2. Run:

   ```bash
   ansible-playbook -i inventories/prod.yml playbooks/site.yml \
     --limit <new-host> --ask-vault-pass
   ```

3. The new server joins through `https://10.10.0.10:9345` using the same
   required Vault-backed pre-shared token. Verify its admin kubeconfig points
   to `https://10.10.0.10:6443`.

### Remove a node

Use `playbooks/node-replace.yml`, pass the failed hostname, and explicitly
select an existing healthy maintenance server. The maintenance server uses
its VIP-backed kubeconfig; the playbook never selects the first inventory
host. If you are decommissioning rather than replacing, remove the inventory
entry after the owner approves the new quorum and capacity state.

```bash
ansible-playbook -i inventories/prod.yml playbooks/node-replace.yml \
  -e rke2_replacement_node=<lost-inventory-hostname> \
  -e rke2_replacement_version=<current-qualified-rke2-pin> \
  -e rke2_maintenance_host=<explicit-healthy-rke2-server> \
  -e rke2_node_replace_evidence_dir=/secure/evidence/c1-2/node-replace \
  -e rke2_node_replace_authorized=true \
  -e rke2_replacement_host_fresh=true \
  --ask-vault-pass
```

The inventory entry must already point to freshly imaged Ubuntu 24.04
replacement hardware. Existing RKE2 state, missing evidence, ambiguous
authority, or an off-ladder replacement pin is a hard stop.
The pre-start fence also rejects stale systemd units, drop-ins, RKE2
environment overrides, and extra command-line arguments outside the rendered
config. The live process is rechecked after registration before the
replacement can progress.

### Align existing node labels

RKE2 `node-label` settings apply at registration; editing
`/etc/rancher/rke2/config.yaml` does not relabel an existing Kubernetes Node.
Before the first manual sync of the C1.2 scheduling changes:

1. Fetch a VIP-backed kubeconfig from any healthy server and export the live
   labels for all three nodes.
2. Obtain the truthful region/zone mapping from the facilities owner. Until
   independent failure domains are proven, all three nodes use the same
   truthful zone.
3. Run `kubectl label node <live-node>
   topology.kubernetes.io/region=<region>
   topology.kubernetes.io/zone=<zone> --overwrite` for each live node.
4. Put those exact, non-empty values in each host's `inventory_region` and
   `inventory_zone`, render the RKE2 configuration, and compare every
   `node-label` entry with the live Node.
5. Abort before sync if any live label, inventory value, or rendered
   configuration disagrees. Retain the before/after evidence.

### Prepare a host for Longhorn

`playbooks/longhorn-prereqs.yml` is an operator-run host prerequisite
template. Run it only after the evidence in
[`docs/C1_2_STORAGE_PLACEMENT_GATE.md`](../../docs/C1_2_STORAGE_PLACEMENT_GATE.md)
passes and an owner approves the host change:

```bash
ansible-playbook -i inventories/prod.yml playbooks/longhorn-prereqs.yml \
  -e longhorn_prereqs_authorized=true \
  --ask-vault-pass
```

The playbook installs/verifies host packages, services, and kernel modules. It
does not install or sync Longhorn, change a StorageClass, touch a bound PVC,
or select a storage migration. Longhorn `1.7.2` remains an unqualified
repository target, not a statement about production. Longhorn upgrades
advance one minor at a time; downgrade is not accepted.

### Rotate etcd S3 credentials

1. Rotate the key in Cloudflare R2.
2. Decrypt + update vault:

   ```bash
   ansible-vault edit inventories/group_vars/all/vault.yml
   ```

3. Re-run the RKE2 role to push the new creds into `config.yaml`:

   ```bash
   ansible-playbook -i inventories/prod.yml playbooks/site.yml \
     --tags rke2 --ask-vault-pass
   ```

---

## Troubleshooting

| Symptom | First step |
| --- | --- |
| Existing-cluster preflight reports a token mismatch | Stop. Securely compare every live server token with the Vault value; correct Vault to the exact existing value. Never bypass or regenerate it. |
| A joining server waits for the control plane | Confirm its `server:` is exactly `https://10.10.0.10:9345`, both VIP ports are reachable, and the required token is present without printing it. |
| VIP is absent or does not fail over | On each server inspect keepalived and the local health script: HTTPS `GET /readyz` on 127.0.0.1:6443 plus TCP 127.0.0.1:9345 must pass. Verify VRRP protocol 112 is allowed only between `cluster_cidrs`. |
| `kubectl` reports an x509 SAN error | Verify the VIP is in `tls-san` on every server; also verify the optional API DNS name and per-node hostname/IP break-glass SANs. |
| fail2ban locked out an SRE laptop | Run `sudo fail2ban-client unban <ip>` from console access. |
| nftables dropped cluster traffic after a NIC rename | Verify `control_plane_vip_interface`, the node address, and `cluster_cidrs`, then inspect `nft list ruleset`. |
| etcd snapshots are not uploading | Check `etcd_s3_*` Vault inputs and run the owner-approved snapshot diagnostic on a healthy server. |
| AIDE reports unexpected changes | Run `aide --check` manually and classify each change as approved drift or possible compromise. |

### Where logs live

* `journalctl -u rke2-server` — all RKE2 / containerd / kubelet
* `/var/log/auth.log` — SSH, sudo, faillock (52-week rotation)
* `/var/log/audit/audit.log` — auditd (identity / sudo / sshd events)
* `/var/lib/rancher/rke2/server/logs/audit.log` — Kubernetes API audit

---

## Repository validation

The authoritative infra CI entrypoint is:

```powershell
node scripts/ci/run.mjs --only=infra
```

Use `scripts/local-ci.mjs` only when it is the aggregate wrapper around that
entrypoint. CI validates repository contracts and renders only; it does not
claim a live host apply, Argo CD sync, upgrade, restore, migration, or HA
drill.

---

## Appendix — CIS Kubernetes Benchmark verification

We enable `profile: cis` in RKE2, but the actual benchmark run is not
automated by this tree. To verify:

```bash
# On any server node:
curl -L https://github.com/aquasecurity/kube-bench/releases/download/v0.7.3/kube-bench_0.7.3_linux_amd64.tar.gz \
  | sudo tar -xz -C /usr/local/bin kube-bench
sudo kube-bench run --targets master,node,etcd \
  --benchmark rke2-cis-1.24 \
  --json > /tmp/kube-bench-report.json
jq '.Totals' /tmp/kube-bench-report.json
```

Expect >95% PASS on the RKE2 CIS profile; any FAIL lines should be filed
as tickets under the SRE backlog.

### Future work

* Kured integration for cluster-aware reboots (referenced in
  `common/defaults/main.yml`; the daemonset lives in the k8s manifest tree).
* Air-gapped install path (switch `rke2_install_method: tarball` and stage
  artefacts on a hospital-local mirror).
* Policy-as-code via Kyverno / OPA Gatekeeper (deployed by a separate
  `infra/kubernetes/` Kustomize layer).
