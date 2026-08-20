# Analytics BI (embedded Metabase) enablement runbook

How to take the dark-shipped embedded BI surface live: Metabase OSS signed
static embeds inside the admin portal's **BI Dashboards** page
(`/dashboard/dashboards`), fed by the analytics warehouse marts. Same
fail-closed pattern as every other dark gate
(see [`DARK_GATE_ENABLEMENT.md`](DARK_GATE_ENABLEMENT.md)):

```
effective = backend env (METABASE_URL + METABASE_EMBED_SECRET)
        AND tenants.settings.analyticsBi.enabled
        AND per-dashboard METABASE_DASH_* id (per-resource config layer)
```

Both AND-ed layers are visible per tenant in the SUPER_ADMIN
**Integrations & Gates** console (`/dashboard/integration-gates`) as the
`analytics_bi` row; the env facts card shows `metabase_configured` and the
count of dashboard ids present. While any layer is dark: the embed-token
endpoint (`POST /api/v1/dashboards/embed/url`) refuses — 400 for missing env,
403 `ANALYTICS_BI_TENANT_DISABLED` for a disabled tenant — and the BI
Dashboards page shows a clear "not enabled"/"not configured" state instead of
an iframe.

Resolution logic: `apps/backend/src/services/dashboards/metabaseService.js`
(`isMetabaseEnvConfigured`, `getAnalyticsBiGate`, `buildEmbedUrl`) +
`apps/backend/src/services/tenant/tenantSettingsService.js`
(`getAnalyticsBiSettings`). Catalog rows (which dashboards exist, which env
var names carry their Metabase ids, role policy) are seeded by migrations 465
and 723 into `analytics_dashboard_catalog`.

## Edition honesty — what OSS Metabase can and cannot do

The deployed module pins **open-source** `metabase/metabase:v0.50.0`
(`infra/kubernetes/optional/metabase/metabase.yaml`). Design accordingly:

| Capability | OSS (deployed) | Pro/EE only |
|---|---|---|
| Signed static embeds (what this platform uses) | yes | — |
| **Locked** embed parameters (server-signed `tenant_id` the viewer can never see or change) | yes | — |
| Enabled (viewer-editable) date/department params | yes | — |
| Per-group collection permissions for authors | yes | — |
| Interactive/full-app embedding, SSO/JWT user embedding | no | yes |
| Data sandboxing (row-level per-user) | no | yes |
| In-portal drag-and-drop dashboard authoring | no | yes |

The honest split this platform ships:

- **Viewing** happens in the admin portal via signed embeds with a locked,
  server-injected `tenant_id` (the backend rejects caller-supplied tenant
  params outright — `METABASE_TENANT_PARAM_FORBIDDEN`).
- **Authoring** happens in Metabase itself on the LAN URL. Locked embed
  params isolate *viewers*; collection permissions isolate *authors'
  dashboards* — but any OSS author with data access to `analytics_marts` can
  query other tenants' rows. Author accounts therefore stay a deliberate,
  owner-decided list (default: platform-operator-authored dashboards only,
  native SQL disabled per the module contract's
  `hospitalAdminNativeSql: forbidden`).
- If true in-portal authoring is ever demanded, swap the image to Metabase
  Pro — everything below works unchanged.

## Layers

| Layer | Setting | How |
|---|---|---|
| Backend env | `METABASE_URL`, sealed `METABASE_EMBED_SECRET`, per-dashboard `METABASE_DASH_*` ids | backend configmap + SealedSecret, ArgoCD sync |
| Admin env | `NEXT_PUBLIC_METABASE_ORIGIN` (adds `frame-src` to the admin CSP; unset ⇒ CSP unchanged and iframes stay blocked) | admin deployment env, ArgoCD sync |
| Tenant flag | `settings.analyticsBi.enabled=true` | Integrations & Gates console toggle, or `PATCH /api/v1/admin/tenants/:tenantId` |

## Bring-up sequence

