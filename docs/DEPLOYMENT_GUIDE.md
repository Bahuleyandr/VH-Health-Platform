# VH Health Platform — Deployment Guide

> End-to-end runbook for bringing up the VH Health backend + admin portal
> on a **3-node on-prem RKE2 Kubernetes cluster** inside a hospital data
> centre. Target audience: hospital SRE who's comfortable with Linux +
> Kubernetes basics.
>
> Companion docs:
>
> - [`HARDWARE_REQUIREMENTS.md`](HARDWARE_REQUIREMENTS.md) — procurement spec
> - [`india-deployment-readiness.md`](india-deployment-readiness.md) — India
>   compliance, ABDM/DPDP/CERT-In, and go-live evidence gates
> - [`../apps/backend/docs/DISASTER-RECOVERY.md`](../apps/backend/docs/DISASTER-RECOVERY.md) — DR scenarios
> - [`../apps/backend/docs/DB-MIGRATION-PLAN.md`](../apps/backend/docs/DB-MIGRATION-PLAN.md) — CNPG data cutover runbook
> - [`CNPG_POSTGRES_18_QUALIFICATION.md`](CNPG_POSTGRES_18_QUALIFICATION.md) —
>   binding CNPG 1.30 / PostgreSQL 18.4 activation and rollback gates
> - [`RKE2_1_34_QUALIFICATION.md`](RKE2_1_34_QUALIFICATION.md) — exact RKE2
>   ladder, evidence, and rollback gates
> - [`C1_2_STORAGE_PLACEMENT_GATE.md`](C1_2_STORAGE_PLACEMENT_GATE.md) —
>   evidence required before selecting any storage migration
> - [`../apps/backend/docs/RUNBOOKS/`](../apps/backend/docs/RUNBOOKS/) — day-2 runbooks

---

## 0. Overview

```
                       [Cloudflare Edge]
                              |
                              | (tunnel, 443 outbound only)
          +-------------------+-------------------+
          |                   |                   |
   [cloudflared pod]    [cloudflared pod]   [cloudflared pod]
          |                   |                   |
     [ingress-nginx DaemonSet on all 3 nodes]
          |
  +-------+----------+----------+--------+
  |                  |          |        |
[vhhealth-     [vhhealth-   [vhhealth-pg CNPG cluster]
 backend]       admin]        (3 replicas, sync)
  |                  |
  +--[Redis Sentinel]--[MinIO]--[Harbor]--[ArgoCD]--[Monitoring]
                     |
                  [Cloudflare R2 offsite backup]
```

Key properties:

- Zero inbound ports on the hospital firewall. All external traffic
  arrives via Cloudflare Tunnel.
- PHI data stays in-hospital. Only encrypted backups leave (to R2).
- GitOps-driven: every change to infra is a commit; ArgoCD reports drift and
  an operator explicitly syncs each production Application.
- Quorum posture: etcd and the three-instance CNPG topology are designed to
  tolerate one member loss. Service-level recovery remains unqualified until
  the owner-threshold HA drills in
  [`runbooks/C1_2_HA_DRILL.md`](runbooks/C1_2_HA_DRILL.md) pass.

Namespace layout:

| Namespace           | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `vhhealth`          | Application pods: backend, admin, migration Jobs     |
| `vhhealth-platform` | Stateful platform: CNPG, Redis, MinIO, cloudflared   |
| `ingress-nginx`     | Ingress controller DaemonSet                         |
| `cnpg-system`       | CloudNativePG operator                               |
| `vhhealth-security` | Sealed-secrets controller and security tooling       |
| `argocd`            | ArgoCD control plane                                 |
| `harbor`            | In-cluster container registry (pull-through to ghcr) |
| `vhhealth-monitoring` | Prometheus + Alertmanager + Grafana + Loki         |

---

## 0.1 Current release baseline

As of the 2026-04 remediation baseline, production readiness depends on the
following invariants:

- Backend liveness probes use `GET /health/live`.
- Backend readiness probes use `GET /health/ready`, which checks database
  connectivity and migration `106` table `appointment_status_history`.
- Legacy `GET /health/ping` and `GET /health/deep` remain available for older
  monitors, but new manifests should not point Kubernetes probes at them.
- Backend Kubernetes Deployment sets `CLUSTER_WORKERS=2`; increasing it needs a
  capacity review so pods do not oversubscribe host CPUs.
- CI database setup reads SQL from `apps/backend/src/migrations`.
- Mobile release workflows require Forgejo Actions variable `VH_BASE_URL`,
  secret `VH_API_KEY`, and patient/staff Android signing secrets.
- Admin CI runs lint, type-check, Jest, production build, and the Clinical AI
  bundle guard.
- Smoke journey commands are documented in
  [`SMOKE_E2E_JOURNEYS.md`](SMOKE_E2E_JOURNEYS.md).

---

## 1. Hardware provisioning

See [`HARDWARE_REQUIREMENTS.md`](HARDWARE_REQUIREMENTS.md) for the full
procurement spec. Summary of what you need in-rack before continuing:

- 3× servers matching at least the "Minimum" tier (16 vCPU / 64 GB ECC / 2× 2 TB NVMe RAID1 / dual 10 GbE / IPMI).
- Rack + dual PDU + UPS + ToR switches configured.
- Dedicated VLAN for cluster, separate VLAN for IPMI.
- Outbound 443 internet access through the hospital firewall.

---

## 2. Fresh OS install

Per node:

1. **Ubuntu 24.04 LTS Server** minimal, no desktop. Install via IPMI
   virtual media or USB.
2. Hostname pattern: `vhh-k8s-01`, `vhh-k8s-02`, `vhh-k8s-03`.
3. Static IPs on the cluster VLAN — example:
   - `vhh-k8s-01` → `10.10.0.11`
   - `vhh-k8s-02` → `10.10.0.12`
   - `vhh-k8s-03` → `10.10.0.13`
   - Gateway `10.10.0.1`, MTU 9000 (jumbo) if switches support it.
4. Create user `vhhealth` with SSH key (public key from your ops
   workstation). No password login. Add to `sudo` via
   `/etc/sudoers.d/vhhealth-nopasswd`.
