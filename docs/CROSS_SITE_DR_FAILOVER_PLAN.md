# Cross-site disaster recovery — C6.2 selected posture

**Status:** C-D9 selects a warm standby; the repository contains only inert
Phase 1 resources and generic held Phase 2 templates.

The primary site's three-node HA protects against node loss, not complete site
loss. C6.2 uses two strictly ordered phases:

1. activate an approved immutable off-site database backup policy and produce
   a timed target-time restore through clinical application reads; then
2. build a continuously replicated warm standby only after that evidence is
   accepted.

Phase 1 measures restore-only RTO/RPO for C-D1. C-D9's approximately one-hour
service-restoration and seconds-of-data-loss targets apply to a separate
Phase 2 end-to-end promotion drill. A 12-hour restore-only result does not fail
C-D9; it quantifies why the standby exists. Evidence always has two rows.

## Selected architecture

The database is a CloudNativePG distributed-topology replica cluster at an
owner/legal-approved second site. It combines:

- asynchronous physical streaming over a private, mutually authenticated,
  allowlisted link; and
- the independently proven R2 Barman archive for bootstrap, catch-up, PITR,
  and re-seed.

The DR site has independent RKE2/etcd, storage, Longhorn, power, network,
control-plane VIP, and internal-ingress VIP. VRRP, etcd membership, Longhorn
replication, local-path storage, and synchronous PostgreSQL quorum remain
site-local.

C1.2 and C2.1 are duplicated per site with distinct VIPs, VRIDs, peers,
interfaces, certificates, and firewalls. DNS/tunnel routing selects a site's
ingress; no VIP moves across sites.

## Inert repository surfaces

- `infra/kubernetes/base/cnpg`: suspended timed PITR and retention-removal
  workflows, split credentials, and network policy.
- `infra/kubernetes/held/c6-2-warm-standby`: generic sentinel-only CNPG and
  network templates, unreferenced by production.
- `infra/ansible/playbooks/c6-2-dr-site-preflight.yml`: localhost-only
  check-mode assertions whose defaults fail.
- `docs/runbooks/C6_2_R2_LOCK_AND_RESTORE_DRILL.md`: Phase 1 operator contract.
- `docs/runbooks/C6_2_WARM_STANDBY_PROMOTION_FAILBACK.md`: Phase 2 promotion
  and asymmetric failback contract.

None of these provisions a site, opens replication, changes DNS/tunnel routes,
enables a bucket lock, mints credentials, applies Kubernetes, or activates
Argo sync.

## Continuity edge on site loss

After DR promotion and signature/clinical validation, the DR application
becomes the continuity-pack publication and edge pull source. A new endpoint
identity does not create a new logical facility or reset state. The edge
retains its manifest, policy, revocation, access-revision, and trusted-time
floors and rejects any rollback.

If neither site can be reached, the edge serves only its last valid signed set
and only until signed expiry. It never extends freshness or resets the access
revision.

## Decisions engineering cannot make

The second site's city/provider/jurisdiction, budget/procurement, private link,
site-specific addresses, DNS/tunnel credentials, drill window, evidence
retention, C-D1 restore-only ratification, and C-D9 promotion-target
ratification remain operator, executive, owner, privacy/legal, and security
inputs. The posture is India-first; this document makes no jurisdictional
decision.
