# One-Month Execution Plan — 2026-07-07 → 2026-08-10

**Companion to** `docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md` (the operating manual —
read it first; this file is the calendar). **Goal:** by 2026-08-10 the platform is a
one-stop tertiary/quaternary-care hospital system — Waves B/C/D built or building, the new
Wave E (quaternary depth) designed and started, the operator board sequenced into a go-live
plan, and every remaining step executable by ANY coordinator (model or human) from the repo
alone.

**Coordinator-independence rules (why this survives any single model):**
1. Every task below is either (a) a pre-authored prompt in `build-prompts/`, (b) a
   design-session that PRODUCES a spec via a pre-authored kickoff, or (c) a mechanical
   procedure documented in the playbook (§4 verification, §5 registry, merge-train drill,
   Prompt-Authoring Guide). Nothing depends on unwritten judgment.
2. When a design spec merges, the next coordinator authors that program's build prompts
   using the playbook's Prompt-Authoring Guide — the guide contains the full template and
   the parallel-safety/sizing method. This is the ONLY recurring authoring act; everything
   else is launch → verify → merge.
3. A human can run the whole loop: every step is a CLI command or a paste-into-a-session
   prompt. No step requires a specific model.

**Standing weekly rhythm (every week, regardless of phase):**
- Merge-train duty as PRs land: scope-check → content-verify (playbook §4) → roll if base
  moved → merge → sync Forgejo → prune → registry/status docs PR (batch ~2/week).
- Keep ≤6–8 build workers concurrent; design sessions are unlimited (docs-only).
- Wednesday + Sunday: `gh pr list`, worktree prune, playbook §5/§8/§9 refresh PR.
- Every owner decision taken gets recorded in the playbook decision log THE SAME DAY.

---

## Week 0 — Jul 7–13: drain Wave B, design Wave C/D, operator unblocking

**Builds (in flight or launching from the library):** finish N6-3, N6-6, NL-5 P4, N6-8,
NL-7 P2, NL-7 P3, NL-5 P2+substrate, N6-10, N6-12. As each merges, launch from the bench in
this order: **N6-7 ophthalmology → N6-9 dialysis → N6-13 CSSD** (assign blocks per §5).
NL-7 P4 launches once P2+P3 are on main (RTLS half stays gated on the vendor-pilot
decision). N6-14 linen stays last.

