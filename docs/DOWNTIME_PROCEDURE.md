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
| One ward, printable | `GET /api/v1/downtime/wards/:wardId/latest?format=html` | bookmark on ward PCs; print at shift start during outage risk |
| One ward, JSON | `GET /api/v1/downtime/wards/:wardId/latest` | staff-app offline cache feed |

## Ward procedure (outage)

1. Charge nurse opens/prints the latest pack for the ward (browser cache or
   the printed copy from the last round). Verify the generation timestamp.
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

## Pre-pilot drill (required before go-live)

Kill the backend deliberately for 30 minutes on a non-production ward and
walk the procedure end-to-end: print, paper-chart a simulated med pass,
recover, back-enter. Record findings in `docs/qa-findings/`. The drill is
the acceptance gate for roadmap item A3 — owning it is a hospital-side
action (see EPIC_LEVEL_ROADMAP.md Phase 1 exit criteria).

## Known limits (v1)

- Packs cover wards with occupied beds only (OPD/ED flow boards are not
  packaged yet — extend `wardDowntimePackService` when ED goes live).
- Pack HTML is served by the backend; a true network-partition scenario
  relies on the **printed** copies or the browser's last-loaded page. A
  read-only static mirror on a ward-local machine is the Phase-2 hardening
  step (sync the HTML files to a LAN share via a tiny cron on the ops box).
