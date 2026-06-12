# QA Findings Archive

This folder stores dated QA and swarm triage evidence. These files are useful
for reproducing older failures, understanding why a fix was made, or comparing
new regressions against prior incidents.

They are not current release gates. For current go/no-go decisions, use:

- [`../RELEASE_READINESS.md`](../RELEASE_READINESS.md)
- [`../SMOKE_E2E_JOURNEYS.md`](../SMOKE_E2E_JOURNEYS.md)
- [`../DB_SCHEMA_GUARDRAILS.md`](../DB_SCHEMA_GUARDRAILS.md)
- [`../SECURITY_HARDENING_CHECKLIST.md`](../SECURITY_HARDENING_CHECKLIST.md)

When adding a new finding, include the date, target environment, exact command
or workflow, observed failure, expected behavior, and the commit or deployment
version tested.