**Design sessions (docs-only, run all five):** `wave-c-nl8-kickoff` (patient flow),
`wave-c-nl9-kickoff` (engagement/CRM), `wave-c-nl10-kickoff` (embedded BI),
`wave-d-nl11-kickoff` (productization — the migration toolkit is the #1 sales blocker),
`wave-d-nl12-kickoff` (assurance split). Coordinator verifies each spec per §4, puts its
Owner Decisions to the owner, records outcomes.

**Owner/operator actions this week (nothing here blocks builds, everything unblocks later
weeks):**
- Submit the NRCeS SNOMED affiliate application (longest lead time — do first).
- Source statutory register formats (blood-bank set, dialyzer reuse, IDSP list) → unblocks
  N6-3's "format pending" exports and N6-9's register.
- Download ICD-11 MMS CSV + order WHOCC ATC files; decide WHO-API mode (self-hosted
  container recommended); run both imports per the terminology runbook (LOINC pattern).
- Appoint the indigenous drug-KB reviewers (pharmacology lead + pharmacy reviewer + backup)
  and pick the first formulary scope — gates Week-2 content authoring.
- Hospital-IT meeting: device VLAN + firewall rules (NL-7 §7.1) + monitor-vendor shortlist.
- Confirm the DAYCARE_OPHTHALMOLOGY_V1 clinician reviewer (unblocks the N6-7 demo story).

**Exit criteria:** Wave B ≤3 slices from complete; all five Wave C/D specs merged with
decisions logged; LOINC+ICD-11+ATC live on QA; NRCeS application in flight.

## Week 1 — Jul 14–20: author Wave C/D prompts, launch round 5, start Wave E design

**Coordinator authoring (per the Prompt-Authoring Guide):** turn the five merged specs into
build prompts — NL-8 P1..Pn, NL-9 P1..Pn, NL-10 P1..Pn, NL-11 slices (N11-1..), NL-12
buildable slices (N12-1..). Sequence NL-11's **legacy-HIS migration toolkit** and NL-8 P1
(kiosk/queue) first — sales-critical. Each prompt lands via a docs PR that also assigns its
§5 migration block.

**Builds:** launch round 5 = NL-8 P1 + NL-11 migration-toolkit slice + NL-10 P1 (tenancy
model first) as Wave B slots free. Bench refills continue.

**Design sessions:** `wave-e-nl13-kickoff` (quaternary specialty suites) +
`wave-e-nl14-kickoff` (critical-care & emergency depth) — both survey-first (the N6 lesson:
the platform usually has more substrate than the roadmap one-liners admit — tierD emergency,
code-blue, ICU vitals, theatre all exist).

**Content track:** indigenous-KB substrate merged (NL-5 P2) → editorial pilot begins under
the appointed reviewers per the indigenous-KB spec (first formulary families, provenance on
every row, NO unreviewed content). Terminology: run the binding-suggest pass for the
investigation catalog + curator confirmations (P1 acceptance metric ≥90%).

**Exit criteria:** ≥3 round-5 builds merged or green-in-CI; Wave E specs delivered;
indigenous editorial pilot producing its first reviewed rows on QA.

## Week 2 — Jul 21–27: Wave C build-out, NL-12 buildables, Wave E decisions

**Builds:** NL-8 P2+ (porter/transport, scheduling 2.0), NL-9 P1 (campaign/consent rails),
NL-10 P2 (embed + governed catalog), NL-11 next slices (white-label/design-system after the
toolkit), NL-12 buildables (NABH indicator exporter, SIEM export seam, eSign/DSC seam, k6
500-bed profile as a CI-adjacent job). Wave B remainder (N6-13, N6-14) closes out.

**Wave E:** verify NL-13/NL-14 specs → owner decisions (cath-lab vendor integration scope,
transplant-program NOTTO alignment, ICU device-density assumptions) → author + launch first
prompts (NL-14 ICU flowsheet depth is the natural P1 — it compounds NL-7 P1's device
gateway and N6-6's device-day denominators).

**Operator:** SNOMED import when NRCeS grants; rollback drill on QA (prior-release
re-import) to complete the NL-5 acceptance boundary; LiveKit media-edge staging on the QA
cluster; pen-test vendor selection + scope sign-off (NL-12 owner decision).

**Exit criteria:** every Wave C/D program has ≥1 slice merged; Wave E building; NL-12
exporters inert-on-main.

## Week 3 — Jul 28–Aug 3: quaternary depth, go-live readiness, activation rehearsal

**Builds:** NL-13 P1 (first specialty suite — cath-lab workflow on the device-gateway rail
is the recommended lead), NL-14 P2, remaining NL-8/9/10 phases, NL-11 demo-tenant
generator + manuals/LMS slice.

**Go-live readiness (design session):** run `golive-readiness-kickoff` — it turns the
playbook's operator board + all deploy-HELD flags into ONE sequenced activation runbook
(dependency-ordered: cluster → tenant onboarding → IdP pilot → terminology/content imports →
LiveKit edge → NHCX sandbox → device VLAN pilot → flag flips with evidence gates). The spec
is verified and merged like any other; it becomes `docs/GO_LIVE_RUNBOOK.md`.

**Activation rehearsal (QA cluster, operator):** execute the runbook's first half against
QA end-to-end — onboard-tenant script, ALLOW_DEFAULT_TENANT=false flip, IdP pilot realm,
full journey-test sweep on the activated posture. Fix-forward anything it surfaces.

**Exit criteria:** GO_LIVE_RUNBOOK merged; QA rehearsal passed; Wave E P1s merged.

## Week 4 — Aug 4–10: hardening, load, docs, version cut

- k6 500-bed load profile executed against QA-activated posture; SLO re-baseline recorded
  (NL-12); fix-forward regressions.
- Full-platform journey sweep (all journeys + smokes) on the combined tree; accessibility
  completion slices; dictation/radiology stretch items if capacity allows.
- Manual accessibility device passes are scheduled on the operator board:
  2026-08-04 staff Windows NVDA plus Android TalkBack, 2026-08-05 patient
  Android TalkBack plus iOS VoiceOver, 2026-08-06 admin Chrome NVDA plus
  VoiceOver/PDF inspection, and 2026-08-07 retest-only window. Evidence rows
  follow `docs/accessibility/NL12-S6_ACCESSIBILITY_COMPLETION_PACK.md`.
- NL-11 docs: user manuals + in-app tours reviewed; demo tenant seeded and walkthrough
  recorded.
- Cut version tags: `backend-vX`, `admin-vX`, `patient-v*`, `staff-v*` per the tag
  convention; pin prod digests stays operator-gated.
- **Month-end review** (coordinator, one docs PR): §9 board fully refreshed, next-month
  plan drafted from the remainder (pilot go-live execution, NL-13/14 continuation,
  certification calendar).

**Month exit state:** Waves A/B complete · C/D substantially built · E designed + started ·
runbook-driven activation rehearsed on QA · content programs (terminology + indigenous KB)
operating under governance · registry/playbook current — any coordinator resumes from the
repo alone.

---

## Dependency map (what truly gates what)

| Blocker | Blocks | Owner |
|---|---|---|
| NRCeS grant | SNOMED import only | external |
| Register formats sourced | N6-3/N6-9 register finalization only | owner |
| KB reviewers appointed | indigenous content authoring (not substrate) | owner |
| Monitor vendor + VLAN | NL-7 device pilot (not builds) | owner + hospital IT |
| NL-7 P2+P3 merged | NL-7 P4 | pipeline |
| Wave C/D specs merged | their build prompts | coordinator loop |
| NL-13/14 specs merged | Wave E builds | coordinator loop |
| GO_LIVE_RUNBOOK merged | activation rehearsal | pipeline → operator |
| NHCX sandbox enrolment | NHCX live-mode flip only | external (long pole) |

Nothing on the external row blocks any build — by design.
