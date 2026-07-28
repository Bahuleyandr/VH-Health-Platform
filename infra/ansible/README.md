# VH Health Platform — Ansible / RKE2

Production-grade Ansible tree that turns three fresh **Ubuntu 24.04 LTS Server**
machines into a hardened **RKE2** Kubernetes cluster for an on-premises
hospital deployment (India-first, DPDP / HIPAA aligned).

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
* Deterministic node labels + zone spread for CNPG / StatefulSets
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
│           └── vault.yml.example        # ansible-vault placeholders
├── playbooks/
│   ├── site.yml                         # full bootstrap
│   ├── upgrade-k8s.yml                  # rolling RKE2 upgrade
│   ├── node-replace.yml                 # replace a failed node
│   └── disaster-recover.yml             # legacy; not approved for full loss
└── roles/
    ├── common/                          # OS baseline
    ├── hardening/                       # CIS subset
    ├── firewall/                        # nftables
    ├── rke2-server/                     # RKE2 server install + join
    └── rke2-agent/                      # RKE2 worker (growth-path, no-op today)
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

Install collections:

```bash
cd infra/ansible
ansible-galaxy collection install -r requirements.yml
```

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

# 2. Create the Vault file and encrypt it.
cp inventories/group_vars/all/vault.yml.example \
   inventories/group_vars/all/vault.yml
$EDITOR inventories/group_vars/all/vault.yml
#   - paste real Cloudflare R2 access key + secret
ansible-vault encrypt inventories/group_vars/all/vault.yml

# 3. Smoke-test connectivity.
ansible -i inventories/prod.yml rke2_servers -m ping

# 4. Apply baseline + bring up the cluster.
ansible-playbook -i inventories/prod.yml playbooks/site.yml \
  --ask-vault-pass

# 5. Pull the admin kubeconfig to your workstation.
scp vhhealth@vhh-node-1:.kube/config ~/.kube/vhhealth-prod.yaml
export KUBECONFIG=~/.kube/vhhealth-prod.yaml
kubectl get nodes -o wide
```

### Dev / single-node

```bash
ansible-playbook -i inventories/dev.yml playbooks/site.yml
```

---

## What each playbook does

| Playbook                       | When to run                                            | Behaviour                                                  |
| ------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------- |
| `playbooks/site.yml`           | Initial cluster bootstrap; also re-runs as a drift-fix | Applies all 4 roles top-to-bottom; idempotent              |
| `playbooks/upgrade-k8s.yml`    | RKE2 point-release upgrades                            | Rolling: drain → upgrade → wait Ready → uncordon, one node at a time |
| `playbooks/node-replace.yml`   | A node died; replacement hardware installed            | Removes dead node from etcd + API, then re-applies `site.yml` on the replacement |
| `playbooks/disaster-recover.yml` | Legacy recovery draft; do not execute for total loss   | Not approved: token and S3/local snapshot semantics do not meet the full-loss runbook |

---

## Idempotency notes

* Every task uses Ansible modules (not `shell`) wherever a module exists.
* The one `command:` call that runs `rke2-install.sh` is gated on a
  version comparison — it only fires if `rke2 --version` differs from
  the pinned `rke2_version`.
* Handlers are used for all service restarts; re-running after no config
  changes triggers zero restarts.
* The `configure.yml` tasks write `config.yaml` with `backup: true`, so
  any human-made edits between runs are preserved as `.YYYY-MM-DD@...~`
  files on disk.
* Firewall rules are atomically reloaded via `nft -f /etc/nftables.conf`;
  the old ruleset is replaced in a single syscall (no flap).

---

## Rolling upgrade runbook

1. Pick the target version from <https://github.com/rancher/rke2/releases>.
   Confirm no `BREAKING` notes for your kubelet-served workloads.
2. Snapshot etcd manually before starting, to R2 *and* locally:

   ```bash
   kubectl -n kube-system exec -it deploy/rke2-etcd-snapshot -- \
     rke2 etcd-snapshot save --name pre-upgrade-$(date +%F)
   ```

3. Run the rolling upgrade (one node at a time, serial=1):

   ```bash
   ansible-playbook -i inventories/prod.yml playbooks/upgrade-k8s.yml \
     -e rke2_version=v1.31.6+rke2r1 --ask-vault-pass
   ```

4. After the playbook exits, verify all three nodes are `Ready` and on
   the new version:

   ```bash
   kubectl get nodes -o wide
   kubectl get --raw /version
   ```

5. Update the pinned version in `inventories/prod.yml` so that subsequent
   `site.yml` runs do not roll back.

### Rollback

If a node comes up un-Ready, the upgrade halts (playbook is `any_errors_fatal`).
To roll the partial upgrade back:

```bash
ansible-playbook -i inventories/prod.yml playbooks/upgrade-k8s.yml \
  -e rke2_version=<previous-version> --ask-vault-pass \
  --limit <failed-host>
