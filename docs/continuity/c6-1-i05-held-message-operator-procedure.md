# C6.1-E I05 held-message operator procedure

## Current authority boundary

Migration 606's C5.2 workbench is the owner and decision surface for continuity
reconciliation. The typed held-message executor extends that workbench with one
receipt-backed exception for an explicitly bound message. An accepted generic
C5.2 decision is not send authority. Only an applied C5.1 held-message receipt
from the typed release endpoint can rearm the I05 row for later dispatch.

Migration 611 leaves every recovered I05 message held by default. A replay
batch only records skipped evidence, `dispatch-now` selects only live-authorized
work, and neither command releases a quarantined message.

## Interim operator procedure

1. Inspect the message and its append-only attempts and receipts in the existing
   interface-engine workbench. Treat `quarantined`, `send_authority = held`, or
   `owner_reconciliation_required = true` as a do-not-send state.
2. Keep the canonical pending-review task open. For a declared continuity
   incident, record the corresponding C5.2 interface requirement and high-water
   evidence, bind the one exact held message, and preserve the immutable source
   fingerprint. Record the distinct safety attestation and named-owner release
   only when the workbench shows the exact evidence is sufficient.
3. Do not use replay batches, `dispatch-now`, migration reruns, direct SQL, or a
   status-only update as a release mechanism. Those paths cannot establish the
   independent send-authority evidence required by the I05 contract.
4. Invoke only the typed C5.2 held-message release endpoint. Treat an `applied`
   or `exact_duplicate` result with the immutable C5.1 receipt outcome
   `held_message_send_authority_rearmed` as authority for the ordinary
   dispatcher to claim the message later. The endpoint does not send, mark sent,
   fabricate an acknowledgement, or advance a cursor.
5. If the workbench, receipt executor, runtime evidence, distinct safety key, or
   named owner is unavailable, leave the message held and escalate. There is no
   SQL fallback.

## Implemented release boundary

The C5.2 executor binds one same-tenant I05 message to one facility incident and
interface requirement. In one fenced transaction it verifies the latest source
state, requires the distinct safety attestation and named releaser, claims and
finalizes the C5.1 receipt, appends evidence, and compare-and-swaps the message
to queued owner-authorized work. The existing dispatcher recognizes that state
only with exact applied receipt/effect proof. No second reconciliation ledger,
predicate-bulk release, or direct database release path is permitted.

This repository capability remains inert until it is merged, deployed, and
separately activated under the applicable owner and clinical-safety gates.
