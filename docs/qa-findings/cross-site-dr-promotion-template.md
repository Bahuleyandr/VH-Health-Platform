# Cross-Site DR Promotion Evidence - YYYY-MM-DD

## Metadata

| Field | Value |
| --- | --- |
| Drill or incident | Drill / Incident |
| Primary site | |
| DR site or cluster | |
| Replica mode | backup-fed-warm-standby / async-physical-replica / cnpg-external-cluster |
| Incident commander | |
| Clinical lead | |
| RPO/RTO approver | |
| Storage jurisdiction approved by | |
| DNS or Cloudflare failover owner | |
| Started at | |
| Traffic restored at | |

## Preflight

- [ ] `npm --prefix apps/backend run dr:cross-site:preflight -- -- --operator-ready --output <path>`
- [ ] Preflight JSON attached to the ticket.
- [ ] No blocker checks remain, or exceptions are signed below.

## Recovery Target

| Field | Value |
| --- | --- |
| Selected recovery target time | |
| Reason for target | |
| Latest safe primary baseline timestamp | |
| Achieved RPO | |
| Achieved RTO | |

## Bootstrap Or Promotion Log

```text
Paste command transcript or attach artifact path.
```

## Clinical Invariants

| ID | DR value | Baseline value | Assessment | Notes |
| --- | --- | --- | --- | --- |
| DR-INV-1 tenants count | | | PASS / FAIL | |
| DR-INV-2 finished migrations count | | | PASS / FAIL | |
| DR-INV-3 max clinical timeline timestamp | | | PASS / FAIL | |
| DR-INV-4 clinical timeline row count | | | PASS / FAIL | |
| DR-INV-5 clinical audit row count | | | PASS / FAIL | |
| DR-INV-6 admitted admissions count | | | PASS / FAIL | |
| DR-INV-7 users count | | | PASS / FAIL | |
| DR-INV-8 `/health/deep` | | | PASS / FAIL | |
| DR-INV-9 read-only clinical timeline smoke | | | PASS / FAIL | |
| DR-INV-10 RLS or PHI tenant guard evidence | | | PASS / FAIL | |

## Traffic Cutover

- [ ] Cloudflare/DNS/tunnel change approved.
- [ ] Public API smoke returned 200.
- [ ] Admin smoke returned 200.
- [ ] Staff/patient client base URL decision recorded.
- [ ] Primary site remains write-frozen or explicitly abandoned.

## Exceptions

| Exception | Approver | Expiry or follow-up |
| --- | --- | --- |
| | | |

## Downtime Reconciliation

- [ ] Paper records collected.
- [ ] Back-entry owner assigned.
- [ ] Conflict review window assigned.
- [ ] Patient-safety sign-off captured.

## Rollback Or Failback Decision

| Decision | Owner | Target date |
| --- | --- | --- |
| Remain on DR / fail back to primary / rebuild primary | | |

## Attachments

- Preflight JSON:
- Recovery command log:
- Invariant query output:
- Healthcheck output:
- Cloudflare/DNS/tunnel screenshot:
- Post-incident review:
