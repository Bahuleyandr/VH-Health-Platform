# VH Health — Disaster Recovery Runbook

> Target architecture: 3-node on-prem RKE2 Kubernetes cluster, CloudNativePG
> (CNPG) Postgres 17, MinIO in-cluster object storage, Cloudflare R2 offsite.
> See [`../../docs/DEPLOYMENT_GUIDE.md`](../../docs/DEPLOYMENT_GUIDE.md) for the
> deployment model and kubeconfig setup.

## Recovery Objectives

| Metric | Target | Notes |
|--------|--------|-------|
| **RPO** (Recovery Point Objective) | 1 hour | WAL archiving continuous; full backup daily |
| **RTO** (Recovery Time Objective) | 30 minutes | k8s reschedules + CNPG promotes in <60s for most scenarios |
| Backup frequency | Daily full + continuous WAL archive | Via pgBackRest to in-cluster MinIO |
| Backup retention | 30 days rolling (MinIO) + 180 days (R2 cold) | Lifecycle policy on R2 bucket |
| Offsite copy | Cloudflare R2 | pgBackRest `repo2` with async replication from MinIO |
| Encryption | Customer-managed key, AES-256 | Key stored in HashiCorp Vault (`secret/vhhealth/pgbackrest/cipher-pass`) |

---

## Backup Architecture

```
  CNPG primary (vhhealth-pg-1)
         │
         │  pgBackRest archive-push (WAL, every 16 MB segment)
         │  + nightly full backup at 02:00 IST
         ▼
  MinIO (in-cluster)  ← repo1 — hot, 30-day retention
         │
         │  MinIO site-replication → R2
         ▼
  Cloudflare R2       ← repo2 — offsite, 180-day retention, lifecycle → cold
```

- **pgBackRest config:** `infra/kubernetes/base/cnpg/backup.yaml` defines
  `repo1 = minio`, `repo2 = r2` with `cipher-type = aes-256-cbc` and
  `cipher-pass` pulled from the `pgbackrest-cipher` sealed secret.
- **WAL archiving:** `archive_mode=on`, `archive_timeout=60s` — guarantees a
  segment is archived every minute, satisfying RPO 1h with room to spare.
- **PITR:** Supported via `kubectl cnpg restore --target-time=...` against
  either repo.

---

## Scenario 1 — Single pod crashed

**Action:** none. Kubernetes restarts the pod automatically (restartPolicy:
Always + liveness probe).

**Verify:**
```bash
kubectl -n vhhealth get pods -l app=vhhealth-backend
kubectl -n vhhealth describe pod <pod-name> | grep -i restart
kubectl -n vhhealth logs deployment/vhhealth-backend --tail=100
```

A restart count > 5 inside an hour deserves triage — look at events, recent
deploys, image pulls, and OOMKills.

---

## Scenario 2 — Node failure (1 of 3)

**Action:** none for workloads. Kubernetes reschedules pods to the 2 surviving
nodes via default `unreachable` tolerations (5 minutes default; tightened to
60s for `vhhealth-backend` + `vhhealth-admin` via `tolerationSeconds`). CNPG
detects primary loss via the instance manager heartbeat and promotes a replica
to primary — takes **<60 seconds**. Service IPs stay stable.

**Verify Postgres promotion:**
```bash
kubectl -n vhhealth-platform get cluster vhhealth-pg
# Status should show: Healthy, primary: vhhealth-pg-2 (or -3)
kubectl -n vhhealth-platform cnpg status vhhealth-pg
```

**Then investigate the dead node:**
```bash
kubectl get nodes
kubectl describe node <dead-node>
# If IPMI/iDRAC reachable, reboot it. Once back, join auto-rejoins the
# RKE2 cluster and CNPG will re-attach the former primary as a replica.
```

---

## Scenario 3 — 2-node failure (etcd quorum lost)

The cluster is unavailable. etcd needs quorum (2 of 3). **Manual restore
required.**

1. **Confirm scope:**
   ```bash
   kubectl get nodes      # likely hangs or shows 2/3 NotReady
   ssh vhhealth@vhh-k8s-01 'sudo rke2 etcd-snapshot ls'
   ```

2. **Pick the newest snapshot** from the surviving node's
   `/var/lib/rancher/rke2/server/db/snapshots/` (RKE2 snapshots etcd every
   12 hours by default; configured to every 4 hours in `site.yml`).

3. **Restore on the surviving node:**
   ```bash
   ssh vhhealth@vhh-k8s-01
   sudo systemctl stop rke2-server
   sudo rke2 server \
     --cluster-reset \
     --cluster-reset-restore-path=/var/lib/rancher/rke2/server/db/snapshots/<snapshot-name>
   ```