5. Time sync: `chrony` pointed at the hospital NTP source with
   Cloudflare NTP (`time.cloudflare.com`) as fallback.
6. Verify outbound internet to Cloudflare, ghcr.io, github.com.

At this point all 3 nodes should be reachable from your ops workstation
via `ssh vhhealth@vhh-k8s-0N` with no password prompt.

---

## 3. Ansible bootstrap

The Ansible project at `infra/ansible/` is what turns 3 bare Ubuntu
nodes into a healthy RKE2 cluster. It does not install CNPG, Barman,
sealed-secrets, ingress, cloudflared, or ArgoCD; those operator and GitOps
steps are explicit later in this guide.

### 3.1 Configure inventory

```bash
cd infra/ansible
cp inventories/prod.yml.example inventories/prod.yml
```

Edit `inventories/prod.yml` and replace every documented placeholder:

- define all three RKE2 server addresses on the cluster VLAN;
- set `ansible_user: vhhealth` and the reviewed SSH private-key path;
- set non-empty `inventory_region` and `inventory_zone` on every server. The
  production example deliberately gives all three servers the same zone until
  facilities evidence proves independent rack, power, and network domains;
- keep the RKE2 starting pin at the exact live version. Advance it only through
  the qualified ladder in
  [`RKE2_1_34_QUALIFICATION.md`](RKE2_1_34_QUALIFICATION.md);
- set the control-plane endpoint contract:
  - `control_plane_vip_enabled: true`;
  - `control_plane_vip_address: 10.10.0.10`;
  - the real `control_plane_vip_interface` and prefix length;
  - a site-unique `control_plane_vip_virtual_router_id`; and
  - optional `control_plane_api_dns_name`;
- set `management_cidrs` to the networks allowed to reach SSH and API TCP 6443,
  and `cluster_cidrs` to the peer network allowed to exchange VRRP protocol 112
  and RKE2 cluster traffic; and
- leave `internal_ingress_vip_enabled` and
  `internal_ingress_vip_firewall_guard_enabled` false, the address/interface
  empty, and `clinical_cidrs` empty unless the complete C2.1 activation packet
  and [`C2_1_INTERNAL_INGRESS_DRILL.md`](runbooks/C2_1_INTERNAL_INGRESS_DRILL.md)
  are approved. Network owners, not repository authors, supply those values;
  and
- use `longhorn` when referring to the repository's Longhorn StorageClass.
  CNPG data and WAL currently remain on `local-path`; the production Longhorn
  PVC patch stays commented and no storage migration is selected by C1.2.

### 3.2 Create Ansible vault with secrets

```bash
cd infra/ansible
ansible-vault create inventories/group_vars/all/vault.yml
```

Put the bootstrap-time secrets here (not the application ones — those flow via
sealed secrets later). Production requires the exact pre-shared RKE2 cluster
token in Vault; it is never generated or read from a preferred bootstrap host:

```yaml
vault_rke2_cluster_token: <exact-live-rke2-server-token>
vault_rke2_prime_artifact_url: "" # set the authenticated URL only for Prime-only rungs
vault_etcd_s3_endpoint: <r2-s3-endpoint>
vault_etcd_s3_bucket: <etcd-snapshot-bucket>
vault_etcd_s3_access_key: <bucket-scoped-access-key>
vault_etcd_s3_secret_key: <bucket-scoped-secret-key>
```

Before the first C1.2 apply to the existing cluster, copy the exact current
server token into Vault through the approved secret-handling channel. The
production inventory maps `rke2_cluster_token` to
`vault_rke2_cluster_token`. The preflight compares the Vault value with every
existing server and stops before configuration or service changes on any
missing value, placeholder, mismatch, or inter-server disagreement. Store the
Vault password in the team password manager; never paste either value into a
ticket, PR, shell transcript, or drill receipt.

The production example defaults to `rke2_cluster_token_mode:
steady_state_exact`. For a brand-new self-signed cluster only, set that local
inventory value to `fresh_short` for the first run and use one approved
high-entropy short token. Immediately after bootstrap, compare the persisted
secure token on every server without printing it, replace the Vault value with
that exact token, and restore `steady_state_exact` before any reapply. The
committed single-node development inventory alone uses `development_short`.

The mandatory `v1.31.14+rke2r2` and `v1.32.13+rke2r2` releases have no public
assets. Before either rung, put the authenticated SUSE Prime Artifacts URL in
`vault_rke2_prime_artifact_url`; the production inventory maps it to the
protected installer input. Missing entitlement, inaccessible artifacts, or an
empty protected URL is a hard stop. Prime runs also require and verify
`system-default-registry: registry.rancher.com` before restart. Never place the
protected URL on the command line or in an evidence receipt.

### 3.3 Run the bootstrap playbook

```bash
export ANSIBLE_STDOUT_CALLBACK=default
ansible-playbook \
  -i inventories/prod.yml \
  playbooks/site.yml \
  --ask-vault-pass
```

The environment override selects Ansible's supported built-in output callback;
current `community.general` releases no longer ship the legacy `yaml` callback
named by the repository's pre-existing controller configuration.

`site.yml` processes the RKE2 servers serially and:

1. applies baseline OS hardening, including the nftables management/cluster
   allowlists;
2. validates the Vault token and the complete unicast keepalived peer contract;
3. configures the bootstrap server with the pre-shared token and no `server:`
   entry, then waits for real local API readiness before the VIP is advertised;
4. waits for both `https://10.10.0.10:6443` and
   `https://10.10.0.10:9345` before starting joining servers;
5. joins each remaining server through the VIP registration endpoint, one at a
   time; and
6. writes a VIP-backed admin kubeconfig to `~vhhealth/.kube/config` on every
   server; and
7. only when explicitly enabled, renders a second independent keepalived
   instance for the internal-ingress VIP after validating its early nftables
   guard, CIDRs, interface, prefix, peer ledger, collision state, and distinct
   VRID.

Manage CNPG, the Barman plugin, cert-manager, and the MinIO Operator through the
held manual-sync lifecycle in [`OPERATOR_LIFECYCLE.md`](OPERATOR_LIFECYCLE.md)
and the qualified sequence in §4.3. `site.yml` does not install or activate
those controllers implicitly.

