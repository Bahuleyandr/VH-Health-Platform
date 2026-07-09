# Cross-Site DR Replica And Failover Plan

**Status:** NL12-S7 design and preflight package. No site, budget, DNS, or RPO/RTO
owner decision is assumed by this document.

This plan extends the existing PITR restore drill in
[`DR_RESTORE_DRILL.md`](DR_RESTORE_DRILL.md). In-cluster CNPG replicas are still
high availability only; cross-site disaster recovery starts when an approved
secondary site can recover or promote the database, application secrets, object
storage access, and clinical safety evidence outside the primary site.

## Boundaries

- Buildable here: cross-site architecture, promotion runbook deltas, evidence
  template, readiness preflight, and clinical invariant checklist.
- Operator-owned: DR site or cluster, private network path, budget, RPO/RTO
  approver, storage jurisdiction, backup reader secret, DNS or Cloudflare
  cutover authority, and the first timed drill window.
- Not included: a live DR cluster manifest, a site-specific overlay, a DNS flip,
  a Cloudflare Access policy, real failover execution, or a database migration.
- Patient safety rule: every promotion must prove clinical timeline, audit,
  admissions, tenants, and migration invariants before traffic returns.

## Current Substrate

| Layer | Existing substrate | Cross-site requirement |
| --- | --- | --- |
| Database | CNPG PostgreSQL 17 with in-cluster replicas, WAL archive, base backups, and PITR drill template. | Secondary site must recover from the approved backup chain or promote an approved replica without using the primary site's storage layer. |
| Backups | R2-backed WAL/base backup hardening and verification jobs. | Operator must approve storage jurisdiction, lifecycle/versioning, and read-only DR credentials. |
| Application | Backend/admin/staff/patient are GitOps-controlled with Sealed Secrets. | DR site needs sealed secrets generated for that site's namespace and endpoint names. Plain secrets stay out of git. |
| Traffic | Cloudflare Tunnel to the primary cluster, no inbound hospital firewall ports. | Failover authority must decide the DR hostname path: tunnel swap, DNS change, or Cloudflare load-balancer pool. |
| Safety evidence | `DR_RESTORE_DRILL.md` has RPO/RTO and clinical invariant evidence. | Cross-site promotion adds network, DNS, secret, object-store, and post-promotion clinical checks. |

## Architecture

The cross-site design is a two-track posture until the operator chooses the real
site:

1. **Backup-fed warm standby.** The DR site can bootstrap CNPG from the approved
   R2 backup chain with a read-only DR key. This is the default design because it
   does not require a permanent database stream across hospitals or regions.
2. **Operator-approved replica.** If a private link, bandwidth budget, and
   jurisdiction review are approved, the operator may add asynchronous physical
   replication or a CNPG external cluster path. That mode must still preserve the
   R2 PITR chain as the fallback.

Both tracks keep the primary source of truth in git and the object store. The
secondary site must not share the primary site's Longhorn volumes, local-path
storage, node disks, or etcd snapshots as its only recovery source.

```text
Primary site                         Approved DR site
------------                         ----------------
CNPG primary + HA replicas           CNPG warm standby or approved replica
WAL/base backup archive  ----------> R2 read-only restore path
Sealed Secrets in primary ns         Site-specific Sealed Secrets
Cloudflare tunnel / DNS              Operator-approved failover endpoint
Backend/admin clients                Backend/admin smoke after promotion
```

## Readiness Preflight

Run the repository package check before a PR, tabletop, or drill:

```bash
npm --prefix apps/backend run dr:cross-site:preflight
```

Run the stricter operator-readiness gate only after the owner fields are known:

```bash
DR_SITE_NAME=<approved-site-or-cluster> \
DR_NETWORK_PATH=<private-link-or-approved-egress> \
DR_STORAGE_JURISDICTION=<approved-region-or-on-prem> \
DR_RPO_RTO_APPROVER=<name-or-ticket> \
DR_DNS_FAILOVER_OWNER=<name-or-team> \
DR_REPLICA_MODE=<backup-fed-warm-standby|async-physical-replica|cnpg-external-cluster> \
DR_DRILL_WINDOW=<approved-window> \
DR_BACKUP_READER_SECRET_REF=<secret-ref-not-secret-value> \
npm --prefix apps/backend run dr:cross-site:preflight -- -- --operator-ready \
  --output output/dr-cross-site/preflight.json
```

