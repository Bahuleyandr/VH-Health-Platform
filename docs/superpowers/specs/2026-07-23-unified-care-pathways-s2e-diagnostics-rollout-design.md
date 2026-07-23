# Unified Care Pathways S2e — Diagnostics Rollout and Evidence

**Status:** implementation design; production activation remains owner-gated

**Grounding revision:** `2465e46a0d3023e56362dab2d8e55cadb8637beb`

**Migration:** `593_structured_diagnostic_patient_notifications.sql`

**Program authority:** `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md`

## Outcome

S2e makes the completed Radiology/AP loop operable as a controlled pilot. It registers the Diagnostics vertical reconciliation profile, provides read-only admin evidence, adds a deliberate release-state backfill command, and adds a durable patient result-ready notification that is disabled unless the pathway is active and the tenant explicitly enables it.

This slice includes an audited, dry-run-first operator command that can set one exact tenant and canonical pathway only to `off` or `shadow`. It requires an active tenant administrator and an explicit observation acknowledgement, and it is deliberately incapable of setting `active`. Nothing supplies clinical timing, clean-streak thresholds, escalation recipients, break-glass authority, retention policy, or production activation approval.

## Registry correction

Database governance and workflow-definition row IDs are tenant-generated. A process-wide immutable registry therefore cannot safely hard-code them. The adapter matches the immutable clinical artifact identity—pathway key, definition version, and compiled definition checksum—while the reconciliation transaction separately verifies every tenant-specific definition/governance/approval row and includes the complete governance tuple set in the evidence checksum.

Diagnostics is the first production vertical adapter. The remaining five profiles stay explicitly incomplete.

## Diagnostics evidence

The vertical profile checks:

- every signed Radiology/AP base report and addendum has one exact immutable generation;
- legacy signed sources without specialist classification remain visible as blockers and are never inferred;
- generation chains are contiguous and predecessor-linked;
- item hashes, canonical evidence, projector evidence, owner viability, doctor action, acknowledgement, task/SLA and supersession contracts agree; and
- every structured generation has a patient-release state.

Shadow observations create evidence only. A repaired or backfilled observation is not a clean activation observation; a later unchanged zero-drift sweep is required.

## Historical release-state backfill

The backfill command is dry-run by default and requires an exact tenant, active tenant administrator and reason. Apply mode additionally requires an explicit acknowledgement that registering an old eligible current generation can make it visible under the already-approved release predicate, and commits an audit record with the reviewed counts. It inserts only missing release-state rows for existing immutable structured generations. It never invents classification, creates a generation from a legacy report, sends a notification, changes pathway mode, or repairs clinical action.

## Patient notifications

Migration 593 stores one append-only receipt per tenant, generation, and result-ready kind. The receipt and `notification_outbox` row commit atomically. A tenant-and-generation advisory lock plus the unique receipt key make concurrent scheduler attempts converge on one outbox row. Delivery copy is deliberately generic and contains no modality, pathology label, classification, finding, patient name, or report text. The only route is the allowlisted `/portal/diagnostic-results` list.

The scheduler is inert unless both conditions hold:

1. `tenants.settings.care_pathways.diagnostics_order_to_action = active`; and
2. `tenants.settings.care_pathways.diagnostic_result_notifications = enabled`.

This separates clinical pathway activation from the still-governed notification policy. Shadow pilots do not notify patients.

## Rollout sequence

1. Deploy migration and code to the Dalekdefender test rig.
2. Register the compiled Diagnostics definition using named clinical and operational owners and an active administrator as approver. The approval and governance timestamps are both sourced directly from the database transaction.
3. Use the audited mode command to set only the test tenant to `shadow`; enable the projector and reconciliation observer, not repairs. The Dalekdefender overlay carries those observer flags and keeps repair disabled.
4. Run the release-state backfill in dry-run mode, review blocker counts, then apply only with the visibility acknowledgement.
5. Exercise normal, abnormal, critical, indeterminate and addendum journeys; confirm no shadow task, SLA or notification is created.
6. Collect reconciliation observations and review them in the admin evidence page.
7. Run the read-only evidence command with owner-supplied window values.
8. Production activation, notification enablement and any live backfill remain separate audited owner actions.

## Required proof

- fresh migration and Prisma/schema-drift checks;
- registry conformance and semantic adapter matching across tenant-specific row IDs;
- exact source/generation/release reconciliation and legacy blocker tests;
- backfill dry-run/apply/idempotency and no-notification tests;
- tenant-scoped shadow-mode dry-run/apply/audit/restore tests, including proof that the operator cannot select `active`;
- notification visibility, gating, atomic outbox/receipt, replay and PHI-free payload tests;
- admin route policy, API and evidence-page tests;
- patient push and in-app deep-link tests; and
- the existing Diagnostics order-to-action journey and Radiology/AP deep suites.