Total runtime: **20–40 minutes** on fast hardware.

### 3.4 Validate the cluster

On your ops workstation, fetch the same VIP-backed kubeconfig from any healthy
server; no normal administration path depends on a preferred node:

```bash
scp vhhealth@<any-healthy-rke2-server>:.kube/config \
  ~/.kube/vhhealth-prod.yaml
export KUBECONFIG=~/.kube/vhhealth-prod.yaml

grep 'server: https://10.10.0.10:6443' "${KUBECONFIG}"
curl --fail --insecure --max-time 3 https://10.10.0.10:6443/readyz
kubectl get nodes
kubectl get nodes -L topology.kubernetes.io/region,topology.kubernetes.io/zone
# Expected:
# NAME          STATUS   ROLES                       AGE
# vhh-k8s-01    Ready    control-plane,etcd,master   20m
# vhh-k8s-02    Ready    control-plane,etcd,master   18m
# vhh-k8s-03    Ready    control-plane,etcd,master   16m

kubectl get pods -A
# Every pod should be Running or Completed.
```

If any pod is `CrashLoopBackOff`, read its logs and check the
Ansible role for missing config.

---

## 4. Install platform services via Kustomize + ArgoCD

The platform baseline (Redis, MinIO, Harbor, ArgoCD itself,
monitoring) is committed under `infra/kubernetes/`. Two-step bootstrap:

Redis is deliberately not self-activating: its committed first-cluster gate is
closed, and existing state requires two agreeing authenticated Sentinels on
every container start. Complete the held activation and live failure evidence
in [`REDIS_SENTINEL_HA_RUNBOOK.md`](REDIS_SENTINEL_HA_RUNBOOK.md) before any
production platform sync.

Production image references and their registry-verification procedure are
recorded in
[`../infra/kubernetes/base/IMAGE_PIN_VERIFICATION.md`](../infra/kubernetes/base/IMAGE_PIN_VERIFICATION.md).
Run `node scripts/check-prod-helm-image-inventory.mjs` and then
`node scripts/check-prod-digests-pinned.mjs` before any reviewed sync. The
digest guard inventories Kustomize-controlled workload, CRD, operator/config,
and scheduled-restore-proof-synthesized image references, verifies each unique active
`tag@digest` against its live registry, and separately enforces the exact seven
held occurrences (six application, one database). It does not render images generated by the
Longhorn, kube-prometheus-stack, or Loki Helm charts; the Helm inventory guard
fails closed on changes to those exact chart sources, and the charts still
require separate rendered image verification before activation.

> **C1.1 activation boundary:** the current production overlay declares the
> Barman `ObjectStore` resources and the live `Cluster/vhhealth-pg` on its
> declared PostgreSQL **17** generation, pinned fail-closed at the all-zero
> digest. The digest-pinned PostgreSQL 18.4 target is no longer in this
> overlay: it is held at `infra/kubernetes/held/c1-1-pg18-cutover/`, composed
> by nothing (audit 2026-08-13, P1 — previously the overlay carried the PG18
> image on the live Cluster, so one sync would have triggered a declarative
> offline `pg_upgrade`). Do not apply this overlay to the live PostgreSQL 17
> cluster, imperatively or through ArgoCD, until an operator has pinned the
> real qualified PostgreSQL 17 digest and C1.2 has completed the exact RKE2
> ladder to `v1.34.9+rke2r1`/Kubernetes 1.34.9 and
> [the database qualification gates](CNPG_POSTGRES_18_QUALIFICATION.md) plus
> [the RKE2 qualification gates](RKE2_1_34_QUALIFICATION.md) and the pre-sync
> checklist in §4.3 are complete. Production remains on RKE2
> `v1.31.4+rke2r1`; this repository change performs no upgrade.

### 4.1 Bootstrap controllers, not the production overlay

Install the sealed-secrets controller and ArgoCD itself through their pinned
bootstrap instructions in `infra/kubernetes/base/sealed-secrets/README.md` and
`infra/kubernetes/base/argocd/README.md`. The cert-manager, CNPG, Barman, and
MinIO operator Applications remain held outside active composition; follow
[`OPERATOR_LIFECYCLE.md`](OPERATOR_LIFECYCLE.md) and §4.3.

The Sealed Secrets helper applies a bootstrap-only Kustomization containing
the `vhhealth-security` Namespace, the SealedSecret CRD, and the exact
`vhhealth-security/sealed-secrets` controller identity. Its ServiceMonitor is
owned by `base/monitoring` and must not be submitted until the Prometheus
Operator has installed the `monitoring.coreos.com` CRDs.

Do **not** use `kustomize build infra/kubernetes/overlays/prod | kubectl apply`
as a bootstrap shortcut. It bypasses the manual Argo gate and, in C1.1, would
submit the PostgreSQL 18 and `ObjectStore` resources before their activation
evidence exists.

### 4.2 Bootstrap ArgoCD to manage itself and the rest

Apply the ArgoCD `AppProject` + `Application` manifests that point
ArgoCD at this repo:

```bash
kubectl apply -k infra/kubernetes/base/argocd
```

This creates:

- `AppProject/vhhealth` — scoping for approved platform namespaces
- `Application/vhhealth-platform` — points at `infra/kubernetes/overlays/prod/`
- `Application/vhhealth-apps` — points at `infra/kubernetes/apps/`
- `Application/vhhealth-kube-prometheus` — pinned kube-prometheus-stack chart
- `Application/vhhealth-loki` — pinned Loki chart

It deliberately does not create the four operator lifecycle Applications under
`infra/kubernetes/held/operator-lifecycle/`. Those Applications require a
separate reviewed apply and remain manual-sync after creation.

After ~3 minutes, ArgoCD discovers desired state. All four top-level
Applications are manual-sync: a merge or poll can make an Application
`OutOfSync`, but it cannot apply or prune production resources. The Longhorn
child Application declared by the platform tree is also manual-sync after the
C1.2 revision is applied. After an approved operator sync, each top-level
Application should show Synced + Healthy in the ArgoCD UI; a deliberately
unsynced Longhorn child may remain `OutOfSync` until it receives its own
reviewed operator sync:

```bash
kubectl port-forward -n argocd svc/argocd-server 8080:443
# Open https://localhost:8080 — password in `argocd admin initial-password -n argocd`
```

From now on, ArgoCD polls `main` and reports drift within roughly three
minutes. The operator must review the target revision and start each production
sync explicitly.

> **C2.1 private-ingress hold:** the platform tree contains a second
> ingress-nginx controller with hostPorts in the dedicated
> `vhhealth-ingress-internal` namespace. That namespace alone enforces
> `privileged` Pod Security because Kubernetes Baseline/Restricted rejects
> hostPort; the controller keeps a Restricted container security context and
> the public ingress namespace remains Restricted. The private VIP is disabled
> and addressless, the default render supplies no internal API TLS producer,
> and non-approved internal routes use the unimplemented
> `nginx-internal-held` class. Do not sync or activate it until C-D13,
> network-owner VIP/interface/prefix/CIDR approval, tenant-host inventory,
> C2.2 staff-web correction, C0.1 parity, and the operator drill are complete.
> The default host-listener NetworkPolicy also contains only TEST-NET
> sentinels; the approved activation overlay must replace them with the exact
> same clinical/management CIDRs used by the host firewall.

### 4.3 Required pre-sync operator sequence

Complete these steps in order **before the next manual ArgoCD sync** (or an
equivalent imperative apply):

> **C1.2 pre-sync impact and abort gate:** Syncing this revision is an operator
> action, not a merge side effect. Syncing `vhhealth-platform` triggers a CNPG
> rolling re-schedule under required hostname anti-affinity and changes the
> Longhorn child Application to manual-sync. Syncing `vhhealth-apps` redeploys
> the backend under hard hostname spread. Expect controlled pod movement and a
> deliberately `OutOfSync` Longhorn child. Abort before either sync if the three
> live nodes do not carry the reviewed region/zone labels, RKE2 config disagrees
> with those labels, capacity cannot hold the rescheduled pods, CNPG quorum or
> synchronous replication is degraded, backend readiness or its disruption
> budget is unhealthy, or the Longhorn ownership and follow-up sync plan is not
> recorded.

Before applying either production tree, complete the live-node transition in
[`runbooks/C1_2_HA_DRILL.md`](runbooks/C1_2_HA_DRILL.md): record the current
labels, relabel all three existing nodes to the truthful region and zone, align
the same values in the corresponding RKE2 host configurations, and prove the
live/configured values agree. RKE2 `node-label` settings apply at registration;
editing inventory alone does not relabel an existing node.

First preserve the retired `vhhealth-pg-nightly` schedule's evidence. That
resource used `backupOwnerReference: self`, so pruning it can cascade-delete
its owned `Backup` custom resources. Export the schedule and all Backups, list
the Backups it owns, then remove **only** that ScheduledBackup owner reference
from each owned Backup before allowing Argo prune:

```bash
EVIDENCE_DIR="docs/qa-findings/$(date -u +%Y-%m-%d)-c1-1-nightly-retirement"
mkdir -p "${EVIDENCE_DIR}"
kubectl -n vhhealth-platform get scheduledbackup vhhealth-pg-nightly -o yaml \
  > "${EVIDENCE_DIR}/vhhealth-pg-nightly.yaml"
kubectl -n vhhealth-platform get backup -o yaml \
  > "${EVIDENCE_DIR}/backups-before-owner-detach.yaml"

kubectl -n vhhealth-platform get backup -o json \
  | jq -r '.items[]
      | select(any(.metadata.ownerReferences[]?;
          .kind == "ScheduledBackup" and .name == "vhhealth-pg-nightly"))
      | .metadata.name' \
  > "${EVIDENCE_DIR}/nightly-owned-backups.txt"

while IFS= read -r backup; do
  [ -n "${backup}" ] || continue
  owner_refs="$(
    kubectl -n vhhealth-platform get backup "${backup}" -o json \
      | jq -c '[.metadata.ownerReferences[]?
          | select(.kind != "ScheduledBackup"
              or .name != "vhhealth-pg-nightly")]'
  )"
  kubectl -n vhhealth-platform patch backup "${backup}" --type=merge \
    -p "{\"metadata\":{\"ownerReferences\":${owner_refs}}}"
done < "${EVIDENCE_DIR}/nightly-owned-backups.txt"

kubectl -n vhhealth-platform get backup -o yaml \
  > "${EVIDENCE_DIR}/backups-after-owner-detach.yaml"
```

Review and retain the before/after evidence. Abort the sync if any listed
Backup still carries the retired schedule's owner reference. Never delete those
Backup custom resources or their R2 objects as part of schedule retirement.

1. Interleave the exact C1.2 RKE2 pins with the CNPG operator ladder so every
   move stays inside a documented support overlap:
   - On current RKE2 `v1.31.4+rke2r1`, advance CNPG
     `1.24.1 → 1.24.4 → 1.25.4 → 1.26.3 → 1.27.4`.
   - Advance RKE2 to `v1.31.14+rke2r2`, then to
     `v1.32.13+rke2r2` while CNPG 1.27.4 remains healthy.
   - On Kubernetes 1.32, advance CNPG to 1.28.4.
   - Advance RKE2 to `v1.33.13+rke2r1`, then CNPG to 1.29.2.
   - With CNPG 1.29.2 healthy, advance Kubernetes to 1.34; only then advance
     CNPG to 1.30.0. The exact RKE2 target for this transition is the objective
     `v1.34.9+rke2r1`.

   CNPG 1.27.4 and 1.28.4 are past-end-of-life, transit-only states crossed in
   one controlled campaign. They are never parking states. The two SUSE
   Prime-only RKE2 rungs require authenticated artifact access before their
   pre-rung windows; an inaccessible package is a hard stop, not permission to
   skip a minor.

   Before each Kubernetes or CNPG transition, capture the published support
   matrix and the exact release provenance proving that pair is supported.
   Follow [`RKE2_1_34_QUALIFICATION.md`](RKE2_1_34_QUALIFICATION.md) for the
   synthetic-QA, pre-rung etcd snapshot, restore, VIP, etcd, storage, network,
   DNS, metrics, alerts, and backend read/write receipts. After each transition,
   retain operator, Cluster, instance, replication, and existing-backup health
   evidence before proceeding. Stop at the last qualified pair if any rung
   fails; never leapfrog versions. Production activation remains blocked until
   the final state is RKE2 `v1.34.9+rke2r1` with CNPG 1.30.0 qualified.
