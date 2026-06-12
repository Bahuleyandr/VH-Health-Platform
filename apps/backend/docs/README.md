# Backend Documentation Index

Current operational docs live here plus in the root `docs/` directory. Prefer
the root release, schema guardrail, and deployability docs for current gates.
Older backend documents are preserved only when they are useful historical
snapshots and are labelled below.

## Current

| Document | Purpose |
| --- | --- |
| [`CI_REQUIRED_CHECKS.md`](./CI_REQUIRED_CHECKS.md) | Required-check notes and local fallback context. |
| [`DB-MIGRATION-PLAN.md`](./DB-MIGRATION-PLAN.md) | CNPG cutover plan for production-style deployments. |
| [`DISASTER-RECOVERY.md`](./DISASTER-RECOVERY.md) | Disaster recovery notes. |
| [`RUNBOOKS/README.md`](./RUNBOOKS/README.md) | Operational runbook index. |

## Cross-Stack Docs

| Document | Purpose |
| --- | --- |
| [`../../../docs/DB_SCHEMA_GUARDRAILS.md`](../../../docs/DB_SCHEMA_GUARDRAILS.md) | Current schema drift and seed guardrails. |
| [`../../../docs/RELEASE_READINESS.md`](../../../docs/RELEASE_READINESS.md) | Local release/CI gate. |
| [`../../../docs/DEPLOYMENT_GUIDE.md`](../../../docs/DEPLOYMENT_GUIDE.md) | Kubernetes and deployment runbook. |
| [`../../../docs/PLATFORM_REMEDIATION_PLAN.md`](../../../docs/PLATFORM_REMEDIATION_PLAN.md) | Remediation tracker. |
| [`../../../docs/india-deployment-readiness.md`](../../../docs/india-deployment-readiness.md) | India deployment compliance and evidence gate. |

## Generated Sources

| Source | Purpose |
| --- | --- |
| [`../src/docs/swagger.yaml`](../src/docs/swagger.yaml) | Current API contract source; validate with `npm run swagger:validate`. |
| [`../src/migrations`](../src/migrations) | Raw SQL migrations. |
| [`../prisma/migrations`](../prisma/migrations) | Prisma migrations. |

## Historical Snapshots

| Document | Notes |
| --- | --- |
| [`DB-SCHEMA-REFERENCE.md`](./DB-SCHEMA-REFERENCE.md) | Snapshot from 2026-04-04. Useful for comparison, not a live schema source. |
| [`RELEASE_NOTES_2026-04.md`](./RELEASE_NOTES_2026-04.md) | April 2026 release summary. |

Obsolete per-app roadmaps, coverage snapshots, and cross-repo convention notes
were removed because they pointed at archived repositories, generated stale
route inventories, or completed scratch plans. Use the current root docs above
for new work.