4. **Rejoin the other two nodes** (or rebuild them if hardware is lost):
   ```bash
   # On each rebuilt node:
   sudo systemctl stop rke2-server
   sudo rm -rf /var/lib/rancher/rke2/server/db
   sudo systemctl start rke2-server
   ```

5. **Verify cluster:**
   ```bash
   kubectl get nodes                              # all 3 Ready
   kubectl -n vhhealth-platform get cluster       # CNPG reconverges
   kubectl -n argocd get application              # ArgoCD syncs the target state
   ```

6. **Postgres check:** CNPG replicas that fell behind will re-sync from the
   primary's WAL. If a replica is beyond WAL retention, it pulls a basebackup
   from `repo1` (MinIO) automatically.

**RTO for this path:** 20–60 minutes depending on etcd snapshot size and
whether nodes need hardware intervention.

---

## Scenario 4 — Postgres data corruption (logical)

Application-visible corruption (constraint violations, missing rows). Use
**Point-in-Time Recovery** via CNPG.

1. **Identify "known good" timestamp** — typically the last clean audit log
   entry before the corruption was introduced. Check
   `kubectl -n vhhealth logs deployment/vhhealth-backend` and Sentry.

2. **Put the app in maintenance mode:**
   ```bash
   kubectl -n vhhealth set env deployment/vhhealth-backend VHHEALTH_MAINTENANCE=true
   # rollout takes ~30s; /health returns maintenance:true
   ```

3. **Run PITR** (creates a new Cluster; doesn't destroy current one):
   ```bash
   kubectl cnpg restore \
     --cluster vhhealth-pg-recovery \
     --source vhhealth-pg \
     --target-time "2026-04-22T14:05:00+05:30"
   # Waits until bootstrap + WAL replay completes — a few minutes for hours
   # of WAL.
   kubectl -n vhhealth-platform get cluster vhhealth-pg-recovery
   ```

4. **Validate the recovered DB** before cutover:
   ```bash
   kubectl -n vhhealth-platform exec -it vhhealth-pg-recovery-1 -c postgres -- \
     psql -d vhhealth -c "SELECT count(*) FROM appointments WHERE created_at >= '2026-04-22';"
   ```

5. **Cut over** by updating the backend's `DATABASE_URL` Secret:
   ```bash
   kubectl -n vhhealth create secret generic vhhealth-db-url \
    --from-literal=DATABASE_URL="postgresql://vhhealth:<DB_PASSWORD>@vhhealth-pg-recovery-rw.vhhealth-platform:5432/vhhealth?sslmode=require" \
     --dry-run=client -o yaml | kubectl apply -f -
   kubectl -n vhhealth rollout restart deployment/vhhealth-backend
   ```

6. **Verify and un-maintenance:**
   ```bash
   kubectl -n vhhealth exec -it deployment/vhhealth-backend -- curl -s http://localhost:5000/health/deep | jq
   kubectl -n vhhealth set env deployment/vhhealth-backend VHHEALTH_MAINTENANCE-
   ```

7. **Rename recovery cluster to primary** (later, at a quiet window):
   Delete the original `vhhealth-pg`, rename the recovery cluster, rewire the
   Service labels. Track the follow-up as a post-incident ticket.

---

## Scenario 5 — Full cluster loss

All 3 nodes destroyed (fire, flood, hardware theft). Reconstruct from Ansible
+ R2.

1. **Provision new hardware** per [`../../docs/HARDWARE_REQUIREMENTS.md`](../../docs/HARDWARE_REQUIREMENTS.md).
   Follow the OS install + networking steps in
   [`../../docs/DEPLOYMENT_GUIDE.md`](../../docs/DEPLOYMENT_GUIDE.md) §2–§3.

2. **Bootstrap fresh cluster:**
   ```bash
   cd infra/ansible
   ansible-playbook -i inventories/prod.yml playbooks/site.yml --ask-vault-pass
   # Validate
   kubectl get nodes && kubectl get pods -A
   ```

3. **Restore etcd snapshot from offsite S3** (the Ansible role uploads RKE2
   etcd snapshots to R2 hourly, retained 7 days):
   ```bash
   # On node 1 (post-install, pre-join-others):
   sudo rke2 server \
     --cluster-reset \
     --cluster-reset-restore-path=s3://vhhealth-etcd-backups/<snapshot-name> \
     --etcd-s3 \
     --etcd-s3-endpoint=<r2-endpoint> \
     --etcd-s3-access-key=<key> \
     --etcd-s3-secret-key=<secret> \
     --etcd-s3-bucket=vhhealth-etcd-backups
   ```

4. **Let ArgoCD reconcile** (the etcd restore brings back all Application CRs).
   Watch `kubectl -n argocd get applications`; Syncing → Healthy.

5. **CNPG bootstraps from R2 (`repo2`)** — the `Cluster` manifest includes
   `.spec.bootstrap.recovery.source: r2-backup` on cold-start. First backup
   pull can take 15–30 minutes on slow WAN; all subsequent replicas stream
   from the promoted primary.
   ```bash
   kubectl -n vhhealth-platform get cluster vhhealth-pg -w
   ```

6. **Reattach PVs:** for stateful workloads that had data on the lost cluster
   (MinIO content, Harbor registry), restore from the R2 cold copy:
   ```bash
   # MinIO was the source; R2 holds the mirrored copy — point new MinIO at it
   kubectl -n vhhealth-platform exec -it minio-0 -- \
     mc mirror r2/vhhealth-backups-cold/ local/vhhealth-backups/
   ```

7. **DNS + tunnel:** new Cloudflare Tunnel credential needs rolling; see
   `RUNBOOKS/cert-rotation.md` §Cloudflare-Tunnel. DNS doesn't change (still
   points at Cloudflare edge; tunnel routing flips to the new cluster).