2. Through the held manual-sync lifecycle, sync the pinned Barman Cloud Plugin
   `0.13.0` only after cert-manager and the qualified CNPG final state are
   healthy. Run `node scripts/operator-lifecycle-preflight.mjs`; it must verify
   the immutable Application, chart and image pins, controller, and Established
   `objectstores.barmancloud.cnpg.io` CRD.
3. Seal the bucket-scoped producer, separate bucket-scoped read-only
   verifier/DR reader, and archive-crypto Secrets from the committed examples.
   The configured destination prefix is workload routing, not token scope. In
   particular, seal `cnpg-backup-producer-credentials`,
   `cnpg-dr-reader-credentials`, `minio-backup-source-reader`,
   `offsite-backup-producer`, `offsite-backup-reader`, and `backup-crypto` in
   every namespace declared by those examples. Never put a producer identity
   in a verifier or restore workload. `backup-crypto` must contain independently
   generated high-entropy `BACKUP_ENCRYPTION_KEY` and `BACKUP_HMAC_KEY` values;
   confirm they differ. Encryption provides confidentiality, while the separate
   HMAC key authenticates archive metadata, identity, and ciphertext.
4. Render both production trees locally and confirm that `R2_ENDPOINT` is
   exactly
   `https://dbe488236c64499a3dfc797a750c912d.r2.cloudflarestorage.com`
   in `vhhealth-env`, `vhhealth-backend-config`, the production Barman
   `ObjectStore`, `cnpg-backup-verify`, the suspended
   `cnpg-scheduled-restore-proof`, and both backend backup jobs. Native
   Kustomize replacements are the contract; ArgoCD has no `envsubst`, SOPS, or
   config-management-plugin pass.

Skipping the operator ladder can leave the existing `Cluster` rejected or
unreconciled. The lifecycle preflight fails closed before platform sync when an
operator Application, required CRD, controller, or pinned image is missing or
unhealthy. Syncing `vhhealth-platform` before the Barman plugin installs its
CRD makes the Application unsyncable on the unknown `ObjectStore` kind.
Missing credentials stop backup, verification, and restore-proof jobs; a
missing or wrong endpoint stops them from reaching the production R2 target.
If the plugin controller later fails, PostgreSQL may continue serving while
WAL/base-backup and recovery work stops; database health alone is not backup
health.
Do not work around any of these failures by reusing writer credentials,
restoring placeholders, or importing the broad backend Secret.

The production CNPG data and WAL PVCs remain on `local-path`; their durability
comes from PostgreSQL streaming replication across hosts. The repository
StorageClass is named `longhorn`, but Longhorn 1.7.2 is an unqualified
repository target rather than a production fact. Keep
`overlays/prod/longhorn-pvc-patch.yaml` commented. Do not select or execute any
storage migration until every item in
[`C1_2_STORAGE_PLACEMENT_GATE.md`](C1_2_STORAGE_PLACEMENT_GATE.md) has
operator-owned evidence and a service-by-service abort plan. Applying the C1.2
revision only makes the Longhorn child manual-sync; it does not move a PVC.

After the placement gate passes, an operator may separately run the inert host
prerequisite template from `infra/ansible/`:

```bash
ansible-playbook -i inventories/prod.yml playbooks/longhorn-prereqs.yml \
  -e longhorn_prereqs_authorized=true \
  --ask-vault-pass
```

That playbook only installs and verifies node-local packages, services, and
kernel modules. It does not install or sync Longhorn, change a StorageClass,
touch a bound PVC, or authorize a migration.

---

## 5. Create secrets

Each GitOps-managed application Secret lives in-repo as a **sealed** form
(`*.sealed-secret.yaml`). The plain form is never committed — you build
it locally, seal it with `kubeseal`, and commit only the sealed output.

The `.example` files are schemas only and are excluded from Kustomize renders.
Real encrypted files omit `.example`, must be referenced by their owning
Kustomization, and are committed only after review. The backend does not use
separate JWT, API-key, database-URL, Firebase, or R2 application Secrets:
those keys live together in `Secret/vhhealth-backend-env`.

### 5.1 Identify the required secrets

```bash
find infra/kubernetes -name '*.sealed-secret.yaml.example'
# Relevant output:
# infra/kubernetes/apps/backend/sealed-secret.yaml.example
# infra/kubernetes/apps/backend/minio-backup-source-reader.sealed-secret.yaml.example
# infra/kubernetes/apps/backend/offsite-backup-producer.sealed-secret.yaml.example
# infra/kubernetes/apps/backend/offsite-backup-reader.sealed-secret.yaml.example
# infra/kubernetes/apps/backend/backup-crypto.sealed-secret.yaml.example
# infra/kubernetes/apps/admin/sealed-secret.yaml.example
# infra/kubernetes/base/cnpg/cnpg-backup-producer-credentials.sealed-secret.yaml.example
# infra/kubernetes/base/cnpg/cnpg-dr-reader-credentials.sealed-secret.yaml.example
# infra/kubernetes/base/cnpg/readonly-credentials.sealed-secret.yaml.example
# infra/kubernetes/base/cnpg/runtime-credentials.sealed-secret.yaml.example
```

### 5.2 For each secret, build and seal

Use the matching example as the required key/metadata schema and source every
plaintext value from the approved secret manager. In particular,
`infra/kubernetes/apps/backend/sealed-secret.yaml.example` describes the
complete broad `vhhealth-backend-env` Secret. Preserve all reviewed keys when
rotating one value; a partial replacement would remove unrelated runtime
credentials.

