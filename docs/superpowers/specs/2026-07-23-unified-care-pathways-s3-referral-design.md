# Unified Care Pathways S3 — Referral Request to Closure

**Status:** implemented; production activation remains evidence- and owner-gated

**Grounding revision:** `d912bbd8af77027295b2e612bad78011f01b81d8`

**Migration:** `594_referral_closed_loop.sql`

**Program authority:** `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md`

## Outcome

S3 turns the existing referral request and response endpoints into one closed clinical loop. An internal referral requires a named, active, same-tenant receiving clinician. Merely seeing the referral does not stop its response clock or transfer ownership. The receiving clinician must explicitly accept, decline, or be replaced through an audited reroute. A completed specialist response is structured, immutable and electronically signed; it does not close the referral unless the receiver explicitly retains continuing ownership. Otherwise, the originator must acknowledge the response and record how it changed the plan.

The existing seeded `referral_response` rule remains the timing authority. This slice does not invent or change clinical timing, business hours, escalation recipients or thresholds.

## Clinical truth and evidence

Migration 594 adds explicit current ownership, accepted ownership time, appointment linkage, optional expiry, repeat/referral replacement provenance, request idempotency and a closure state separate from specialist work status. It adds:

- `referral_transition_events`: append-only, sequence-numbered lifecycle evidence linked to canonical timeline and audit rows;
- `referral_responses`: immutable versioned specialist responses with content fingerprints and document-integrity signatures; and
- `referral_patient_notifications`: one durable receipt for each released response notification.

All lifecycle mutations lock the referral row inside a tenant transaction. Each transition, canonical timeline entry, clinical audit entry, task/SLA mutation and domain update commits atomically. Exact retries return prior evidence. Reusing an idempotency key for different content is rejected. A deliberate repeat must identify the prior referral and state a reason.

## Ownership and closure rules

For internal referrals:

1. The originator owns the request until a named receiving clinician accepts it.
2. `seen` records visibility only. It leaves the receiver task open and the `referral_response` SLA active.
3. Acceptance requires the named receiver personally. There is no administrative shortcut that can accept or sign on the receiver's behalf. In active mode, acceptance completes the receiver's linked task/SLA, transfers current ownership and creates a second named task for the specialist response.
4. Decline returns the obligation to the originator with a named reroute task.
5. Reroute cancels the old receiver task, re-arms the existing SLA from its pinned rule, and creates a new named receiver task. It never guesses an owner.
6. A structured specialist response requires assessment and recommendations and is signed in the same transaction that completes its named response task. `completed` means the specialist response exists; it does not mean the loop is closed.
7. If the receiver records continuing ownership, that signed decision closes the loop. Otherwise, a named originator task remains open until the originator records a plan update or an approved closure disposition. A different qualified doctor may close only as an explicit audited covering-doctor override with a reason and an active care-team relationship to the patient; non-clinical administrators cannot perform clinical closure.
8. Patient-declined and lost-to-follow-up closure require recorded recovery attempts. Expiry or missed/no-show appointments create a recovery task and never auto-close the referral.

External referrals remain on the pre-S3 referral path in every rollout mode until the owner approves the external-provider communication, identity and evidence policy. S3 does not pretend an external clinician can participate in the internal acknowledgement or signing protocol.

## Patient release

Patient visibility is fail-closed. The portal returns only a response that:

- belongs to the authenticated patient and tenant;
- has an integrity signature;
- was explicitly marked `release_to_patient`; and
- has both a patient-safe summary and patient instructions.

The portal never exposes the specialist assessment or recommendations fields. The patient list and detail route remain unavailable unless `tenants.settings.care_pathways.referral_request_to_closure` is `active`. Notification creation additionally requires `care_pathways.referral_notifications = enabled`. Notification copy contains no referral reason, specialty, assessment, recommendation, patient name or other clinical content; it links only to `/portal/referrals`.

## Runtime and reconciliation

The code-reviewed workflow definition has four stages: named receiver acceptance, signed specialist response, originator closure and finalization. The runtime handlers derive their decisions from referral rows and signature evidence; `seen` cannot satisfy acceptance.

The projector starts or advances this pathway only from the reviewed referral event catalog. Generation 2 remains replayable through its pinned registry; generation 3 adds Referral without changing earlier semantics.

The Referral reconciliation profile checks transition ordering and canonical links, named receiver task/SLA obligations, response/signature and closure shape, expiry/no-show recovery tasks, and projected pathway state. It records evidence in shadow mode and does not repair clinical facts.

## Historical backfill

`care-pathways:backfill-referral-receiver-tasks` is dry-run by default. Apply mode requires an active tenant administrator, a reason and `--acknowledge-safe-referral-backfill`. It creates only missing receiver tasks for pending internal referrals where all of the following already exist:

- a named active route-capable receiving doctor;
- an active, breached or escalated incomplete `referral_response` SLA with a deadline, or a completed SLA whose recorded completion action is exactly the legacy `seen` defect; and
- no existing actionable receiver task.

It copies the SLA’s exact deadline and links the same referral source identity. For the narrowly identified legacy `seen` defect, it reopens the same SLA without changing its original deadline, marks an already-past deadline breached, removes stale completion evidence and records the reason/source. It skips nameless or unavailable receivers and every other missing or completed clock. It does not create referrals, infer ownership, close referrals or notify patients.

## Rollout sequence

1. Deploy migration and code with Referral mode `off`. Off mode preserves the pre-S3 referral mutation path. Shadow mode writes the new append-only domain evidence and signed response needed for projection/reconciliation, but creates no pathway tasks, recovery tasks, patient notifications or patient surface. Active mode enables the complete task-first loop.
2. Register the exact compiled definition with named clinical and operational owners, an administrator approval and an owner-approved patient visibility policy reference.
3. Run the receiver-task backfill in dry-run mode. Review every skipped category before any separately authorized apply.
4. Set one test tenant to `shadow`; keep patient visibility and patient notifications off.
5. Exercise request, seen, unauthorized access, accept, decline/reroute, structured response, originator closure, continuing ownership, duplicate request, intentional repeat, expiry and no-show journeys.
6. Review the Referral reconciliation profile and require an owner-defined clean evidence streak.
7. Production `active`, patient notification enablement and any historical apply remain separate audited owner actions.

## Required proof

- fresh 000-to-594 migration and schema-drift checks;
- full seed coverage for the four Referral evidence tables;
- task/SLA binding and the existing generic breach sweep;
- real-database request-to-closure journey, including proof that `seen` leaves the SLA active;
- unauthorized receiver, administrative accept-on-behalf and sequential-detail denial before mutation or PHI response;
- off/shadow/active conformance proving legacy preservation, shadow task suppression and active named-task enforcement;
- replay, concurrency, idempotency-key mismatch and intentional-repeat tests;
- response signature, closure, reroute/re-arm and recovery-task tests;
- patient release, notification gating, deep-link and patient-safe projection tests;
- admin oversight, staff workflow and mobile write-policy tests; and
- existing referral authorization, canonical atomicity and patient child-route guard suites.
