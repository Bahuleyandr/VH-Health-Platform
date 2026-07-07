# DESIGN: Go-live readiness — turn the operator board into ONE sequenced activation runbook

Docs-only design session. Deliverable: `docs/GO_LIVE_RUNBOOK.md` as a docs-only PR (note:
repo root docs/, not specs/ — this is a permanent operational document, the successor to
the playbook's operator board).

**Job:** collect EVERY deploy-HELD flag, inert feature, operator gate, and activation
precondition across the repo and sequence them into a dependency-ordered, evidence-gated
activation runbook a human operator can execute end-to-end.

## Method — inventory first, cite path:line for every gate
Sweep and ground (non-exhaustive; the sweep must prove completeness by grep, not memory):
deploy-HELD manifests (`infra/kubernetes/base/{telemedicine,device-gateway}/` unreferenced
kustomizations), `ALLOW_DEFAULT_TENANT` + onboard-tenant.mjs (multi-tenancy activation),
IdP pilot (NL-1: OIDC/SAML/SCIM per-tenant config), care-team enforce flip (+ its
enumeration-oracle hazard note), ledger flip-authoritative (evidence-gated), NHCX
live-mode (sandbox enrolment external), LiveKit media edge + TURN, terminology content
imports (LOINC done on QA; SNOMED/ICD-11/ATC per runbook) + binding coverage, indigenous-KB
edition activation gate (acceptance battery + sign-off), device VLAN + gateway NodePort +
monitor pilot bring-up (NL-7 §10), per-gate env privilege flips (N6-5), content-studio
per-tenant flags, alarm-policy governance sign-off, Grafana/PrometheusRule activation,
backup/DR posture checks, pen-test + cert prerequisites (NL-12), tag/pin-digests release
step.

## The runbook must contain
1. **Dependency-ordered phases** (cluster → tenant → identity → content → media → devices →
   clinical flips), each step with: exact commands/files, the evidence gate that must pass
   BEFORE it (test name, metric, sign-off), rollback for that step, and owner (operator /
   clinician / external).
2. **A rehearsal profile**: the same runbook executable against the QA cluster with
   explicitly marked skips (external enrolments) — Week-3 of the one-month plan runs this.
3. **Flip registry table**: every flag with location, default, flip condition, and audit
   evidence to record.
4. **Owner Decisions**: pilot tenant identity, go-live date criteria, on-call rota for
   activation week.

## Isolation
Fresh worktree off `github/main` per `_worker-common.md`, branch `docs/go-live-runbook`,
single-file PR, STOP after the PR (coordinator verifies the inventory's completeness by
independent grep before merge).

## Kickoff line
> You are a design worker for the VH Health Platform. Read
> `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\golive-readiness-kickoff.md`
> and `_worker-common.md` beside it; produce `docs/GO_LIVE_RUNBOOK.md` exactly as instructed
> (inventory-grounded, docs-only, single-file PR, stop after PR).
