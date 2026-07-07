# NL-10 Embedded BI Design

- **Date:** 2026-07-07
- **Program:** NL-10 Embedded BI
- **Status:** Design for review - build not started
- **Scope:** Docs-only design spec for deployable embedded analytics, governed datasets, exec digest, and benchmark pack.
- **Branch:** `docs/nl10-embedded-bi-design`
- **Recommendation:** Choose Metabase first, connected only to the analytics warehouse marts, and hold any self-serve multi-tenant launch until tenant isolation is enforced below the dashboard filter layer.

## 1. Binding Invariants

1. **BI must not read OLTP directly.** The current warehouse plan exists because Metabase-on-OLTP was called out as low-value and risky; the durable path is logical replication into a separate warehouse plus dbt marts (`docs/ANALYTICS_WAREHOUSE.md:8-24`).
2. **The BI database role must see curated marts only.** The warehouse module already gives `vh_metabase` no `BYPASSRLS` and grants it only dbt materialized marts, not raw public tables (`docs/ANALYTICS_WAREHOUSE.md:36-51`, `infra/kubernetes/optional/analytics-warehouse/dbt/macros/grant_marts_read.sql:1-12`).
3. **Tenant isolation cannot rely on an iframe parameter alone.** `metabaseService` injects `tenant_id` into signed dashboard params, which is useful for curated embeds, but app-layer JWT params are not a self-serve isolation boundary (`apps/backend/src/services/dashboards/metabaseService.js:91-114`).
4. **PHI minimization is part of the data product.** The existing analytics publication excludes credentials, names, phones, audit, AI, token, and payroll surfaces; NL-10 should keep that posture and treat any expansion as an owner decision (`apps/backend/src/migrations/295_analytics_publication.sql:1-35`, `docs/ANALYTICS_WAREHOUSE.md:36-51`).
5. **Deployment remains held until explicitly enabled.** The analytics warehouse overlay is optional and deliberately not referenced by the base kustomization; NL-10 should use the same opt-in posture for any Metabase module (`infra/kubernetes/optional/analytics-warehouse/README.md:1-16`, `infra/kubernetes/optional/analytics-warehouse/kustomization.yaml:1-13`).
6. **Existing operational dashboards are preserved.** Current admin snapshots and real-time boards keep working while embedded BI grows beside them; old `bi_*` and reporting pages are not a replacement for governed self-serve analytics (`apps/backend/src/routes/dashboards/dashboardsRoutes.js:1-8`, `docs/superpowers/specs/2026-06-27-realtime-dashboards-beds-design.md:17-22`).
7. **NL-10 owns BI, not every adjacent platform.** NL-12 owns SIEM and audit export, NL-11 owns the public developer portal, and NL-9 owns outreach/campaign consent rails; NL-10 may consume notification delivery for exec digests but must not redefine those boundaries (`docs/superpowers/build-prompts/wave-c-nl9-kickoff.md:5-9`).
8. **Tier-H and operational AI stay decision-support only.** BI can surface forecasts and alert context, but it cannot auto-act, reorder patients, or bypass the clinical AI governance posture (`apps/backend/src/services/ai/tierHOperationalService.js:1-5`, `apps/backend/src/services/ai/operationalAlertService.js:18-23`).

## 2. Survey Grounding

The roadmap defines NL-10 as "deploy + embed self-serve analytics" using Metabase or Superset on dbt marts, with a `metabaseService` seam, governed dataset catalog, exec mobile digest, and benchmark pack (`docs/NEXT_LEVEL_ROADMAP.md:220-222`). The same roadmap marks the broader ops-intelligence gap as only partially present: dbt marts and report-builder seams exist, but embedded BI is not deployed, exec digest and benchmarking are still missing, and predictive models are not surfaced operationally (`docs/NEXT_LEVEL_ROADMAP.md:138-143`, `docs/NEXT_LEVEL_ROADMAP.md:308`).

The repository already has a credible BI substrate:

- The analytics warehouse is documented as code-complete, owner-side opt-in, and fed by logical replication plus nightly dbt (`docs/ANALYTICS_WAREHOUSE.md:3-24`).
- The warehouse publication is curated, excludes sensitive columns and whole domains, and intentionally avoids `FOR ALL TABLES` (`apps/backend/src/migrations/295_analytics_publication.sql:1-35`, `apps/backend/src/migrations/295_analytics_publication.sql:42-76`).
- dbt models produce staging views, dimensions, facts, and marts, with tests and no external packages (`docs/ANALYTICS_WAREHOUSE.md:53-69`, `infra/kubernetes/optional/analytics-warehouse/dbt/dbt_project.yml:1-13`).
- The Metabase embed seam already exists in backend code, including signed dashboard URLs and tenant-scoped JWT params (`apps/backend/src/services/dashboards/metabaseService.js:3-17`, `apps/backend/src/services/dashboards/metabaseService.js:39-80`, `apps/backend/src/services/dashboards/metabaseService.js:91-114`).
- Admin reporting and exports exist, but they are fixed operational reports and file downloads, not governed self-serve BI (`apps/admin/src/app/(with-auth)/dashboard/reporting/page.tsx:68-129`, `apps/admin/src/app/(with-auth)/dashboard/reporting/components/DataExporter.tsx:59-115`).

The important gap is not "can VH Health render a dashboard." It can. The gap is whether a BI tool can be deployed, embedded, governed, tenant-safe, refreshable, and explainable without widening PHI exposure or creating a shadow analytics platform.

## 3. Existing Substrate

### 3.1 Warehouse and dbt

The target data plane is the optional analytics warehouse module:

- OLTP Postgres publishes a curated table/column set into a second Postgres warehouse (`docs/ANALYTICS_WAREHOUSE.md:15-35`).
- dbt builds `analytics_stg` views and `analytics_marts` tables, then grants mart read access to `vh_metabase` (`infra/kubernetes/optional/analytics-warehouse/dbt/dbt_project.yml:35-51`, `infra/kubernetes/optional/analytics-warehouse/dbt/macros/grant_marts_read.sql:1-12`).
- The module runs nightly dbt by CronJob and is verified through owner-run commands, not enabled automatically in production overlays (`infra/kubernetes/optional/analytics-warehouse/dbt-cronjob.yaml:1-18`, `infra/kubernetes/optional/analytics-warehouse/README.md:57-118`).
- The cluster is currently single-instance and rebuildable, with HA deferred until executive dashboards become critical (`infra/kubernetes/optional/analytics-warehouse/warehouse-cluster.yaml:1-7`, `infra/kubernetes/optional/analytics-warehouse/warehouse-cluster.yaml:24-45`).

Initial certified datasets should come from the marts and dimensions already present:

- `dim_date`, `dim_department`, `dim_doctor`, `dim_patient`, and `dim_payer`.
- `fct_encounters`, `fct_orders`, and `fct_revenue`.
- `mart_bed_flow_daily`, `mart_ot_utilization_daily`, `mart_department_revenue_monthly`, and `mart_payer_mix_monthly`.

`dim_patient` is already pseudonymous and age-banded, which is directionally correct for BI (`infra/kubernetes/optional/analytics-warehouse/dbt/models/dims/dim_patient.sql:3-19`). However, facts and marts are uneven for multi-tenant BI: several facts carry `tenant_id` (`infra/kubernetes/optional/analytics-warehouse/dbt/models/facts/fct_encounters.sql:22-72`, `infra/kubernetes/optional/analytics-warehouse/dbt/models/facts/fct_orders.sql:6`, `infra/kubernetes/optional/analytics-warehouse/dbt/models/facts/fct_revenue.sql:21-44`), while some marts currently omit `tenant_id` from their final output (`infra/kubernetes/optional/analytics-warehouse/dbt/models/marts/mart_bed_flow_daily.sql:50-75`, `infra/kubernetes/optional/analytics-warehouse/dbt/models/marts/mart_department_revenue_monthly.sql:38-53`, `infra/kubernetes/optional/analytics-warehouse/dbt/models/marts/mart_payer_mix_monthly.sql:56-73`). That is acceptable for an internal single-tenant deployment but not enough for multi-tenant self-service.

