# Codex overnight swarm run — triage & fix-list (2026-05-21)

Source: ~12h autonomous Codex swarm run on dalekdefender (commit `a8f355ee`, = `main`).
103 raw findings → ~30 distinct genuine product issues + ~23 test-harness/env artifacts.
Findings live on dalekdefender at `~/vh-health-swarm/findings/`. IDs below are traceable there.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` fixed+merged · `[stale]` already fixed on main · `[wontfix]` by-design/feature-deferred

---

## P0 — Clinical safety (patient-harm risk)

- [ ] **MAR ER→ICU carry-over creates near-duplicate ASA/GTN rows** (both administrable → double-dose) — `2026-05-20-emergency-walk-in-nurse-7622bcce`
- [ ] **IPD admission drops the OPD-captured allergy list** on conversion — `2026-05-20-tpa-insurance-claim-admission-29d13399`
- [ ] **Pharmacy substitution keeps mL dose after strength change** → pediatric mis-dose — `2026-05-21-walk-in-opd-pharmacy-c05e2adb`
- [ ] **ANC BP exactly 140/90 → no pre-eclampsia/HTN screen** (`>` vs `>=` boundary) — `2026-05-20-obstetric-anc-nurse-acf39daa`
- [ ] **ANC pre-eclampsia alert ignores recorded urine protein** — `2026-05-20-obstetric-anc-nurse-8e355261`
- [ ] **Critical lab alert fires on normal values** (no unit conversion; WBC in /µL) — `2026-05-20-obstetric-anc-lab-tech-9ceaa0ee`, `2026-05-20-obstetric-anc-lab-tech-93c18f93`

## P0 — TPA / billing financial integrity

- [ ] **Billing v2 invoice list ignores admission_id/patient_id → returns another patient's TPA bill** (IDOR) — `2026-05-20-tpa-insurance-claim-billing-5670dc67`
- [ ] **Cashless final bill shows insurer receivable as patient amount due** — `2026-05-20-tpa-insurance-claim-patient-25a59426`
- [ ] **Claim-amount validation broken**: accepts approved > claimed/billed; ₹65k vs ₹80k cover; underclaims; ignores room cap; untraceable synthetic line (CRIT) — `2026-05-21-tpa-insurance-claim-billing-8aca91a3`, `2026-05-20-tpa-insurance-claim-billing-4600ed9c`, `2026-05-21-tpa-insurance-claim-billing-f5089414`, `2026-05-21-tpa-insurance-claim-discharge-5005fd01`, `2026-05-21-tpa-insurance-claim-billing-32c3eee4`, `2026-05-21-tpa-insurance-claim-billing-c13b90cc`
- [ ] **Payer mismatch accepted** (preauth/response accepts wrong insurer; NIA ref posts to Star Health) — `2026-05-20-tpa-insurance-claim-billing-24314cb8`, `2026-05-20-tpa-insurance-claim-billing-08c03175`, `2026-05-20-tpa-insurance-claim-billing-df39fefb`
- [ ] **Claim document packet empty** (not auto-assembling signed summary + final bill) — `2026-05-21-tpa-insurance-claim-discharge-9746f26c`, `2026-05-21-tpa-insurance-claim-discharge-f9ef3054`, `2026-05-20-tpa-insurance-claim-discharge-54ede17f`
- [ ] **Admission↔TPA linkage broken** (policy_id null; pre-auth not opened from admission) — `2026-05-20-dynamic-acute-abdomen-admission-d730fa1b`, `2026-05-21-tpa-insurance-claim-admission-cea3771d`, `2026-05-20-emergency-walk-in-admission-ff4ca33c`
- [ ] **TPA enhancement: doctor can draft from chart but cannot submit / fetch template** — `2026-05-20-tpa-insurance-claim-doctor-391174a0`
- [ ] **source_ref integrity**: room_day without source_ref_id; unverified line items — `2026-05-20-tpa-insurance-claim-billing-013275c3`, `2026-05-21-tpa-insurance-claim-billing-ff5e590c`
- [ ] Discharge cascade closes billing before TPA desk finalizes; summary not exposed to sign-off API — `2026-05-20-tpa-insurance-claim-discharge-6bbb8575`, `2026-05-20-tpa-insurance-claim-discharge-2c420a24`
- [ ] Transparency: disallowance shown without plain-language reason; no patient-visible signed summary — `2026-05-20-tpa-insurance-claim-patient-3dd3a70b`, `2026-05-20-tpa-insurance-claim-patient-180a03b1`

## P1 — Encounter/order linkage + guardian lookup + routing

- [ ] **ER orders/meds don't carry into the IPD/ICU admission encounter**; ER encounter rejects diagnosis coding ("Encounter not found") — `2026-05-20-emergency-walk-in-admission-e481678b`, `2026-05-20-emergency-walk-in-doctor-9305e429`, `2026-05-20-emergency-walk-in-doctor-27e9c536`
- [ ] **OB vitals don't populate the ANC timeline**; timeline omits prior visits; staff vitals posts legacy payload — `2026-05-20-obstetric-anc-nurse-d4c9c118`, `2026-05-20-obstetric-anc-doctor-971d3a14`, `2026-05-20-obstetric-anc-nurse-e8bdd0ca`
- [ ] **Guardian-phone lookup misses dependent children** (pharmacy + lab) — `2026-05-21-pediatric-opd-pharmacy-6961419e`, `2026-05-21-walk-in-opd-pharmacy-dbb39fef`, `2026-05-21-lab-walk-in-receptionist-80c8c463`
- [ ] **Order routing/RBAC**: STAT ECG routed as lab investigation; admission-officer blocked from ICU/CCU; ICU nurse can't mark bedside collection — `2026-05-20-emergency-walk-in-doctor-ddfeae14`, `2026-05-20-emergency-walk-in-admission-91e04de2`, `2026-05-20-emergency-walk-in-nurse-209b596a`
- [ ] Completed lab results don't queue a patient/guardian notification — `2026-05-21-lab-walk-in-lab-tech-65aded1a`
- [ ] Pediatric Rx PDF omits the weight-based dose calculation — `2026-05-21-pediatric-opd-patient-ffea3aba`

## P2 — Medium (lower priority)

- [ ] Allocated bed number dropped from admission detail (recurring)
- [ ] Auto-issued attendant passes have no expiry
- [ ] ANC uses UTC not IST for visit-number/GA
- [ ] ANC supplement reminders lack a daily-dose schedule
- [ ] Maternity packages have no prices/pre-booking path
- [ ] `/clinical/progress-notes` 500s on OPD note save
- [ ] Verified ANC lab orders stay `IN_PROGRESS` after result
- [ ] Hindi ANC advice is placeholder text (clinical-AI i18n) — `2026-05-20-obstetric-anc-patient-3a5d5030`

---

## Discarded — test-harness / env artifacts (not product bugs)

- **DB-target mismatch** (~8): swarm `config.db` ≠ backend's in-cluster Postgres — `…dynamic-acute-abdomen-receptionist-4bcd9c03`, `…emergency-walk-in-receptionist-fddf57d8`, `…obstetric-anc-receptionist-03dc99f8`, `…walk-in-opd-receptionist-ddb122c1`, +mediums
- **Patient-app QA auth** (~5, incl. 1 of the 2 "criticals"): Firebase degraded in QA + dev login bypass not mounted — `2026-05-21-pediatric-opd-patient-685532c7`, `2026-05-20-obstetric-anc-patient-d2ca8974`, `2026-05-21-lab-walk-in-patient-6897197c`
- **Seed gaps** (~6): no LAB_INCHARGE / ER doctor / receptionist seeded — `2026-05-20-emergency-walk-in-lab-tech-3015c395`, `2026-05-20-obstetric-anc-lab-tech-cd80d871`
- **Auditor backlog rollups** (4): `rollup-2026-05-2[01]-*-last24-open-flood`
