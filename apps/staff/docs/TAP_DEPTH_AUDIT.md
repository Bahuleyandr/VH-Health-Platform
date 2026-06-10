# Staff App — Tap-Depth Audit (roadmap E5)

_Audited: 2026-06-10, alongside the one-screen patient summary ship._

Epic's killer ergonomic is information density: the five things a
clinician asks about every patient — **allergies, active medications,
active problems, last vitals, pending results** — reachable in ≤1 tap
from any patient context. This audit measures where the staff app
stood and what the `PatientSummarySheet` changes.

Counting rule: taps AFTER the app is open, excluding typing. "Patient
context" = a screen already scoped to one patient.

## Before (2026-06-10 morning)

| Need | Cheapest path | Taps | Notes |
|---|---|---:|---|
| Allergies (IP) | Dashboard → Patient Command Board → find row → allergies chips | 2 + scroll | IP-only; OP allergies surfaced nowhere outside Rx CDS |
| Allergies (OP) | Prescriptions screen → CDS evaluation banner | 3+, indirect | Only at prescribing time |
| Active meds (IP) | Command Board → row → Drug Chart | 3 | Admission required |
| Active meds (OP) | Orders screen → filter chips | 3 | Text-only list pre-E1 |
| Active problems | — | n/a | B7 problem list had NO staff-app surface at all |
| Last vitals | Timeline → quick action → Vitals chart | 3 | Or Bed Board → bed → Record Vitals (3) |
| Pending results | Orders screen → status filter | 3 | No "results pending" view |
| All five together | impossible | — | No single surface existed |

## After

`PatientSummarySheet` (allergies — loud and first, active problems
(B7's first staff surface), active medication orders, last vitals
line, pending result orders, plus quick links to Orders / Vitals /
Timeline / Notes). Composed client-side from existing endpoints in
parallel; sections degrade independently.

| From | Path | Taps |
|---|---:|---:|
| Patient Timeline | app-bar summary icon | **1** |
| Orders screen | app-bar summary icon | **1** |
| Order Composer | app-bar summary icon | **1** |
| Patient Command Board | row summary icon | **1** |
| ANY screen (unknown patient) | magnifier (or Ctrl+K) → type → row summary icon | **2** + typing |

The global path rides the patient search that already sits on every
`StaffScaffold` app bar, so "from anywhere" holds app-wide without
touching every screen.

## Remaining gaps (follow-up queue)

- Vitals chart, Clinical Notes, Case Sheet, Drug Chart, Discharge Hub
  don't carry the summary action yet — add the same one-line
  `IconButton` as screens get touched (pattern in
  `orders_screen.dart`).
- OP allergies inside the summary depend on the command-board payload,
  which is admission-scoped; an un-admitted patient shows "No
  allergies recorded" even when OP stores have entries. Fix = expose
  A10's `getUnifiedActiveAllergies` over HTTP (small backend follow-up)
  and point the sheet at it.
- Pending results = result-type orders not yet completed; it does not
  yet read `lab_results` directly for collected-but-unverified
  specimens (B3 inbox nuance).
- Bed Board bed-sheet quick actions could add Summary as a fifth chip
  (today: EMR / Vitals / Note / Handover).
