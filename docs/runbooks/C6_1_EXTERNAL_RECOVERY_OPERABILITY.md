# C6.1 external-recovery operability

This runbook describes evidence collection and response. It does not activate an
interface family, start a worker, authorize a bulk replay, weaken a recovery
fence, or change cursor semantics.

## Preconditions

- Treat an absent or stale `external_recovery_observation_timestamp_seconds`
  as unknown output, never as healthy output.
- Use the Admin **Continuity Reconciliation > External recovery** workbench and
  select one exact tenant, family, direction, partition, and generation.
- Preserve the offset state fingerprint, marker, retained-range evidence,
  signed owner/retention evidence, action receipt, and request ID.
- Do not use direct SQL against `event_consumer_offsets`.

## Offset and inbox response

1. Identify the exact alert labels: tenant, honest facility scope/facility,
   family, and direction.
2. Open the exact workbench row and record the partition/generation, state
   fingerprint, safe marker evidence, pending/dead counts and ages, and latest
   immutable command receipt.
3. For `reconciliation_required_*`, preserve source and retained-range evidence
   and obtain the named interface-owner decision. Never start at zero or at the
   source tail.
4. Register or resume only the exact item through the authenticated Admin
   command if its server-derived capability is true. A receipt authorizes only
   that transition; it does not start the worker or advance the cursor.
5. For dead or stalled work, preserve the exact inbox/offset evidence and
   escalate to the interface owner. Do not predicate-bulk redrive.

## Late-critical continuity awareness

`ExternalRecoveryCriticalReviewUnacknowledged` is an operational continuity
page, not a retrospective lab alarm or clinical SLA breach.

1. Open **Critical Results / Clinical Inbox** for the labelled tenant/facility.
2. Locate the task marked **Recovered critical result — acknowledgement
   required** and verify it remains critical priority, `DUTY_DOCTOR`, no-SLA,
   and pending clinical review.
3. An authorized clinician acknowledges the existing inbox task. The task
   moves to `in_progress` and the immutable continuity-awareness receipt is
   appended atomically.
4. Confirm the database-output metric clears on the next complete observation
   and that Alertmanager sends the resolved notification.
5. Confirm no `lab_critical_alerts`, `workflow_sla_instances`,
   `care_pathway_transition_events`, or `notification_outbox` row was created
   by the recovery path.

## Delivery acceptance

Rule presence is not activation evidence. Before any external-recovery
activation, complete the C1.3 live drill in
`docs/runbooks/C1_3_MONITORING_LIVE_DRILL.md`, including the source series,
evaluated rule, operations/PagerDuty/continuity receiver delivery, external
Watchdog, resolution, and a named human acknowledgement.

## Rollback

Disable the new Admin commands and operational page source. Do not delete or
rewrite action, obligation, acknowledgement, audit, offset, inbox, task, or
result evidence. Existing Clinical Inbox tasks remain available for manual
review and acknowledgement under incident command.
