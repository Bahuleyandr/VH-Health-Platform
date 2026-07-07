# DESIGN: NL-11 kickoff — Productization (survey + slice plan, NL-6 style)

Docs-only design session. Deliverable: ONE grounded survey+slice-plan at `docs/superpowers/specs/<today>-nl11-productization-plan.md` as a docs-only PR. NO code. NL-11 is huge — model the document on the NL-6 plan (survey → gap inventory → sized slice table → owner decisions), not on a single-feature spec.

**Program (roadmap §5 NL-11):** shared design system (token + component parity across the 3 clients), white-label theming (T2 #7), license/entitlement packaging on the per-tenant module substrate, **legacy-HIS migration toolkit** (CSV/HL7 importers, patient/encounter/billing openers, validation reports, rehearsal mode — the #1 sales blocker), demo-tenant generator, user manuals + in-app tours + LMS, developer portal (activate `api_clients`) + public SMART-on-FHIR endpoints + FHIR R4 writes + HL7 interface engine (Mirth-class).

## Method
1. **Survey first, cite `path:line`.** Ground: the three clients' theming/design-token state (drift documented in the competitive frame), per-tenant module substrate (`clinical_ai_tenant_modules` + settings patterns), `api_clients`/`api_keys` (dormant — NL-7 deliberately did not squat on them; this program activates them), FHIR read surface + conformance job (writes are new), HL7 HTTP bridge + outbound feeds (the interface engine subsumes-or-peers question NL-7 §2 deliberately left open — ANSWER IT HERE), seed/demo tooling, docs/manuals state.
2. **Boundaries:** NL-7 owns device transport (the engine takes system-to-system feeds); NL-12 owns certification/assurance; NL-10 owns BI embedding.
3. **Slice discipline:** each slice sized S/M/L with substrate-readiness + sales-value columns (the NL-6 table shape); migration toolkit and developer portal are the value spine — sequence them early; the interface engine is the deepest build — give it its own mini-design gate.
4. **Structure:** boundaries → headline survey findings → per-workstream survey (exists/gaps/scope sketch/migrations/tests) → cross-cutting defects found → recommended slice order with rationale → **Owner Decisions** (white-label depth, LMS make-vs-buy, SMART app registration policy, engine subsume-vs-peer, migration-toolkit source-format priorities) → risks.
5. **Isolation:** worktree per `_worker-common.md`, branch `docs/nl11-productization-plan`, single-file PR, stop after PR.

## Kickoff line
> You are a design worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\wave-d-nl11-kickoff.md` and `_worker-common.md` beside it; produce the NL-11 survey+slice-plan exactly as instructed (survey-grounded, docs-only, single-file PR, stop after PR).
