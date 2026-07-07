# DESIGN: NL-12 kickoff — Assurance & scale (plan; heavily operator-track)

Docs-only design session. Deliverable: ONE grounded plan at `docs/superpowers/specs/<today>-nl12-assurance-plan.md` as a docs-only PR. NO code. Most of NL-12 is programs and evidence, not features — the plan's job is to split OPERATOR work (certifications, pen-test engagement, DR hardware) from BUILDABLE work (exporters, load profiles, automation) and sequence the buildable part.

**Program (roadmap §5 NL-12):** ISO 27001/SOC 2 program, pen-test execution, ABDM M1–M3 certification, NABH indicator exporter, SIEM export, cross-site DR replica, 500-bed load profile (k6 + SLO re-baseline), accessibility completion (screen-reader automation + font scaling), SLSA-L3 finish (Kyverno enforce, verify-before-pin), zero-trust network (Cloudflare Access, Cilium L7, per-tenant NetworkPolicy).

## Method
1. **Survey first, cite `path:line`.** Ground: `nabh_indicator_snapshots` (mig 286) + what indicators exist vs the NABH pack; audit-chain/SIEM-adjacent surfaces (hash-chained `clinical_audit_events`, identity_audit_events, security webhooks); existing k6 baseline + SLO definitions (observability program); SLSA state (what's left of T2 #11); backup/DR posture (deployment guide §; CNPG replicas ≠ cross-site DR); accessibility state (staff S-program work + what remains); ABDM integration surfaces (M1-M3 readiness).
2. **Buildable vs operator split is the organizing principle.** Every workstream gets: buildable slices (sized, with migration counts) + operator checklist (who, external dependency, evidence artifact). Certifications NEVER block builds — exporters and evidence automation land inert.
3. **Boundaries:** NL-11 owns the developer portal + statutory register PACK printing machinery (NL-12 defines indicator CONTENT + export formats); departmental registers stayed in NL-6.
4. **Structure:** boundaries → survey → per-workstream buildable/operator split → slice table (NL-6 shape) → **Owner Decisions** (cert body/auditor selection, pen-test vendor + scope + window, DR site/hardware budget, SIEM target product) → risks.
5. **Isolation:** worktree per `_worker-common.md`, branch `docs/nl12-assurance-plan`, single-file PR, stop after PR.

## Kickoff line
> You are a design worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\wave-d-nl12-kickoff.md` and `_worker-common.md` beside it; produce the NL-12 assurance plan exactly as instructed (survey-grounded, docs-only, single-file PR, stop after PR).