**RTO for full cluster loss:** 4–8 hours (hardware procurement assumed ready;
add 1–5 days if not).

---

## Scenario 6 — Offsite DR (standby site)

**Deferred to batch 17.**

The plan (not yet implemented):
- Secondary 3-node cluster at a partner hospital site (currently scoped to a
  sister VH Health facility in a different city).
- CNPG **replica cluster** (read-only, streams from primary via WAN) running
  at the standby site — async replication, WAN latency ~15ms to Chennai DC.
- Cloudflare load-balancer monitors primary tunnel; on health failure, routes
  traffic to standby cluster's tunnel.
- Standby promoted to primary manually via `kubectl cnpg promote` once
  primary site outage is declared a disaster (not a hiccup).

Tracking: batch 17, item "Offsite DR standby cluster".

---

## Common Commands — k8s Runbook Cheatsheet

```bash
# Cluster health
kubectl get nodes -o wide
kubectl -n vhhealth get pods
kubectl -n vhhealth-platform get cluster vhhealth-pg

# Logs (the journalctl replacement)
kubectl -n vhhealth logs deployment/vhhealth-backend --tail=100
kubectl -n vhhealth logs deployment/vhhealth-backend --tail=100 -f

# Restart (the systemctl restart replacement)
kubectl -n vhhealth rollout restart deployment/vhhealth-backend
kubectl -n vhhealth rollout status deployment/vhhealth-backend

# Shell into Postgres primary (the docker exec replacement)
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- psql -U vhhealth -d vhhealth

# Take an on-demand backup
kubectl cnpg backup vhhealth-pg

# List backups
kubectl -n vhhealth-platform get backups

# Check WAL lag across replicas
kubectl -n vhhealth-platform cnpg status vhhealth-pg
```

---

## Contact Escalation Matrix

| Level | Responder | Contact | Escalation Trigger |
|-------|-----------|---------|-------------------|
| L1 | On-call engineer | [Phone/Slack TBD] | Any alert from Prometheus/Alertmanager |
| L2 | Backend lead | [Phone/Slack TBD] | L1 unresolved after 15 minutes |
| L3 | Platform lead (k8s + CNPG) | [Phone/Slack TBD] | Cluster-level failure, quorum loss |
| L4 | Hospital IT director | [Phone/Slack TBD] | Patient-safety impact or data breach |

> **Action required**: Fill in contact details for each level before this runbook goes live.

---

## Post-Incident Review Checklist

After any incident requiring this runbook, complete the following within 48 hours:

- [ ] **Timeline**: Document exact timestamps for detection, response start, mitigation, and full recovery
- [ ] **Root cause**: Identify the underlying cause (not just the symptom)
- [ ] **Impact assessment**: Number of affected users, duration of downtime, any data loss
- [ ] **Detection gap**: How long between incident start and detection? Can Prometheus/Alertmanager be improved?
- [ ] **Response effectiveness**: Did the runbook steps work as documented? Any gaps?
- [ ] **Data integrity**: Confirm no data was lost or corrupted beyond RPO target (check WAL archive coverage)
- [ ] **HIPAA / DPDP implications**: Determine if PHI was exposed or unavailable beyond acceptable limits
- [ ] **Action items**: List concrete improvements with owners and deadlines
- [ ] **Runbook updates**: Update this document with any lessons learned
- [ ] **Communication**: Notify relevant stakeholders (hospital management, affected staff)
- [ ] **Backup verification**: Confirm next `kubectl cnpg backup` completed successfully after recovery
- [ ] **ArgoCD state**: Confirm all Applications are Healthy + Synced