```bash
# Build this complete plaintext Secret outside the repository:
# /secure/operator-work/vhhealth-backend-env.yaml
# metadata.name: vhhealth-backend-env
# metadata.namespace: vhhealth
kubeseal \
  --controller-namespace vhhealth-security \
  --controller-name sealed-secrets \
  --scope strict \
  -f /secure/operator-work/vhhealth-backend-env.yaml \
  -w infra/kubernetes/apps/backend/sealed-secret.yaml
```

### 5.3 Commit the sealed form

Keep every `.example` schema. Before staging a real sealed file, confirm its
owning `kustomization.yaml` lists that non-example file under `resources`; for a
first activation, add and stage the resource entry in the same reviewed change.

```bash
git add infra/kubernetes/apps/backend/sealed-secret.yaml \
  infra/kubernetes/apps/backend/kustomization.yaml
git diff --cached -- \
  infra/kubernetes/apps/backend/sealed-secret.yaml \
  infra/kubernetes/apps/backend/kustomization.yaml
git commit -m "feat(secrets): seal backend runtime credentials for prod"
git push
```

ArgoCD reports the committed change within roughly three minutes. After the
operator reviews and manually syncs the relevant Application, the
sealed-secrets controller materializes it into a real `Secret`, and the next
approved `Deployment` rollout picks up the new environment variables.

### 5.4 Repeat for every secret

Minimum required before backend will start:

- `vhhealth-backend-env`, produced from
  `infra/kubernetes/apps/backend/sealed-secret.yaml.example`, contains the
  complete backend runtime and migration inputs, including
  JWT, API, encryption, and integration keys; `DATABASE_URL`, `DATABASE_READ_URL`,
  `DATABASE_SUPERUSER_URL`, Firebase, and application R2 credentials. Non-secret
  R2 endpoint/account/bucket values stay in the ConfigMap as declared by the
  example.
- `vhhealth-pg-runtime` and `vhhealth-pg-readonly`, produced from the CNPG
  runtime/readonly examples for their corresponding managed roles.
- `cnpg-backup-producer-credentials` (R2 Object Read & Write, restricted to the
  database backup bucket; deletion is required for Barman retention, while the
  ObjectStore prefix is workload routing rather than credential scope)
- `cnpg-dr-reader-credentials` (separate R2 Object Read-only identity in the
  platform and restore-proof namespaces)
- `minio-backup-source-reader`, `offsite-backup-producer`,
  `offsite-backup-reader`, and `backup-crypto` (disjoint backend archive
  identities; no backup pod imports the broad backend Secret).
  `backup-crypto` contains independently generated, unequal
  `BACKUP_ENCRYPTION_KEY` and `BACKUP_HMAC_KEY` values. Rotate them as a
  reviewed generation used by both producer and verifier, retain the prior pair
  in the approved secret manager while its archives remain required, and do not
  retire that pair until a new archive is produced, HMAC-verified, decrypted,
  and restore-tested.

Optional but recommended:

- Provider credentials such as chatbot and clinical-AI keys stay in
  `vhhealth-backend-env` when those integrations are enabled.
- `vhhealth-admin-env`, produced from
  `infra/kubernetes/apps/admin/sealed-secret.yaml.example` (JWT, backend API,
  Sentry, and Firebase credentials).

### 5.5 Application-upload public URL gate

The committed `CF_R2_URL: ""` is an intentional fail-closed activation blocker:
Joi rejects the empty value as an invalid URI, so the backend cannot start.
`CF_R2_URL` is the public or custom-domain base returned in application-upload
object URLs. It is not the S3 API endpoint and must never be populated with
`R2_ENDPOINT`.

Before manually syncing `vhhealth-apps`, prove the intended R2 public/custom
domain, set that literal non-secret base in a reviewed apps Kustomize patch, and
inspect the rendered `vhhealth-backend-config`. Keep the backend blocked until
an upload probe lands in the intended bucket and the URL returned by the
application uses that exact base and successfully retrieves the object under
the approved access policy. This gate does not change §4.3 step 4:
`R2_ENDPOINT` remains the separately confirmed S3 API endpoint used by the
backup/ObjectStore paths.

---

## 6. Data migration to CNPG Postgres

See [`../apps/backend/docs/DB-MIGRATION-PLAN.md`](../apps/backend/docs/DB-MIGRATION-PLAN.md)
for the original cutover steps and
[`CNPG_POSTGRES_18_QUALIFICATION.md`](CNPG_POSTGRES_18_QUALIFICATION.md) for the
binding major-upgrade procedure. The running production cluster remains
PostgreSQL 17, and the repository now enforces that rather than asserting it:
`base/cnpg/cluster.yaml` declares the PostgreSQL 17 generation with a
fail-closed all-zero digest, and the PostgreSQL 18.4 target lives only in the
held cutover path `infra/kubernetes/held/c1-1-pg18-cutover/`, which no
kustomization composes. Applying that held path — not syncing the platform
overlay — is what converts the database, and it is gated on the
qualification evidence recorded there.

Before any major change, re-derive and install the current secure PostgreSQL 17
minor (17.10 as of 2026-07-28), prove a PG17 backup and reader-only restore, and
rehearse the entire CNPG operator ladder without changing the database major
version. Align the source image to Bookworm before a physical `pg_upgrade`.
If the operating-system/library assumptions cannot be aligned safely, use a
rehearsed logical dump/restore or logical-replication cutover instead; never
silently force a physical upgrade.

The synthetic qualification must prove roles, schema, row counts, checksums,
pgvector files/extension/casts/distance queries, representative application
reads, `ANALYZE`, a run-unique synthetic PG18 archive identity distinct from
the fixed production `vhhealth-pg18` identity, and a fresh PostgreSQL 18
Backup plus reader-only restore selected by the exact Backup CR
`status.backupId` through `recoveryTarget.backupID`. Only then may an operator
update the three database bindings in the complete `vhhealth-backend-env`
SealedSecret, manually sync `vhhealth-apps`, require the
`Job/vhhealth-backend-migrate` PreSync hook to pass, and run the application
guardrails and smoke journeys.

---

## 7. DNS + Cloudflare Tunnel cutover

Once CNPG + backend + admin are all Healthy in the cluster, flip
external traffic.

