# C2.1 Private Ingress and Address Slice Design

**Status:** coordinator-cleared implementation delta

**Clearance date:** 2026-07-29

**Implementation baseline:** `github/main` at
`ed5167385d44853b4f0adae497a62c92418340de`, fetched and pinned on 2026-07-30

**Scope:** `infra/kubernetes`, `infra/ansible`, and `docs` only. This slice has
no application-code, backend, database-migration, DNS-record, certificate-
issuance, real-secret, live-host, live-cluster, Argo-sync, deployment, or
fault-injection action.

**Authority:** the C2 tranche in
[`docs/superpowers/specs/2026-07-28-clinical-service-continuity-design.md`](../superpowers/specs/2026-07-28-clinical-service-continuity-design.md),
the C2.1 execution plan in
[`docs/superpowers/plans/2026-07-28-clinical-service-continuity.md`](../superpowers/plans/2026-07-28-clinical-service-continuity.md),
and the coordinator-cleared C2.1 Step-1 delta dated 2026-07-29.

## 1. Outcome and activation boundary

C2.1 supplies an inert, fail-closed repository definition for a second,
independent ingress-nginx controller and a redundant hospital-LAN virtual IP.
It creates the future private route to the existing backend without changing
the public route or claiming that the route is ready for clinical use.

Everything lands inert:

- all four top-level production Argo CD Applications remain manual-sync;
- the Longhorn child Application remains manual-sync;
- no Kubernetes manifest is applied or synced;
- the internal-ingress VIP defaults disabled and addressless;
- no production inventory supplies an activation value;
- no DNS record, `LoadBalancer`, `NodePort`, or automated-sync path is added;
- the active internal API Ingress references a parameterized TLS secret, but
  the default production render supplies neither that Secret nor a
  `Certificate`;
- both certificate approaches are unreferenced Kustomize components;
- held routes use an unimplemented controller identifier and therefore cannot
  be claimed by either active controller; and
- no operator drill, network change, certificate issuance, or live comparison
  is executed by repository validation.

This slice does not resolve the owner decisions and evidence that gate
activation. It records them as holds.

## 2. Independent internal ingress controller

The internal controller is a second ingress-nginx `DaemonSet`, not another
class watched by the public controller. It uses the same digest-pinned image as
the public controller:

`registry.k8s.io/ingress-nginx/controller:v1.11.3@sha256:d56f135b6462cfc476447cfe564b83a45e8bb7da2774963b00d12161112270b7`

Its identities are wholly independent:

- ServiceAccount `ingress-nginx-internal`;
- ClusterRole and ClusterRoleBinding `ingress-nginx-internal`;
- Role and RoleBinding `ingress-nginx-internal`;
- ConfigMap `ingress-nginx-internal-controller`;
- Service `ingress-nginx-internal-controller`;
- metrics Service `ingress-nginx-internal-controller-metrics`;
- ServiceMonitor `ingress-nginx-internal`;
- PodDisruptionBudget `ingress-nginx-internal-controller`;
- leader election ID `ingress-nginx-internal-leader`;
- controller class `k8s.io/ingress-nginx-internal`; and
- labels with `app.kubernetes.io/instance: ingress-nginx-internal`.

The controller explicitly sets:

- `--ingress-class=nginx-internal`;
- `--watch-ingress-without-class=false`;
- `--update-status=false`; and
- metrics enabled on container port 10254.

Status updates are disabled because private DNS and address publication are
operator-owned C2.2 state, not controller-owned state.

The existing public controller has admission-webhook arguments and a mounted
certificate volume but no committed `ValidatingWebhookConfiguration`. C2.1
does not copy that partial identity and does not alter, complete, or remove it.
The only public manifest change is extracting the existing `nginx-internal`
IngressClass into the new internal base.

The new base owns two classes:

- `nginx-internal`, whose controller is `k8s.io/ingress-nginx-internal`; and
- `nginx-internal-held`, whose controller is
  `vhhealth.io/ingress-nginx-internal-held-unimplemented`.

The held class is deliberately unimplemented. It is a repository-visible
quarantine state, not an alternate route.

## 3. LAN listener and keepalived mechanism

The LAN mechanism is keepalived unicast VRRP. MetalLB is not introduced.

Each internal-controller pod binds:

- host TCP 80 to controller TCP 80;
- host TCP 443 to controller TCP 443; and
- host TCP 10255 to controller TCP 10254.

Port 10255 exists only for the node-local keepalived health check and
monitoring policy. Host firewall rules keep it loopback-only.

The C1.2 `control_plane_vip` role renders one validated
`/etc/keepalived/keepalived.conf` containing two independent VRRP instances
when both are enabled:

- `VI_RKE2_CONTROL_PLANE`, unchanged from C1.2; and
- `VI_VHHEALTH_INTERNAL_INGRESS`, enabled only when
  `internal_ingress_vip_enabled=true`.

The ingress instance has a separate address, interface, prefix, unicast source
and peer set, virtual-router ID, priority range, advert interval, health
script, fall/rise hysteresis, and state. All peers start `BACKUP`, use stable
hostname ordering, and retain `nopreempt`.

The ingress health script uses strict timeouts and checks only local listener
readiness:

- TCP 80 on `127.0.0.1`;
- TCP 443 on `127.0.0.1`; and
- HTTP `GET /healthz` on `127.0.0.1:10255`.

Backend readiness is deliberately excluded. Moving the VIP between nodes
during a backend outage would add churn while every node is equally affected.

The role rejects an enabled ingress VIP when any of these is true:

- the address, interface, source address, peer set, or approved client CIDRs
  are empty or invalid;
- the VIP equals a node-owned address, a declared peer address, or the
  control-plane VIP;
- the VIP is outside the selected interface subnet;
- the selected interface does not own the declared unicast source or its
  actual prefix differs from the declared prefix;
- the ingress VRID equals the control-plane VRID;
- a peer address is missing, duplicated, off-subnet, or not represented
  exactly once;
- the effective priority falls outside 1 through 254;
- `clinical_cidrs` or `management_cidrs` are empty, malformed, or not
  sequences; or
- `internal_ingress_vip_firewall_guard_enabled` is not true.

All ingress-VIP defaults are disabled and addressless. Repository authors do
not invent a production VIP. Network owners must supply a collision-checked
address, interface, prefix, peer ledger, and approved client CIDRs before any
activation attempt.

## 4. Host firewall and Kubernetes network policy

The Ansible firewall continues to atomically replace only the
`inet vhhealth` table. It never flushes the global ruleset or tables owned by
kube-proxy or the CNI.

When the internal VIP is enabled, nftables:

- creates explicit sets for clinical, management, cluster, and ingress-VRRP
  peer IPv4 ranges or addresses;
- permits VIP-destination TCP 80 and 443 only on the declared LAN interface
  from approved `clinical_cidrs` and `management_cidrs`;
- rejects TCP 80 and 443 addressed to physical node IPv4 addresses;
- rejects other, guest, and external sources to the VIP listener ports;
- rejects direct IPv6 access to TCP 80 and 443 until an approved AAAA
  contract exists;
- permits VRRP protocol 112 only on the declared interface and only between
  the declared ingress peers;
- permits the health endpoint only over loopback; and
- applies an early `prerouting` guard so hostPort destination NAT cannot
  bypass an input-chain-only decision.

The guard is fail-closed: enabling the ingress VIP without its firewall guard
is invalid.

Kubernetes NetworkPolicies separate the two controller identities:

- cloudflared may reach only the public controller on TCP 80 and 443;
- the public controller retains only the destinations required by existing
  public routes;
- the internal controller may egress only to the backend, the later staff-web
  target, DNS, monitoring, and cert-manager HTTP-01 solver pods;
