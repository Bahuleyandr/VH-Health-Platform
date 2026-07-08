# Metabase embedded BI - OPT-IN module (NL-10 B1)

Metabase for VH Health embedded analytics. This module is deliberately **not**
referenced by `base/kustomization.yaml` or any production overlay. It stays
held until the owner enables the analytics warehouse and explicitly adds this
module to the prod overlay.

## Binding rules

- Metabase must never connect to OLTP Postgres.
- The only VH Health analytics source is `vhhealth-warehouse-rw:5432/vhhealth`
  as `vh_metabase`.
- `vh_metabase` has no `BYPASSRLS`; dbt's `grant_marts_read` post-hook grants
  read access only to materialized relations in `analytics_marts`.
- Phase 1 is internal, single-tenant embedded analytics. Hospital admins use
  signed embeds from the backend. Do not create hospital-admin Metabase logins
  or grant native SQL authoring in this phase.
- The `vhhealth-metabase` CNPG cluster in this module stores Metabase
  application metadata only. It is not a clinical or analytics data source.

## Enablement

1. Enable and validate `infra/kubernetes/optional/analytics-warehouse` first.
   Run the warehouse migration, subscription, and dbt jobs from that module's
   README so `analytics_marts` exists and the `vh_metabase` grants are present.
2. Seal the secrets shown in `metabase-secrets.sealed-secret.yaml.example`.
   Commit the sealed outputs and add them to this module's `resources:` list.
   The warehouse module must also provide `vh-metabase-credentials` for the
   warehouse read role.
3. Add both optional modules to the prod overlay, with the warehouse first:

   ```yaml
   resources:
     - ../../base
     - ../../optional/analytics-warehouse
     - ../../optional/metabase
   ```

4. Wait for `Cluster/vhhealth-metabase` and `Deployment/vh-metabase`.
5. Complete the one-time Metabase setup with a platform-operator account only.
   Add exactly one PostgreSQL data source:

   - Host: `vhhealth-warehouse-rw`
   - Port: `5432`
   - Database: `vhhealth`
   - User: `vh_metabase`
   - Schema include filter: `analytics_marts`

   Do not add `vhhealth-pg-rw`, `DATABASE_URL`, `DATABASE_READ_URL`, or any
   other OLTP connection.
6. Disable native SQL/query authoring for any non-platform group before sharing
   dashboards. Phase 1 hospital users should only receive curated signed embeds.
7. Configure the backend with `METABASE_URL`, `METABASE_EMBED_SECRET`, and the
   `METABASE_DASH_*` dashboard IDs. The backend is the only supported embed
   broker; the frontend must not construct Metabase URLs directly.

## Validation

```bash
kubectl kustomize infra/kubernetes/optional/metabase
```

After enablement, spot-check the warehouse data-source connection from a
platform Metabase session and verify a hospital-admin account cannot open the
native SQL editor.