```

---

## Disaster recovery runbook

Scenario: all three nodes lost (hospital power incident + UPS failure).
You have a fresh etcd snapshot in R2 and fresh Ubuntu 24.04 installs
on the replacement hardware.

1. Power up the new hardware and confirm SSH + sudo for `vhhealth`.
2. Update `inventories/prod.yml` with the new IPs if they changed.
3. Follow the proven manual full-loss sequence in
   [`apps/backend/docs/DISASTER-RECOVERY.md`](../../apps/backend/docs/DISASTER-RECOVERY.md#scenario-5--full-cluster-loss).
   It keeps all servers stopped before reset, restores the S3 snapshot on N1
   with the exact original RKE2 server token, starts and validates N1, then
   wipes and rejoins N2 and N3 serially.

   `playbooks/disaster-recover.yml` is **not approved for full-cluster
   recovery**. It does not yet preserve the required bootstrap/reset token
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
   The internal controller, VIP, and LAN DNS path are separate C2 work; this
   recovery procedure does not assume or validate an ingress `LoadBalancer` IP.

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
   hostname + `inventory_zone`. **Do NOT set `rke2_bootstrap: true`** on
   the new node.
2. Run:

   ```bash
   ansible-playbook -i inventories/prod.yml playbooks/site.yml \
     --limit <new-host> --ask-vault-pass
   ```

3. The new host's `rke2-server` will auto-join using the token read from
   the bootstrap node.

### Remove a node

Use `playbooks/node-replace.yml` and pass the hostname of the old node.
If you're actually decommissioning (not replacing), edit
`inventories/prod.yml` to drop the entry afterwards.

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

| Symptom                                               | First step                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `site.yml` hangs on "Wait for API server readiness"   | `sudo journalctl -u rke2-server -f` on bootstrap node — look for etcd errors |
| Second node fails to join                             | Check `/etc/rancher/rke2/config.yaml` on the joiner has `server:` + `token:` lines |
| `kubectl` says `x509: certificate is valid for…`      | Regenerate cert with a TLS SAN you missed; re-run with `--tags rke2`      |
| fail2ban locked out an SRE laptop                     | `sudo fail2ban-client unban <ip>` from console access                     |
| nftables dropped cluster traffic after a NIC rename   | Verify `cluster_cidrs` still covers the new subnet; `nft list ruleset`    |
| etcd snapshots silently not uploading                 | Check `etcd_s3_*` in vault; `rke2 etcd-snapshot save --debug`             |
| AIDE daily report finds unexpected changes            | Run `aide --check` manually to confirm; decide: legitimate or compromise  |

### Where logs live

* `journalctl -u rke2-server` — all RKE2 / containerd / kubelet
* `/var/log/auth.log` — SSH, sudo, faillock (52-week rotation)
* `/var/log/audit/audit.log` — auditd (identity / sudo / sshd events)
* `/var/lib/rancher/rke2/server/logs/audit.log` — Kubernetes API audit

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
