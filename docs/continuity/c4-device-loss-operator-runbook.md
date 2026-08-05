# C4 device-loss operator runbook

**Status:** post-orchestration physical handling and verification procedure. This
runbook does not activate the tenant capability, grant SUPER_ADMIN authority, or
replace server evidence.

## 1. Open the incident and prove the exact target

Before executing the Admin action, open one security/continuity incident and
record:

- report time, reporter, loss or theft circumstances, and last-known contact;
- the stable device UUID from authoritative provisioning evidence;
- every affected Staff UID;
- the incident reference and incident-specific containment reason; and
- the accountable SUPER_ADMIN operator.

Do not infer the stable device UUID from an FCM token, browser identity,
hostname, friendly name, or clinical-device registry row. If the exact UUID or
affected identity set cannot be proved, stop and escalate; never contain a
guessed device.

## 2. Execute and preserve the server receipt

In **Facility Context > Device loss**, submit the exact device UUID, affected
Staff UIDs, incident reference, reason, and exact-device confirmation once.
Preserve the operation ID, request ID, ordered step states, evidence IDs,
break-glass exclusions, signed wipe-order identity and hash, C-D6 route, and
offline-pack risk deadline in the incident.

The server performs the ordered duties the old runbook handled manually:
capture and C3 edge-read grant revocation; C-D15 session, staff-session, device,
PIN and biometric shutdown through the existing SCIM service; token revocation;
one signed wipe order; and durable `needs_review` routing to the configured C-D6
fallback principal. Phase 1 relational shutdown and its audit evidence commit
atomically. Token revocation, signing and standing-route creation run afterward
with durable per-attempt evidence because they cannot share that transaction.

If the response is incomplete or unavailable, keep the incident open and retry
the unchanged request with the displayed idempotency key. Re-invocation keeps
the same operation and wipe-order identity, skips proved steps, and retries the
first unfinished step. Never replace a failed step with a local checkbox or an
edited receipt.

## 3. Control the physical device

If the device is recovered:

1. isolate it from clinical use and do not reconnect it to a trusted network;
2. preserve chain-of-custody, recovery time, finder, condition, SIM/removable
   media state, and photographs where policy permits;
3. quarantine it for security/forensic inspection; and
4. do not unlock, browse, factory-reset, repair, or reassign it before the
   security owner records a disposition.

If it remains missing, record the physical search and notification actions,
including security, department leadership and any external authority required
by hospital policy. The server receipt does not prove physical recovery.

## 4. Verify wipe delivery and execution

The signed wipe order is initially `awaiting_contact`. On the device's next
authoritative contact, preserve the delivery acknowledgement and execution
receipt and verify that both bind the server-issued order ID, content hash,
stable device UUID and signing key. A queued or delivered order is not an
executed wipe.

If the device never contacts the service, keep the residual risk open through
at least the signed offline-pack expiry recorded by the operation. Revocation
does not retroactively erase an already valid offline pack.

## 5. Verify preserved unsynced work

When late work arrives from the lost device, verify that it is held as
`needs_review`, names the configured C-D6 fallback principal and assigned
safety lead, and retains the originating device-loss operation ID. The fallback
owner must reconcile the work through the existing C-D6 process. Never delete,
discard, auto-accept, or mark it reviewed merely because containment completed.

Record both positive routing receipts and the explicit result of checking for
late work. A standing route with no arrivals is not evidence that no offline
work exists.

## 6. Recovery, reprovisioning and closure

Reprovision only after the security owner has documented quarantine/forensic
disposition, wipe execution or approved destruction, and the owning department
has approved return to service. Use a new device credential and the ordinary
C-D14 enrollment process; never restore a revoked credential or reuse the
device-loss operation as enrollment authority.

Close the incident only when an accountable owner has verified:

- every server step is complete and its append-only evidence is attached;
- every named break-glass exclusion was reviewed under its separate control;
- physical recovery or missing-device handling is documented;
- wipe delivery and execution, destruction, or accepted residual risk has an
  owner and evidence;
- late unsynced work was checked and any arrivals were reconciled from
  `needs_review`; and
- quarantine, forensics and reprovisioning decisions are signed off.

## References

- [C-D10 countersigned record](c0-4-owner-decision-dossier.md#c-d10--break-glass-retention-device-loss-and-communications)
- [C-D14 countersigned record](c0-4-owner-decision-dossier.md#c-d14--capture-side-facility-context-operating-model)
- [Device-loss orchestration design delta](c4-device-loss-orchestration-design-delta.md)
- [Facility-context establishment and lifecycle](c4-facility-context-design-delta.md#5-establishment-and-lifecycle)
