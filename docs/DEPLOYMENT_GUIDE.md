# VH Health Platform — Deployment Guide

> End-to-end runbook for bringing up the VH Health backend + admin portal
> on a **3-node on-prem RKE2 Kubernetes cluster** inside a hospital data
> centre. Target audience: hospital SRE who's comfortable with Linux +
> Kubernetes basics.
>
> Companion docs:
>
> - [`HARDWARE_REQUIREMENTS.md`](HARDWARE_REQUIREMENTS.md) — procurement spec
> - [`../apps/backend/docs/DISASTER-RECOVERY.md`](../apps/backend/docs/DISASTER-RECOVERY.md) — DR scenarios
> - [`../apps/backend/docs/DB-MIGRATION-PLAN.md`](../apps/backend/docs/DB-MIGRATION-PLAN.md) — data cutover from legacy deployment
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
- GitOps-driven: every change to infra is a commit; ArgoCD reconciles.
- Self-healing: k8s restarts failed pods; CNPG promotes replicas; etcd
  tolerates 1 node loss.

Namespace layout:

| Namespace           | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `vhhealth`          | Application pods: backend, admin, migration Jobs     |
| `vhhealth-platform` | Stateful platform: CNPG, Redis, MinIO, cloudflared   |
| `ingress-nginx`     | Ingress controller DaemonSet                         |
| `cnpg-system`       | CloudNativePG operator                               |
| `sealed-secrets`    | Sealed-secrets controller                            |
| `argocd`            | ArgoCD control plane                                 |
| `harbor`            | In-cluster container registry (pull-through to ghcr) |
| `monitoring`        | Prometheus + Alertmanager + Grafana + Loki           |

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

- 3× servers matching at least the "Minimum" tier (16 vCPU / 64 GB ECC / 2× 1 TB NVMe RAID1 / dual 10 GbE / IPMI).
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
nodes into a healthy RKE2 cluster with the platform operators
pre-installed.

### 3.1 Configure inventory

```bash
cd infra/ansible
cp inventories/prod.yml.example inventories/prod.yml
```

Edit `inventories/prod.yml` — fill in:

- `[servers]` — the 3 node IPs (cluster VLAN).
- `ansible_user: vhhealth`
- `ansible_ssh_private_key_file: ~/.ssh/vhhealth_prod_ed25519` (or wherever your key lives)
- `group_vars/all.yml`:
  - `cluster_cidr: 10.42.0.0/16` (RKE2 default)
  - `service_cidr: 10.43.0.0/16` (RKE2 default)
  - `cluster_vip: 10.10.0.10` (VIP shared by all 3 control-plane nodes for kubeconfig)
  - `cloudflare_tunnel_id: <from Cloudflare dashboard>`
  - `r2_account_id: <Cloudflare account id>`
  - `ntp_servers: [10.0.0.5, time.cloudflare.com]`
  - `storage_class: longhorn-nvme`

### 3.2 Create Ansible vault with secrets

```bash
cd infra/ansible
ansible-vault create inventories/group_vars/all/vault.yml
```

Put the bootstrap-time secrets here (not the application ones — those
flow via sealed secrets later):

```yaml
vault_rke2_token: <rke2-cluster-join-token, 64 chars>
vault_cloudflare_tunnel_token: <from Cloudflare dashboard>
vault_r2_access_key_id: <for etcd snapshot upload>
vault_r2_secret_access_key: <for etcd snapshot upload>
vault_sealed_secrets_bootstrap_key: <base64-encoded CA-like keypair for bootstrap>
```

Store the vault password in your team password manager.

### 3.3 Run the bootstrap playbook

```bash
ansible-playbook \
  -i inventories/prod.yml \
  playbooks/site.yml \
  --ask-vault-pass
```

`site.yml` does:

1. Baseline OS hardening (unattended-security-updates, firewall rules,
   journald persistent logs, `vhhealth` sudoers).
2. Install RKE2 server on node 1 → wait until API ready.
3. Join RKE2 server on nodes 2 + 3 → wait until all 3 are Ready.
4. Install CNPG operator (`cnpg-system` namespace).
5. Install sealed-secrets controller (`sealed-secrets` namespace).
6. Install ingress-nginx as DaemonSet (`ingress-nginx` namespace).
7. Install `cloudflared` Deployment (`ingress-nginx` namespace).
8. Copy `kubeconfig` back to the Ansible control machine at
   `./artifacts/kubeconfig`.

Total runtime: **20–40 minutes** on fast hardware.

### 3.4 Validate the cluster

On your ops workstation:

```bash
export KUBECONFIG=$(pwd)/artifacts/kubeconfig

kubectl get nodes
# Expected:
# NAME          STATUS   ROLES                       AGE
# vhh-k8s-01    Ready    control-plane,etcd,master   20m
# vhh-k8s-02    Ready    control-plane,etcd,master   18m
# vhh-k8s-03    Ready    control-plane,etcd,master   16m

kubectl get pods -A
# Every pod should be Running or Completed.

kubectl get crd | grep -E "cnpg|sealed"
# Expected: clusters.postgresql.cnpg.io, sealedsecrets.bitnami.com, etc.
```