### 3.2 Backend embed seam

`metabaseService` is the right seam to keep:

- It centralizes Metabase URL, secret, dashboard IDs, and signed JWT construction (`apps/backend/src/services/dashboards/metabaseService.js:24-80`).
- It exposes only configured dashboard keys through list and embed endpoints (`apps/backend/src/services/dashboards/metabaseService.js:82-114`).
- The route layer is admin-gated and obtains tenant context before returning embed URLs (`apps/backend/src/routes/dashboards/dashboardsRoutes.js:41-109`).

This service should become the only app-owned embed broker. The BI tool should not be embedded directly from the frontend, and users should not provide tenant filters or dashboard IDs in a way that bypasses the catalog.

### 3.3 Current snapshots, BI views, and reports

The old `bi_*` path is useful history, not the NL-10 target. Migration 157 introduced BI views and a broad legacy `metabase_readonly` grant over public schema tables (`apps/backend/src/migrations/157_bi_dashboards.sql:1-19`, `apps/backend/src/migrations/157_bi_dashboards.sql:130-144`). Current snapshot service intentionally avoids those views for request-time isolation because they do not expose `tenant_id`; it aggregates source tables with explicit tenant filters instead (`apps/backend/src/services/dashboards/snapshotService.js:3-55`). NL-10 should not revive broad public-schema BI grants.

The admin reporting page and export rail are operationally valuable, but they are fixed workflows: report overview tabs, predefined export formats, and CSV/PDF/XLSX downloads (`apps/admin/src/app/(with-auth)/dashboard/reporting/components/ReportsOverview.tsx:59-74`, `apps/admin/src/app/(with-auth)/dashboard/reporting/components/DataExporter.tsx:59-210`). NL-10 should integrate with them only through links, catalog metadata, or future governed export approval, not by turning these pages into ad hoc BI engines.

### 3.4 Read replica posture

`prismaReadOnly` is not a substitute for embedded BI. The architecture docs say analytics, exports, and dashboard reads can route to `DATABASE_READ_URL` when configured, but production currently has only a placeholder and reads fall back to the primary (`docs/SYSTEM-ARCHITECTURE.md:467-477`, `apps/backend/src/lib/prisma.js:423-451`, `infra/kubernetes/apps/backend/sealed-secret.yaml.example:95-96`). The CNPG pooler is currently RW, with a read-only pooler deferred until the backend split is wired (`infra/kubernetes/base/cnpg/poolers.yaml:17-21`).

NL-10 should use the warehouse for BI and leave `DATABASE_READ_URL` as an application read scaling improvement.

### 3.5 Notifications and exec mobile digest

The notification substrate is mature enough for an executive digest if NL-10 limits itself to aggregate, PHI-minimized content:

- `notificationOutbox` persists intent and supports retry/claim semantics (`apps/backend/src/utils/notifications/notificationOutbox.js:11-19`, `apps/backend/src/utils/notifications/notificationOutbox.js:112-154`).
- Delivery resolves tenant-specific channel settings and dispatches through unified push, email, in-app, WhatsApp, voice, SMS, or print paths (`apps/backend/src/utils/notifications/notificationOutboxDelivery.js:166-248`, `apps/backend/src/utils/notifications/notificationDispatcher.js:13-27`).
- Patient mobile already merges notification updates into unread counts and fetches `/notifications/my` (`apps/patient/lib/core/providers/notification_provider.dart:17-53`).

NL-10 should define digest content and role targeting; NL-9 should own campaign consent, WhatsApp/email policy, and reusable outreach templates.

### 3.6 Operational AI adjacency

Tier-H and operational AI already know how to produce queue, TAT, tariff, feedback, no-show, OT, and operational alert signals (`apps/backend/src/services/ai/tierHOperationalService.js:61-308`, `docs/CLINICAL_AI_MODULE_INVENTORY.md:183-189`). NL-10 can surface those as certified measures or linked explainers only after the source query is tenant-safe and cataloged. It should not convert AI outputs into automated BI-driven actions.

