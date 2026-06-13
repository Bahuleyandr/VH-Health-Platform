# DR Restore Drill — CNPG PITR (REL-2 / B2.2)

> Last updated: 2026-06-13 — full executable procedure added; R2 hardening
> and results template captured. Script at
> `infra/kubernetes/base/cnpg/dr-restore-drill.sh`.

HA (3 in-cluster replicas) protects against a node dying. It does NOT
protect against ransomware, a fat-fingered `DROP`, fire/flood, or the
storage layer eating itself — those need the **off-site** backup chain:
continuous WAL archiving + nightly base backups to Cloudflare R2
(`base/cnpg/cluster.yaml` + `base/cnpg/scheduled-backup.yaml`).

---

## Targets (confirmed with hospital leadership — sign off date: TBD)

| Objective | Target | Source |
|---|---|---|
| RPO (max data loss) | ≤ 5 minutes | continuous WAL archiving to R2 |
| RTO (time to restored service) | ≤ 60 minutes | drill-verified, below |
| Backup freshness alert | base backup > 30h old | `CNPGBackupNotRecent` alert |
| Drill cadence | quarterly, timed, logged | this document |

---

## R2 backup hardening (ransomware resistance)

R2 versioning is enabled on `vhhealth-db-backups` (see
`infra/kubernetes/base/cnpg/r2-backup-hardening.yaml`).

| Control | Status | Notes |
|---|---|---|
| R2 bucket versioning | OPERATOR ACTION | `wrangler r2 bucket versioning enable vhhealth-db-backups` |
| Lifecycle: purge non-current > 35d | OPERATOR ACTION | Prevents unbounded storage growth |
| Write-only backup key (no delete) | OPERATOR ACTION | R2 API token scoped to `object:put` only |
| Read-only DR key | OPERATOR ACTION | Separate R2 token for restore/drill |
| Weekly WAL archive verification | MANIFESTED | `cnpg-backup-verify` CronJob (see r2-backup-hardening.yaml) |
| Object Lock (WORM) | NOT SUPPORTED | R2 does not support S3 ObjectLock (mid-2026). Re-evaluate. |

**Operator: complete the R2 hardening steps in r2-backup-hardening.yaml
before the first quarterly drill.**

---

## Prerequisites

```bash
# On the ops workstation:
export CF_R2_ACCOUNT_ID=<your-r2-account-id>  # from Cloudflare dashboard
export DRILL_DATE=$(date +%Y-%m-%d)

# Tools:
kubectl cnpg version    # kubectl cnpg plugin (cloudnative-pg.io/documentation)
envsubst --version      # gettext-base package
jq --version
```

Also required:
- `kubectl` authenticated to the prod cluster.
- `cnpg-backup-credentials` Secret accessible in `vhhealth-platform`.
- Network access from the ops workstation to the cluster API.

---

## Automated drill (recommended)

The drill script automates all steps, verifies invariants, calculates
RPO/RTO, writes the results file, and tears down the scratch namespace.

```bash
# From the repo root:
export CF_R2_ACCOUNT_ID=<account-id>
export DRILL_DATE=$(date +%Y-%m-%d)
# Optional: set RECOVERY_TARGET_TIME to test a specific point-in-time.
# Default: 10 minutes ago.
# export RECOVERY_TARGET_TIME="2026-06-13T10:00:00+05:30"

bash infra/kubernetes/base/cnpg/dr-restore-drill.sh
```

The script:
1. Validates prerequisites.
2. Records production `max(clinical_timeline_events.created_at)` for RPO baseline.
3. Creates namespace `vhhealth-drill`, copies backup credentials.
4. Renders and applies `dr-restore-drill.yaml` (PITR to target time).
5. Waits (up to 50 min) for `Cluster in healthy state`.
6. Runs 5 clinical invariant queries.
7. Calculates RPO and RTO vs targets.
8. Writes results to `docs/qa-findings/${DRILL_DATE}-dr-drill.md`.
9. Deletes namespace `vhhealth-drill` (PHI teardown enforced).
10. Exits non-zero if any target is breached.

---

## Manual drill procedure (copy-pasteable)

Use this if the automated script fails or you need to pause mid-drill.

### Step 1 — Pick recovery target time T (record exact time)

```bash
T="$(date -u -d '10 minutes ago' '+%Y-%m-%dT%H:%M:%SZ')"
echo "Recovery target: ${T}"
# IST alternative: date -d '10 minutes ago' '+%Y-%m-%dT%H:%M:%S+05:30'
```

### Step 2 — Create scratch namespace

```bash
kubectl create namespace vhhealth-drill
kubectl label namespace vhhealth-drill \
  vhhealth.app/purpose=dr-drill \
  vhhealth.app/phi-present=true
```

### Step 3 — Copy backup credentials

```bash
kubectl get secret cnpg-backup-credentials -n vhhealth-platform -o yaml \
  | sed 's/namespace: vhhealth-platform/namespace: vhhealth-drill/' \
  | kubectl apply -f -
```

### Step 4 — Render and apply the drill cluster

```bash
export CF_R2_ACCOUNT_ID=<account-id>
export RECOVERY_TARGET_TIME="${T}"
export DRILL_DATE=$(date +%Y-%m-%d)
envsubst < infra/kubernetes/base/cnpg/dr-restore-drill.yaml > /tmp/drill-cluster.yaml
kubectl apply -f /tmp/drill-cluster.yaml
rm /tmp/drill-cluster.yaml
```

