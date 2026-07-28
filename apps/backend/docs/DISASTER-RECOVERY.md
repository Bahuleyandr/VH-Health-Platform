# VH Health — Disaster Recovery Runbook

> Target architecture: 3-node on-prem RKE2 Kubernetes cluster, CloudNativePG
> (CNPG) PostgreSQL, MinIO in-cluster object storage, Cloudflare R2 offsite.
> Production currently runs PostgreSQL 17. The digest-pinned PostgreSQL 18.4
> and Barman-plugin target is inert until C1.2 upgrades RKE2 to Kubernetes 1.34
> or newer and the complete qualification passes.
> See [`../../../docs/DEPLOYMENT_GUIDE.md`](../../../docs/DEPLOYMENT_GUIDE.md) for the
> deployment model and kubeconfig setup.

## Recovery Objectives

| Metric | Target | Notes |
|--------|--------|-------|
| **RPO** (Recovery Point Objective) | ≤ 5 minutes | continuous WAL archiving to R2; drill evidence required |
| **RTO** (Recovery Time Objective) | ≤ 60 minutes | timed reader-only restore proof |
| Backup frequency | One daily base backup at 20:30 UTC + continuous WAL | Barman Cloud Plugin direct to R2 |
| Backup retention | 30 days declared by the producer `ObjectStore` | Live bucket/lifecycle evidence remains operator-owned |
| Offsite target | Cloudflare R2 | Database bucket/prefix, distinct PG17 and PG18 archive identities |
| Encryption | R2 provider-managed encryption at rest | R2 automatically encrypts objects/metadata; backend upload-archive client-side crypto is separate |

---

## Backup Architecture

```
  CNPG primary (vhhealth-pg)
         │
         │  Barman Cloud Plugin: continuous WAL
         │  + vhhealth-pg-daily at 20:30 UTC
         ▼
  Cloudflare R2 database bucket/prefix
         │
         ├── producer: cnpg-backup-producer-credentials (Object R/W)
         └── verifier/restore: cnpg-dr-reader-credentials (Object Read-only)
```

- **Plugin config:** `base/cnpg/barman-cloud-object-store.yaml` defines the
  production writer `ObjectStore`;
  `base/cnpg/dr-restore-drill.yaml` defines the excluded, namespace-local
  reader `ObjectStore` used for proof/recovery.
- **WAL archiving:** `archive_mode=on`, `archive_timeout=5min` bounds archive
  rollover; acceptance depends on observed archive freshness, not this setting
  alone.
- **Credential boundary:** the bucket-scoped producer needs Object Read & Write
  because Barman retention deletes expired objects. Verification and restore
  use a separate bucket-scoped Object Read-only identity. The Barman
  destination prefix is workload routing, not token scope. Ordinary long-lived
  R2 credentials are not true put-only tokens; brokered prefix/put-only
  enforcement and retention/deletion separation are deferred to C6.2.
- **PITR:** recovery uses declarative
  `externalClusters[].plugin` configuration and the namespace-local reader
  `ObjectStore`; no restore workload receives the producer Secret.
- **Backend upload-archive staging:** the MinIO archive producer and verifier
  each use a bounded 10 GiB `emptyDir`. Production activation is blocked until
  observed MinIO source and encrypted-archive sizes pass the capacity
  preflight: the producer stages the source plus encrypted archive together
  with a 128 MiB safety margin and projects this as
  `2 × source bytes + 128 MiB ≤ 10 GiB` (a practical source ceiling below
  5 GiB), while the verifier requires
  `archive bytes + 128 MiB ≤ 10 GiB`. The producer fails closed before
  encryption/upload and the verifier checks R2 `ContentLength` before download.
  Scaling beyond this boundary requires streaming/multipart transfer, MinIO
  replication, or a dedicated staging PVC.
- **Backend archive authenticity:** `backup-crypto` contains independently
  generated, unequal `BACKUP_ENCRYPTION_KEY` and `BACKUP_HMAC_KEY` values.
  HMAC-SHA256 covers the canonical format, SHA-256, creation timestamp/epoch,
  source bucket, object count, encryption identifier, content length, archive
  key, and ciphertext. The verifier checks this HMAC before decryption; size or
  SHA-256 checks alone do not authenticate an archive. Rotate producer and
  verifier to the same reviewed new key pair, retain the prior pair while its
  archives remain required, and require a new archive, HMAC verification,
  decryption, and restore proof before retiring the prior generation.

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
   `/var/lib/rancher/rke2/server/db/snapshots/`. The Ansible RKE2 role
   schedules snapshots every 6 hours and retains the newest 20 snapshots; this
   is a count-based policy, not a fixed number of days.