- monitoring may reach only the internal controller metrics port;
- host traffic to the internal controller has an explicit fail-closed policy
  in addition to nftables; and
- backend ingress names both controller identities explicitly instead of
  admitting the entire ingress namespace.

Canal provides L3/L4 NetworkPolicy enforcement. The host firewall remains the
authoritative LAN source and destination guard for hostPorts.

## 5. Routing and tenant-host contract

The new `infra/kubernetes/apps/backend/ingress-internal-api.yaml` is not a
clone of the public wildcard Ingress. Its initial ledger contains exactly:

- host `api.vhhealth.app`;
- path `/` with `Prefix` semantics;
- backend Service `vhhealth-backend`; and
- the full Staff-facing surface, including REST, health, continuity,
  upload/download, and Socket.IO/WebSocket paths.

No wildcard `*.vhhealth.app` rule exists on the internal controller.

The coordinator condition is that the initial ledger ships the apex API host
only. Each onboarded `<slug>-api.vhhealth.app` host is added later as an
explicit, reviewed rule through the tenant-onboarding runbook. Unknown Host
values, unlisted tenants, node-IP Host values, `admin.vhhealth.app`, and
arbitrary `*.vhhealth.app` names fall through to the controller default
backend and return 404.

The internal route has no rewrite, upstream-vhost, or Host-replacement
annotation. TLS SNI terminates at the internal controller. The original Host
and scheme reach the backend unchanged, preserving the W4 trust-by-topology
tenant contract.

## 6. Staff-web quarantine

`clinical.vhhealth.hospital.local` remains the staff SPA identity. It is not an
API hostname.

The staff-web Ingress and the old partial clinical-AI Ingress move to
`nginx-internal-held`. Their issuer and ingress-shim annotations are removed.
They do not receive a route or request a certificate.

This hold is required because the production staff-web artifact currently
bakes:

`VH_BASE_URL=https://clinical.vhhealth.hospital.local`

It omits `/api/v1`. Activation waits for the C2.2 artifact correction plus
browser proof covering CORS, WebSocket, login, upload, and tenant behavior.

## 7. Header, TLS, logging, and public-edge parity contract

The internal controller does not trust inbound forwarding identity:

- `use-forwarded-headers=false`;
- `compute-full-forwarded-for=false`;
- proxy protocol disabled;
- real-IP rewriting disabled; and
- inbound `Forwarded`, `X-Forwarded-For`, `X-Real-IP`,
  `X-Forwarded-Host`, `CF-Connecting-IP`, `True-Client-IP`,
  `CF-IPCountry`, and equivalent client-identity headers are cleared.

It regenerates `X-Forwarded-For` from the observed source and preserves the
original Host and scheme. Snippet annotations remain disabled.

The controller permits TLS 1.2 and 1.3 with a committed cipher posture. The
active internal API route matches the public API's:

- 50 MiB request-body limit;
- 50 connections per source;
- 600 requests per minute; and
- 10-second connect and 60-second read/send timeouts.

JSON access logs contain request ID, observed source IP, Host, method, status,
bytes, and timing. They exclude request and response bodies, authorization and
cookie headers, query strings, and raw patient paths.

Repository state cannot prove parity with live Cloudflare WAF, bot, rate-
limiting, or other public-edge controls. A C0.1/network-owner live comparison
is an activation hold, not a claim made by this slice.

## 8. Certificate options remain unselected

The active internal API Ingress references a parameterized TLS Secret name.
The default production render creates neither the Secret nor a `Certificate`.

Two unreferenced Kustomize components document the C-D13 options:

- `tls/operator-held`: a SealedSecret example with no real ciphertext; and
- `tls/step-ca`: a cert-manager `Certificate` with exact API SANs, a
  configurable issuer, and no wildcard-with-HTTP-01 configuration.

