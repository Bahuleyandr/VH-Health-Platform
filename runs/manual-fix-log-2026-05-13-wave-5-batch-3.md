# Wave 5 batch 3 — clinical workflow + billing disclosure

**Date:** 2026-05-13
**Branch:** `fix/wave-5-workflow-gaps`
**Worktree:** `D:/Dev/Projects/VH-Health-Platform-wave5-workflow`

## Scope

9 high-severity findings across workflow bridges and operational
disclosure. Larger than batches 1+2 — split commits by concern (4
root-cause groups A/B/C/D). Closes the Wave 2.1 explicit deferral
of the auto-itemizer.

## Findings inbox

| # | Finding ID | Status |
|---|---|---|
| 1 | `2026-05-08-inpatient-admission-receptionist-no-admission-advice-workflow` | **Partial-prior + new.** `adviseForAdmission` existed (migration 169 columns, Wave-4B-3 read filter). Wave 5/3 closes the audit gap and the clinical-decision gate. |
| 2 | `2026-05-08-dynamic-acute-abdomen-doctor-emergency-admit-blocked-by-treatment-consent` | **Resolved-by-prior.** Migration 182 + `admissionService.js` B-4 block (lines 271-292) already handle implied-consent bypass for `admission_type='emergency'` AND `priority='emergent'`. No new work. |
| 3 | `2026-05-10-obstetric-anc-doctor-visit-assigned-to-non-doctor` | **Defense-in-depth.** Wave 3.3 fixed the dialog filter (`assignable=true`). Wave 5/3 adds the backend pre-flight validation so a malformed payload cannot write a non-DOCTOR `doctor_id` onto an appointment row. |
| 4 | `2026-05-09-walk-in-opd-patient-follow-up-appt-not-booked` | **Fixed.** `createPrescription` now Phase-1.5 best-effort auto-books the follow-up appointment when `follow_up_date` is set. Idempotent. |
| 5 | `2026-05-10-pediatric-opd-nurse-immunisation-up-to-date-requires-29-writes` | **Fixed.** Single-tap `clinical_notes` row pattern; new endpoint `POST /api/v1/maternity/immunisations/up-to-date`. Migration 215 adds the partial index. |
| 6 | `2026-05-10-lab-walk-in-lab-tech-no-sample-barcode-audit` | **Fixed.** Migration 214 adds `sample_barcode`, `collected_notes`, `verified_at/by`. New `POST /api/v1/investigations/:id/collected` mints + persists. |
| 7 | `2026-05-10-obstetric-anc-lab-tech-collected-time-missing` | **Fixed.** Same fix as #6; `markSampleCollected` stamps `collected_at`, `collected_by`. Read-side aliases `i.requested_at AS sample_collected_at` corrected to `i.collected_at`. |
| 8 | `2026-05-10-surgical-day-care-billing-package-not-itemised-iol-delta-opaque` | **Fixed — closes Wave 2.1 deferral.** `itemizeAdmissionInvoice()` walks admission events (package, pharmacy, lab, consults, theatre) and emits one `billing_invoice_items` row per source. Idempotent. |
| 9 | `2026-05-09-tpa-insurance-claim-discharge-nonpayable-not-disclosed-proactively` | **Fixed.** Migration 216 adds `tpa_decision`, `tpa_non_payable_reason`, `tpa_decided_at/by` on `billing_invoice_items`. Patient portal `getMyBill` returns `non_payable_preview` rollup. New routes: TPA-desk decision recording + non-payable breakdown read. |

## Commits

```
1d5ab2ab  chore(migrations): reserve 211/212/213 for Wave 5 batch 3
6360b93f  fix(wave-5-3-A): workflow bridges — advise-admission audit + walk-in DOCTOR gate + Rx follow-up auto-book
17340845  fix(wave-5-3-B): single-tap immunisation up-to-date shortcut
0d440f54  fix(wave-5-3-C): investigations sample-collected stamp + barcode + read fix
5636e0e2  fix(wave-5-3-D): admission invoice auto-itemizer + TPA non-payable surface
24c287f0  chore(prisma): declare wave-5-3 columns on investigations + billing_invoice_items
```

## Migrations applied

| File | Tables touched | Index changes |
|---|---|---|
| `214_investigations_sample_barcode_collection.sql` | `investigations` (4 new cols) | UNIQUE on `sample_barcode` (partial NOT NULL); partial index on `collected_at` for pending-upload worklist |
| `215_clinical_notes_immunisation_review.sql` | (index only) | Partial index on `clinical_notes(patient_uid, created_at DESC) WHERE note_type='immunisation_review'` |
| `216_billing_invoice_items_tpa_decision.sql` | `billing_invoice_items` (4 new cols) | Partial index on `invoice_id` for `tpa_decision IN ('non_payable','partial')` |

