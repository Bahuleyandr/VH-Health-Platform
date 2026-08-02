# C6.1-E I05 held-message operator procedure

## Current authority boundary

Migration 606's C5.2 workbench is the owner and decision surface for continuity
reconciliation. It can record interface high-water requirements, resolve the
configured interface owner, assign an existing task, and append an immutable
decision. Its executor does not reference or mutate an I05 `interop_messages`
row, so an accepted C5.2 decision is not send authority and cannot release a
quarantined message.

Migration 611 therefore leaves every held I05 message held. A replay batch only
records skipped evidence, `dispatch-now` selects only live-authorized work, and
neither command releases a quarantined message.

## Interim operator procedure

1. Inspect the message and its append-only attempts and receipts in the existing
   interface-engine workbench. Treat `quarantined`, `send_authority = held`, or
   `owner_reconciliation_required = true` as a do-not-send state.
2. Keep the canonical pending-review task open. For a declared continuity
   incident, record the corresponding C5.2 interface requirement and high-water
   evidence; record the owner decision in that workbench when evidence is
   sufficient.
3. Do not use replay batches, `dispatch-now`, migration reruns, direct SQL, or a
   status-only update as a release mechanism. Those paths cannot establish the
   independent send-authority evidence required by the I05 contract.
4. If the owner decision requires a resend, retain the message and decision
   evidence in the held state until the typed C5.2 executor below is available.

## Required release slice

The release executor belongs in a post-train C6.1-E follow-up, after migrations
611-616 and before any I05 protocol activation. It must derive migration 617 or
higher and extend the existing C5.2 reconciliation item and decision model with
a same-tenant typed I05 message binding. In one fenced transaction, the executor
must append the owner decision, verify the latest attempts and receipts, and
compare-and-swap the held message to queued owner-authorized work. The database
claim contract and dispatcher must then recognize that owner-authorized state.
No second reconciliation ledger or direct release endpoint is permitted.