## 4. Tool Decision Matrix

| Option | Fit | Strengths | Risks | NL-10 ruling |
|---|---|---|---|---|
| Metabase embedded analytics | High | Already has a backend seam, dashboard ID catalog, signed embed URLs, and a known warehouse role path (`apps/backend/src/services/dashboards/metabaseService.js:3-114`). Fastest route to executive dashboards and internal self-serve. | Dashboard filters are not a database boundary. Native SQL, saved questions, and broad collections can leak if permissions are loose. No current Kubernetes Metabase manifest was found under `infra/kubernetes`. | **Pick first.** Deploy as an optional module, connect only to warehouse marts as `vh_metabase`, and start with curated embeds before broader self-serve. |
| Superset | Medium | Strong semantic layer, SQL Lab controls, dataset certification concepts, and good fit for analytics teams. | No existing app seam, no current infra manifest, more RBAC and operational surface to prove, and a larger product decision before value is visible. | **Defer.** Reconsider if Metabase cannot satisfy governed catalog, certified dashboards, or executive embed needs. |
| Native app dashboards only | Medium for fixed ops, low for self-serve | Best auth and tenant control because data stays in existing backend routes. Works well for operational boards and digest cards. | Does not meet the self-serve BI requirement and would duplicate BI charting/query semantics in app code. | **Use selectively.** Good for digest summaries and links; not the NL-10 BI engine. |
| Warehouse SQL exports | Low as primary BI | Simple for benchmark pack generation and controlled extracts. | Easy to bypass governance if exposed directly. Poor interactive experience. | **Use only behind cataloged export/benchmark workflows.** |

The design should standardize on **Metabase on warehouse marts for phase 1**, while explicitly preserving the right to swap or add Superset after the catalog, tenant isolation model, and benchmark policy are proven.

## 5. Tenancy and Security Design

### 5.1 Current tenant posture

The app is still documented as operationally single-tenant in places, with tenant context and RLS staged for stronger multi-tenant enforcement (`docs/SYSTEM-ARCHITECTURE.md:337-345`). Backend RLS policies are permissive when the tenant GUC is unset, and the repository has spent multiple migrations forcing RLS and broadening tenant policy coverage because owner/superuser behavior can otherwise bypass protections (`docs/SYSTEM-ARCHITECTURE.md:372-423`, `apps/backend/src/migrations/075_tenant_rls_policies.sql:1-69`, `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:5-56`, `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:1-64`).

That context matters because BI tools make direct database connections. They do not automatically run through `setTenant`, route guards, or app audit conventions. For self-serve BI, the database surface itself must be tenant-safe.

### 5.2 Isolation options

| Model | Description | Use | Limitation |
|---|---|---|---|
| Signed dashboard params only | `metabaseService` embeds `tenant_id` as a JWT param and dashboards filter on it. | Acceptable for a first curated internal dashboard where admins do not author queries. | Not enough for self-serve or native SQL. A bad card, missing filter, or exported question can cross tenant boundaries. |
| Per-tenant BI connections or roles | Each tenant uses a BI database connection, schema, or role that can only read that tenant's certified rows. | Recommended multi-tenant self-serve target after every certified dataset carries a tenant boundary. | More operational work: provisioning, rotation, dashboard duplication or connection mapping. |
| Tenant-split marts or secured views | dbt materializes per-tenant schemas/views or security-barrier views over tenant-filtered marts. | Strongest option for benchmark packs and external sharing because exports can be generated from pre-partitioned aggregate surfaces. | Higher dbt complexity and more migrations/schema management. |

### 5.3 Recommended staged posture

**Phase 1 internal embed:** Metabase may connect as `vh_metabase` to `analytics_marts` only. Native SQL should be disabled for non-platform operators, Metabase collections should be locked down, and embeds should be returned only through `metabaseService`. Dashboard `tenant_id` params are required but treated as defense-in-depth.

**Before multi-tenant self-service:** Every certified self-serve dataset must either expose `tenant_id` or be a pre-approved aggregate that cannot identify a tenant or patient. The current marts that omit tenant ID need to be amended or wrapped before self-serve launch (`infra/kubernetes/optional/analytics-warehouse/dbt/models/marts/mart_bed_flow_daily.sql:50-75`, `infra/kubernetes/optional/analytics-warehouse/dbt/models/marts/mart_department_revenue_monthly.sql:38-53`, `infra/kubernetes/optional/analytics-warehouse/dbt/models/marts/mart_payer_mix_monthly.sql:56-73`).

**Benchmark pack:** External benchmark sharing should not be a Metabase export. It should be a generated, owner-approved aggregate pack with minimum cell thresholds, tenant opt-in, and a persisted export record.

## 6. Governed Dataset Catalog

NL-10 needs a catalog before self-serve is offered. The catalog is not just display metadata; it is the permission and certification contract between dbt, Metabase, exports, digest generation, and future benchmark packs.

### 6.1 Proposed catalog entities

1. `analytics_dataset_catalog`
   - Dataset key, display name, dbt relation, grain, refresh cadence, source domain, owner role, certification status, tenant boundary mode, PHI class, min-cell threshold, allowed roles, export policy, and deprecation status.
2. `analytics_dataset_fields`
   - Dataset key, field name, display label, semantic type, aggregation behavior, PHI class, hidden-by-default flag, allowed filter flag, and description.
3. `analytics_dashboard_catalog`
   - Dashboard key, Metabase dashboard ID, dataset keys used, required params, embed roles, owner, status, and last certification date.
4. `analytics_digest_subscriptions`
   - Tenant, role or user target, digest cadence, channel preference, enabled metric bundle, and last delivered timestamp.
5. `analytics_benchmark_pack_exports`
   - Tenant, pack key, covered period, included datasets, suppression counts, approver, delivery method, and immutable export artifact metadata.

These names are design placeholders, not reserved migration names. The build worker should verify current migration head and naming conventions before implementation.

### 6.2 Initial certified datasets

The first catalog release should certify the existing warehouse models only:

- **Operational flow:** `mart_bed_flow_daily`, `mart_ot_utilization_daily`, `fct_encounters`, `dim_department`, `dim_doctor`, `dim_date`.
- **Revenue and payer:** `fct_revenue`, `mart_department_revenue_monthly`, `mart_payer_mix_monthly`, `dim_payer`, `dim_date`.
- **Orders and turnaround context:** `fct_orders`, `dim_department`, `dim_doctor`, `dim_date`.
- **Patient demographics:** `dim_patient` only as pseudonymous, age-banded, and hidden from broad self-serve by default (`infra/kubernetes/optional/analytics-warehouse/dbt/models/dims/dim_patient.sql:3-19`).

The catalog should explicitly label row-level facts as restricted and aggregate marts as preferred for broad BI. Fields such as `patient_uid` should be hidden by default, unavailable in benchmark packs, and exposed only to roles with a concrete operational need.

## 7. Exec Mobile Digest

The executive digest is a scheduled summary, not a free-form report generator. It should read from catalog-certified datasets and produce aggregate, PHI-minimized messages with links back to embedded dashboards.

Initial bundle:

- Daily OPD, IPD, and ER volumes.
- Bed occupancy and discharge-ready flow.
- OT utilization and late starts.
- Collections, outstanding receivables, department revenue, and payer mix.
- Lab/radiology turnaround exception counts when cataloged.
- Patient feedback/NPS summary when NL-9 survey rails provide certified aggregates.
- High or critical operational AI alert counts, with decision-support language only.

Delivery:

- In-app and push are the default channels because the notification substrate already supports authenticated app notification flows (`apps/backend/src/routes/notification/notificationRoutes.js:16-46`, `apps/patient/lib/core/providers/notification_provider.dart:17-53`).
- Email or WhatsApp delivery requires NL-9 consent/template approval because Wave C NL-9 owns campaign/outreach consent and PHI-minimization constraints (`docs/superpowers/build-prompts/wave-c-nl9-kickoff.md:5-9`).
- Each digest should persist delivery history and the dataset/catalog versions used so an executive can answer "what numbers did we send this morning?"

