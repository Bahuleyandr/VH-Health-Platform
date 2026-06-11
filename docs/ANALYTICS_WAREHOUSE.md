# Analytics Warehouse (roadmap F1/F2)

Status: **code-complete 2026-06-11** · deploy is owner-side (opt-in overlay)
Owner runbook: [`infra/kubernetes/optional/analytics-warehouse/README.md`](../infra/kubernetes/optional/analytics-warehouse/README.md)

## Why

Metabase reads the OLTP CNPG cluster today. That ceiling is low and risky:
long scans contend with clinical writes and die at the 30–60s statement
timeout; every new dashboard is a new way to slow down med-pass. F1 moves
analytics onto its own Postgres, fed by native logical replication, with dbt
building reviewed, tested star schemas — F2's four operational marts ride on
those instead of hand-written OLTP SQL.

```
OLTP vhhealth-pg (PG17, 3-node HA)            vhhealth-warehouse (PG17, 1 node)
  migration 295: PUBLICATION ──── WAL ────▶  SUBSCRIPTION vh_analytics_sub
  vh_analytics_pub (22 tables,                 same schema (same migration
  users column-listed)                         chain, seeds skipped)
                                                  │ nightly dbt build
                                                  ▼
                                               analytics_stg (views)
                                               analytics_marts (tables)
                                                  ▲ vh_metabase (marts ONLY)
```

## What replicates (and what never does)

The publication is **curated** (migration `295_analytics_publication.sql`,
locked by `src/tests/analytics-warehouse.deep.test.js`): encounters
(admissions / appointments / emergency_visits / icu_admissions), flow
(beds / bed_transfers / wards / ot_schedules), revenue (billing_* / payers /
tpas / claims / policies), orders (clinical_orders / pharmacy_orders /
investigations), and reference rows (departments / doctors / users).

PHI posture:

- `users` replicates through a **column list** — uid, role, gender,
  birthday, is_minor, is_active, registered_at, tenant_id. Credentials,
  names, phones, addresses (incl. `*_encrypted`), ABHA/PAN identifiers,
  device tokens, guardian contacts **cannot** reach the warehouse; the test
  suite has a tripwire list.
- Audit (`clinical_audit_events` — C4 chain), AI, token, and **payroll**
  tables are excluded. "Department P&L" is therefore deliberately
  **revenue + collections only** (`mart_department_revenue_monthly`);
  adding salary cost needs an explicit privacy sign-off to publish payslip
  aggregates — queue it as its own roadmap line if wanted.
- The warehouse applies the same migrations, so replicated tables keep
  FORCEd tenant-RLS. `vh_dbt` carries BYPASSRLS (cluster-scoped analytics);
  `vh_metabase` has **no** BYPASSRLS and reads only what the dbt post-hook
  grants: the `analytics_marts` schema. Metabase never touches raw rows.

## Star schemas (dbt, `infra/kubernetes/optional/analytics-warehouse/dbt/`)

(The dbt project lives inside the k8s module because kustomize's
configMapGenerator load restrictions require generator sources in/below the
kustomization root — keeping one source of truth beats a copy step.)

| Layer | Models |
|---|---|
| staging (views) | stg_admissions, stg_appointments, stg_emergency_visits, stg_billing(+items/payments), stg_ot_schedules, stg_bed_transfers, stg_wards, stg_orders |
| dims | dim_date, dim_department, dim_doctor, dim_patient (age-banded, pseudonymous), dim_payer |
| facts | **fct_encounters** (OPD+IPD+ER, payer_class, LOS), **fct_orders** (3 stores unified, status_class + TAT), **fct_revenue** (invoice-line grain) |
| marts (F2) | **mart_bed_flow_daily** (admits/discharges/transfers/midnight census/occupancy vs seeded beds), **mart_ot_utilization_daily** (cases + minutes vs staffed-day var), **mart_department_revenue_monthly** (gross/discounts/net/collected/outstanding/voided), **mart_payer_mix_monthly** (encounter mix + billed + TPA/insurance settlement) |

dbt tests: uniqueness on every fact/dim key, accepted-values on enum-ish
columns (payer_class warns rather than blocks — upstream `payer_type` is
free-ish text), and a singular test pinning bed-flow grain + occupancy
bounds. **No external dbt packages** — the cluster has no egress.

Relationship to the in-app `bi_*` tables (migration 157): those OLTP rollups
keep serving the in-app admin dashboards; the warehouse marts are the
analytics-grade replacements for exec/Metabase use. Retire `bi_*` consumers
opportunistically.

## Operating it

Bring-up, release runbook (migrate → re-grant → REFRESH PUBLICATION),
teardown, and the slot-monitoring SQL live in the module README. The one
failure mode that pages: a dead subscription leaves `vh_analytics_slot`
retaining WAL on the **primary**. The PrometheusRule covering it
(`AnalyticsReplicationSlotStalled` >4GB for 30m, plus
`AnalyticsReplicationSlotInactive`) ships **inside the module**
(`slot-alerts.yaml`) and deploys with it — verify the CNPG metric names once
post-enablement per the file header.

Health check: `node apps/backend/scripts/warehouse-verify.mjs`
(`DATABASE_URL` = OLTP, `WAREHOUSE_URL` = warehouse) — publication, slot
state/lag, subscription workers, spot row-count compare, marts freshness.

CI: `.forgejo/workflows/ci-warehouse.yml` is the canonical hosted gate and
`.github/workflows/ci-warehouse.yml` is the mirror. Both apply the full
migration chain to a service Postgres and run `dbt build` — model-vs-schema
drift fails in PR, plus a `kustomize build` of the module so the ConfigMap file
list can't go stale silently.

## G4 pairing (deferred until F1 runs in prod)

Tier-H ops forecasting / revenue-cycle AI modules stay `enabled=false` and
unwired. When the warehouse has real data and the owner green-lights G4,
point the Tier-H readers at the marts (they currently read OLTP) — that is
its own roadmap item with its own review.

## Local validation

```bash
# scratch DB with the full chain applied (per apps/backend/CLAUDE.md):
cd apps/backend && set DATABASE_URL=postgresql://postgres@127.0.0.1:55432/vhhealth_drift_fresh ^
  && node scripts/ci-setup-db.mjs
# then:
cd ../../infra/kubernetes/optional/analytics-warehouse/dbt
set DBT_PG_HOST=127.0.0.1& set DBT_PG_PORT=55432& set DBT_PG_USER=postgres& set DBT_PG_DBNAME=vhhealth_drift_fresh
dbt build --profiles-dir profiles
```
