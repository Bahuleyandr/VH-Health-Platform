# Downtime Procedure — Ward Packs (Roadmap A3)

When the backend, network, or cluster is unavailable, wards run on the
**downtime packs**: per-ward printable documents regenerated automatically
every 15 minutes while the system is healthy. This is the VH Health
equivalent of Epic's BCA (Business Continuity Access).

## What a pack contains

Per occupied bed: patient identity (name, age/sex, UID), **allergies**
(merged from all four stores — structured, legacy import, profile text,
admission intake), **code status**, attending, admitting diagnosis, the
**MAR due-list for the next 12 hours**, active orders, latest vitals +
NEWS2. Packs carry a generation timestamp; anything older than ~30 minutes
at outage start means the generator itself was already degraded — escalate.

## Sources

| Surface | Where | Notes |
|---|---|---|
| Scheduled generation | cron `*/15` (`ward-downtime-packs` job) | `withJobLock`, skips failed wards, 24 h retention |
| Manual generation | `POST /api/v1/downtime/generate` | ADMIN only — run before planned maintenance |
| List latest per ward | `GET /api/v1/downtime/wards` | clinical roles |
| Independent edge, printable | `https://<facility-edge-host>:8443/v1/tenants/<tenant-uuid>/facilities/<facility-id>/locations/<location-type>/<location-id>/pack.html` | target bookmark; requires the managed client certificate and launcher-supplied named staff/device context |
| Independent edge, JSON | same exact path ending in `/pack.json` | read-only; no tenant, facility, or location index exists |
| Legacy one-ward route | `GET /api/v1/downtime/wards/:wardId/latest?format=html` and `/downtime/static` | deprecated coexistence only; dedicated downtime token required |

## Ward procedure (outage)

1. Charge nurse uses the managed terminal launcher to open the bookmarked exact
   facility/unit edge URL and prints the latest pack. The launcher must present
   the approved client certificate and exact named staff/device context; a raw
   bookmark without that managed context fails closed. Verify tenant, facility,
   unit, and generation/expiry timestamps before use.
2. All new orders, administrations, and vitals are recorded on the paper
   downtime forms (hospital stationery) — the pack is **read-only context**,
   never a charting surface.
3. Medication administration during downtime: verify against the pack's
   allergy line AND the paper drug chart; two-person check for high-alert
   drugs (no electronic CDS is available).
4. New admissions during downtime get a paper chart started from the blank
   downtime form set.

## Recovery / backfill

1. Confirm `/health/ready` green and clinicians can log in.
2. Back-enter in this order: admissions/transfers → orders → medication
   administrations (mark with actual administration times, not entry time)
   → vitals. The MAR back-entry must reference the paper record's
   administering nurse.
3. Ward clerk marks the paper pack "RECONCILED" with date/initials and files
   it per retention policy.
4. Admin triggers `POST /api/v1/downtime/generate` to refresh packs
   immediately rather than waiting for the next cron tick.

## Legacy route coexistence and retirement

The legacy `/downtime/static` surface is deprecated, not silently removed.
Before the edge activation:

1. inventory every ward bookmark, kiosk policy, printed instruction, monitoring
   probe, and support document that names the legacy host or route;
2. provision its dedicated `DOWNTIME_ACCESS_TOKEN` if it must remain available
   during the coexistence window; a monitoring token never authorizes it;
3. install the exact tenant/facility/location edge URL in the managed launcher
   and prove that the launcher supplies the client certificate and named
   staff/device context;
4. run both paths for the owner-approved coexistence window and record access,
   freshness, failures, and staff feedback;
5. obtain a signed clinical/privacy/security/operations change receipt naming
   the retirement time, rollback owner, and retained printed fallback; and
6. remove legacy bookmarks and token only in that approved change. Do not
   delete backend route code as part of an operator sunset.

Rollback restores the dedicated legacy token/bookmark only if its approved
coexistence window and retention posture still permit it. It never points an
edge bookmark at an unsigned directory or bypasses edge authorization.

## Pre-pilot drill (required before go-live)

On a non-production ward, stop the backend and database path and isolate the
edge from Kubernetes, Cloudflare, and internet for 30 minutes. Prove an
authorized managed terminal can retrieve and print its exact edge pack, then
prove wrong-tenant/facility/location, revoked or expired credential,
rolled-back, corrupt, unsigned, partial, and expired set attempts fail closed.
Walk the paper-chart and recovery procedure end-to-end, upload the signed
hash-chained access logs, run the existing central ingest CLI, and reconcile
the paper record. Record timings, expected/actual outcomes, log-chain receipt,
bookmarks migrated, rollback result, named owners, and findings in
`docs/qa-findings/`.

## Known limits

- Only locations in the signed facility coverage are addressable. There is no
  all-tenant, tenant-root, facility-root, or location-list browser.
- The edge is read-only clinical context, not charting, identity discovery, or
  an emergency authorization bypass.
- The Kubernetes RWX component and edge services remain held until the H1/H2
  receipts in
  [`GO_LIVE_ACTIVATION_CHECKLIST.md`](GO_LIVE_ACTIVATION_CHECKLIST.md) are
  complete and a separate activation change is approved.
- Printed copies remain the last-resort fallback when the independently
  powered edge itself is unavailable.
