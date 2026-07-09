# Documentation Index

This directory is the current front door for VH Health Platform documentation.
Use this index before following older deep links: dated audits and generated
reports are retained as evidence, not as the source of truth for current
operations.

## Start Here

| Topic | Document |
| --- | --- |
| **Go-live critical path (operator sequence)** | [`GO_LIVE_CRITICAL_PATH.md`](GO_LIVE_CRITICAL_PATH.md) |
| Release gate | [`RELEASE_READINESS.md`](RELEASE_READINESS.md) |
| Deployment runbook | [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) |
| India go-live readiness | [`india-deployment-readiness.md`](india-deployment-readiness.md) |
| Backend docs index | [`../apps/backend/docs/README.md`](../apps/backend/docs/README.md) |
| Architecture | [`SYSTEM-ARCHITECTURE.md`](SYSTEM-ARCHITECTURE.md) |
| On-call runbook | [`RUNBOOK_ONCALL.md`](RUNBOOK_ONCALL.md) |

## Milestone / Roadmap

**[`ROADMAP.md`](ROADMAP.md) is the single source of truth for pending work.** The
older planning docs (the 2026-06-16 goal, S-tier, epic roadmap, execution log,
remediation trackers, AI-gap backlog, clinical-AI plans, tenant-RLS gap analysis)
were consolidated into it on 2026-06-22 and moved to [`archive/`](archive/).

| Topic | Document | Notes |
| --- | --- | --- |
| Pending work (consolidated) | [`ROADMAP.md`](ROADMAP.md) | What's left + links to the live runbooks; **start here** |
| Pilot staff workflow scenarios | [`PILOT_STAFF_WORKFLOW_SCENARIOS.md`](PILOT_STAFF_WORKFLOW_SCENARIOS.md) | Real-world workflow coverage for pilot |
| Archived planning docs | [`archive/`](archive/) | Point-in-time roadmaps / logs (provenance only) |

## Architecture

| Topic | Document |
| --- | --- |
| System architecture (single entry point) | [`SYSTEM-ARCHITECTURE.md`](SYSTEM-ARCHITECTURE.md) |
| Canonical clinical timeline | [`CANONICAL_CLINICAL_TIMELINE.md`](CANONICAL_CLINICAL_TIMELINE.md) |
| Analytics warehouse | [`ANALYTICS_WAREHOUSE.md`](ANALYTICS_WAREHOUSE.md) |
| Flutter plugin major migrations | [`FLUTTER_PLUGIN_MAJOR_MIGRATIONS.md`](FLUTTER_PLUGIN_MAJOR_MIGRATIONS.md) |

## Deployment, Database, And DR

| Topic | Document |
| --- | --- |
| Deployment runbook (end-to-end) | [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) |
| Hardware requirements | [`HARDWARE_REQUIREMENTS.md`](HARDWARE_REQUIREMENTS.md) |
| India go-live readiness | [`india-deployment-readiness.md`](india-deployment-readiness.md) |
| DB schema guardrails | [`DB_SCHEMA_GUARDRAILS.md`](DB_SCHEMA_GUARDRAILS.md) |
| Production DB hardening | [`PRODUCTION_DB_HARDENING.md`](PRODUCTION_DB_HARDENING.md) |
| Downtime procedure | [`DOWNTIME_PROCEDURE.md`](DOWNTIME_PROCEDURE.md) |
| DR restore drill evidence | [`DR_RESTORE_DRILL.md`](DR_RESTORE_DRILL.md) |
| Cross-site DR failover plan | [`CROSS_SITE_DR_FAILOVER_PLAN.md`](CROSS_SITE_DR_FAILOVER_PLAN.md) |
| Live Dalekdefender drift remediation | [`LIVE_DALEKDEFENDER_DRIFT_REMEDIATION.md`](archive/LIVE_DALEKDEFENDER_DRIFT_REMEDIATION.md) |
| Per-tenant rollout playbook | [`PER_TENANT_ROLLOUT_PLAYBOOK.md`](PER_TENANT_ROLLOUT_PLAYBOOK.md) |

## Security And Compliance

| Topic | Document | Notes |
| --- | --- | --- |
| Security hardening checklist | [`SECURITY_HARDENING_CHECKLIST.md`](SECURITY_HARDENING_CHECKLIST.md) | Authoritative gate checklist |
| Operator-only remediation steps | [`PHASE0_OPERATOR_ACTIONS_2026-06-10.md`](PHASE0_OPERATOR_ACTIONS_2026-06-10.md) | Infrastructure-side actions |
| ABDM readiness | [`ABDM_READINESS.md`](ABDM_READINESS.md) | ABDM / NDHM compliance |
| Pentest readiness | [`PENTEST_READINESS.md`](PENTEST_READINESS.md) | RoE pack for the external engagement |
| Code security sweep (dated snapshot) | [`../SECURITY_SWEEP_2026-06-13.md`](../SECURITY_SWEEP_2026-06-13.md) | Root-level point-in-time sweep (2026-06-13) |
| Audit & evidence (archived) | [`archive/audits/`](archive/audits/) | Platform & security audits, sweeps, self-assessment, investigations — point-in-time, do not edit |

## Clinical AI And Product

| Topic | Document |
| --- | --- |
| Module inventory | [`CLINICAL_AI_MODULE_INVENTORY.md`](CLINICAL_AI_MODULE_INVENTORY.md) |
| Knowledge curation | [`CLINICAL_AI_KNOWLEDGE_CURATION.md`](CLINICAL_AI_KNOWLEDGE_CURATION.md) |
| Rollout plan, feature backlog, spec audit (archived) | [`archive/`](archive/) + [`archive/audits/`](archive/audits/) |

## Smoke, QA, And Evidence

| Topic | Document | Notes |
| --- | --- | --- |
| Smoke E2E journeys | [`SMOKE_E2E_JOURNEYS.md`](SMOKE_E2E_JOURNEYS.md) | Journey coverage map |
| First trial deployment readiness | [`FIRST_TRIAL_DEPLOYMENT_READINESS.md`](FIRST_TRIAL_DEPLOYMENT_READINESS.md) | Pre-trial gate evidence |
| Patient Play Store submission | [`PATIENT_PLAY_STORE_SUBMISSION.md`](PATIENT_PLAY_STORE_SUBMISSION.md) | Play Store readiness checklist |
| QA findings archive | [`qa-findings/README.md`](qa-findings/README.md) | Agent-driven QA outputs |
| Audit & evidence snapshots (archived) | [`archive/audits/`](archive/audits/) | Platform audits, role-workflow sweeps, investigations |

## Trackers

| Topic | Document |
| --- | --- |
| Translation review tracker | [`TRANSLATION_REVIEW_TRACKER.md`](TRANSLATION_REVIEW_TRACKER.md) |

Older point-in-time investigations and consistency audits are archived under
[`archive/audits/`](archive/audits/).

## Maintenance Notes

- Do not add hand-maintained API endpoint inventories. The current API source is
  `apps/backend/src/docs/swagger.yaml` plus `npm run swagger:validate`.
- Do not add static schema dumps as current DB documentation. Use
  `docs/DB_SCHEMA_GUARDRAILS.md` and the backend contract scripts.
- Keep dated audit reports if they are evidence, but label them as snapshots
  and point new work at the current runbooks above.
- Point-in-time snapshots (platform & security audits, sweeps, self-assessment,
  investigations) live under [`archive/audits/`](archive/audits/); consolidated
  planning docs under [`archive/`](archive/). `PENTEST_READINESS.md` is the one
  process-managed snapshot still at top level (external-engagement RoE pack).
