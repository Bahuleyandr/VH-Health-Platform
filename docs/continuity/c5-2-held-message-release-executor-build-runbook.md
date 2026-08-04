# C5.2 held-message release executor build runbook

## 1. Authority and scope

This build implements the approved C5.2 owner-directed held-message release
delta for one explicitly bound I04, I05, or non-payment outbound I19 message.
It is an inert software capability. Merge, deployment, connector enablement,
facility policy, credentials, clinical sign-off, and production activation are
separate authorities.

The executor grants send authority only. It does not send, mark sent, fabricate
an acknowledgement or transport result, advance a cursor, redrive, release a
batch, or retroactively fire pathway, service-level agreement, timeline, or
notification effects. I18 is not implemented and an `unclassified` I18
subscription is not releaseable.

## 2. Command contract

The only release action is
`clinical_continuity.interface_held_message.release/v1`. A C5.2 reconciliation
item binds one source message to one active incident-interface requirement and
one named owner task. The server derives the safety class:

- I04 and I05 are `safety_critical` and require a distinct attester plus the
  named releaser;
- non-payment outbound I19 is `routine_operational` and requires the named
  releaser; and
- any other or unclassified family fails closed.

The release transaction claims and finalizes one C5.1 receipt, appends its
effect evidence, audit event, and C5.2 decision, and compare-and-swaps only the
family-specific send-authority fields. An exact duplicate returns the prior
immutable outcome. Actor, reason, source state, version, or attestation drift
records a mismatch attempt and fails closed.

## 3. Operator sequence

1. Inspect the exact source message, immutable source-state fingerprint,
   payload hash or ciphertext evidence, attempts, acknowledgements, recovery
   inbox, and current channel, subscription, or NHCX runtime state.
2. Link one exact message to the active C5.2 incident-interface requirement.
   Predicate-bulk and batch binding are unavailable.
3. Keep the named no-SLA review task open while evidence is reviewed. For I04
   and I05, record the distinct safety attestation over the exact command
   fingerprint.
4. Invoke the typed release endpoint with a unique `Idempotency-Key`. Treat only
   an `applied` or `exact_duplicate` result carrying
   `held_message_send_authority_rearmed` as release evidence.
5. Allow the ordinary family dispatcher to claim the message later. Release is
   not delivery, acknowledgement, or cursor evidence.

If the workbench, receipt executor, runtime readiness check, or required owner
is unavailable, leave the message held and escalate. There is no SQL fallback.

## 4. Prohibited release paths

Never use direct SQL, a status-only or send-authority-only update, migration
rerun, replay batch, `dispatch-now`, redrive, broad dispatch, a generic C5.2
decision, or a fabricated receipt/effect row as release authority. Database
guards require the applied receipt and effect in the same transaction and deny
direct mutation by the privileged application role.

## 5. Validation gate

Merge remains blocked until all of the following pass on the exact candidate
commit:

- fresh zero-database migration through 624, migration rerun, Prisma generation
  from that database, schema validation, and drift checks;
- comprehensive seed and seeded database contracts with no unexpected empty
  registry or mirror;
- raw-PostgreSQL direct-forgery negatives for I04, I05, and I19, plus an
  unclassified-I18 refusal;
- focused and full backend tests, lint, security/static gates, and all
  family-specific dispatcher proofs;
- canonical OpenAPI generation, byte-identical core mirror, Spectral with zero
  errors, and zero lint-budget additions;
- Admin, shared-core, and Staff lint/analyze/type/test/build gates; and
- a final frozen-ledger and forbidden-scope audit.

Passing these checks does not authorize merge, deployment, or activation.

## 6. Rollback

Code rollback hides and disables bind, attest, and release commands while
leaving the additive schema and all items, tasks, decisions, receipts, effects,
audits, attempts, acknowledgements, cursors, and recovery rows intact. It never
rewinds a release already consumed by a dispatcher. Stopping a released but
unclaimed message requires a separately authorized, receipt-backed command and
is outside this slice.