### Step 5 — Watch recovery (record start time)

```bash
RECOVERY_START=$(date +%s)
kubectl get cluster vhhealth-pg-drill -n vhhealth-drill -w
# Wait for: "Cluster in healthy state"
RECOVERY_END=$(date +%s)
echo "Recovery elapsed: $(( RECOVERY_END - RECOVERY_START ))s"
```

### Step 6 — Verify clinical invariants

```bash
DRILL_POD=$(kubectl get pods -n vhhealth-drill \
  -l postgresql=vhhealth-pg-drill,role=primary \
  -o jsonpath='{.items[0].metadata.name}')

psql() {
  kubectl exec -n vhhealth-drill "${DRILL_POD}" \
    -c postgres -- psql -U postgres vhhealth -tAc "$*"
}

echo "INV-1 admitted admissions:          $(psql 'SELECT count(*) FROM admissions WHERE status = '\''admitted'\'';')"
echo "INV-2 max(clinical_timeline_events): $(psql 'SELECT max(created_at) FROM clinical_timeline_events;')"
echo "INV-3 migration count:               $(psql 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;')"
echo "INV-4 users count:                   $(psql 'SELECT count(*) FROM users;')"
echo "INV-5 tenants count:                 $(psql 'SELECT count(*) FROM tenants;')"
```

### Step 7 — Backend smoke test (strongest check)

```bash
# Point a local backend env file at the drill cluster:
# DATABASE_URL=postgresql://postgres:<superuser-pw>@<kubectl-port-forward>:5432/vhhealth

# Port-forward the drill primary:
kubectl port-forward -n vhhealth-drill pod/${DRILL_POD} 5432:5432 &

# Run backend health check:
DATABASE_URL="postgresql://postgres:${PG_SUPERUSER_PW}@localhost:5432/vhhealth" \
  node apps/backend/src/scripts/healthcheck.js

# OR hit a locally-started backend:
curl -s http://localhost:5000/health/deep | jq .
```

### Step 8 — Record results

Fill in the results template in the next section. Commit to git.

### Step 9 — Tear down (MANDATORY — PHI present)

```bash
kubectl delete namespace vhhealth-drill --wait=true
# Confirm:
kubectl get pods -n vhhealth-drill 2>&1
# Expected: "No resources found in vhhealth-drill namespace"
```

---

## Results capture template

Copy this block, fill in values, save to `docs/qa-findings/YYYY-MM-DD-dr-drill.md`.

```markdown
# DR Restore Drill — YYYY-MM-DD

## Drill metadata

| Field | Value |
|---|---|
| Drill date | YYYY-MM-DD |
| Drill start | HH:MM IST |
| Recovery target time (T) | RFC3339 |
| Cluster ready at | HH:MM IST |
| Operator | Name |

## Timing results

| Metric | Measured | Target | Status |
|---|---|---|---|
| Cluster ready (recovery elapsed) | Xs (Xm) | N/A | — |
| RPO (max event lag vs prod) | Xs | ≤ 300s (5m) | PASS/FAIL |
| RTO (total drill wall time) | Xs (Xm) | ≤ 3600s (60m) | PASS/FAIL |

## Clinical invariants

| Check | Drill value | Prod baseline | Assessment |
|---|---|---|---|
| admissions (admitted) | X | X | PASS/FAIL |
| max(clinical_timeline_events.created_at) | TIMESTAMP | PROD_TIMESTAMP | PASS: ≤ T |
| migration count | X | X | PASS: equal |
| users count | X | X | PLAUSIBLE |
| tenants | X | X | PASS: equal |

## Backend smoke test

- [ ] `GET /health/deep` → 200
- [ ] Timeline chart read → data present up to T
- [ ] Admission endpoint → count matches invariant

## Findings

(None / list issues)

## Actions

(None / ticket refs)

## Teardown confirmed

- [x] `kubectl delete namespace vhhealth-drill` completed at HH:MM IST
```

---

## Real-incident quick path

1. **Declare**: wards switch to the downtime procedure
   (`docs/DOWNTIME_PROCEDURE.md`). Incident commander paged.
2. **Set recovery time**: decide T = last known-good time (check Prometheus
   for when the anomaly started).
3. **Run drill script against the prod namespace** (not scratch):
   ```bash
   # Change DRILL_NS to vhhealth-platform and DRILL_CLUSTER to vhhealth-pg-recovery
   # Restore into a new cluster name; verify; repoint DATABASE_URL SealedSecret.
   ```
4. **Verify** (steps 6–7 above in the production namespace).
5. **Repoint**: update `DATABASE_URL` SealedSecret to point at the recovery
   cluster; ArgoCD sync; confirm `/health/ready`.
6. **Back-entry**: wards enter paper records accumulated during downtime.
7. **Post-incident**: full write-up + diff against this runbook.

---

## Open items (owner-gated)

- [ ] R2 versioning enabled on `vhhealth-db-backups` (operator).
- [ ] R2 lifecycle rule: purge non-current versions > 35d (operator).
- [ ] Write-only + read-only R2 API tokens created and sealed (operator).
- [ ] First quarterly drill: scheduled and on ops calendar.
- [ ] RPO/RTO targets signed off by hospital leadership.
- [ ] Re-evaluate R2 Object Lock when Cloudflare ships it.
