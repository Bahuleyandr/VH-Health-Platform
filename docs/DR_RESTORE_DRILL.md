# DR Restore Drill — CNPG PITR (Roadmap A4)

HA (3 in-cluster replicas) protects against a node dying. It does NOT
protect against ransomware, a fat-fingered `DROP`, fire/flood, or the
storage layer eating itself — those need the **off-site** backup chain:
continuous WAL archiving + nightly base backups to Cloudflare R2
(`base/cnpg/cluster.yaml` + `base/cnpg/scheduled-backup.yaml`).

## Targets (v1 — confirm with hospital leadership before pilot)

| Objective | Target | Source |
|---|---|---|
| RPO (max data loss) | ≤ 5 minutes | continuous WAL archiving to R2 |
| RTO (time to restored service) | ≤ 60 minutes | drill-verified, below |
| Backup freshness alert | base backup > 30h old | `CNPGBackupNotRecent` alert |
| Drill cadence | quarterly, timed, logged | this document |

## Prerequisites

- `cnpg-backup-credentials` sealed secret valid (R2 access keys).
- `kubectl cnpg` plugin installed on the ops workstation.
- A scratch namespace (`vhhealth-drill`) with capacity for one PG pod.

## Drill procedure (timed — record each step's clock time)

1. **Pick a target time** T (e.g. 10 minutes ago). Record it.
2. **Create the recovery cluster** in the scratch namespace:

   ```yaml
   apiVersion: postgresql.cnpg.io/v1
   kind: Cluster
   metadata:
     name: vhhealth-pg-drill
     namespace: vhhealth-drill
   spec:
     instances: 1
     storage: { size: 100Gi, storageClass: local-path }
     bootstrap:
       recovery:
         source: vhhealth-pg
         recoveryTarget:
           targetTime: "<T in RFC3339>"
     externalClusters:
       - name: vhhealth-pg
         barmanObjectStore:
           destinationPath: "s3://vhhealth-db-backups/cluster/"
           endpointURL: "https://<CF_R2_ACCOUNT_ID>.r2.cloudflarestorage.com"
           s3Credentials:
             accessKeyId: { name: cnpg-backup-credentials, key: ACCESS_KEY_ID }
             secretAccessKey: { name: cnpg-backup-credentials, key: SECRET_ACCESS_KEY }
   ```

3. **Watch recovery**: `kubectl -n vhhealth-drill get cluster -w` until
   `Cluster in healthy state`.
4. **Verify clinically meaningful invariants** (not just `SELECT 1`):

   ```sql
   SELECT count(*) FROM users;
   SELECT count(*) FROM admissions WHERE status = 'admitted';
   SELECT max(created_at) FROM clinical_timeline_events;  -- ≤ T, close to T
   SELECT count(*) FROM _migrations;                       -- matches prod
   ```

5. **Run the app against it** (strongest check): point a local backend at
   the drill cluster and hit `/health/deep` + one chart read.
6. **Record**: T, time-to-healthy, verification results, total wall time →
   `docs/qa-findings/YYYY-MM-DD-dr-drill.md`. RTO breach = high-severity
   finding.
7. **Tear down**: delete the namespace. Never leave a drill cluster running
   (it contains PHI).

## Real-incident quick path

1. Declare: wards switch to the downtime procedure
   (`docs/DOWNTIME_PROCEDURE.md`).
2. Restore per the drill into the production namespace under a new name;
   verify (step 4/5); repoint the backend `DATABASE_URL` secret; ArgoCD
   sync; confirm `/health/ready`; wards back-enter paper records.
3. Post-incident: full write-up + drill-procedure diffs.

## Owner actions still open

- [ ] Confirm R2 bucket versioning + lifecycle (ransomware-resistant:
      object-lock or at minimum versioning with delete protection).
- [ ] First quarterly drill scheduled and on the ops calendar.
- [ ] RPO/RTO targets signed off by hospital leadership.