The script is read-only. It checks that the DR package is linked, that required
docs and templates exist, and that operator-controlled fields are present when
`--operator-ready` is supplied. It never prints secret values.

## Promotion Runbook Deltas

Use `DR_RESTORE_DRILL.md` for the PITR mechanics. Add these deltas for a
cross-site promotion:

1. Declare site-disaster severity and switch wards to
   [`DOWNTIME_PROCEDURE.md`](DOWNTIME_PROCEDURE.md).
2. Confirm primary site recovery is not faster or safer than DR promotion.
3. Freeze writes at the primary if any control-plane path remains reachable.
4. Run `dr:cross-site:preflight -- --operator-ready` and attach the JSON report
   to the incident.
5. Select recovery target time and record the RPO/RTO approver.
6. Bootstrap or promote the DR database using the approved replica mode.
7. Apply pending migrations only through the normal backend migrate job. Do not
   hand-edit the database during promotion.
8. Run the clinical invariant checklist below before any traffic cutover.
9. Cut over the approved Cloudflare/DNS/tunnel endpoint.
10. Smoke `/health`, `/health/deep`, backend auth, admin login, and one
    read-only clinical timeline query.
11. Record RPO/RTO, operator approvals, invariant results, screenshots, and
    rollback/failback decision in the evidence template.
12. After the incident, reconcile downtime paper records and open a separate
    failback plan. Do not improvise failback under incident pressure.

## Clinical Invariant Checklist

Run these checks against the DR candidate and compare them with the latest safe
primary baseline or drill baseline. They are intentionally aggregate and
low-PHI.

| ID | Query or check | Promotion rule |
| --- | --- | --- |
| DR-INV-1 | `SELECT count(*) FROM tenants;` | Equal to the chosen baseline unless the incident window includes a known tenant migration. |
| DR-INV-2 | `SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;` | Equal to the baseline after any normal migrate job completes. |
| DR-INV-3 | `SELECT max(created_at) FROM clinical_timeline_events;` | No later than the selected recovery target and within approved RPO. |
| DR-INV-4 | `SELECT count(*) FROM clinical_timeline_events;` | Plausible versus baseline and incident RPO. Sudden large drops block promotion. |
| DR-INV-5 | `SELECT count(*) FROM clinical_audit_events;` | Plausible versus timeline count and baseline. |
| DR-INV-6 | `SELECT count(*) FROM admissions WHERE status = 'admitted';` | Plausible versus ward census and downtime log. |
| DR-INV-7 | `SELECT count(*) FROM users;` | Plausible versus baseline; zero or sharp unexpected drop blocks promotion. |
| DR-INV-8 | Backend `/health/deep` with DR `DATABASE_URL`. | Database, Redis fallback, and route loader checks are healthy or have documented incident-specific exceptions. |
| DR-INV-9 | Read-only clinical timeline request for a synthetic or approved test patient. | Response envelope is valid and contains data only up to the recovery target. |
| DR-INV-10 | RLS posture check or `check:phi-tenant-id` evidence from the promoted branch. | No tenant isolation regression before traffic returns. |

Any failed invariant blocks public traffic unless the incident commander and
clinical lead explicitly sign an exception in the evidence record.

## Evidence

Use [`qa-findings/cross-site-dr-promotion-template.md`](qa-findings/cross-site-dr-promotion-template.md)
for drills and real incidents. Attach:

- preflight JSON report,
- recovery target and achieved RPO/RTO,
- DR database bootstrap or promotion log,
- clinical invariant values and baseline comparison,
- `/health` and `/health/deep` smoke output,
- DNS/Cloudflare/tunnel cutover evidence,
- downtime paper-record reconciliation owner,
- rollback or failback decision.

## Deferrals

- The first real DR site, network path, storage jurisdiction, budget, and drill
  date remain owner decisions.
- No site-specific Kubernetes overlay is included here. Add one only after the
  operator selects the site and secrets workflow.
- RPO/RTO targets remain the leadership-approved values from
  `DR_RESTORE_DRILL.md` until the owner updates them through the evidence
  process.