## 8. Benchmark Pack

The benchmark pack should launch as an internal pack first, then become external only after owner approval.

**Internal benchmark pack:**

- Compare current tenant performance against prior period, target, and rolling baseline.
- Use only certified aggregate datasets.
- Suppress small cells and any metric that would identify a patient, clinician, payer, or tenant cohort below threshold.
- Persist generated pack metadata for auditability.

**External benchmark pack:**

- Requires tenant opt-in, owner-approved sharing policy, minimum cell thresholds, and a clear data-sharing agreement.
- Should be generated from tenant-split marts, security-barrier views, or export tables, not from ad hoc Metabase downloads.
- Must keep audit/SIEM export ownership out of NL-10 unless NL-12 explicitly defines the handoff.

## 9. Phased Plan and Migration Counts

### Phase 0 - This PR

- Produce this design spec only.
- No code, migrations, infrastructure, frontend, or generated artifacts.
- Validation: docs diff check only.
- **Migration count:** 0.

### Phase 1 - Deployable internal Metabase embed

- Add an optional Metabase Kubernetes module adjacent to the analytics warehouse optional module.
- Configure it to connect only to warehouse `analytics_marts` as `vh_metabase`.
- Keep it unreferenced from production overlays until owner enables the warehouse and Metabase cutover.
- Use existing `metabaseService` and dashboard catalog keys for signed embeds.
- Disable or heavily restrict native SQL and broad collection access for non-platform operators.
- **Estimated migrations:** 0 to 1. Zero if dashboard IDs remain environment-driven; one if the build chooses to persist dashboard catalog/audit metadata immediately.

### Phase 2 - Governed dataset catalog

- Add catalog tables for datasets, fields, dashboards, and certification status.
- Seed existing dbt marts and dimensions as the first certified catalog entries.
- Add admin-only catalog APIs and tests.
- Add a catalog-driven layer inside `metabaseService` so embed keys, roles, datasets, and required params are not hard-coded only in env variables.
- **Estimated migrations:** 2 to 3.

### Phase 3 - Multi-tenant BI hardening

- Add `tenant_id` to every row-level or aggregate mart that will be self-serve, or create tenant-split secured views/schemas.
- Add database tests proving `vh_metabase` cannot read raw public tables and cannot cross tenant boundaries through certified datasets.
- Add Metabase provisioning logic for tenant-specific connections, roles, or collections if owner chooses multi-tenant self-serve.
- **Estimated migrations:** 1 to 3, plus dbt model changes. Exact count depends on whether the owner chooses per-tenant connections, secured views, or tenant-split marts.

### Phase 4 - Exec mobile digest

- Add digest subscription and delivery-history persistence.
- Generate digest summaries from catalog-certified aggregates.
- Deliver via notification outbox, defaulting to in-app/push.
- Add digest templates only after NL-9 signs off channel and consent posture for email or WhatsApp.
- **Estimated migrations:** 1 to 2.

### Phase 5 - Benchmark pack

- Add benchmark pack registry/export history, suppression metadata, and approval status.
- Generate internal benchmark packs first.
- Add external benchmark pack export only after owner approves the data-sharing posture.
- **Estimated migrations:** 1.

**Total expected implementation range:** 5 to 10 migrations after this docs-only PR. The next build worker must check the current migration head at implementation time and should not reserve migration numbers from this design document.

## 10. Test Strategy

### 10.1 Validation for this docs-only PR

- `git diff --check`
- No backend, admin, Flutter, dbt, or Kubernetes gates are required for this PR because it changes only one Markdown file.

### 10.2 Required future gates for implementation

**Warehouse and dbt**

