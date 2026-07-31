# C6.2 warm-standby promotion and asymmetric failback

**State:** held Phase 2 contract. Site-specific implementation is forbidden
until accepted Phase 1 evidence exists.

The selected topology is a CloudNativePG distributed-topology replica cluster:
asynchronous physical streaming over an approved private link supplies the
low-lag path, while the Phase 1-proven Barman archive supplies bootstrap, WAL
catch-up, PITR, and re-seed. Backup shipping alone cannot prove a seconds-level
RPO; streaming alone is not an independent recovery source.

## Activation holds

Do not resolve the held Kubernetes sentinels or run the Ansible preflight until:

- Phase 1 lock/identity/PITR evidence is accepted off-site;
- C-D1 ratifies the restore-only measurements;
- owner/legal selects the second site and jurisdiction;
- budget/procurement and the private link are approved;
- DR-site trust, secret, R2, control-plane VIP, internal-ingress VIP, DNS,
  tunnel, monitoring, and clinical drill inputs are complete; and
- the Phase 2 promotion window and C-D9 measurement method are approved.

The platform is India-first. This runbook chooses no city, operator, region,
jurisdiction, or cross-border posture.

## Site isolation

The DR site has its own RKE2 control plane, etcd quorum, Longhorn/storage
failure domain, node disks, switches, power, control-plane VIP, and internal
ingress VIP. Never stretch etcd, Longhorn replicas, local-path volumes, VRRP,
or synchronous PostgreSQL quorum across sites.

C1.2 and C2.1 are duplicated locally:

- distinct VIP addresses, interfaces, prefixes, VRIDs, unicast peers,
  certificates, firewall ledgers, and health checks;
- no VRRP packet crosses the inter-site link;
- a DNS/tunnel decision selects a site's ingress; no LAN VIP moves between
  sites; and
- the DR ingress preserves C2.1 Host, tenant, TLS/pin, sanitization, and held
  route contracts.

PostgreSQL cross-site streaming is asynchronous and private, with mutual TLS,
a dedicated replication role/certificate, exact address/port allowlists,
lag/WAL-receiver/archive/link monitoring, and a rehearsed isolation control.

## Secret and trust restoration

Git contains no cleartext secret. The DR-site inventory names each required
secret's authority, site audience, restore order, freshness, rotation,
revocation, and non-secret verification:

- database owner/migration/runtime/read-only/replication roles;
- DR reader, DR-site writer, and evidence identities;
- application encryption/signing and historical decrypt/verify generations;
- JWT, session, Firebase, FHIR/ABDM, messaging, and approved integrations;
- internal CA, current/next pins, service TLS, tunnel, and DNS credentials; and
- off-site custody references.

Do not copy the primary Sealed Secrets controller private key into DR. Reseal
for the DR site's controller. Do not copy every Secret, and do not omit a
load-bearing historical key.

## Continuity-edge source transition

The edge remains pull-only. Before traffic moves, the promoted DR application
must publish a correctly signed set for the same logical facility identity.
The DR publication endpoint then becomes the edge's pull source.

A source endpoint or TLS identity change never resets state. Each edge keeps:

- highest accepted manifest and policy versions;
- revocation epoch;
- access-revision floor;
- trusted-time floor; and
- last valid signed set.

The first DR publication must meet or exceed every persisted floor and the
approved signing/trust chain. Record old/new endpoint identities, source-switch
time, floors before/after, and first accepted DR manifest.

If neither site is reachable, the edge serves only its last valid set and only
until its signed expiry. It must not extend `fresh_until`, reset access
revision, accept rollback, or invent a local override. At expiry it stops
serving the set and raises the existing continuity alerts.

## Planned or unplanned promotion

1. Declare the incident/exercise; name incident commander and clinical lead;
   activate downtime procedure; start the end-to-end service timer.
2. Fence the primary writer. If it cannot be proven stopped or isolated,
   promotion is blocked unless incident authority explicitly accepts the
   split-brain risk.
3. Capture both sites' CNPG state, replay/flush LSNs, timestamps, lag, archive
   freshness, private-link state, and writer evidence.
4. Planned switchover: demote the old primary and bind its promotion token to
   the topology change. Unplanned failover: mark the old primary divergent and
   ineligible to rejoin.
5. Restore and verify the DR secret/trust inventory.
6. Promote CNPG and prove exactly one writable global primary, a new timeline,
   continuous archive, and no old writer.
7. Manually sync applications. Run schema changes only through the normal
   PreSync migration Job.
8. Validate readiness, authentication, WebSockets, storage, and approved
   integrations.
9. Validate tenants, finished migrations/checksums, clinical timeline and
   audit chains, active admissions, and a tenant-isolated application clinical
   read. Unexplained drift blocks traffic.
10. Produce and accept the DR continuity publication, switch the edge pull
    source, and prove persisted floors did not move backward.
11. Change approved Cloudflare tunnel/load-balancer and split-horizon DNS
    routing. Record TTL, resolver, TLS/pin, route, and rollback evidence.
12. Run external and hospital-LAN clinical reads, then the approved bounded
    write probe. Confirm one writer and canonical audit/timeline creation.
13. Stop the service timer only when the approved clinical surface is usable.
14. Record C-D9 end-to-end promotion RTO and RPO separately from C-D1's
    restore-only row and retain all receipts off-site.

Database promotion time alone is not C-D9 RTO. RPO comes from the last safe
primary point versus the promoted replay point, with LSN/WAL evidence.

## Abort and rollback

Before traffic moves, abort by leaving the primary authoritative, reversing
only reviewed DR changes, and preserving evidence. After the DR site accepts
writes, “rollback” is not a Git revert or DNS-only change. The original site
is divergent until rebuilt.

Never:

- allow two writable primaries;
- point traffic at stale original volumes;
- reuse a promotion token;
- force an edge anti-rollback reset;
- copy writer/remover/lock-admin credentials into an edge or DR reader; or
- treat a failed clinical invariant as advisory.

## Asymmetric failback

Failback is a new, separately approved exercise:

1. Keep the DR site authoritative and fence the old site.
2. Preserve incident volumes/evidence; do not reattach them as current data.
3. Create a new immutable backup and restore proof from the DR primary.
4. Rebuild the original site as a fresh replica using Barman bootstrap plus
   streaming catch-up.
5. Sustain approved lag and prove complete trust, secret, app, ingress,
   continuity-edge, migration, tenant, admission, timeline, audit, and clinical
   reads.
6. Open a new change window with explicit source/destination names.
7. Demote, transfer the new promotion token, and promote under one-writer
   proof.
8. Re-establish publication at the returned primary, switch the edge source
   without resetting floors, then change DNS/tunnel routing.
9. Repeat the clinical read/write and evidence gates.

If the original site cannot be rebuilt cleanly, DR remains primary. Time
pressure never authorizes symmetric reversal, timeline rewind, or dual primary.

Reference:

- <https://cloudnative-pg.io/documentation/current/replica_cluster/>
