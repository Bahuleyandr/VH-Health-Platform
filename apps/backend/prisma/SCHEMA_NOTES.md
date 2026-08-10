# schema.prisma — design notes

Comments captured from `prisma/schema.prisma` before regenerating it with
`prisma db pull`. Prisma strips `//` lines on pull (it preserves only `///`
doc comments). This file holds the rationale behind columns, migrations,
and design decisions that would otherwise be lost.

_Keyed by Prisma model name. `__top_level__` holds comments outside any model._

## Top-level

- L4983: `// A11 — structured per-category caps for TPA / insurance claims`
- L4984: `// (migration 178).`
- L8574: `// IPD support subsystem (migration 174). Per project decision 2026-05-09.`
- L8575: `//`
- L8576: `// advance_deposits — money collected against an admission's eventual`
- L8577: `// final bill. Receipt series RCT-YYYYMM-NNNN, distinct from invoices.`
- L8578: `// Refunds are sibling negative-amount rows pointing at parent_deposit_id`
- L8579: `// so the trail is auditable.`
- L8606: `// attendant_passes — 2 per admission, auto-issued at admit. Pass color`
- L8607: `// snapshotted from ward at issue time. Expires at discharge.`
- L8635: `// ward_indents — pharmacy/stores → ward consumables flow.`
- L8636: `// State machine: requested → approved → issued → received (rejected as terminal).`
- L9496: `// Tenant-configurable normal ranges with sex + age applicability`
- L9497: `// (architectural item A5 / migration 175). Lookup picks the most`
- L9498: `// specific match. Critical thresholds co-located so a single read`
- L9499: `// returns normal + critical bounds for a test.`

## model:admissions

> ER linkage. When a patient is admitted from the emergency department,
> from_er_visit_id points back at emergency_visits.id; er_arrival_at is
> the original door-time so SLA / door-to-bed reports don't need a join.
> Migration 170. See finding
> 2026-05-08-emergency-walk-in-doctor-admit-no-er-visit-linkage.

> Bedless-emergency tracker. Set when an admission is created without
> a bed under the emergency exception (admission_type='emergency' AND
> priority='emergent'). Migration 171. Once a bed is assigned later
> via /admissions/:id/assign-bed, the bed_transfers row carries the
> assignment timestamp; bed_pending_since stays as the historical
> anchor for SLA / door-to-bed reports.

> Agreed-room-category at admit time (migration 177). Tariff +
> TPA pre-auth use this, NOT the assigned bed's bed_type, because
> the patient is billed at the agreed rate even while waiting for
> their preferred category to free up. See finding
> 2026-05-08-inpatient-admission-admission-no-semiprivate-room-category.

> B-4 — emergency consent bypass tracking (migration 182). Set when
> admitPatient fires under emergency + emergent priority and the
> active-treatment-consent check is overridden by implied-consent
> doctrine. Powers the post-stabilisation consent-capture worklist.

> B-6 — discharge summary PDF persistence (migration 183). NULL
> until the post-signoff persisted-PDF path runs the first time;
> thereafter, the R2 object key for the immutable snapshot.

> Discharge cascade lifecycle markers (migration 173). T0..T4.
> discharged_at (existing) is T4 = patient physically left.

> IPD support subsystem (migration 174).

## model:beds

> Denormalized back-link to the active admission. Populated on admit /
> assign-bed / transfer; cleared on discharge / transfer-out.
> Migration 172. See finding
> 2026-05-08-inpatient-admission-admission-bed-not-back-linked.

## model:doctors

> E-9 — paediatric / adult / all (migration 189). Powers the
> /doctors?ageRange=paediatric filter on the paeds OPD list.

## model:emergency_visits

> Back-relation for admissions.from_er_visit_id (migration 170).

## model:insurance_claims

> A11 — per-category caps (migration 178). Structured equivalent of
> the jsonb caps merged into documents by batch 9.

## model:investigations

> E-5 — result versioning (migration 185). previous_results holds
> an array of prior snapshots; result_version increments on each
> re-submit. collected_at + collected_by track the COLLECTED state.

## model:users

> E-9 — guardian fields for paediatric / minor patients (migration 189).
> Captured at walk-in registration; updatable via PUT /users/:uid.
>
> Wave-3 batch-2 — walk-in field completion (migration 202).
> Adds weight_kg (paediatric dosing intake), guardian_id_type +
> guardian_id_reference (structured legal-ID), guardian_user_id (FK to
> the guardian's own users row — dependent-profile model), is_minor
> (set from birthday at registration), is_unidentified (ER walk-in
> without phone/ID; backend mints a UNIDENT-EMER-<ts> synthetic phone
> so the UNIQUE(phone) constraint is not violated; merge-me target
> for a future identity-reconciliation flow). Partial indexes:
> idx_users_guardian_user_id WHERE NOT NULL, idx_users_is_minor and
> idx_users_is_unidentified each WHERE TRUE. The guardian_user_id FK
> is a self-reference (users → users) with ON DELETE SET NULL —
> deleting a guardian leaves the dependent row intact, just unlinked.

> ABHA verification gate (migration 653). abha_verification_status
> ('pending' | 'verified', CHECK chk_users_abha_verification_status) +
> abha_verified_at record whether the linked ABHA number was confirmed
> with the ABDM gateway. 'verified' is minted only by a successful
> gateway check (registerABHA with ABDM enabled, or
> POST /abdm/my-abha/verify); ABDM-disabled linking and the
> ABDM_ABHA_ALLOW_UNVERIFIED override mint 'pending'. The expression
> index uniq_users_tenant_abha_number_canonical (migration 647, not
> introspectable by `prisma db pull` so absent from schema.prisma) was
> re-created in 653 with its predicate extended to
> `AND abha_verification_status = 'verified'` — pending claims do not
> consume the tenant-unique slot, so an unverified squat cannot lock
> out the rightful ABHA holder. Inbound ABDM callback resolution and
> the staff patient-by-abha lookup resolve verified links only.

## model:wards

> Attendant-pass color + screening level snapshot for the IPD support
> subsystem (migration 174). Per project decision 2026-05-09: deluxe /
> ICU get distinctive colours + relaxed screening; general wards keep a
> generic colour + standard/strict screening.

## model:lab_results

> Panel grouping (architectural item A5 / migration 175). Multiple
> analytes from the same panel entry session share a panel_id;
> panel_code is the template (CBC | LIPID | RFT | THYROID …) so
> reports + trend queries can group by it.

## model:cash_drawer_sessions

> Cashier shift-close / cash-drawer reconciliation (migration 198,
> wave-2 batch). One row per cashier per shift open; closed/reviewed
> rows accumulate as audit history. A partial unique index on
> `(tenant_id, cashier_uid, shift) WHERE status='open'` (NOT a Prisma
> model attribute — enforced at the DB layer) keeps the "one open
> session at a time per cashier" invariant. `system_total` is the
> CASH-mode billing_payments total for the same cashier+shift since
> `opened_at`. `variance = counted_total - (system_total +
> opening_float)`. A non-zero variance flips short_count / over_count;
> when |variance| exceeds CASH_DRAWER_VARIANCE_TOLERANCE (env, default
> ₹1) the session stays `closed` with `requires_review=true` until a
> FINANCE_INCHARGE / ADMIN signs it off. Within tolerance, the close
> handler auto-stamps `reviewed_at` and flips to `reviewed`.


## model:tpa_claims

### Migration 221 — `stage` + `parent_claim_id` (self-referential FK)

Final claim API accepts `stage` and `parent_claim_id` in the request body
but the columns didn't exist on `tpa_claims`, so they were silently
dropped. Without the link the TPA portal can't auto-correlate the
final claim with the originating preauth/enhancement and the auditor
can't reconstruct the full episode chain.

`stage` is one of `'preauth' | 'enhancement' | 'final' | 'reimbursement'`
(default `'final'` for backward compat with existing rows, since they're
all final claims by construction). `parent_claim_id` is a FK to
`tpa_claims(id)` with `ON DELETE SET NULL` — the migration creates the
constraint, but Prisma's introspection drops the `onDelete: SetNull`
annotation on self-referential nullable FKs (the DB-level behaviour is
preserved regardless). Index `idx_tpa_claims_parent_claim` on
`parent_claim_id` for parent-traversal queries.

The chip hint about `insurance_preauth.parent_preauth_id` covers the
mid-stay enhancement hop; this migration adds the *claim*-level link
so a final claim row also knows its predecessor preauth-claim.
Finding: `2026-05-09-tpa-insurance-claim-discharge-final-claim-stage-dropped`.
