# C6.2 warm-standby promotion and failback evidence

**Run ID:**

**Incident/exercise:**

**Source commit/render SHA-256:**

**Primary site identity:**

**DR site decision/jurisdiction references:**

**Promotion mode:** planned switchover / unplanned failover

**Evidence object URI/SHA-256/readback:**

## Objective measurements — keep both rows

| Scenario | Target | Measured RTO | Measured RPO | Authority | Ratification |
| --- | --- | --- | --- | --- | --- |
| Immutable-backup restore-only | Previously measured and ratified Phase 1 result | | | C-D1 | |
| Warm-standby end-to-end promotion | Approximately one hour to restored service; seconds of data loss | | | C-D9 | |

Never overwrite the C-D1 row with promotion numbers or use its measurements to
claim that C-D9 passed or failed.

## Phase 1 and owner gates

- [ ] Accepted Phase 1 evidence ID and digest attached.
- [ ] C-D1 restore-only ratification attached.
- [ ] Site selection and owner/legal jurisdiction decision attached.
- [ ] Budget/procurement and private-link approvals attached.
- [ ] Promotion drill window approved.
- [ ] C-D9 measurement/ratification owner named.

## Fencing and database

| Check | Before | After | Pass/evidence |
| --- | --- | --- | --- |
| Old primary writer fenced | | | |
| Primary/DR flush and replay LSNs | | | |
| Archive/WAL freshness | | | |
| Promotion token or unplanned-failover record | | | |
| Exactly one writable global primary | | | |
| New timeline and archive continuity | | | |

## Site, secrets, and traffic

- [ ] DR RKE2/etcd/Longhorn failure domain is independent.
- [ ] Site-local control-plane and ingress VIPs are distinct.
- [ ] No etcd, VRRP, Longhorn, local-path, or sync quorum is stretched.
- [ ] Required secret/trust inventory restored and verified.
- [ ] DR reader and DR-site writer are separate; no remover/lock-admin copied.
- [ ] Private-link allowlists and mutual TLS verified.
- [ ] Tunnel/load-balancer and split-horizon DNS receipts attached.

## Continuity-edge source transition

| Field | Value |
| --- | --- |
| Old publication/pull source identity | |
| New DR publication/pull source identity | |
| Source-switch time | |
| Manifest floor before/after | |
| Policy floor before/after | |
| Revocation floor before/after | |
| Access-revision floor before/after | |
| Trusted-time floor before/after | |
| First accepted DR manifest/hash | |
| Last-valid-set serving interval, if any | |
| Signed expiry behavior verified | |

- [ ] No floor reset occurred when endpoint/TLS identity changed.
- [ ] An edge unable to reach either site served only its last valid set.
- [ ] The set stopped serving at signed expiry; freshness was not extended.

## Application and clinical invariants

| Invariant | Approved baseline | Result | Pass |
| --- | --- | --- | --- |
| Finished migration set/checksums | | | |
| Tenant identities/count | | | |
| Active admissions/census | | | |
| Canonical clinical timeline count/max time/chain | | | |
| Clinical audit count/max time/chain | | | |
| Tenant-isolated application clinical read | | | |
| Approved bounded write creates timeline and audit | | | |
| Authentication/WebSockets/object storage/integrations | | | |

## End-to-end timing

| Event | UTC time/LSN |
| --- | --- |
| Incident declared/service timer started | |
| Primary fenced | |
| DR promoted | |
| Secrets/apps ready | |
| Edge accepted DR publication | |
| DNS/tunnel route changed | |
| Clinical surface usable/service timer stopped | |
| Last safe primary point | |
| Promoted replay point | |

## Failback — separate asymmetric exercise

- [ ] Former primary remained fenced and incident volumes preserved.
- [ ] New backup/restore proof was created from the DR primary.
- [ ] Original site was rebuilt as a fresh replica; old volumes were not
  reattached as authoritative.
- [ ] Sustained lag and all secret/app/clinical/edge gates passed.
- [ ] New change window and direction-specific promotion token recorded.
- [ ] Edge source returned without resetting anti-rollback floors.
- [ ] Exactly one writer remained after cutback.

If the original site cannot be rebuilt cleanly, DR remains primary.

## Approvals

| Role | Name/reference | Time | Decision |
| --- | --- | --- | --- |
| Incident commander | | | |
| Clinical lead | | | |
| Database owner | | | |
| Infrastructure/network | | | |
| Security | | | |
| Privacy/legal | | | |
| C-D9 accountable owner | | | |