If any pod is `CrashLoopBackOff`, read its logs and check the
Ansible role for missing config.

---

## 4. Install platform services via Kustomize + ArgoCD

The platform baseline (Redis, MinIO, Harbor, ArgoCD itself,
monitoring) is committed under `infra/kubernetes/`. Two-step bootstrap:

### 4.1 First-run: `kustomize build | kubectl apply`

```bash
kustomize build infra/kubernetes/overlays/prod | kubectl apply -f -

kubectl -n vhhealth-platform wait --for=condition=Ready pod -l app=minio --timeout=300s
kubectl -n vhhealth-platform wait --for=condition=Ready pod -l app=redis --timeout=300s
kubectl -n argocd wait --for=condition=Ready pod -l app.kubernetes.io/name=argocd-server --timeout=300s
```

This drops Kustomize-rendered manifests on the cluster imperatively —
a one-time bootstrap. From here on, everything flows through ArgoCD.

### 4.2 Bootstrap ArgoCD to manage itself and the rest

Apply the ArgoCD `AppProject` + `Application` manifests that point
ArgoCD at this repo:

```bash
kubectl apply -f infra/kubernetes/overlays/prod/argocd-bootstrap.yaml
```

This creates:

- `AppProject/vhhealth-platform` — scoping for platform namespaces
- `Application/vhhealth-platform` — points at `infra/kubernetes/overlays/prod/`
- `Application/vhhealth-backend` — points at `infra/kubernetes/apps/backend/`
- `Application/vhhealth-admin` — points at `infra/kubernetes/apps/admin/`
- `Application/cnpg-cluster` — points at `infra/kubernetes/base/cnpg/`

After ~3 minutes, ArgoCD reconciles and all Applications show Synced +
Healthy in the ArgoCD UI:

```bash
kubectl port-forward -n argocd svc/argocd-server 8080:443
# Open https://localhost:8080 — password in `argocd admin initial-password -n argocd`
```

From now on, **any change committed to `main` reconciles automatically**
within ~3 minutes (ArgoCD default poll).

---

## 5. Create secrets

Each application Secret lives in-repo as a **sealed** form
(`*.sealed-secret.yaml`). The plain form is never committed — you build
it locally, seal it with `kubeseal`, and commit only the sealed output.

For each `*.sealed-secret.yaml.example` file that Agent E has committed:

### 5.1 Identify the required secrets

```bash
find infra/kubernetes -name '*.sealed-secret.yaml.example'
# Example output:
# infra/kubernetes/apps/backend/vhhealth-jwt.sealed-secret.yaml.example
# infra/kubernetes/apps/backend/vhhealth-api-keys.sealed-secret.yaml.example
# infra/kubernetes/apps/backend/vhhealth-r2.sealed-secret.yaml.example
# infra/kubernetes/apps/backend/vhhealth-firebase.sealed-secret.yaml.example
# infra/kubernetes/apps/backend/vhhealth-chatbot.sealed-secret.yaml.example
# infra/kubernetes/apps/backend/vhhealth-clinical-ai.sealed-secret.yaml.example
# infra/kubernetes/apps/backend/vhhealth-db-url.sealed-secret.yaml.example
# infra/kubernetes/apps/admin/admin-env.sealed-secret.yaml.example
# infra/kubernetes/base/cnpg/readonly-credentials.sealed-secret.yaml.example
# infra/kubernetes/base/cloudflared/cloudflared-token.sealed-secret.yaml.example
```

### 5.2 For each secret, build and seal

```bash
# 1. Write the plain Secret locally (NEVER COMMIT THIS FILE)
cat > /tmp/vhhealth-jwt.yaml <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: vhhealth-jwt
  namespace: vhhealth
stringData:
  JWT_SECRET: "$(openssl rand -base64 64 | tr -d '\n')"
  FIELD_ENCRYPTION_KEY: "$(openssl rand -hex 32)"
  TOTP_ENCRYPTION_KEY: "$(openssl rand -hex 32)"
EOF

# 2. Seal it
kubeseal \
  --controller-namespace sealed-secrets \
  --controller-name sealed-secrets-controller \
  < /tmp/vhhealth-jwt.yaml \
  > infra/kubernetes/apps/backend/vhhealth-jwt.sealed-secret.yaml

# 3. Remove the plain copy
rm /tmp/vhhealth-jwt.yaml
```

### 5.3 Commit the sealed form

```bash
rm infra/kubernetes/apps/backend/vhhealth-jwt.sealed-secret.yaml.example
git add infra/kubernetes/apps/backend/vhhealth-jwt.sealed-secret.yaml
git commit -m "feat(secrets): seal JWT + encryption keys for prod"
git push
```

ArgoCD picks up the change within ~3 minutes, the sealed-secrets
controller materializes it into a real `Secret`, and the next
`Deployment` rollout picks up the new env vars.

