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

1. Seal the three secrets in
   `warehouse-credentials.sealed-secret.yaml.example`.
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
7. Point Metabase at `vhhealth-warehouse-rw:5432/vhhealth` as `vh_metabase`
   (sees ONLY the `analytics_marts` schema), and retire its OLTP connection.

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

Add the PrometheusRule alert (suggested in `docs/ANALYTICS_WAREHOUSE.md`,
pairs with base/monitoring) before go-live. Tearing the warehouse down?
**`DROP SUBSCRIPTION vh_analytics_sub;` first** (drops the slot), or
`SELECT pg_drop_replication_slot('vh_analytics_slot');` on the primary if
the warehouse is already gone.

## Sanity checks

`node apps/backend/scripts/warehouse-verify.mjs` (env `DATABASE_URL` = OLTP,
`WAREHOUSE_URL` = warehouse) — publication membership, subscription state,
slot lag, marts freshness, spot row-count compare.