- `dbt build --profiles-dir profiles` from the warehouse dbt project.
- `node apps/backend/scripts/warehouse-verify.mjs` after a live warehouse is enabled (`docs/ANALYTICS_WAREHOUSE.md:76-89`, `infra/kubernetes/optional/analytics-warehouse/README.md:95-118`).
- dbt tests that every certified self-serve dataset has either `tenant_id` or an approved aggregate classification.

**Kubernetes**

- `kustomize build infra/kubernetes/optional/analytics-warehouse`.
- `kustomize build` for the future optional Metabase module.
- A negative check that neither optional module is referenced by production base/overlay until owner enablement.

**Backend**

- Unit tests for `metabaseService` catalog lookup, signed embed params, TTL clamp, and tenant override rejection.
- Route tests proving only authorized admin roles can list or fetch embedded dashboard URLs.
- Database tests proving `vh_metabase` cannot select from raw public tables and cannot read uncataloged datasets.
- Multi-tenant negative tests proving a tenant A BI role or connection cannot query tenant B rows.
- Digest tests proving generated text contains no patient names, phone numbers, ABHA identifiers, direct patient IDs, or raw note text.

**Frontend and admin**

- Admin tests for catalog display, embedded dashboard loading states, unauthorized states, and dashboard key routing.
- Visual/manual QA that embedded dashboards render without exposing Metabase authoring controls to roles that should only view.

**Export and benchmark**

- Tests for small-cell suppression and blocked PHI fields.
- Tests that external benchmark pack generation requires approval/opt-in and persists export metadata.

## 11. Owner Decisions

1. **BI tool:** Approve Metabase as the phase-1 embedded BI tool, with Superset deferred until Metabase proves insufficient.
2. **Tenant isolation model:** Choose whether multi-tenant self-service will use per-tenant BI connections/roles, tenant-split marts, secured views, or remain single-tenant/internal only for the first release.
3. **Patient pseudonym policy:** Decide whether `patient_uid` can ever be exposed to BI authors, or whether it must stay hidden except in backend-controlled drilldowns.
4. **Native SQL policy:** Decide whether any hospital admin can use BI-native SQL. The recommended answer for phase 1 is no.
5. **Benchmark sharing:** Decide whether benchmark packs are internal-only or externally shareable, and set minimum cell thresholds before implementation.
6. **Digest channels:** Approve in-app/push as the default exec digest channel, and route email/WhatsApp decisions through NL-9 consent/template ownership.
7. **Deployment ownership:** Decide who owns Metabase backup, upgrades, sizing, secrets, and break-glass access before enabling the optional module.

## 12. Source Notes

Primary kickoff and program scope:

- `docs/superpowers/build-prompts/wave-c-nl10-kickoff.md`
- `docs/superpowers/build-prompts/_worker-common.md`
- `docs/NEXT_LEVEL_ROADMAP.md:138-143`
- `docs/NEXT_LEVEL_ROADMAP.md:220-222`
- `docs/NEXT_LEVEL_ROADMAP.md:308`
- `docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md:221`

Analytics warehouse, publication, and dbt:

- `docs/ANALYTICS_WAREHOUSE.md:3-102`
- `apps/backend/src/migrations/295_analytics_publication.sql:1-99`
- `infra/kubernetes/optional/analytics-warehouse/README.md:1-118`
- `infra/kubernetes/optional/analytics-warehouse/kustomization.yaml:1-78`
- `infra/kubernetes/optional/analytics-warehouse/warehouse-cluster.yaml:1-85`
- `infra/kubernetes/optional/analytics-warehouse/dbt-cronjob.yaml:1-48`
- `infra/kubernetes/optional/analytics-warehouse/dbt/dbt_project.yml:1-51`
- `infra/kubernetes/optional/analytics-warehouse/dbt/macros/grant_marts_read.sql:1-12`
- `infra/kubernetes/optional/analytics-warehouse/dbt/models/schema.yml:1-99`
- `infra/kubernetes/optional/analytics-warehouse/dbt/models/dims/dim_patient.sql:3-19`
- `infra/kubernetes/optional/analytics-warehouse/dbt/models/facts/fct_encounters.sql:22-72`
- `infra/kubernetes/optional/analytics-warehouse/dbt/models/facts/fct_orders.sql:6`
- `infra/kubernetes/optional/analytics-warehouse/dbt/models/facts/fct_revenue.sql:21-44`
- `infra/kubernetes/optional/analytics-warehouse/dbt/models/marts/mart_bed_flow_daily.sql:50-75`
- `infra/kubernetes/optional/analytics-warehouse/dbt/models/marts/mart_department_revenue_monthly.sql:38-53`
- `infra/kubernetes/optional/analytics-warehouse/dbt/models/marts/mart_payer_mix_monthly.sql:56-73`

