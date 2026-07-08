# Analytics warehouse (logical replication + dbt) — OPT-IN module (roadmap F1/F2)

Second CNPG Postgres (`vhhealth-warehouse`) fed by **native logical
replication** from the OLTP cluster, with **dbt** building star schemas and
the four F2 operational marts nightly. Metabase repoints here and stops
scanning the clinical database. Full architecture + rationale:
[`docs/ANALYTICS_WAREHOUSE.md`](../../../../docs/ANALYTICS_WAREHOUSE.md).

**Deliberately NOT referenced by `base/kustomization.yaml`** (same rule as
`optional/pacs`): the prod overlay consumes base wholesale, and warehouse
sizing + the Metabase cutover are owner decisions.

The operator here is CNPG **1.24** — the declarative `Publication`/
`Subscription` CRDs arrive in 1.25, so this module does the SQL setup with
idempotent Jobs instead. If the operator is upgraded later, the Jobs can be
retired in favour of CRDs without touching migration 295.

## Bring-up (one-time)

1. Seal the three secrets (run from a machine with cluster access +
   `kubeseal`; fetches the controller cert in-band):

   ```bash
   cd infra/kubernetes/optional/analytics-warehouse
   REPL_PW="$(openssl rand -base64 24 | tr -d '/+=' )"
   DBT_PW="$(openssl rand -base64 24 | tr -d '/+=' )"
   MB_PW="$(openssl rand -base64 24 | tr -d '/+=' )"

   kubectl -n vhhealth-platform create secret generic vh-warehouse-repl-credentials \
     --from-literal=password="$REPL_PW" --dry-run=client -o yaml \
     | kubeseal --controller-namespace kube-system --format yaml > repl-credentials.sealed.yaml

   kubectl -n vhhealth-platform create secret generic vh-dbt-credentials \
     --type=kubernetes.io/basic-auth \
     --from-literal=username=vh_dbt --from-literal=password="$DBT_PW" \
     --dry-run=client -o yaml \
     | kubeseal --controller-namespace kube-system --format yaml > dbt-credentials.sealed.yaml

   kubectl -n vhhealth-platform create secret generic vh-metabase-credentials \
     --type=kubernetes.io/basic-auth \
     --from-literal=username=vh_metabase --from-literal=password="$MB_PW" \
     --dry-run=client -o yaml \
     | kubeseal --controller-namespace kube-system --format yaml > metabase-credentials.sealed.yaml

   # CNPG managed roles reload basic-auth secrets — add the reload label:
   for f in dbt-credentials.sealed.yaml metabase-credentials.sealed.yaml; do
     yq -i '.spec.template.metadata.labels."cnpg.io/reload" = "true"' "$f"
   done

   echo "Metabase connection password (save it NOW, it is not recoverable): $MB_PW"
   ```

   Commit the three `*.sealed.yaml` files and add them to
   `kustomization.yaml` `resources:`. Only `$MB_PW` needs writing down —
   it goes into Metabase's connection form; the other two live solely
   in-cluster.
2. Add the module to `overlays/prod/kustomization.yaml`:

   ```yaml
   resources:
     - ../../base
     - ../../optional/analytics-warehouse
   ```

3. Make sure the backend release carrying **migration 295** (the
   `vh_analytics_pub` publication) has deployed.
4. Run, in order (each is idempotent, watch each complete):

   ```bash
   kubectl -n vhhealth-platform create job --from=job/vh-warehouse-publisher-setup pub-setup-1
   kubectl -n vhhealth-platform create job --from=job/vh-warehouse-migrate wh-migrate-1
   kubectl -n vhhealth-platform create job --from=job/vh-warehouse-subscribe wh-subscribe-1
   ```

5. Watch the initial copy: `SELECT * FROM pg_stat_subscription;` on the
   warehouse; slot lag on the publisher (query in subscribe-job logs).
6. First dbt build: `kubectl -n vhhealth-platform create job
   --from=cronjob/vh-warehouse-dbt dbt-initial`.
7. Enable `../metabase` only after the warehouse is healthy, then point
   Metabase at `vhhealth-warehouse-rw:5432/vhhealth` as `vh_metabase`
   (sees ONLY the `analytics_marts` schema), and retire any OLTP connection.

## After every backend release that adds migrations (runbook)

Logical replication does not replicate DDL. The deploy order is:

1. Backend release rolls out (OLTP migration job runs as usual).
2. `vh-warehouse-migrate` job — applies the same new migrations to the
   warehouse. Until this runs, a publication-member table that gained a
   column will stall the subscription (it retries; WAL retention on the
   publisher grows — don't leave it for days, see monitoring below).
3. If the release **added tables to the publication**: re-run
   `vh-warehouse-publisher-setup` (re-grants), then `vh-warehouse-subscribe`
   with `REFRESH_PUBLICATION=1`.

## Monitoring (the one real failure mode)

A wedged/abandoned subscription leaves an inactive replication slot on the
PRIMARY, which retains WAL until the disk fills. Watch on the OLTP cluster:

```sql
SELECT slot_name, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots WHERE slot_name = 'vh_analytics_slot';
```

The PrometheusRule for this (`slot-alerts.yaml` — stalled-WAL + inactive
slot) **ships in this module** and deploys with it; verify the CNPG metric
names once after enablement (instructions in the file header). Tearing the
warehouse down?
**`DROP SUBSCRIPTION vh_analytics_sub;` first** (drops the slot), or
`SELECT pg_drop_replication_slot('vh_analytics_slot');` on the primary if
the warehouse is already gone.

## Sanity checks

`node apps/backend/scripts/warehouse-verify.mjs` (env `DATABASE_URL` = OLTP,
`WAREHOUSE_URL` = warehouse) — publication membership, subscription state,
slot lag, marts freshness, spot row-count compare.