### 7.1 Configure Cloudflare Tunnel

In the Cloudflare dashboard → Zero Trust → Networks → Tunnels:

1. Edit the `vhhealth-prod` tunnel (already dialled out from the
   `cloudflared` Deployment installed by Ansible).
2. Add Public Hostnames:
   - `api.vhhealth.app` → `https://ingress-nginx-controller.ingress-nginx.svc.cluster.local:443`
     with `No TLS Verify = true` (internal cert; Cloudflare is trusted
     layer above).
   - `admin.vhhealth.app` → same Service.
3. Set HTTP Host Header: `api.vhhealth.app` / `admin.vhhealth.app`
   respectively.

### 7.2 Update DNS

If `api.vhhealth.app` currently resolves via an A record to the legacy
host, replace it with a CNAME to the Cloudflare Tunnel:

```
api.vhhealth.app   CNAME  <tunnel-id>.cfargotunnel.com   (proxied)
admin.vhhealth.app CNAME  <tunnel-id>.cfargotunnel.com   (proxied)
```

DNS TTL should already be ≤ 300s. Propagation is near-immediate via
Cloudflare.

### 7.3 Verify traffic is flowing

```bash
curl -sv https://api.vhhealth.app/health
# Expected: 200 OK, headers include `cf-ray` + `server: cloudflare`.

curl -sv https://admin.vhhealth.app/
# Expected: 200 OK, Next.js response.
```

Then check that the traffic is actually hitting the cluster:

```bash
kubectl -n vhhealth logs deployment/vhhealth-backend --tail=20 | grep "GET /health"
# Should see the request you just made.
```

### 7.4 Cut the legacy host off

After confirming 24 hours of stable production traffic on the cluster:

- Remove the legacy host from any remaining DNS records.
- Stop the legacy backend process + DB container.
- Revoke the legacy host's Cloudflare Tunnel credentials (if it had its own).

---

## 8. Validation checklist

After steps 3–7 are complete:

- [ ] `kubectl get nodes` — 3 Ready
- [ ] `kubectl get pods -A` — 0 pods in CrashLoopBackOff or Pending > 2 min
- [ ] `kubectl -n vhhealth-platform get cluster vhhealth-pg` — Phase: "Cluster in healthy state", ReadyInstances: 3
- [ ] `kubectl -n argocd get application` — all Applications Synced + Healthy
- [ ] `curl https://api.vhhealth.app/health/deep` — all checks `ok: true`
- [ ] `curl https://admin.vhhealth.app/` — returns admin portal HTML
- [ ] **Post-C1.2/qualification only:** `ScheduledBackup/vhhealth-pg-daily`
      succeeds with `method: plugin`; its `Backup` is complete under the
      distinct `vhhealth-pg18` R2 archive identity. Until then, production
      remains on its qualified PostgreSQL 17 backup path
- [ ] Grafana dashboards (port-forward the Grafana Service in `vhhealth-monitoring`) — all panels populated, no "No data"
- [ ] A merge leaves the C1.1 `PrometheusRule` definitions inert. After the
      approved `vhhealth-platform` manual sync, confirm Prometheus loads and
      evaluates them; C1.3 separately owns Alertmanager receiver/delivery
      wiring and proof
- [ ] A test OTP login via the patient app succeeds end-to-end
- [ ] A test admin login via `https://admin.vhhealth.app` succeeds
- [ ] A file upload via the uploads endpoint lands in R2, and the application
      returns a working object URL under the proven `CF_R2_URL` public/custom
      domain (`CF_R2_URL` is not `R2_ENDPOINT`)

### First SUPER_ADMIN login

With `REQUIRE_MFA_FOR_SUPER_ADMIN=true` (the prod default in
`validateEnv.js`), the very first login for any `SUPER_ADMIN` account does
NOT return a JWT. Instead the login response is `mfa_setup_required` and
carries a short-lived setup token. The admin portal renders a first-time
enrollment panel that:

1. Shows a QR code — scan it with Google Authenticator, Authy, 1Password,
   or Bitwarden.
2. Displays 10 one-time backup codes — **save them to a secure vault now;
   they are shown exactly once** and are the only recovery path if the
   authenticator device is lost.
3. Prompts for the 6-digit authenticator code to finalise enrollment.

On confirmation the JWT cookie is set and the admin is taken to the
dashboard. To turn enforcement off temporarily (e.g. for disaster recovery
when the SUPER_ADMIN is locked out), set `REQUIRE_MFA_FOR_SUPER_ADMIN=false`
in the backend SealedSecret and roll the deployment; the next login then
follows the normal non-MFA path. Revert the flag after recovery.

---

## 9. Day-2 operations

Links to live runbooks under `apps/backend/docs/RUNBOOKS/`:

| Scenario                                     | Runbook                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Postgres primary is down / data loss         | [`db-restore.md`](../apps/backend/docs/RUNBOOKS/db-restore.md)                                     |
| R2 bucket / object issues                    | [`r2-restore.md`](../apps/backend/docs/RUNBOOKS/r2-restore.md)                                     |
| Credential exposure / rotation               | [`credential-incident-response.md`](../apps/backend/docs/RUNBOOKS/credential-incident-response.md) |
| Secret / cert / key rotation                 | [`cert-rotation.md`](../apps/backend/docs/RUNBOOKS/cert-rotation.md)                               |
| Code Blue mis-fire                           | [`code-blue-misfire.md`](../apps/backend/docs/RUNBOOKS/code-blue-misfire.md)                       |
| Chatbot provider switch                      | [`chatbot-provider-switch.md`](../apps/backend/docs/RUNBOOKS/chatbot-provider-switch.md)           |
| Clinical AI provider switch                  | [`clinical-ai-provider-switch.md`](../apps/backend/docs/RUNBOOKS/clinical-ai-provider-switch.md)   |
| C1.2 node/control-plane/database/storage HA drill | [`runbooks/C1_2_HA_DRILL.md`](runbooks/C1_2_HA_DRILL.md)                                     |
| DR scenarios (node/quorum/full-cluster loss) | [`DISASTER-RECOVERY.md`](../apps/backend/docs/DISASTER-RECOVERY.md)                                |

