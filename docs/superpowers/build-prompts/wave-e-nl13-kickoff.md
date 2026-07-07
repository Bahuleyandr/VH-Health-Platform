# DESIGN: NL-13 kickoff — Quaternary specialty suites (survey + design)

Docs-only design session. Deliverable: ONE grounded survey+design at
`docs/superpowers/specs/<today>-nl13-quaternary-suites-design.md` as a docs-only PR. NO code.

**Program (Wave E, roadmap §5-E):** the specialty depth that separates tertiary/quaternary
centres from mid-market HIS — invasive cardiology (cath-lab workflow: pre-cath checklist →
procedure log → hemodynamics/contrast/fluoro record → post-cath orders; EP/TAVR seams; device
data rides the NL-7 gateway), neuro/stroke pathway (code-stroke activation, thrombolysis
door-to-needle timers, structured NIHSS), transplant program management (NOTTO-aligned
recipient/donor workflow, waitlist, cross-match chain-of-custody, immunosuppression protocol
seams — build on the N6-2/N6-3 donor + transfusion rails), oncology completion (TNM/AJCC
staging + CTCAE toxicity + tumor board — the gaps N6 deliberately left), CTVS/perfusion
record seam, nuclear-medicine/radiotherapy COORDINATION seams (integrate LINAC/planning
systems — never rebuild them).

## Method (Wave B discipline — survey first, cite path:line)
The platform has more substrate than the roadmap admits: ground against theatre/anesthesia
(migs 116/163), chemo (mig 290), device gateway (migs 371–373), NEWS2/code-blue fabric,
canonical timeline, N6-1 structured-reporting pattern, N6-4 AP reports (tumor-board linkage
via malignancy_flag), donor rails, `clinical_ai_*` cardiology/neuro modules (92-module
inventory). Every claim cites `path:line`.

## Must answer
1. Per-suite: exists / gaps / scope sketch / migrations estimate / test strategy (the NL-6
   §4.x format), each suite sized as its own slice.
2. Which suites are BUILD vs INTEGRATE-ONLY (radiotherapy planning, perfusion pumps,
   angiography systems = integrate via NL-7/NL-11 seams; state this explicitly per suite).
3. Regulatory anchors per suite (NOTTO for transplant, AERB adjacency for cath/radiation —
   name the obligation, don't paraphrase regulations from memory; owner sources documents).
4. Slice order with rationale + hard dependencies; Owner Decisions section (vendor
   integrations, program scope per pilot hospital, privilege gates per suite via N6-5
   catalog).
5. Do-not-build restated: no LINAC/planning replacement, no genomics, no custom device
   protocol stacks (NL-7 owns transport).

## Isolation
Fresh worktree off `github/main` per `_worker-common.md`, branch
`docs/nl13-quaternary-suites-design`, single-file PR, STOP after the PR.

## Kickoff line
> You are a design worker for the VH Health Platform. Read
> `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\wave-e-nl13-kickoff.md`
> and `_worker-common.md` beside it; produce the NL-13 survey+design exactly as instructed
> (survey-grounded, docs-only, single-file PR, stop after PR).