Neither component is selected by the base or an overlay. C-D13 remains a
security-owner decision through C0.4.

The internal controller may claim generated `cm-acme-http-solver-*` Ingresses
only for the exact ACME challenge path and solver pod. Repository validation
does not issue a certificate.

## 9. Adoption matrix

| Surface | C2.1 class | Certificate behavior |
|---|---|---|
| New apex internal API Ingress | `nginx-internal` | References parameterized Secret; no default producer |
| Future reviewed tenant API hosts | `nginx-internal` | Added explicitly by onboarding change |
| HTTP-01 solver Ingress | `nginx-internal`, conditional | Exact challenge path and solver pod only |
| Old clinical-AI Ingress | `nginx-internal-held` | Issuer annotations removed |
| Staff-web Ingress | `nginx-internal-held` | Issuer annotations removed |
| Grafana | `nginx-internal-held` | Issuer annotations removed |
| Argo CD | `nginx-internal-held` | Issuer annotations removed |
| MinIO console | `nginx-internal-held` | Issuer annotations removed |
| Optional Metabase | `nginx-internal-held` | Issuer annotations removed |
| Optional OHIF | `nginx-internal-held` | Issuer annotations removed |
| Harbor | Public `nginx` unchanged | Existing behavior unchanged |
| Longhorn | Public `nginx` unchanged | Existing behavior unchanged |

A contract test rejects every held-class Ingress that carries any
cert-manager or ingress-shim annotation.

## 10. Repository ledger

### Add

- `infra/kubernetes/base/ingress-nginx-internal/kustomization.yaml`;
- `infra/kubernetes/base/ingress-nginx-internal/controller.yaml`;
- `infra/kubernetes/base/ingress-nginx-internal/network-policy.yaml`;
- `infra/kubernetes/base/ingress-nginx-internal/tls/step-ca/kustomization.yaml`;
- `infra/kubernetes/base/ingress-nginx-internal/tls/step-ca/certificate.yaml`;
- `infra/kubernetes/base/ingress-nginx-internal/tls/operator-held/kustomization.yaml`;
- `infra/kubernetes/base/ingress-nginx-internal/tls/operator-held/internal-api-tls.sealed-secret.yaml.example`;
- `infra/kubernetes/apps/backend/ingress-internal-api.yaml`;
- `infra/kubernetes/qa/c2-1-internal-ingress-contract.mjs`;
- `infra/ansible/roles/control_plane_vip/templates/check-internal-ingress.sh.j2`;
- `infra/ansible/tests/c2_1_contract.yml`;
- `docs/continuity/c2-1-private-ingress-slice-design.md`; and
- `docs/runbooks/C2_1_INTERNAL_INGRESS_DRILL.md`.

### Modify

- `infra/kubernetes/base/kustomization.yaml`;
- `infra/kubernetes/base/ingress-nginx/ingress-nginx.yaml`, class extraction
  only;
- `infra/kubernetes/base/_common/network-policies.yaml`;
- `infra/kubernetes/apps/backend/kustomization.yaml`;
- `infra/kubernetes/apps/backend/network-policy.yaml`;
- `infra/kubernetes/apps/backend/ingress-clinical-internal.yaml`;
- `infra/kubernetes/apps/staff-web/ingress.yaml`;
- `infra/kubernetes/base/minio/tenant.yaml`;
- `infra/kubernetes/base/monitoring/kube-prometheus-values.yaml`;
- `infra/kubernetes/base/argocd/argocd-values.yaml`;
- `infra/kubernetes/optional/metabase/metabase.yaml`;
- `infra/kubernetes/optional/pacs/ohif.yaml`;
- `infra/ansible/inventories/group_vars/all/main.yml`;
- `infra/ansible/inventories/prod.yml.example`;
- `infra/ansible/inventories/dev.yml`;
- `infra/ansible/playbooks/site.yml`;
- `infra/ansible/playbooks/disaster-recover.yml`;
- `infra/ansible/roles/control_plane_vip/defaults/main.yml`;
- `infra/ansible/roles/control_plane_vip/tasks/main.yml`;
- `infra/ansible/roles/control_plane_vip/templates/keepalived.conf.j2`;
- `infra/ansible/roles/firewall/defaults/main.yml`;
- `infra/ansible/roles/firewall/templates/nftables.conf.j2`;
- `infra/ansible/.ansible-lint`;
- `infra/ansible/README.md`;
- `docs/DEPLOYMENT_GUIDE.md`;
- `docs/TENANT_ONBOARDING_RUNBOOK.md`; and
- `docs/continuity/c1-2-control-plane-slice-design.md`.

