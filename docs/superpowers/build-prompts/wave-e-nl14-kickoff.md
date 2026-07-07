# DESIGN: NL-14 kickoff — Critical-care & emergency depth (survey + design)

Docs-only design session. Deliverable: ONE grounded survey+design at
`docs/superpowers/specs/<today>-nl14-critical-care-emergency-design.md` as a docs-only PR.
NO code.

**Program (Wave E, roadmap §5-E):** the acute backbone of a tertiary/quaternary centre —
ICU flowsheet depth (hourly grids fed by the NL-7 device gateway, ventilation records +
weaning, sedation/RASS + delirium scoring, lines/tubes/drains tracking that FEEDS N6-6's
device-day HAI denominators), ED/trauma depth (structured triage scale, trauma-team
activation + primary/secondary survey records, MLC workflow completeness), code-blue/resus
documentation (the emit fabric exists — the RECORD may not), ambulance/pre-hospital seam
(referral-in, en-route vitals via gateway kind reservation, handover record), NICU/PICU
depth (feeds/fluids charts, neonatal scoring, ties to the IAP growth packs from NL-5 P4),
burns charting (TBSA map, fluid protocols as order-set content — NOT hardcoded clinical
math without governance).

## Method (Wave B discipline — survey first, cite path:line)
Substrate to ground before writing: vitals_chart/NEWS2/device pipeline (migs 371–373), MAR
+ BCMA offline trilogy, `tierDEmergencyService` + existing ED/triage surfaces, code-blue
channels + `code-blue-misfire.md` runbook, theatre/anesthesia records, admission/bed fabric
(ICU bed types), housekeeping/porter patterns, N6-6 `device_presence_logs` (in flight —
check merge state), paediatric services (NL-5 P4 growth/immunisation). Every claim cites
`path:line`.

## Must answer
1. Per-area: exists / gaps / scope sketch / migrations estimate / tests (NL-6 §4.x format);
   slices sized individually — ICU flowsheets are the expected P1 (compounds NL-7 P1).
2. Device-density assumptions per unit type (what arrives via gateway vs manual charting)
   and the charting-policy interaction with NL-7's downsampling.
3. Clinical-governance boundaries: scoring calculators ship as decision support with
   references; protocol CONTENT (burns fluids, weaning) goes through the NL-5 P3 content
   studio — never hardcoded.
4. Slice order + dependencies; Owner Decisions (triage scale choice, trauma registry
   participation, ambulance-partner integration scope, NICU device fleet).
5. Boundaries: NL-7 owns transport; NL-8 owns queue/flow surfaces; N6-6 owns HAI logic.

## Isolation
Fresh worktree off `github/main` per `_worker-common.md`, branch
`docs/nl14-critical-care-design`, single-file PR, STOP after the PR.

## Kickoff line
> You are a design worker for the VH Health Platform. Read
> `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\wave-e-nl14-kickoff.md`
> and `_worker-common.md` beside it; produce the NL-14 survey+design exactly as instructed
> (survey-grounded, docs-only, single-file PR, stop after PR).