3. **Restore on the surviving node:**
   ```bash
   ssh vhhealth@vhh-k8s-01
   sudo systemctl stop rke2-server
   sudo rke2 server \
     --cluster-reset \
     --cluster-reset-restore-path=/var/lib/rancher/rke2/server/db/snapshots/<snapshot-name>
   # The reset command exits after restoring. Start N1 normally, without
   # --cluster-reset, and prove it is active before touching either peer.
   sudo systemctl start rke2-server
   sudo systemctl is-active --quiet rke2-server
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
   kubectl -n argocd get application              # inspect drift; sync remains manual
   ```

6. **Postgres check:** CNPG replicas that fell behind should rejoin from the
   healthy cluster under operator control. If database recovery is required,
   use the reader-only Barman-plugin path below; there is no MinIO `repo1`.

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
   # Prove the committed namespace-local reader path first:
   bash infra/kubernetes/base/cnpg/dr-restore-drill.sh
   ```

   For the incident cluster, use a reviewed copy of
   `infra/kubernetes/base/cnpg/dr-restore-drill.yaml` with a new cluster name
   and the approved recovery target. Preserve the reader-only
   `externalClusters[].plugin` binding and use the exact image matching the
   source backup's PostgreSQL major. Record the rendered YAML and checksum,
   then watch `kubectl -n vhhealth-platform get cluster
   vhhealth-pg-recovery -w`.

4. **Validate the recovered DB** before cutover:
   ```bash
   kubectl -n vhhealth-platform exec -it vhhealth-pg-recovery-1 -c postgres -- \
     psql -d vhhealth -c "SELECT count(*) FROM appointments WHERE created_at >= '2026-04-22';"
   ```

5. **Cut over by rotating the actual `vhhealth-backend-env` SealedSecret.**
   Start from its approved complete plaintext source and preserve every reviewed
   non-database key. Change only `DATABASE_URL`, optional `DATABASE_READ_URL`,
   and `DATABASE_SUPERUSER_URL` to the recovered services with their correct
   runtime/read-only/owner roles. Seal the complete Secret to
   `infra/kubernetes/apps/backend/sealed-secret.yaml`; never replace the broad
   Secret with a partial database-only Secret or apply plaintext from shell
   history. Confirm the real sealed file is referenced by
   `infra/kubernetes/apps/backend/kustomization.yaml`, then explicitly stage
   both reviewed files, commit, push, and manually sync `vhhealth-apps` at the
   approved revision. That sync runs
   `infra/kubernetes/apps/backend/migration-job.yaml` as the
   `Job/vhhealth-backend-migrate` PreSync hook using
   `DATABASE_SUPERUSER_URL`; a hook failure aborts cutover. Inspect the Job
   status/logs before restarting and verifying the backend Deployment.

6. **Verify and un-maintenance:**
   ```bash
   kubectl -n vhhealth exec -it deployment/vhhealth-backend -- curl -s http://localhost:5000/health/deep | jq
   kubectl -n vhhealth set env deployment/vhhealth-backend VHHEALTH_MAINTENANCE-
   ```

7. **Plan consolidation** later, at a quiet window. Do not delete or rename the
   original cluster during the incident. Preserve the source cluster, Backup
   custom resources, R2 objects, checksums, and recovery evidence until a
   separately approved follow-up signs off.

---

## Scenario 5 — Full cluster loss

All 3 nodes destroyed (fire, flood, hardware theft). Reconstruct from Ansible
and R2.

1. **Provision new hardware** per [`../../../docs/HARDWARE_REQUIREMENTS.md`](../../../docs/HARDWARE_REQUIREMENTS.md).
   Follow the OS install + networking steps in
   [`../../../docs/DEPLOYMENT_GUIDE.md`](../../../docs/DEPLOYMENT_GUIDE.md) §2
   only. Do not follow its normal §3 cluster bootstrap: this recovery sequence
   replaces §3 so the restored etcd state is not overwritten by a fresh
   quorum.

2. **Prepare all three servers without forming a fresh quorum.** Apply the
   common/hardening/firewall baseline and RKE2 binary/configuration through an
   operator-reviewed recovery play that guarantees `rke2-server` remains
   stopped on every node. Do not run `playbooks/site.yml`: it starts and joins
   all servers, which would create a fresh quorum before the restore. Recover
   the exact original backed-up RKE2 server token from the approved vault; a
   newly generated token cannot decrypt bootstrap data in the snapshot.

   Before continuing, prove all three services are stopped:

   ```bash
   ansible rke2_servers -i inventories/prod.yml --become \
     -m ansible.builtin.systemd \
     -a "name=rke2-server state=stopped enabled=true" --ask-vault-pass
   ansible rke2_servers -i inventories/prod.yml --become \
     -m ansible.builtin.command \
     -a "systemctl show rke2-server --property=ActiveState --value" \
     --ask-vault-pass
   # Expected on every node: inactive. Any active/failed-to-query result stops
   # the restore; do not continue into a live fresh quorum.
   ```

3. **Restore etcd snapshot from offsite S3.** The Ansible RKE2 role uploads
   snapshots to R2 every 6 hours and retains the newest 20 snapshots; do not
   infer a fixed day count from this count-based retention:
   ```bash
   # On node 1, while nodes 2 and 3 remain stopped:
   sudo rke2 server \
     --cluster-reset \
     --cluster-reset-restore-path=<snapshot-filename-only> \
     --token=<original-rke2-server-token> \
     --etcd-s3 \
     --etcd-s3-endpoint=<r2-endpoint> \
     --etcd-s3-access-key=<key> \
     --etcd-s3-secret-key=<secret> \
     --etcd-s3-bucket=vhhealth-etcd-backups
   # The reset command exits after restoring; start node 1 normally before
   # joining either replacement peer.
   sudo systemctl start rke2-server
   sudo systemctl is-active --quiet rke2-server

   # Wait for the restored API on node 1. Then, one peer at a time, clear only
   # its fresh/local server DB and let it join the restored cluster.
   sudo env KUBECONFIG=/etc/rancher/rke2/rke2.yaml \
     kubectl wait --for=condition=Ready node/<node-1-name> --timeout=10m

   # On node 2; wait for Ready before repeating on node 3:
   sudo systemctl stop rke2-server
   sudo rm -rf /var/lib/rancher/rke2/server/db
   sudo systemctl start rke2-server

   # After each serial join, run from node 1:
   sudo env KUBECONFIG=/etc/rancher/rke2/rke2.yaml \
     kubectl wait --for=condition=Ready node/<joined-node-name> --timeout=10m

   # Validate only after both peers have rejoined the restored control plane:
   sudo env KUBECONFIG=/etc/rancher/rke2/rke2.yaml kubectl get nodes
   sudo env KUBECONFIG=/etc/rancher/rke2/rke2.yaml kubectl get pods -A
   ```

4. **Recover the operator prerequisites before syncing workloads.** On a fresh
   replacement, install the exact last-qualified CNPG version compatible with
   the restored Kubernetes and PostgreSQL state: for Kubernetes 1.34 or newer,
   install the pinned CNPG 1.30 directly rather than starting unsupported CNPG
   1.24. The interleaved ladder applies only to an in-place upgrade from the
   existing Kubernetes 1.31/CNPG 1.24 stack. Install the pinned Barman Cloud
   Plugin, confirm `objectstores.barmancloud.cnpg.io`, restore the sealed
   producer and namespace-local reader credentials, then prove the committed
   R2 endpoint renders into the `ObjectStore` and backup jobs.

5. **Restore CNPG into a new cluster through the reader-only plugin path.**
   Select the exact qualified image and archive identity that match the source
   backup: never replay PG18 WAL into the PG17 identity or try to open a PG18
   data directory with a PG17 image. Prove roles, schema, checksums, pgvector,
   and representative application reads before cutover.

6. **Keep writers and public ingress quiesced; sync only platform
   prerequisites.** Restored etcd may recreate the old application workloads,
   so immediately remove the recovered
   `HorizontalPodAutoscaler/vhhealth-backend` in namespace `vhhealth` after
   capturing it as incident evidence, then scale
   `Deployment/vhhealth-backend` to zero. The later `vhhealth-apps` sync
   recreates the HPA. Suspend `CronJob/vhhealth-backend-r2-sync` and
   `CronJob/backup-verification` in `vhhealth`; capture and terminate any
   in-flight Job they own rather than allowing it to run against the empty
   replacement bucket. Verify that no backend, producer, or verifier pod/job
   remains active.

   Keep `Deployment/cloudflared` in namespace `vhhealth-ingress` at zero
   through a reviewed incident recovery patch and do not activate the tunnel
   credential yet, so platform recovery cannot reopen public traffic.

   Manually sync only `vhhealth-platform` at the approved revision and with
   that recovery patch. Before syncing, prove its diff preserves the recovered
   database and keeps `cloudflared` at zero; do not let the ordinary
   initdb/upgrade `Cluster` declaration replace the incident recovery source.
   Confirm MinIO and the required platform services are healthy, then re-prove
   that the backend and both archive CronJobs remain quiesced. Do **not** sync
   `vhhealth-apps`, `vhhealth-kube-prometheus`, or `vhhealth-loki` yet.

7. **Restore the MinIO upload bucket from the encrypted off-site archive while
   writers remain quiesced.**
   Use only `offsite-backup-reader` plus `backup-crypto` to fetch, verify object
   metadata and SHA-256/size, authenticate the canonical metadata, archive key,
   and ciphertext with HMAC-SHA256, then decrypt and validate the tar stream
   before an approved import into the replacement MinIO bucket. Reject an HMAC
   mismatch before decryption. The off-site object is an encrypted archive, not
   a live MinIO mirror; do not run `mc mirror` against it and do not give the
   restore path `offsite-backup-producer`. Confirm the selected archive plus the
   128 MiB safety margin fits the verifier's bounded 10 GiB staging volume
   before starting the recovery job. Validate restored object counts and
   checksums before permitting any backend or archive job to start.

8. **Activate applications only after MinIO validation.** Restore the proven
   R2 public/custom-domain base as `CF_R2_URL` in a reviewed apps Kustomize
   patch; the committed empty value deliberately fails backend URI validation,
   and the S3 API `R2_ENDPOINT` is not a substitute. Review the
   `vhhealth-apps` diff, confirm it will start the backend and unsuspend the two
   archive CronJobs only now, then manually sync it at the approved revision.
   Require the migration hook and backend readiness to pass. Through an
   approved internal access path, perform an application upload and prove the
   returned object URL uses the approved base and retrieves successfully under
   the intended access policy. Then confirm a new producer run and its separate
   reader-owned verification succeed.

   After application health is proven, manually sync
   `vhhealth-kube-prometheus` and `vhhealth-loki` one at a time. Stop on the
   first failure and capture Argo diff, health, events, and logs. None of the
   four restored Application custom resources should be assumed to sync
   itself.

9. **DNS + tunnel:** remove the temporary `cloudflared` hold only after the
   internal application/upload proof passes. Roll the new Cloudflare Tunnel
   credential and manually reconcile the reviewed platform revision; see
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

# Take an approved on-demand backup by applying a one-off Backup that uses
# method: plugin and pluginConfiguration.name: barman-cloud.cloudnative-pg.io.

# List backups
kubectl -n vhhealth-platform get backups

# Check WAL lag across replicas
kubectl -n vhhealth-platform cnpg status vhhealth-pg
```

