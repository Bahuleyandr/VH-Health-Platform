# C4 device-loss operator runbook

**Status:** pre-activation operator procedure; the Admin portal performs only
capture-grant revocation. This runbook does not activate C-D14, create a missing
server capability, or authorize a clinical/organizational role.

## 1. Authority and boundary

The countersigned C-D14 record says:

> “IT/security alone maintains the staff-to-facility authorization set and
> performs device enrollment, re-provisioning, and revocation.”

The countersigned C-D10 record requires immediate grant and session revocation,
a signed governed wipe order on next contact, offline-pack expiry at no more
than 24 hours, and preservation of unsynced work as `needs_review` for the C-D6
fallback reconciliation principal.

The facility-context Admin page can execute only individual revocations of
`capture_fixed_device` and `capture_staff_facility` grants returned by the
landed capture-grant ledger. It cannot revoke C3 `edge_read` grants, target a
device session, issue or deliver a wipe order, shorten an already signed
offline-pack expiry, or move unsynced work to `needs_review`.

Until a unified device-loss orchestration contract lands, those duties are
completed and evidenced elsewhere. A capture-grant receipt alone is never a
completed device-loss response.

## 2. Start record

Open one incident/security record and capture these exact values before acting:

- report time and reporter;
- stable device UUID from authoritative device/provisioning evidence;
- affected Staff UID or UIDs;
- facility ID or IDs;
- loss/theft circumstances and last-known contact time;
- operator identity; and
- the incident/audit reference that will bind every downstream receipt.

Do not infer the stable device UUID from an FCM token, browser identity,
hostname, friendly name, or clinical-device registry row. If the exact UUID is
not proven, stop the portal portion and escalate through the security incident
process; do not revoke a guessed device.

## 3. Revoke capture grants in the Admin portal

1. Open **Facility Context > Device loss** as a temporarily authorized
   `SUPER_ADMIN` account.
2. Paste the full stable device UUID.
3. Copy the explicit enumeration of active capture grants into the incident
   record. The absence of a match does not prove the device safe.
4. For each displayed grant, separately:
   - verify the grant UUID, purpose, Staff UID if present, device UUID,
     facility ID, and validity;
   - enter the incident-specific reason;
   - type the full grant UUID; and
   - append the revocation.
5. Record the server request ID, revocation UUID, grant UUID, capture revision,
   revoker UID, timestamp, and reason from each response.
6. Re-read the ledger. Do not continue treating a failed, denied, or unavailable
   request as success. There is no bulk revoke and no optimistic completion.

## 4. Complete the duties outside this portal

Each item below requires an authoritative receipt from its owning control. Do
not use a portal checkbox, local note, or capture-grant receipt as a substitute.

### 4.1 Sessions

Revoke affected staff sessions through the established identity/security
control and attach its receipt. The existing Admin auth operation revokes all
sessions for a staff account; it is not an exact device-targeted C-D10
orchestration seam. Confirm the affected staff identity and the blast radius
before using it. If that broader action is not appropriate, escalate rather
than claiming device-session revocation.

### 4.2 C3 edge-read grants

Revoke every active `edge_read` grant for the exact device through the
continuity-edge security control and attach the grant/revocation receipts. The
facility-context Admin routes intentionally list and revoke capture purposes
only; they cannot prove this step.

### 4.3 Signed governed wipe order

Issue the signed governed wipe order through the approved device-management
control, preserve issuer/signature/order identifiers, and preserve delivery and
execution receipts. The order may execute only on the device's next contact.
There is no landed wipe-order endpoint in the facility-context Admin contract.

### 4.4 Offline-pack risk window

Record the signed offline-pack expiry and verify it is no more than 24 hours as
required by C-D10. Revocation does not retroactively erase a valid offline pack;
do not claim pack access ended before its signed expiry unless an authoritative
wipe receipt proves it.

### 4.5 Unsynced work and `needs_review`

Preserve and route unsynced captured work to `needs_review` for the C-D6
fallback reconciliation principal through the owning reconciliation control.
Record its receipt and owner. Never delete, discard, or mark work reviewed from
this Admin page. No landed facility-context endpoint performs this step.

## 5. Completion ledger

Keep the device-loss incident **incomplete** until every applicable row has an
authoritative receipt:

| Duty | Required evidence | Portal ownership |
| --- | --- | --- |
| Capture-grant revocation | One request ID and revocation row per explicitly enumerated grant | Facility Context page |
| Session revocation | Identity/security control receipt with affected Staff UID and scope | Elsewhere |
| C3 `edge_read` revocation | Exact edge grant and revocation receipts | Elsewhere |
| Signed wipe order | Signed order plus delivery/execution state | Elsewhere |
| Offline-pack expiry | Signed expiry and residual-risk record | Elsewhere |
| Unsynced-work preservation | `needs_review` routing receipt and C-D6 owner | Elsewhere |

If a required control is unavailable, record the blocker, preserve all receipts
already obtained, escalate to the security/continuity owner, and leave the
incident visibly incomplete. Do not retry by inventing a client-side success or
editing an append-only ledger row.

## 6. Follow-up contract gap

A separate backend slice must design and authorize a unified, idempotent
device-loss orchestration contract that can bind capture-grant, `edge_read`,
session, wipe-order, offline-risk, and `needs_review` receipts. Its capability
and accountable-role mapping are owner decisions. That backend work, any Staff
app work, and C-D14 activation are outside this Admin lane.

## References

- [C-D10 countersigned record](c0-4-owner-decision-dossier.md#c-d10--break-glass-retention-device-loss-and-communications)
- [C-D14 countersigned record](c0-4-owner-decision-dossier.md#c-d14--capture-side-facility-context-operating-model)
- [Facility-context establishment and lifecycle](c4-facility-context-design-delta.md#5-establishment-and-lifecycle)
- [Admin-surface design delta](c4-facility-context-admin-surface-design-delta.md)
