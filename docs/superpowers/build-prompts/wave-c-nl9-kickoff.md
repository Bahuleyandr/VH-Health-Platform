# DESIGN: NL-9 kickoff — Engagement & CRM (campaigns, NPS, RPM, follow-up loops)

Docs-only design session. Deliverable: ONE grounded spec at `docs/superpowers/specs/<today>-nl9-engagement-crm-design.md` as a docs-only PR. NO code.

**Program (roadmap §5 NL-9):** recall/outreach campaigns on the WhatsApp rails (consent-gated), NPS analytics on feedback, RPM/home-health program (device kit + `rpm agent` module), teleconsult follow-up loops, loyalty deepening (health points).

## Method (Wave B discipline)
1. **Survey first, cite `path:line`.** Ground: WhatsApp/notification rails (`notificationOutbox`, templates, consent state), feedback/NPS substrate, the `rpm` agent module + governed-AI wrapper state (92-module inventory — check `docs/CLINICAL_AI_MODULE_INVENTORY.md`), teleconsult follow-up seams (NL-3 shipped surfaces), health-points/loyalty constructs, patient-app engagement surfaces, campaign-adjacent tables.
2. **Hard constraints to design around:** consent-gating is load-bearing (outreach without recorded consent is a non-starter — cite the consent surfaces); PHI in outbound messages minimized (template discipline); NL-7 owns any RPM device ingestion transport (RPM kit telemetry rides the device-gateway seams — design the handshake, don't rebuild it); campaigns must be per-tenant flagged (mig-351 pattern) and rate-limited.
3. **Structure:** invariants → existing substrate (verified) → workstream designs (campaigns/recall, NPS analytics, RPM program, follow-up loops, loyalty) → phased plan with migration counts → test strategy → **Owner Decisions** (e.g., WhatsApp template approval ownership, RPM device kit procurement, campaign consent copy) → source notes.
4. **Isolation:** worktree per `_worker-common.md`, branch `docs/nl9-engagement-design`, single-file PR, stop after PR.

## Kickoff line
> You are a design worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\wave-c-nl9-kickoff.md` and `_worker-common.md` beside it; produce the NL-9 design spec exactly as instructed (survey-grounded, docs-only, single-file PR, stop after PR).
