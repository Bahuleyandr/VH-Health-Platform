# Zero-Trust Network And Cloudflare Access Pack

Status: NL12-S9 build artifact. Operator application is held until the coordinator approves the Cloudflare Access policy and tenant group mapping.

## Scope

This pack adds the repo-owned control plane for:

- Cloudflare Access policy-as-code at `infra/cloudflare/access/vhhealth-access-policy.json`.
- IdP group mapping for super admins, tenant admins, clinical leads, and break-glass responders.
- Default-deny and workload-selected NetworkPolicy evidence.
- Optional per-tenant namespace NetworkPolicy boundaries for tenant-owned workers or connectors.
- A Cilium L7 migration plan only. The current RKE2 CNI remains `canal`.

No database migration, CNI migration, DNS change, or live Cloudflare Access activation is part of this slice.

## Cloudflare Access Policy

The policy pack is declarative JSON so it can be reviewed, diffed, and translated by the operator into Cloudflare Terraform or API calls without storing account IDs or IdP IDs in git.

Required operator inputs:

| Reference | Meaning |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account that owns `vhhealth.app`. |
| `CF_ACCESS_IDP_WORKFORCE_ID` | Cloudflare Access IdP ID for the hospital workforce IdP. |
| `vh-super-admins`, `vh-admins`, `vh-clinical-leads`, `vh-break-glass` | IdP group names or aliases mapped to Access groups. |

Policy intent:

| Application | Host/path | Allowed groups | Default |
|---|---|---|---|
| Admin portal | `admin.vhhealth.app/*` | Super admins, tenant admins, break-glass | Deny unmatched users. |
| API admin paths | `api.vhhealth.app/api/v1/admin/*`, `/system/*`, `/quality/*` | Super admins, tenant admins, break-glass | Deny unmatched users. |
| Tenant API wildcard | `*.vhhealth.app/api/v1/*` except apex API/admin hosts | Super admins, tenant admins, clinical leads, break-glass | Deny unmatched users. |

Cloudflare Access is an edge gate. It does not replace VH Health JWT validation, `wrapAutoRBAC`, tenant RLS, Host-to-token tenant binding, or break-glass audit logging.

## NetworkPolicy Evidence

Local static checks:

```bash
node scripts/check-zero-trust-network-pack.mjs
node scripts/validate-kubernetes-manifests.mjs
```

Operator live evidence after sync:

```bash
kubectl get networkpolicy -A
kubectl -n vhhealth-platform describe networkpolicy allow-backend-to-cnpg
kubectl -n vhhealth-platform describe networkpolicy vhhealth-pg-rw-pooler
kubectl -n vhhealth-platform describe networkpolicy redis-allow-app-ingress
kubectl -n vhhealth-platform describe networkpolicy minio-allow-cluster-access
```

Expected posture:

- Every `vhhealth-*` namespace has a default-deny ingress and egress policy.
- CNPG ingress from the app namespace is limited to `vhhealth-backend`, `vhhealth-backend-migrate`, and `ward-downtime-packs` on TCP 5432.
- The PgBouncer pooler is selected by `cnpg.io/poolerName`, not `cnpg.io/cluster`, and carries its own policy: the same three app-namespace clients in on TCP 5432, and out only to the CNPG pods on TCP 5432 plus the private-range Kubernetes API on TCP 443. Reachability is not adoption — the runtime DSN still points at the CNPG primary service, and moving it is an operator action (`docs/PRODUCTION_DB_HARDENING.md`).
- Redis ingress from the app namespace is limited to `vhhealth-backend` and `vhhealth-admin` on TCP 6379 and 26379.
- MinIO API ingress from the app namespace is limited to `vhhealth-backend`, `vhhealth-backend-r2-sync`, and `ward-downtime-packs` on TCP 9000.
- Optional tenant namespaces start default-deny and opt pods into edge ingress, backend API egress, or monitoring through labels.

## Per-Tenant Boundary

The optional tenant boundary lives at `infra/kubernetes/optional/tenant-network-boundary/`. It is deliberately not referenced by `infra/kubernetes/base/kustomization.yaml`.

Use it when a tenant needs isolated tenant-owned workers, connectors, or edge services outside the shared `vhhealth` app namespace:

1. Copy the optional directory for the tenant.
2. Replace `vhhealth-tenant-example` and `vhhealth.app/tenant-slug: example` with the approved tenant slug.
3. Label only the pods that need an edge listener with `vhhealth.app/network-exposure=edge`.
4. Label only the pods that need backend API egress with `vhhealth.app/needs-backend-api=true`.
5. Keep all other pods default-denied unless a reviewed NetworkPolicy grants a narrow path.

Under canal this is L3/L4 isolation. It cannot enforce tenant identity by HTTP Host header.

## Cilium L7 Migration Plan

Cilium L7 is deferred to a later operator-approved migration. This slice only records the plan:

1. Build a staging cluster from the same Ansible inventory with `rke2_cni: cilium`; do not mutate production in place.
2. Render and apply the current NetworkPolicy set first, then prove parity with the default-deny evidence above.
3. Add candidate `CiliumNetworkPolicy` resources in a non-base branch for HTTP host/path checks on `admin.vhhealth.app`, `api.vhhealth.app`, and `*.vhhealth.app`.
4. Prove DNS/FQDN egress policy for Cloudflare, R2, Firebase, and approved telemetry endpoints without broad private-range leakage.
5. Run rollback drills: restore canal cluster from backup, redeploy the current NetworkPolicy base, and verify API/admin health.
6. Only after staging parity, live evidence, and rollback proof should the coordinator schedule production CNI migration.

Until that migration lands, do not commit Cilium CRDs into the root base and do not claim L7 enforcement.
