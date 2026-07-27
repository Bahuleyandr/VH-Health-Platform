# Unified Care Pathways S5 — ED Completion Implementation Plan

1. Add migration 597 with revisioned ED closure evidence, recovery contact
   events, exact foreign keys, append-only guards, tenant RLS, task binding,
   and active-mode planned-closure constraints.
2. Add the ED closure/recovery domain service with strict owner
   authorization, idempotency, canonical timeline/audit records, outbox
   events, exact follow-up/handoff/death/MLC validation, and task settlement.
3. Extend ED routes and staff API models for closure history, continuity
   status, closure recording, recovery attempts, and recovery outcome.
4. Add emergency definition v2, workflow runtime registry v6, projector
   generation 6, and reconciliation registry v7 while freezing all previous
   versions.
5. Extend patient What's Next with an exact allowlist projection of the latest
   released ED patient-safe next steps.
6. Add the staff ED continuity panel and focused widget/API tests.
7. Add migration, service, route, runtime, replay, reconciliation, tenancy,
   actor-authorization, patient-redaction, and end-to-end ED journey tests.
8. Run backend lint/unit/deep/journey/schema/OpenAPI gates and staff
   format/analyze/tests, then open one PR without activating or deploying.