---

## Contact Escalation Matrix

| Level | Responder | Contact | Escalation Trigger |
|-------|-----------|---------|-------------------|
| L1 | On-call engineer | Configure in incident contact registry before go-live | Any proven monitoring alert or manual detection; Alertmanager delivery is C1.3 |
| L2 | Backend lead | Configure in incident contact registry before go-live | L1 unresolved after 15 minutes |
| L3 | Platform lead (k8s + CNPG) | Configure in incident contact registry before go-live | Cluster-level failure, quorum loss |
| L4 | Hospital IT director | Configure in incident contact registry before go-live | Patient-safety impact or data breach |

> **Go-live gate:** this runbook is not production-complete until each level has
> a tested phone/alert route in the hospital incident contact registry.

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
- [ ] **Backup verification**: Confirm the next plugin `Backup` and reader-only verification completed successfully after recovery
- [ ] **ArgoCD state**: Confirm all Applications are Healthy + Synced

## Rollback and evidence rules

- Before C1.1 activation, rollback is a Git revert; manual Argo sync keeps a
  merge inert.
- Stop the CNPG ladder at the last qualified rung. A failed PostgreSQL 18
  upgrade returns to the exact qualified PostgreSQL 17 image and retains every
  failure artifact.
- After successful conversion, never image-downgrade the converted cluster.
  Restore the qualified PostgreSQL 17 backup into a new cluster or fix forward.
- Suspend a broken verifier or restore-proof job without interrupting healthy
  WAL/base backups. Remove only labeled disposable restore resources.
- Keep old and new credential generations until backup, reader-only
  verification, and synthetic restore evidence pass.
- Never delete R2 objects, `Backup` custom resources, checksums, drill evidence,
  or the only recoverable generation. Never reintroduce the broken endpoint
  placeholder, duplicate schedule, writer/reader reuse, or broad Secret
  imports.
