# C2.1 Internal Ingress Operator Drill

**Status:** specification only — not executed by C2.1

**Repository baseline:** the approved, pinned revision containing
`docs/continuity/c2-1-private-ingress-slice-design.md`

**Purpose:** prove a separately approved private-ingress activation without
changing the public path, widening the firewall, inventing a certificate
decision, or exposing held routes.

Do not run this drill from CI. Do not run it against a live host or cluster
until every activation hold in the C2.1 design has a named owner, evidence
reference, and approval. Replace every `<...>` token in an operator-local copy;
never commit real addresses, credentials, certificate material, tokens, or
patient-bearing output.

## 1. Required approvals and abort authority

Record:

- change ID and approved maintenance window;
- operator, observer, network owner, security owner, application owner, and
  clinical continuity owner;
- the person authorized to abort and withdraw private DNS;
- the exact repository commit and prior pinned platform/apps revisions;
- C-D13 approval for hostname, certificate custody, trust, and client pins;
- network-owner approval of VIP, interface, prefix, collision check, unicast
  peers, `clinical_cidrs`, and `management_cidrs`;
- explicit tenant-host inventory;
- C2.2 staff-web artifact and browser-proof reference, if that held route is in
  scope; and
- C0.1 public-edge WAF, bot, rate-limit, and header comparison reference.

Abort before change if any item is absent, if any Argo Application is set to
automated sync, or if a requested route still targets
`nginx-internal-held`.

## 2. Evidence workspace

Create an access-controlled, non-repository evidence directory using the
organization's normal incident/change tooling. Record UTC time on every
command and redact secrets, authorization headers, cookies, patient
identifiers, request paths, and query strings.

Required files:

- `00-approvals.md`;
- `01-revision-and-render.txt`;
- `02-address-cidr-collision-ledger.md`;
- `03-certificate-and-pin-ledger.md`;
- `04-preflight-public-path.txt`;
- `05-preflight-cluster-and-argo.txt`;
- `06-host-firewall-before.txt`;
- `07-host-firewall-after.txt`;
- `08-keepalived-before.txt`;
- `09-keepalived-after.txt`;
- `10-private-route-probes.txt`;
- `11-header-and-log-redaction.txt`;
- `12-public-private-parity.md`;
- `13-vip-failover.txt`;
- `14-backend-outage-no-flap.txt`;
- `15-rejection-probes.txt`; and
- `16-rollback.txt`.

## 3. Repository and render preflight

From the pinned checkout, record without applying:

```bash
git rev-parse HEAD
git status --short
node infra/kubernetes/qa/c2-1-internal-ingress-contract.mjs
kustomize build infra/kubernetes/overlays/prod
kustomize build infra/kubernetes/apps
```

Validate the rendered outputs with strict kubeconform. Prove:

- one public and one internal ingress-nginx controller use the same approved
  image digest;
- `nginx`, `nginx-internal`, and `nginx-internal-held` map to three distinct
  controller identifiers;
- the private API ledger contains `api.vhhealth.app` plus only explicitly
  approved tenant hosts and no wildcard;
- the chosen TLS Secret has exactly one approved producer;
- every held-class route has no cert-manager or ingress-shim annotation;
- the two private Services remain `ClusterIP`;
- no `LoadBalancer`, `NodePort`, DNS object, automated sync, or unexpected
  Secret exists; and
- Harbor, Longhorn, cloudflared, and the public controller match their prior
  pinned behavior.

Abort on any difference.

## 4. Live preflight before change

Record:

```bash
kubectl get nodes -o wide
kubectl get pods -A
kubectl get ingressclass
kubectl get ingress -A
kubectl get applications.argoproj.io -n argocd
kubectl get pdb -A
```

For all four top-level Applications and the Longhorn child, record target
revision, sync status, health, and the absence of automated sync. Record public
API health, login, WebSocket, and a representative upload before any private
change. Do not place credentials or patient data in the receipt.

On every RKE2 server, record:

```bash
ip -o -4 address show
sudo nft list table inet vhhealth
sudo keepalived --config-test --config-file /etc/keepalived/keepalived.conf
sudo systemctl status keepalived --no-pager
```

The network owner must prove the proposed VIP is unused from each relevant
network and is not a DHCP reservation, node address, control-plane VIP, device
management address, or another VRRP address. Confirm the interface and actual
prefix on every node. Confirm complete, unique unicast peers and distinct
VRIDs.

## 5. Certificate and client-trust staging

Select exactly one approved C-D13 component in the operator-controlled overlay:

- operator-held TLS material; or
- cert-manager with the approved internal issuer and exact SAN ledger.

Do not select both. Do not use a wildcard with HTTP-01. Confirm the internal
API Ingress references the resulting Secret name. If HTTP-01 is selected,
prove the generated solver Ingress has the exact challenge path, solver pod,
and `nginx-internal` class; remove it after issuance.

Before routing clients, validate the complete chain and pins on every supported
Staff client family. Abort on any mismatch or unapproved root.

## 6. Serial host rollout

Update the operator-local production inventory with the approved values and
set both:

```yaml
internal_ingress_vip_enabled: true
internal_ingress_vip_firewall_guard_enabled: true
```

