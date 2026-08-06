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

## I03 inbound ADT/ORM recovery

I03 remains inert until one exact sender credential and partition satisfy the
canonical activation gates. An HL7 `AA` from this recovery path means only that
the exact message was durably accepted for human reconciliation; it does not
mean that an admission, transfer, discharge, investigation, or order was
applied.

### Sender and marker preconditions

- Require an active DB-backed `tenant_interop_secrets` credential with
  `kind='hl7_inbound'`. The environment-secret fallback has no durable
  credential identity and cannot be enrolled for I03 recovery.
- Prove the backend can load the tenant's existing active wrapped field-
  encryption KEK with its configured master KEK before replay. Do not provision
  or rotate a tenant KEK in the recovery request path, and do not rerun tenant
  onboarding as a recovery shortcut; inability to load the exact tenant key is
  a fail-closed stop.
- Obtain external sender or bridge spool evidence for retained exact message
  bytes, durable monotonic positions, predecessor tokens, source timestamps,
  and outstanding counts. Backend receipt time, MSH-10, MSH-13, or "start from
  now" is not a substitute for that source evidence.
- Reconcile and sign the initial marker, retained range, outstanding count, and
  resume cutoff separately for
  `i03/credential/<credential-id>/family/adt` and
  `i03/credential/<credential-id>/family/orm`. ADT A01/A02/A03 share the ADT
  partition; ORM O01 uses the independent ORM partition.
- If either partition lacks a reconciled initial position/token, keep it on
  **HOLD** in `reconciliation_required_missing_marker`. Never infer position
  zero, the source tail, or the other partition's marker.
- Register and resume an exact I03 partition only through the authenticated
  Admin external-recovery commands. Do not create, alter, or advance its offset
  with direct SQL, and do not treat an Admin command receipt as worker-start
  authority.

### One-partition replay procedure

1. Keep that sender's external HL7 ingress closed. Restore and verify the
   database, field-encryption keys, replay store, task service, and canonical
   recovery substrate before replay.
2. In the Admin workbench, register the exact credential/family partition and
   generation. Record the resulting state fingerprint and immutable command
   receipt. A missing marker remains on HOLD.
3. After the accountable owner has signed that partition's retained range,
   outstanding-count reconciliation, and cutoff, authorize resume for only
   that exact offset through the Admin workbench.
4. Replay **one partition at a time**. Do not interleave ADT and ORM recovery,
   and do not reopen normal ingress while either backlog is being reconciled.
5. After every item, verify one append-only
   `hl7_inbound_recovery_receipts` record, one reachable no-SLA review task,
   one stored exact ACK and hash, one terminal canonical inbox outcome, and the
   expected cursor decision. ADT tasks route to `MEDICAL_RECORDS`; ORM tasks
   route to `DUTY_DOCTOR`.
6. Confirm the returned ACK bytes are the committed bytes and an exact handled
   retry returns the same ACK without another receipt or task. Treat `AA` only
   as acceptance for reconciliation with no live clinical effect.
7. Stop immediately on a missing position, predecessor mismatch, source or
   retention gap, duplicate/payload conflict, absent receipt/task/ACK, or cursor
   mismatch. Preserve the evidence and return the exact offset to owner
   reconciliation; never skip an item or advance to the next position.
8. At the signed cutoff, verify the terminal cursor equals that cutoff, receipt
   and task counts equal the reconciled source count, and every late item has a
   reachable review task. Repeat the procedure independently for the other
   partition.
9. Reopen that sender's normal live ingress only after both partitions have
   reached their signed cutoffs, all evidence checks pass, and incident command
   records the owner decision. Registration, resume, replay evidence, or an
   `AA` alone grants no authority to reopen ingress.

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