1. **Warehouse first.** Enable the deploy-held
   `infra/kubernetes/optional/analytics-warehouse/` module (migrate →
   publisher-setup → subscribe → dbt CronJob) and verify replication +
   `dbt build` per [`ANALYTICS_WAREHOUSE.md`](ANALYTICS_WAREHOUSE.md). Marts
   land in `analytics_marts`, readable only by `vh_metabase`.
2. **Deploy Metabase OSS.** Enable `infra/kubernetes/optional/metabase/`
   (LAN-only ingress `analytics.vhhealth.hospital.local`, egress locked to
   its app DB + the warehouse). One-time setup with the platform-operator
   account; add a single data source: the warehouse's `analytics_marts`
   schema as `vh_metabase`. Never connect Metabase to OLTP.
3. **Enable static embedding globally.** Metabase Admin → Settings →
   Embedding → enable "Static embedding". Copy the **embedding secret key**.
4. **Author dashboards** matching the catalog keys (migrations 465 + 723):
   `daily_ops`, `patient_flow`, `theatre_utilization`, `revenue_payer_mix`,
   `orders_turnaround`, `lab_turnaround`, `pharmacy_ops`, `collections_rcm`,
   `encounter_volume`. If multi-tenant authoring is in scope, create a
   per-tenant collection + author group per the owner decision above.
5. **Per dashboard**: enable embedding ("Sharing" → "Embed"), set the
   `tenant_id` parameter to **Locked** (never "Enabled"), and mark
   date/department filters "Enabled" where viewers should filter. Publish,
   note the numeric dashboard id from the URL.
6. **Backend env**: set `METABASE_URL` (the LAN origin) and each
   `METABASE_DASH_*` id in `infra/kubernetes/apps/backend/` configmap;
   provision `METABASE_EMBED_SECRET` (step 3's key) via SealedSecret. Sync.
   A dashboard with no id stays a disabled "Config" card — ids can be rolled
   out one at a time.
7. **Admin env**: set `NEXT_PUBLIC_METABASE_ORIGIN=https://analytics.vhhealth.hospital.local`
   on the admin deployment and sync. This is what opens the admin CSP's
   `frame-src`; without it the browser blocks the iframe even with a valid
   signed URL. (Viewers' browsers must be able to reach the LAN ingress.)
8. **Flip the tenant flag**: Integrations & Gates → `Analytics BI embeds` →
   enable (writes `settings.analyticsBi.enabled=true` through the tenant
   PATCH merge).

## Verification

1. Integrations & Gates: `analytics_bi` reads `ON`; env facts show
   `metabase_configured` on with the expected dashboard-id count.
2. BI Dashboards page: gated cards read "Ready"; opening one renders the
   embed iframe. Before step 8 the page must show "Analytics embedding is
   not enabled for this hospital" (that state is the gate working).
3. Tenant lock: decode an issued embed URL's JWT (it is signed, not
   encrypted) — `params.tenant_id` is the server tenant;
   `POST /api/v1/dashboards/embed/url` with a `tenant_id` param must return
   `METABASE_TENANT_PARAM_FORBIDDEN`; in the rendered dashboard the
   `tenant_id` filter is invisible (Locked).
4. Fail-closed spot-checks: unset one env var in a staging namespace → 400;
   flag off → 403 `ANALYTICS_BI_TENANT_DISABLED`; a catalog row whose
   `METABASE_DASH_*` id is unset → "Config" card and
   `Dashboard ... has no metabase_id configured` on direct POST.

## Operations notes

- **TTLs**: embed URLs expire (default 600 s, clamped 60 s–24 h); the page
  requests 1800 s. Re-opening a dashboard mints a fresh token.
- **Replication slot pager**: the warehouse module ships
  `slot-alerts.yaml` — an inactive logical slot pages before WAL fills the
  primary. Do not disable it while the warehouse is subscribed.
- **Teardown**: flag off per tenant (instant 403), or remove
  `NEXT_PUBLIC_METABASE_ORIGIN` (CSP re-blocks frames), or scale the
  Metabase Deployment to 0. The catalog rows and env registrations are
  harmless at rest.
