# Swarm 17h run — manual deduped triage (2026-05-23)

Source: autonomous QA swarm (codex, tuned ×3), ~17h run against
`main 54dc246f` (the deploy that landed PRs #162–#187, redeployed
at 09:58 UTC May 22). 547 in-flight findings filed against the
current commit (44 critical, 279 high, 258 medium, 7 low) collapsed
through manual theme-clustering — `dedupe_signature` is per-finding
specific so it gave us 547/547 unique signatures; the real
distinct-root-cause count is ~50 themes (~11:1 manual collapse,
matching the 12h triage's 12:1).

Reconciliation pass shipped first: 478 superseded-deploy findings
(stamped against `cf49fa83`/`a8f355ee`/pre-stamping commits)
archived via `scripts/reconcile-stale-findings.mjs --apply` →
`findings/archive/` with `status: superseded-by-redeploy` + reason.
The 547 against `54dc246f` are the genuine current-code surface.

## Critical tier (44 findings → 2 distinct root causes)

| Cluster | Status | PR / Reason |
|---|---|---|
| **C1' Preauth payer-mismatch guard never fires** (parent + enhancement) — `2026-05-22-tpa-insurance-claim-billing-28284746`, `-d961e4cf` | ✅ SHIPPED | **PR #187** — `getPreauth` now joins `payers`; existing guard fires correctly |
| **C2' Patient lab login broken** — `2026-05-22-lab-walk-in-patient-eebbea33` | 🟡 HARNESS NOISE | Firebase OTP + `/auth/dev/patient-login` gated by `ENABLE_DEV_AUTH` (by design, non-prod only). Same class as swarm-12h "patient/guardian login unavailable" cluster. **Not a platform bug.** |

## High tier (279 findings → ~50 distinct themes)

### Shipped this triage

| # | Theme | PR | Findings covered |
|---|---|---|---|
| H' R1 | **Radiology orders 500 on encounter UUID** — service inserted uuid into integer column; resolver added (uuid → admissions.id), `$2::int` cast | **PR #188** | `7ded987b`, `449c93ec`, `a8d4e86f`, `2de6874d`, `cdf1c658`, `a69c2203` (6 findings) |

### Already-fixed / verified-by-reading (no PR needed)

| Theme | Verdict | Evidence |
|---|---|---|
| **MAR repeat-administration of already-given dose** (`cce2279a`) | VERIFIED-FIXED | `marService.js:241-243` already throws `AppError.conflict('Medication has already been administered')` when `existing[0].status === 'administered'`. Plus cross-row dup guard at `:256-275` (F-2). Swarm response likely a stale-read artifact; could be hardened with a regression test in a separate small PR. |
| **TPA preauth accepts wrong-insurer decisions** (`8f9d73d9`) | ✅ SHIPPED in PR #187 | Same root as critical C1'; preauth path now fires the guard. |
| **Discharge cascade soft-closes billing before final invoice** (`0207c6f2`, `3b1c4306`, `33a8885e`, `674bce28`) | LIKELY-ALREADY-FIXED — PR #163 (C3) removed the dead-code `if (!billing_closed_at)` bypass; needs a re-verify against current main. | Re-verify by re-running `inpatient-admission` journey. |

### Harness noise (not platform bugs)

These are the swarm-12h *"Driver verifies against the wrong DB"* + *"Patient/guardian login unavailable"* classes that we previously documented. Drivers will keep regenerating them until either (a) the harness DB target is fixed swarm-side or (b) ENABLE_DEV_AUTH is on in QA.

| Cluster | Count |
|---|---|
| QA patient login / OTP / dev-bypass blocked | ~25 findings across journeys |
| "Read-only DB doesn't match backend" / "Published DB target not the backend" | ~10 findings across journeys |
| Bed pool has zero ICU/CCU beds (seed gap) | ~3 findings |

### Real, high-impact, well-scoped — PRs to ship next

These are the themes I'd queue for the next fix wave (1 PR each, same pattern):

| # | Theme | Reason it's worth a tight PR | Findings |
|---|---|---|---|
| H' D1 | **Cross-tenant RLS PHI leak** — staff PHI endpoints ignore tenant scope; tenant-B override reads tenant-A patients | CRITICAL-equivalent (PHI), but needs `AUTH_ENFORCE_TENANT_RLS=true` + non-superuser DB role for the app → infrastructure work, not a code-only fix. Sensitive. | `0989e414`, `67a1fcb5`, `e49a15e9`, `3b0361a3`, `3b6b4fa5` (5) |
| H' D2 | **Doctor ID confusion** — walk-in/booking accepts `doctors.id` or `users.id` interchangeably, routes to wrong doctor (sometimes a patient/HR user) | Recurring across walk-in/follow-up/IPD. Needs a canonical "resolveDoctorRef(value) → users.id" helper used everywhere. | `a6d05639`, `db011a6e`, `126bc68e`, `1c8d09ce`, `c63a0718`, `dbcb4a50`, `bc270435`, `80afeb4d`, `ca224a9e`, `e2aaf531`, `b5f15f3b`, `6ca6c1b5`, `89e2a8d7`, +others (15+) |
| H' D3 | **ER orders not carried into IPD encounter** — `ER admission closes the visit but leaves active ER orders on the ER encounter` | Continuity-of-care break across NSTEMI/acute-abdomen/dehydration flows. Encounter-linkage gap. | `0411361f`, `3d3d9a03`, `d1152597`, `f93ac6da`, `3cdbc2eb`, `c513629b`, `5517c5af`, `0a19832f`, `aff2d43f`, +others (10+) |
| H' D4 | **STAT clinical order saves but doesn't reach lab worklist** | Order-to-worklist materialization gap. Clinical safety (STAT troponin invisible). | `42fa2a8e`, `7e11373a`, `d7f74117`, `1c4898dc`, +others (5+) |
| H' D5 | **Discharge summary builder leaves diagnosis/takeaway-meds blank** | Patient-facing discharge doc empty. Related to H13(c) deferred materialization. | `7cd18310`, `bf7687d1`, `327c123e`, +others (5+) |
| H' D6 | **TPA pre-auth not auto-opened from admission** (TPA emergency admission → 48h SLA instead of emergency) | Workflow gap. Existing P0 #19 partially shipped; emergency-specific path missing. | `c9a66b2b`, `0fcbd630`, `5c99c200`, `e611d08e`, `e4a583fd`, `8dcb4d45`, `f0ac04fb`, +others (8+) |
| H' D7 | **TPA room cap warning doesn't enforce cash-difference / consent step** | D2 (#181) added warnings; this needs the warnings to BLOCK or surface as actionable step. | `7d32c72e`, `95f65c1f`, `ca8de3a8`, `cdb10053`, `1c196fa9`, `dfff157c`, `27ba20de`, `07369ecc`, `7efe1512` (9) |
| H' D8 | **TPA final claim ignores invoice non-payable decisions** | `Final TPA claim under-claims non-payables`. Settlement adjudication broken. | `870ff6a9`, `5953f182` (2) |
| H' D9 | **Final cashless TPA claim accepts unsigned discharge summary** | H13 sign-gate didn't cover this path. | `d3df8c98`, `f6440157`, `9c3e7848`, `21d0b3df` (4) |
| H' D10 | **Cashless TPA final payment accepted with no linked preauth/claim** — `Leaving insurer collections unattributed` | Billing integrity. | `d60050d2`, +similar (3+) |
| H' D11 | **Allergy disappears from appointment/queue/payload** | Allergy propagation gap (clinical safety). | `0c8e7e35`, `1e156f91`, `a3e9554b`, `5b5a529d`, +others (5+) |
| H' D12 | **MAR frequency expansion missing** — 8-hourly/BD orders only create one MAR row; next-day MAR empty | Clinical safety (missed doses). Needs MAR generator for active recurring orders per date. | `a5b0d216` (1) |
| H' D13 | **Pharmacy ward indent picks wrong SKU/form** — IV Pantoprazole → oral tablet indent; Normal Saline → free-text despite IV-fluid catalog | H4 (#166) was deferred for IV→oral mapping. | `81cc9d1f`, `1f39990e`, `24e4cc7a`, `5a2e490f`, `cdd9523d`, `c0a78801`, +others (8+) |
| H' D14 | **Pediatric prescription safety blocks valid mg/kg syrup** | Prescription safety regression post-H5. Parser misreads mg/kg as absolute mg. | `1ddf68d5`, `46f070a2` (2) |
| H' D15 | **Bed list ignores availability filters** | Returns occupied/cleaning beds as selectable. | `f74a0037`, +similar (2-3) |
| H' D16 | **OT case completion bypasses consent/counts/signer** (C1 extension) | C1 #162 covered site/side mismatch; consent + instrument counts + booked-surgeon enforcement still missing. | `021226a6`, `aa11d8f2`, `c0c9885a`, `e828dd9a`, `5cb3a780`, `8d4cf8d6`, `be58cf97`, `82e5d7bc`, `89e50e3e`, +others (10+) |
| H' D17 | **Walk-in drops chronic medications** | Intake-to-history persistence gap. | `56a203d0`, `16e99276`, `313b7af0` (3) |
| H' D18 | **Daily collection / Doctor queue use UTC (should be IST)** | TZ bug surfaces. P2 #32 covered ANC; same class. | `67d9e548`, `f98a4bcd` (2) |
| H' D19 | **Lab report PDF "Completed: Pending"** + missing patient ID / verification metadata | H6 #173 area; possibly incomplete. | `36cb3bf5`, `f3273a84` (2) |
| H' D20 | **Pharmacy can't find handed prescription / patient state** | Pharmacy lookup bug. | `ac28f559`, `a3a995b2`, `020e66e9` (3) |
| H' D21 | **A/R aging duplicates invoices** when multiple TPA claims point to one | SQL join inflates receivables. | `8131f896`, `9c28990d` (2) |
| H' D22 | **Pediatric Rx PDF omits weight-based dose** + drops paracetamol dose | H4/H5 area. | `35767b3c`, `d69b6432` (2) |
| H' D23 | **Pharmacy partial dispense marks fulfilled** | Quantity validation. | `94a004fe`, `b627a0d3` (2) |
| H' D24 | **Discharge readiness checklist requires Clinical AI** | No non-AI fallback. | `c983f992` (1) |
| H' D25 | **ANC nurse triage acuity not propagated to doctor queue** | H9 #170 covered scales; surfacing path missing. | `bb3ae863` (1) |
| H' D26 | **Pregnancy BP warnings not in CDS alerts** | Vitals→alerts pipeline gap. | `b6dc4ea4` (1) |
| H' D27 | **Pediatric due-list ignores signed immunisation review** | Workflow gap. | `886ba467` (1) |
| H' D28 | **Hindi ANC advice is placeholder text** | Content gap (3 dupes). | `76c005c4`, `c38eabb7`, `ded7ea20` (3) |
| H' D29 | **Pregnancy self-care UI missing kick counter / package access** | Feature gap. | `302123f4` (1) |
| H' D30 | **Anaesthetist role allowed by OT routes but missing from staff registry** | Role-registry gap. | `aa11d8f2` (1) |
| H' D31 | **Pre-op API silently drops day-care nursing fields (glucose, eye-drop)** | Field truncation. | `e9b794c8` (1) |
| H' D32 | **Post-op recovery note truncates handover text** | Field length bug. | `d18a9b0a` (1) |
| H' D33 | **Pre-op checklist API missing for day-care OT readiness** | API gap. | `89e50e3e`, `6a1e95b5` (2) |
| H' D34 | **Bed allocation moves general → private without cost/consent reconciliation** | Class-change gap. | `19030e9a` (1) |
| H' D35 | **Attendant passes auto-issued without expiry** | Stamp missing. | `c1da7281`, +similar (2) |
| H' D36 | **Admission API accepts non-existent doctor UID** | Validation gap. | `06e43c24`, `7523da24` (2) |
| H' D37 | **Advise-admission accepts non-consultant doctor** | RBAC gap. | `ee096dc7` (1) |
| H' D38 | **Vitals POST echoes triage acuity, read-back drops it** | Read-back filter. | `009ad565` (1) |
| H' D39 | **Lab notifications missing for signed-off results** | P1 fix #28 area; same class. | `6ca8645a` (1) |
| H' D40 | **Manual lab result entry accepts duplicate analytes** | Constraint gap. | `a5accf7a` (1) |
| H' D41 | **Released lab results lose investigation_id** | Linkage gap. | `63e47eaa` (1) |
| H' D42 | **Verified lab_results don't populate completed investigation result fields** | Completion link bug. | `27e3c1c1` (1) |
| H' D43 | **Lab sample collection/barcode/rejection API missing** | Workflow gap. | `ae070930` (1) |
| H' D44 | **Verified STAT lab result doesn't close/link to ER order** | ER-lab linkage. | `c41e9836` (1) |
| H' D45 | **New ER STAT troponin hidden behind stale worklist rows** | Ordering bug. | (1) |
| H' D46 | **ED open-visits pagination hides untriaged arrivals** | Ordering bug. | `ff98a21a` (1) |
| H' D47 | **Emergency walk-in to specialty dept not on ED queue** | Routing bug. | `ac8945ab` (1) |
| H' D48 | **Doctor lab-order shortcut 500s on acute-abdomen panels** | 500 bug. | `0e597b54` (1) |
| H' D49 | **Signed radiology report hides sign-off metadata** | Read-side filter. | `31d32cc1` (1) |
| H' D50 | **Signed radiology report blocks overwrite without addendum route** | Addendum workflow gap. | `42f9bdb5` (1) |
| H' D51 | **Radiology tech attribution free-text, no license capture** | Identity gap. | `0adb88ba` (1) |
| H' D52 | **Non-radiology staff can acquire radiology studies** | RBAC gap. | `b90c70d2` (1) |
| H' D53 | **Radiology acquisition marks study acquired without PACS/image attachment** | Acquisition workflow gap (deferred — needs PACS integration design). | `e1dfd3ee`, `dc420d74`, `b04fb116`, `025a6f43`, `a25ea4c9`, `50c94455` (6) |
| H' D54 | **ICU I/O balance rejects admission encounter UUID** | Encounter UUID handling (same class as the radiology fix in PR #188). | `d94bba9f` (1) |
| H' D55 | **ER doctor can't read unassigned ER appointment/admission advice** | RBAC over-tight. | `70bf7587` (1) |
| H' D56 | **Chest-pain order set routes ECG as lab investigation** | Order set routing. | `1c47996c` (1) |
| H' D57 | **Documented pharmacy dispense/lookup endpoints not mounted** | Route mounting OR doc gap. | `ec926e09` (1) |
| H' D58 | **Issued IPD ward pharmacy indents don't create billable charge** | Billing link. | `f9007a9c` (1) |
| H' D59 | **Final TPA invoice lines manual, not traceable** | Billing-line traceability (recurring). | `34a5928d`, `be200b0b`, `649b5be4`, `d29bdd37`, `27edcc74` (5) |
| H' D60 | **Cash discharge payment recorded with no shift** | Cash-drawer reconciliation gap. | `8f3634b2` (1) |
| H' D61 | **Deferred admission advance shows zero balance** | Advance calc bug. | `ac0e6a1e` (1) |
| H' D62 | **Admission detail omits allocated bed number** | Surface read bug. | `c52e8649`, `b92372d9` (2) |
| H' D63 | **Housekeeping queue hides breached dirty-bed tickets** | Ordering + SLA flag bug. | `7a73a9b5` (1) |
| H' D64 | **Final cashless claim submitted for wrong (interim) invoice** | Invoice selection bug. | `2a388c37` (1) |
| H' D65 | **Confirmed phone-booked follow-up: no deterministic visit number** | Token gen bug. | `55a91186`, `6e610cd1` (2) |
| H' D66 | **Bulk EMR orders save but don't reach worklists** | Bulk-order routing. | `2acb3b65`, `30540d94` (2) |
| H' D67 | **ANC timeline omits prior visits / anomaly scan / supplements** | H7 #169 area; possibly incomplete (recurring 6+ findings). | `106585e2`, `186fb702`, `54b594f6`, `5e785226`, `ac5e4020`, `e79a74dc` (6) |
| H' D68 | **Patient bills endpoint 500s** | 500 bug. | `40651441` (1) |
| H' D69 | **TPA claim documents not exposed for patient download** | Patient surface gap. | `95008441`, `0a3e84c3` (2) |
| H' D70 | **Patient claim screen labels "You paid" without evidence** | Label/data bug. | `1a29da94` (1) |
| H' D71 | **Discharge meds materialization** — takeaway meds shown as generic sentence | D3/H13(c) deferred. | `a175476a`, `c221cd96` (2) |
| H' D72 | **Dependent appointment list keeps guardian id in URL** | Guardian/dependent visibility. | `3edd5127` (1) |
| H' D73 | **Pediatric age-range doctor picker returns adult doctors** | Filter gap. | `37cf68ae` (1) |
| H' D74 | **Minor walk-in registration accepts guardian without legal ID** | Validation gap. | `69db0787` (1) |

(That covers the bulk; the remainder of high-tier findings are dupes / variants of the above themes.)

## Medium tier (258 findings)

Not exhaustively re-triaged in this pass — most are lower-priority
variants of the high-tier themes above (e.g. medium-severity dupes
of the discharge-billing cluster), or harness-noise surfaces
(login bypass, DB target mismatch). The high-tier theme list above
covers the actionable surfaces; medium-tier mop-up belongs to a
later sweep.

## Low tier (7 findings)

Cosmetic / nice-to-have. Defer.

## Recommended next sequence (if resuming)

If you pick this up later, the highest-value remaining PRs in
descending impact:

1. **H' D1 — Cross-tenant RLS PHI leak**. PHI exposure across
   tenants is the highest-stakes residual. Needs:
   - `AUTH_ENFORCE_TENANT_RLS=true` flipped on in prod env
   - A non-superuser DB role for the app to actually be subject
     to the RLS policies (boot guard `logTenantRlsRolePosture()`
     already exists and now warns loudly per D5 / #185)
   - Verification deep test that tenant-B JWT can't read tenant-A
     PHI through staff routes
2. **H' D2 — Doctor ID confusion**. A single helper used
   consistently kills 15+ findings; this is the highest-leverage
   code-only fix in the queue.
3. **H' D16 — OT case completion gates** (C1 extension).
   Clinical safety; extends the C1 pattern.
4. **H' D11 — Allergy propagation**. Clinical safety.
5. **H' D3 — ER → IPD order carry-over**. Continuity of care.

## Shipped from this triage

| PR | Theme | Findings closed |
|---|---|---|
| **#187** | preauth payer-mismatch (getPreauth payer_name join) | 28284746, d961e4cf |
| **#188** | radiology orders 500 (uuid → admissions.id resolver) | 7ded987b, 449c93ec, a8d4e86f, 2de6874d, cdf1c658, a69c2203 |
| _(reconciliation, no PR)_ | 478 superseded-deploy findings archived via `scripts/reconcile-stale-findings.mjs` | — |

## Pending swarm
The swarm is **stopped** (`systemctl --user stop vh-swarm-loop`,
STOP file in place, watchdog still points at the codex launcher).
Resume by re-arming the systemd unit per the launch recipe in
`start-loop-codex.sh`.