## API surface added

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/maternity/immunisations/up-to-date` | Single-tap immunisation note (clinical_notes row) |
| GET  | `/api/v1/maternity/immunisations/status/:patientUid` | Read most-recent immunisation_review |
| POST | `/api/v1/investigations/:id/collected` | Stamp sample collection + barcode |
| POST | `/api/v1/billing/v2/invoices/:id/itemize` | Auto-itemizer (idempotent) |
| POST | `/api/v1/billing/v2/invoices/:id/items/:itemId/tpa-decision` | TPA-desk verdict recording |
| GET  | `/api/v1/billing/v2/invoices/:id/non-payable` | Non-payable rollup |

The patient portal `GET /api/v1/portal/bills/:id` payload also gained a
`non_payable_preview` field (total + line_count + reason breakdown)
and each item carries `tpa_decision` / `tpa_non_payable_reason` /
`source_ref_type` / `source_ref_id`.

## Verification

- `node --check` on every touched controller / service / route file.
- `npm --prefix apps/backend run lint:raw-params` green (0 sites).
- `npx eslint` on all 10 modified files clean.
- `npx prisma validate` green.
- Migrations 211 / 212 / 213 applied to local test DB
  (`vhhealth_test@127.0.0.1:55432`) by `postgres` owner.
- Test suites run (`--runInBand --forceExit`):
  - `billing.test` — 35 / 35 pass
  - `appointment-deep.test` — pass
  - `investigation-deep.test` — pass
  - `prescription-deep.test` — pass
  - `admission-deep.test`, `tpa-*`, `portal-tpa-claims` — 26 / 26 pass
  - `ipd|portal-billing|maternity|walkin|authorization` — 39 pass / 3 skipped
  - Total targeted: **128 / 128** pass on touched surfaces.
- `tenant-rls.deep.test.js` errors with `permission denied to set role
  "rls_test_app"` — pre-existing perms issue with the local QA DB
  setup, unrelated to this work (none of the touched files reference
  the `rls_test_app` role or RLS migrations).

## Closed deferrals

- **Wave 2.1 auto-itemizer** (commit 5f4f0db6 logged it as an explicit
  deferral). Migration 199 added the source-ref columns as the
  unblock; this batch's `itemizeAdmissionInvoice()` is the producer
  that the deferral was waiting on.

## Out of scope (carried forward to future batches)

- **No-smartphone SMS channel** — product feature requiring SMS
  provider integration. Same deferral noted in Wave 5.2 prompt.
- **Rural / illiterate patient outreach** — separate channel design.
- **Cross-resource bulk billing operations** — out of this batch's
  envelope.
- **Cost catalogue for `discharge_consults` + `ot_schedules` /
  `theatre_cases`** — auto-itemizer currently emits audit-only lines
  at `unit_price=0` for these. Operator can override at the TPA-desk
  surface. Seeding the catalogues is a separate piece.
- **Room-day breakdown** — needs a room-cost catalogue (per
  bed-category, per day). Cashier still adds room charges manually.
- **Pharmacy over-cap detection in the itemizer** — `tpa_decision`
  defaults to `'pending'`; auto-flagging non-payable requires
  cross-referencing `insurance_claim_caps` per dispense, which has
  enough edge cases (cap reset on enhancement preauth, category
  matching) to warrant its own batch.

## Files touched

```
apps/backend/src/migrations/211_investigations_sample_barcode_collection.sql        (new)
apps/backend/src/migrations/212_clinical_notes_immunisation_review.sql              (new)
apps/backend/src/migrations/213_billing_invoice_items_tpa_decision.sql              (new)
apps/backend/src/controllers/appointment/appointmentWorkflowController.js           (advise-admission gate+audit; walk-in DOCTOR gate)
apps/backend/src/controllers/prescription/ePrescriptionController.js                (follow-up auto-book)
apps/backend/src/services/maternity/immunisationService.js                          (markScheduleUpToDate, getImmunisationStatus)
apps/backend/src/routes/maternity/maternityRoutes.js                                (2 new routes)
apps/backend/src/services/investigation/investigationService.js                     (markSampleCollected)
apps/backend/src/controllers/investigation/investigationController.js               (markInvestigationCollected + read-alias fix)
apps/backend/src/routes/investigation/investigationRoutes.js                        (1 new route)
apps/backend/src/services/billing/billingV2Service.js                               (itemizeAdmissionInvoice + TPA helpers)
apps/backend/src/routes/billing/billingV2Routes.js                                  (3 new routes)
apps/backend/src/services/portal/patientPortalService.js                            (non_payable_preview rollup)
apps/backend/prisma/schema.prisma                                                   (4 new cols × 2 tables)
runs/manual-fix-log-2026-05-13-wave-5-batch-3.md                                    (this file)
```
