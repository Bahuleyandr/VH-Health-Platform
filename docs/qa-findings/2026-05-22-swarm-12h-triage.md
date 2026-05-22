# Swarm 12h run — deduped fix-list (2026-05-22)

Source: autonomous QA swarm (codex, tuned ×3), ~12h run against main `cf49fa83`
(i.e. **after** the 12 fixes shipped 2026-05-21, PRs #149–#160). 213 open
critical/high findings collapsed to ~18 distinct issues (~12:1). Findings live
in `vh-health-swarm/findings/in-flight/` on dalekdefender.

Workflow: each item is its own CI-gated PR. Before fixing, **verify against
current code** — the swarm's "wrong-DB driver" harness bug (below) produced
some false negatives, and several items are *siblings* of already-shipped fixes
on different code paths (verify, don't assume).

## Harness noise — NOT product bugs (do not fix as platform changes)
- [ ] **Driver verifies against the wrong DB** (~25 files) — driver checks `:5433/vhhealth_test`, backend writes `vhhealth-postgres/vhhealth`; reports "0 rows" for rows that exist. Repr `2026-05-21-inpatient-admission-receptionist-39192cb0`. → swarm-harness config.
- [ ] **Patient/guardian login unavailable** (~15) — `/auth/dev/patient-login` 401 (unmounted) + Firebase degraded → patient-app surface unverified. Repr `2026-05-22-walk-in-opd-patient-e1632f80`. → check whether dev-login route should be mounted in qa env (harness/env, possibly platform dev-auth).

## CRITICAL — clinical safety / security (fix first)
- [ ] **C1. OT/surgical safety gates bypassable** — WHO time-out saves "complete" with wrong site (scheduled right vs marked left); incision allowed on site mismatch; nurse signs surgeon-only op notes; consent-less OT start; pre-op checklist completes with no site mark. Repr `2026-05-22-surgical-day-care-ot-staff-e410248f`.
- [ ] **C2. `doctor_id` accepts any user-id** — walk-in/ER POST returns 200 with `doctor_id` resolving to a PATIENT/HR user; no validation it's a real doctor. Repr `2026-05-22-emergency-walk-in-receptionist-e8685ad5`.
- [ ] **C3. Discharge closes billing before a final invoice exists** — final discharge 200 with no `billing_invoices` row; close-stamp clears the NO_INVOICE blocker. Repr `2026-05-22-inpatient-admission-discharge-d670b613`.
- [ ] **C4. Tenant RLS not enforced — cross-tenant PHI leak** — bogus `x-tenant-id` returns tenant-1 rows; walk-in inserts omit `tenant_id`. Repr `2026-05-22-cross-tenant-rls-receptionist-0ff7bac5`. (auth/RLS — extra care; verify vs test-env superuser-bypass.)

## HIGH
- [ ] **H1. List endpoints ignore patient/admission filters (PHI bleed)** — investigations & ward-indents return other patients' rows. Repr `2026-05-21-inpatient-admission-doctor-58437f67`.
- [ ] **H2. Unassigned doctor can write/sign/complete another's visit** — GET 403 but POST notes+sign+complete succeed. Repr `2026-05-21-follow-up-opd-doctor-188a603b`.
- [ ] **H3. Patient `/auth/login` issues JWT on phone-only, no OTP challenge.** Repr `2026-05-22-walk-in-opd-patient-36657889`. (auth — extra care.)
- [ ] **H4. Pharmacy unsafe dose/quantity defaults** — qty defaults to 1, dispensing 9 accepted silently; tablet sub prints liquid warning; IV→oral map. Repr `2026-05-21-walk-in-opd-pharmacy-1646bc24`.
- [ ] **H5. Pediatric paracetamol mis-dosed to 5 mL on label + PDF** — concentration `125mg/5ml` parsed as the dose; `child_weight_kg=null`; PDF Dosage "-". Repr `2026-05-22-pediatric-opd-pharmacy-f346bf82`. (sibling of #6/weight-dose — verify.)
- [ ] **H6. Lab completed-order PDF 500s + detail blank + notified=false** — Repr `2026-05-21-lab-walk-in-patient-2747d82d`. (notify/status covered by #5/#10; PDF-500 + detail are new.)
- [ ] **H7. ANC timeline / prior-orders return empty** (`visits:[]`, prior USG absent → dup scan risk). Repr `2026-05-22-obstetric-anc-doctor-8d245f7c`. (sibling of #7 vitals — this is the read.)
- [ ] **H8. TPA final claim capped at interim invoice** — claim stuck ₹76k vs ₹80k approval, blocks settlement. Repr `2026-05-22-tpa-insurance-claim-billing-7239f4be`. (interacts with #4 cap logic.)
- [ ] **H9. ED triage (ATS-2) not honored in doctor queue** — `acuity_rank=null, is_emergent=false`. Repr `2026-05-22-emergency-walk-in-nurse-2dd88574`.
- [ ] **H10. ER→ICU MAR carry-over drops doses** — STAT order, no `medication_administrations` row. Repr `2026-05-21-emergency-walk-in-nurse-7d2d873a`.
- [ ] **H11. Fahrenheit vitals trigger false Celsius critical alert / PDF unit flip.** Repr `2026-05-21-walk-in-opd-doctor-126619d3`.
- [ ] **H12. Admission-advice handoff missing `admission_advice_id`** — OPD patient stuck in advice queue post-admit. Repr `2026-05-21-inpatient-admission-receptionist-5e965972`.
- [ ] **H13. Discharge-summary integrity** — signed summaries not materialized to patient surface; blank sections signable; discontinued IV drugs in takeaways. Repr `2026-05-21-inpatient-admission-patient-8db55849`.
- [ ] **H14. Pediatric growth percentile transient** — returned on vitals POST, gone on readback. Repr `2026-05-22-pediatric-opd-nurse-d9b616dc`.

## Status log
(updated as each lands)
