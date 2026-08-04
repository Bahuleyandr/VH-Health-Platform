# Downtime Procedure — Ward Packs (Roadmap A3)

When the backend, network, or cluster is unavailable, wards run on the
**downtime packs**: per-ward printable documents. This is the VH Health
equivalent of Epic's BCA (Business Continuity Access).

> **Generation is not automatic today.** The `ward-downtime-packs` CronJob runs
> every 15 minutes and exits successfully, but its sweep is gated and publishes
> nothing until the preconditions below are met — see
> [Why generation may produce nothing](#why-generation-may-produce-nothing).
> Until then the only path that produces a ward pack is the admin-triggered
> `POST /api/v1/downtime/generate`. Do not assume a pack exists; the
> `WardDowntimePacksMissing` alert is what asserts that one does.

## What a pack contains

Per occupied bed: patient identity (name, age/sex, UID), **allergies**
(merged from all four stores — structured, legacy import, profile text,
admission intake), **code status**, attending, admitting diagnosis, the
**MAR due-list for the next 12 hours**, active orders, latest vitals +
NEWS2. Packs carry a generation timestamp; anything older than ~30 minutes
at outage start means the generator itself was already degraded — escalate.

**A pack never asserts a clinical fact it does not hold** (C-D2, countersigned
2026-07-30). An unrecorded allergy prints `Allergy status UNKNOWN — not
recorded`, never NKDA; an unrecorded code status prints `Code status NOT
RECORDED — confirm per hospital policy`, never a defaulted full code; and both
print with the same prominence as a known dangerous finding. Every pack states
its own expiry on its face — `Generated <time> — NOT VALID AFTER <time>, then
use paper and phone` — so a sheet that outlives its window says so. Treat an
UNKNOWN line as a question to answer at the bedside, not as a negative result.

## Sources

| Surface | Where | Notes |
|---|---|---|
| Scheduled generation | cron `*/15` (`ward-downtime-packs` job) | **Publishes nothing today** — gated sweep, exits 0 regardless; see below |
| Manual generation | `POST /api/v1/downtime/generate` | ADMIN only — currently the ONLY path that produces a ward pack |
| Output monitoring | `WardDowntimePacksMissing` alert | Fires when an occupied ward has no fresh, unexpired, non-empty pack |
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

## Why generation may produce nothing

The `ward-downtime-packs` CronJob calls `generateWardDowntimePacks()` with no
arguments. That signature is the **governed C3 sweep**
(`generateClinicalContinuityPackSets`), not the legacy per-tenant generator, and
it returns an empty result — without touching the database or the filesystem,
and with a zero exit code — unless all three of these hold:

1. **`CLINICAL_CONTINUITY_PACKS_ENABLED=true`.** Unset in the backend ConfigMap
   and pinned `"false"` by the `continuity-publication-rwx` component. Enabling
   publication is a separate owner-approved change.
2. **`DOWNTIME_MIRROR_DIR` points at the operator-provisioned durable
   publication root.** C3 publication never falls back to a temp directory.
3. **An active signed facility continuity policy plus a wired operator
   signer.** The CronJob supplies no signer, so the signer preflight cannot
   pass even once (1) and (2) are satisfied.

None of the three is satisfied in this repository's manifests, which is
deliberate — pack publication is held pending the continuity activation
decisions. The consequence to understand is that **the job succeeding is not
evidence that a pack exists.** That is why the CronJob-liveness alert was
replaced (2026-08-04) by `WardDowntimePacksMissing`, which reads an output
probe in the backend and counts wards that have an occupied bed but no pack
that exists, is under 45 minutes old, is unexpired, and is non-empty. The
backend log line `Ward downtime packs missing for N occupied ward(s)` names
them. `WardDowntimePackOutputUnobserved` covers the probe itself going quiet,
so an unmeasured deployment never reads as a healthy one.

Until publication is activated, an ADMIN must run
`POST /api/v1/downtime/generate` to produce packs — before planned maintenance,
and whenever the missing-packs alert fires.

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