### 5.4 Repeat for every secret

Minimum required before backend will start:

- `vhhealth-jwt` (JWT_SECRET + encryption keys)
- `vhhealth-api-keys` (API_KEY_PATIENT/STAFF/ADMIN)
- `vhhealth-db-url` (set **after** CNPG is up — step 6)
- `vhhealth-firebase` (service account JSON + FIREBASE_PROJECT_ID)
- `vhhealth-r2` (R2 access keys + bucket)
- `vhhealth-pg-readonly` (password for the `vhhealth_readonly` role — audit H10)
- `cloudflared-token` (Cloudflare Tunnel credentials JSON)

Optional but recommended:

- `vhhealth-chatbot` (LLM provider config)
- `vhhealth-clinical-ai` (clinical AI provider config)
- `admin-env` (BACKEND_API_KEY, NEXT_PUBLIC_ALLOWED_ORIGIN, etc.)

---

## 6. Data migration from legacy Postgres

See [`../apps/backend/docs/DB-MIGRATION-PLAN.md`](../apps/backend/docs/DB-MIGRATION-PLAN.md)
for the full step-by-step. Summary:

1. Apply the CNPG `Cluster` manifest → 3-replica Postgres 17 healthy.
2. Take final `pg_dump` from legacy DB.
3. `kubectl cp` dump to `vhhealth-pg-1` and `pg_restore`.
4. Update `vhhealth-db-url` sealed secret to point at `vhhealth-pg-rw`.
5. `kubectl -n vhhealth rollout restart deployment/vhhealth-backend`.
6. Verify application end-to-end.
7. Keep legacy DB in standby for 30 days; then decommission.

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
- [ ] `kubectl cnpg backup vhhealth-pg` — succeeds; backup appears in MinIO + R2
- [ ] Grafana dashboards (port-forward `monitoring/grafana`) — all panels populated, no "No data"
- [ ] Alertmanager (`kubectl -n monitoring port-forward svc/alertmanager 9093:9093`) — reachable, no firing alerts that shouldn't be firing
- [ ] A test OTP login via the patient app succeeds end-to-end
- [ ] A test admin login via `https://admin.vhhealth.app` succeeds
- [ ] A file upload via the uploads endpoint lands in R2 (`wrangler r2 object list vh-health-records`)

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
| DR scenarios (node/quorum/full-cluster loss) | [`DISASTER-RECOVERY.md`](../apps/backend/docs/DISASTER-RECOVERY.md)                                |

**Rolling upgrade (every image build on `main`):**
Automatic via ArgoCD image updater (planned) or manual bump in
`infra/kubernetes/apps/<app>/kustomization.yaml`:

```bash
# Manual tag bump for backend
kustomize edit set image ghcr.io/bahuleyandr/vh-health-platform-backend=ghcr.io/bahuleyandr/vh-health-platform-backend:backend-v1.5.2
git commit -am "deploy: backend v1.5.2"
git push
# ArgoCD syncs within 3 minutes; rolling update is zero-downtime.
```

**Node replacement:**

1. `kubectl drain vhh-k8s-02 --ignore-daemonsets`
2. Power off, swap server, reinstall Ubuntu 24.04.
3. Re-run `ansible-playbook -l vhh-k8s-02` — role joins it back to RKE2.
4. `kubectl uncordon vhh-k8s-02`.

**Cert rotation (cluster-issued TLS):**
Managed by cert-manager + CNPG operator — auto-rotated. Manual
intervention only on compromise (see `cert-rotation.md`).

---

## 10. Compliance posture

### In place

- **DPDP Act (India, 2023):**
  - Data-in-India: all PHI stored on cluster storage + R2 (Asia-Pac
    region pinned). No cross-border data transfer in the default path.
  - Audit logs: `audit_log` + `file_access_logs` tables capture every
    PHI access with actor, timestamp, resource.
  - Encryption at rest: CNPG uses PG17 with `data_checksums`; off-site
    backups request SSE (AES-256) via `barmanObjectStore.encryption` in
    cluster.yaml (audit finding M13 — the previous "pgBackRest encrypts
    with AES-256" claim was aspirational; CNPG uses barman-cloud, and no
    `pgbackrest-cipher` secret ever existed); R2 additionally encrypts
    all objects at rest with provider-held keys.
  - Access controls: RBAC on both the application layer
    (`wrapAutoRBAC`) and k8s namespace layer (NetworkPolicy + RBAC).

- **HIPAA-ready (for future multi-region / US workload):**
  - Field-level encryption for sensitive columns
    (`FIELD_ENCRYPTION_KEY`).
  - TOTP secrets encrypted with a distinct key
    (`TOTP_ENCRYPTION_KEY`).
  - Backup encryption with customer-managed keys.
  - Audit log preservation (Loki 30d retention + SQL audit tables
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
- **Offsite DR cluster** — see `DISASTER-RECOVERY.md` Scenario 6.
- **Multi-region failover for cross-border clients** — only when the
  platform ships to a second hospital in a second country.