Metabase seam, dashboard snapshots, and exports:

- `apps/backend/src/services/dashboards/metabaseService.js:3-123`
- `apps/backend/src/routes/dashboards/dashboardsRoutes.js:1-109`
- `apps/backend/src/migrations/157_bi_dashboards.sql:1-144`
- `apps/backend/src/services/dashboards/snapshotService.js:3-174`
- `apps/admin/src/app/(with-auth)/dashboard/reporting/page.tsx:68-129`
- `apps/admin/src/app/(with-auth)/dashboard/reporting/components/ReportsOverview.tsx:59-218`
- `apps/admin/src/app/(with-auth)/dashboard/reporting/components/DataExporter.tsx:59-210`
- `apps/backend/src/routes/appointment/appointmentAdminRoutes.js:362-440`
- `apps/backend/src/routes/record/adminRoutes.js:35-80`
- `apps/backend/src/routes/staff/hrRoutes.js:85`
- `apps/backend/src/services/department/departmentExportService.js:17-95`

Tenant isolation, read paths, and RLS:

- `docs/SYSTEM-ARCHITECTURE.md:337-345`
- `docs/SYSTEM-ARCHITECTURE.md:372-423`
- `docs/SYSTEM-ARCHITECTURE.md:467-477`
- `apps/backend/src/lib/prisma.js:423-451`
- `apps/backend/src/migrations/075_tenant_rls_policies.sql:1-69`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:5-56`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:1-64`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:245-276`
- `infra/kubernetes/base/cnpg/poolers.yaml:17-21`
- `infra/kubernetes/apps/backend/sealed-secret.yaml.example:95-96`

Notifications, digest adjacency, and AI context:

- `docs/superpowers/build-prompts/wave-c-nl9-kickoff.md:5-9`
- `apps/backend/src/utils/notifications/notificationOutbox.js:11-154`
- `apps/backend/src/utils/notifications/notificationOutboxDelivery.js:166-248`
- `apps/backend/src/utils/notifications/notificationDispatcher.js:13-250`
- `apps/backend/src/utils/notifications/tenantNotificationChannels.js:1-20`
- `apps/backend/src/utils/notifications/templates.js:3-14`
- `apps/backend/src/routes/notification/notificationRoutes.js:16-46`
- `apps/patient/lib/core/providers/notification_provider.dart:17-53`
- `apps/backend/src/services/ai/tierHOperationalService.js:1-308`
- `apps/backend/src/routes/admin/clinicalAi/tierHOperationalRoutes.js:32-113`
- `apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/coreModulePanels/TierHOperationalPanel.tsx:3-108`
- `docs/CLINICAL_AI_MODULE_INVENTORY.md:183-189`
- `apps/backend/src/services/ai/operationalAiService.js:1-269`
- `apps/backend/src/services/ai/operationalAlertService.js:18-237`
- `apps/backend/src/services/ai/operationalAlertEvaluators.js:934-954`

Real-time/admin dashboard adjacency:

- `docs/SYSTEM-ARCHITECTURE.md:182`
- `docs/superpowers/specs/2026-06-27-realtime-dashboards-beds-design.md:10-91`
- `docs/superpowers/specs/2026-06-29-realtime-dashboards-lab-design.md:6-10`
- `docs/superpowers/specs/2026-06-29-realtime-dashboards-radiology-design.md:6-10`