In the same reviewed activation overlay, replace the host-listener
NetworkPolicy's RFC 5737 TEST-NET sentinels with the exact approved
`clinical_cidrs` and `management_cidrs`. Abort if the Kubernetes and Ansible
ledgers differ.

Run the Ansible preflight in check mode and inspect the diff. Then process one
server at a time. After each server:

1. validate the rendered nftables file with `nft -c`;
2. atomically apply only `table inet vhhealth`;
3. prove the early `c2_1_internal_ingress_prerouting` chain exists;
4. prove VIP TCP 80/443 admits only approved clinical/management sources;
5. prove physical-node TCP 80/443 and direct IPv6 are rejected;
6. prove TCP 10255 is loopback-only;
7. validate the combined keepalived configuration;
8. prove both VRRP instances use their approved addresses, VRIDs, peer sets,
   priorities, and health scripts; and
9. confirm the public route remains healthy.

Never reload all peers simultaneously. Abort if the control-plane VIP moves
unexpectedly or the public route regresses.

## 7. Manual Argo sync sequence

Review the exact target revisions. Sync only the approved platform revision,
observe the internal controller on all intended nodes, then sync the approved
apps revision. Do not sync a held route. Do not enable automated sync.

Before private DNS:

- all internal-controller pods are Ready;
- host ports 80/443 are bound on each intended node;
- `curl --fail --max-time 3 http://127.0.0.1:10255/healthz` passes locally;
- the metrics Service and ServiceMonitor select only the internal controller;
- the new API route has its approved TLS Secret; and
- an unknown Host reaches the default backend rather than another service.

## 8. Private DNS and functional probes

C2.2 creates or changes private DNS only after the prior gates pass. Publish
the apex `api.vhhealth.app` split-horizon record first. Add an onboarded
`<slug>-api.vhhealth.app` only if its explicit Ingress rule, SAN, tenant
inventory, and runbook review are complete. Never publish a wildcard private
record.

From each approved clinical and management network, test with non-patient
fixtures:

- TLS SNI and chain/pin validation;
- apex health and authenticated login;
- full REST Staff surface;
- Socket.IO/WebSocket upgrade and bidirectional traffic;
- maximum-approved multipart upload and download;
- continuity endpoints;
- browser CORS preflight and credentialed request;
- original Host preservation at the backend;
- 50 MiB body, 50 connection, 600 rpm, and timeout posture;
- spoofed `Forwarded`, `X-Forwarded-For`, `X-Real-IP`,
  `X-Forwarded-Host`, `CF-Connecting-IP`, `True-Client-IP`, and
  `CF-IPCountry` values; and
- JSON access-log correlation by request ID.

The backend must observe the controller's socket peer as the source chain and
the original allowed Host. Logs must contain no raw patient path, query string,
authorization/cookie header, or body.

## 9. Rejection probes

Prove all of these fail closed:

- guest and unapproved networks to the VIP on TCP 80/443;
- direct physical-node IPv4 on TCP 80/443;
- direct IPv6 on TCP 80/443;
- non-loopback TCP 10255;
- unknown Host;
- unlisted tenant Host;
- node-IP Host;
- `admin.vhhealth.app`;
- arbitrary `*.vhhealth.app`;
- staff-web, old clinical-AI, Grafana, Argo CD, MinIO console, Metabase, and
  OHIF while they remain held; and
- a held route carrying an issuer annotation in a deliberately invalid
  repository fixture.

Expected HTTP behavior for an unrecognized Host on the admitted listener is
the controller default backend 404, not a backend response.

## 10. Parity and resilience probes

Compare public and private behavior for the same approved test identity:

- authentication and authorization;
- CORS and WebSocket behavior;
- upload/download limits;
- rate and connection controls;
- timeout behavior;
- security headers;
- audit correlation; and
- WAF/bot controls or documented compensating controls.

Repository state alone cannot pass the live public-edge comparison.

For VIP failover, withdraw or fail only the approved local listener health on
the current ingress-VIP holder. Observe one new holder within the approved
window, no duplicate advertisement, and no control-plane VIP move.

For the backend-outage proof, make the backend unavailable using the separately
approved non-patient test procedure while all three internal controllers stay
locally healthy. The API may return an upstream failure, but the ingress VIP
must not flap because backend readiness is intentionally absent from the
keepalived health script.

## 11. Acceptance

Accept only if:

- public behavior never regressed;
- every functional and rejection probe matched the contract;
- only one node advertised each VIP;
- control-plane and ingress VRRP instances remained independent;
- no held route or wildcard was exposed;
- logs were redacted;
- public/private differences have an owner-approved disposition; and
- the rollback procedure was rehearsed or observed within the change window.

## 12. Rollback

Verify the public path first. Then:

1. C2.2 withdraws every private apex and tenant DNS record;
2. wait for the approved negative-cache/TTL window and prove clients use the
   public route;
3. set `internal_ingress_vip_enabled: false` and apply serially;
4. prove no node advertises the ingress VIP;
5. prove physical-node ports 80/443 remain blocked;
6. manually sync the prior pinned apps and platform revisions;
7. remove only the unneeded private TLS material through its approved custody
   process; and
8. preserve all before/change/after evidence.

Rollback must not widen the firewall, create a wildcard, route clients to a
node address, expose a held Ingress, or point users at an unverified endpoint.
