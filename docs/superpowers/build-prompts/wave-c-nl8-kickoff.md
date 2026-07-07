# DESIGN: NL-8 kickoff — Patient-flow suite (kiosk, queue displays, porter, scheduling 2.0, census)

Docs-only design session. Deliverable: ONE grounded spec at `docs/superpowers/specs/<today>-nl8-patient-flow-design.md` as a docs-only PR. NO application code, migrations, or manifests.

**Program (roadmap §5 NL-8):** kiosk self-check-in (Flutter web/tablet build), queue TV display app (token boards; channels exist), porter/transport tasks (reuse housekeeping dispatch pattern), scheduling 2.0 (provider templates, overbook, resource booking), predictive census/LOS surfaced on the command centre.

## Method (the Wave B discipline — non-negotiable)
1. **Survey before you write.** The roadmap's one-liners understate what exists (NL-6's survey found six departments already API-complete). Grep/read the repo at your base commit; every claim in the spec cites `path:line`. Known seams to ground: appointment fabric + token/queue constructs, the housekeeping dispatch/task pattern (`housekeepingTaskDispatchService`), realtime board recipe (13 shipped boards; CHANNEL_CATALOG), tierH predictive models (census/LOS), kiosk-relevant auth (patient Firebase OTP; NL-4 front-desk registration guardrails + EMPI dedupe), Flutter web build story, NL-6 N6-10 infusion chairs (slot-vs-resource precedent), NL-12 accessibility overlap for public displays.
2. **Respect boundaries:** NL-7 owns device/LAN transport; NL-9 owns outreach/recall; NL-11 owns white-label/theming (kiosk skinning = seam, not scope). PHI on public screens is a first-class design concern (token boards must be PHI-free — name masking policy is an owner decision).
3. **Structure** (mirror the NL-7 spec): Context + binding invariants (canonical timeline, RLS mig-356, per-tenant flags mig-351 pattern — NOT `feature_flags`, deploy HELD, zero-inbound-ports for any new device/display surface) → Existing substrate (verified) → per-workstream design → phased plan (P1–P4 or slices, each with migration COUNT estimates — numbers come from the playbook registry at launch) → test strategy → **Owner Decisions** section → source notes.
4. **Isolation:** fresh worktree off `github/main` (per `_worker-common.md` setup), branch `docs/nl8-patient-flow-design`; single-file PR; STOP after the PR (coordinator verifies per playbook §4, then decisions, then build prompts).

## Kickoff line
> You are a design worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\wave-c-nl8-kickoff.md` and `_worker-common.md` beside it; produce the NL-8 design spec exactly as instructed (survey-grounded, docs-only, single-file PR, stop after PR).