Cleanup riders:

- `disaster-recover.yml` must require exactly one explicitly declared
  `rke2_bootstrap: true` host and must not fall back to the first server; and
- `.ansible-lint` must replace the stale bootstrap-token justification with
  wording that matches the current token-custody implementation.

## 11. Validation and receipt contract

Repository validation retains receipts for:

- `git diff --check`;
- `ansible-lint`;
- production-example and development inventory parsing;
- `site.yml` and `disaster-recover.yml` syntax checks;
- a three-node combined keepalived render with distinct VIP, VRID, instance,
  peer, priority, and health-script assertions;
- disabled ingress-VIP rendering;
- invalid collision, missing guard, malformed CIDR, duplicate peer,
  off-subnet, interface, and prefix negatives;
- `shellcheck` for both keepalived health scripts;
- production platform and application renders;
- strict `kubeconform`;
- exact controller digest, identity, Lease, RBAC, hostPort, class-isolation,
  and watch-flag assertions;
- exactly one public and one internal active controller, with neither claiming
  the other's class;
- all four Argo Applications and the Longhorn child remaining manual-sync;
- no wildcard internal API rule;
- every non-approved internal Ingress on the held class;
- no held-class issuer or ingress-shim annotation;
- no real Secret, default Certificate, DNS record, `LoadBalancer`, `NodePort`,
  automated sync, or activation value;
- zero public-path behavior change beyond class extraction; and
- `node scripts/ci/run.mjs --only=infra`.

The operator drill specifies, but repository validation does not execute:

- preflight evidence capture;
- network-owner address and CIDR confirmation;
- certificate-option approval and material staging;
- one-node-at-a-time firewall and keepalived rollout;
- manual Argo sync sequencing;
- listener, default-404, Host-preservation, WebSocket, upload, login, CORS,
  rate-limit, header-spoofing, and log-redaction probes;
- public/private parity comparison;
- VIP holder and failover observation;
- backend-outage no-flap proof;
- unknown, guest, node-address, direct-IPv6, and held-route rejection; and
- rollback rehearsal with evidence preservation.

## 12. Rollback

Before activation, rollback is a repository revert. Manual-sync state keeps the
committed delta inert.

After a separately approved activation:

1. verify the public path first;
2. require C2.2 to withdraw private DNS;
3. disable the ingress VIP serially;
4. prove that no node advertises the VIP and physical-node listener ports
   remain blocked;
5. manually sync the prior pinned Argo revisions; and
6. preserve preflight, change, verification, and rollback evidence.

Rollback never widens the firewall, points clients at an unverified endpoint,
restores wildcard internal routing, or exposes held Ingresses.

## 13. Activation holds

C2.1 records and does not resolve:

- C-D13 security-owner choice of hostname, certificate, pin, and trust
  boundary;
- network-owner VIP, interface, prefix, collision check, peer, and clinical/
  management CIDR ledger;
- reviewed tenant-host inventory;
- the C2.2 staff-web `/api/v1` artifact correction and browser proof; and
- the C0.1 live public-edge WAF/bot/rate-limit comparison.

No route is production-open until every applicable hold is resolved by its
named owner and the operator drill has passed against approved values.