**Rolling upgrade (approved image release):**
Use the release build's `image-ref.txt` evidence. The update command
cross-checks the tag against that build-emitted digest, verifies the image
signature with cosign, and writes an immutable `@sha256` pin to
`infra/kubernetes/apps/kustomization.yaml`. Never commit a tag-only production
image:

```bash
COSIGN_PUBLIC_KEY=<public-key> node scripts/update-prod-digests.mjs \
  --tag backend-v1.5.2 \
  --expected-digest-file <release-artifact-directory>/image-ref.txt
git diff -- infra/kubernetes/apps/kustomization.yaml
git add infra/kubernetes/apps/kustomization.yaml
git commit -m "deploy: backend v1.5.2 digest"
git push
# ArgoCD reports OutOfSync; an operator reviews and manually syncs vhhealth-apps.
```

**Node replacement:**

1. Confirm the VIP-backed kubeconfig reaches `https://10.10.0.10:6443`, capture
   the failed member's etcd/CNPG/storage state, and select an explicit healthy
   maintenance delegate. Do not infer a first inventory host.
2. From `infra/ansible/`, run the gated playbook with the failed/replacement
   hostname, exact current qualified pin, reviewed maintenance delegate, and
   retained evidence:

   ```bash
   ansible-playbook -i inventories/prod.yml playbooks/node-replace.yml \
     -e rke2_replacement_node=<lost-inventory-hostname> \
     -e rke2_replacement_version=<current-qualified-rke2-pin> \
     -e rke2_maintenance_host=<explicit-healthy-rke2-server> \
     -e rke2_node_replace_evidence_dir=<absolute-evidence-directory> \
     -e rke2_node_replace_authorized=true \
     -e rke2_replacement_host_fresh=true \
     --ask-vault-pass
   ```

   The playbook removes only the named lost member, preserves the pre-shared
   cluster token, and rejoins the fresh replacement through
   `https://10.10.0.10:9345`.
3. Reinstall Ubuntu 24.04 on replacement hardware and keep its reviewed
   `inventory_region` and `inventory_zone` aligned with the live node labels.
4. Verify VIP access, etcd quorum, CNPG replication, storage convergence,
   backend synthetic reads/writes, CNI, DNS, metrics, and alerts. Uncordon only
   after those checks pass, and retain the before/after evidence.

**Cert rotation (cluster-issued TLS):**
Managed by cert-manager + CNPG operator — auto-rotated. Manual
intervention only on compromise (see `cert-rotation.md`).

---

## 10. Compliance posture

For Indian hospital production go-live, complete
[`india-deployment-readiness.md`](india-deployment-readiness.md) in addition to
the infrastructure checks below. That runbook is the acceptance gate for
ABDM/ABHA, DPDP Act/Rules, CERT-In 180-day logs and six-hour incident
reporting, clinical UAT, backup/DR, and medical-device boundary decisions.

### In place

- **DPDP Act (India, 2023):**
  - Data residency: primary PHI remains on cluster storage. The confirmed R2
    S3 endpoint has no jurisdiction suffix and is not, by itself, evidence of
    an India or Asia-Pacific placement; verify and record the bucket's approved
    location/residency configuration separately before go-live.
  - Audit logs: `audit_log` + `file_access_logs` tables capture every
    PHI access with actor, timestamp, resource.
  - Encryption at rest: the running CNPG PostgreSQL 17 cluster uses
    `data_checksums`. Cloudflare R2 automatically encrypts database backup
    objects and metadata at rest with provider-managed AES-256-GCM; the Barman
    `ObjectStore` must not force the unsupported S3 server-side-encryption
    header. Backend upload archives use separate encryption and HMAC keys from
    `backup-crypto`: encryption provides confidentiality, and HMAC-SHA256
    authenticates the canonical metadata, archive key, and ciphertext before
    decryption. No pgBackRest cipher Secret exists.
  - Access controls: RBAC on both the application layer
    (`wrapAutoRBAC`) and k8s namespace layer (NetworkPolicy + RBAC).

- **HIPAA-ready (for future multi-region / US workload):**
  - Field-level encryption for sensitive columns
    (`FIELD_ENCRYPTION_KEY`).
  - TOTP secrets encrypted with a distinct key
    (`TOTP_ENCRYPTION_KEY`).
  - Client-side backend upload-archive encryption plus independent HMAC-SHA256
    authenticity with separately managed `backup-crypto` material; CNPG R2
    objects use provider-managed encryption.
  - Audit log preservation (Loki 180-day retention + SQL audit tables
    permanent).
  - PHI access middleware (`phiAccessLogger`) on every medical data
    route.
  - Route-level rate limiting to prevent data-exfiltration via brute
    enumeration.

- **ABDM (India National Digital Health Mission) — partial:**
  - FHIR R4 resources exposed at `/fhir/*`.
  - HL7v2 ADT + ORU parsers.
  - ABHA-linked identity integration present (see backend auth
    architecture for hooks).

### Deferred (batch 17)

- **SOC 2 Type II** formal audit — needs 6-month observation window.
- **Formal pentest engagement** — separate vendor contract.
- **BAA (Business Associate Agreement)** for HIPAA — only matters if
  a US-covered-entity partnership lands; scope-gated.
- **ABDM sandbox-to-prod transition** — needs production ABHA API
  credentials + sandbox sign-off.
- **Offsite DR cluster** — see
  [`CROSS_SITE_DR_FAILOVER_PLAN.md`](CROSS_SITE_DR_FAILOVER_PLAN.md) for the
  site-neutral architecture, preflight, promotion invariants, and evidence
  template; the actual site and network path remain operator-owned.
- **Multi-region failover for cross-border clients** — only when the
  platform ships to a second hospital in a second country.

---

## 11. Operator Script Index

Before running tenant onboarding, RLS/runtime-role rehearsal, ledger cutover
evidence, clinical-AI readiness checks, PHI encryption jobs, QA cluster bring-up,
or seed scripts, review [`SCRIPTS_INDEX.md`](SCRIPTS_INDEX.md) for purpose,
run context, prerequisites, and failure modes.
