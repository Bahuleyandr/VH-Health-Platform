# EPIC-Level Roadmap — What to Improve, What's Missing

Created: 2026-06-09. Based on a full sweep of the monorepo (backend routes/schema,
staff/patient/admin apps, infra, docs) plus the open items in
`GOAL_2026-06-16.md`, `PLATFORM_REMEDIATION_PLAN.md`, the 2026-05-23 swarm
triage, `AI_FEATURE_GAP_BACKLOG.md`, `CLINICAL_AI_ROLLOUT_PLAN.md`, and
`PER_TENANT_ROLLOUT_PLAYBOOK.md`.

"Epic-level" here means four things Epic actually delivers, beyond feature
count: **(1) closed-loop clinical safety** (every order is tracked to the
bedside and verified), **(2) boring reliability** (a hospital can run on it at
3 AM during an outage), **(3) an ecosystem** (interfaces, terminology,
analytics, certification), and **(4) AI clinicians actually use under
governance** (ambient documentation, in-workflow decision support — not a
demo). The feature breadth is largely already here — 478 tables, ~80 route
domains, 100+ staff screens, and a 99-module governed AI substrate. The gaps
are depth, closure of loops, operational trust, and taking the AI from
`enabled=false` to measured production use.

---

## 1. Honest position today

| Dimension | State |
|---|---|
| Core EHR (ADT, appointments, eRx, MAR, labs, radiology orders, OT, billing) | Broad and deep — competitive |
| India-market revenue cycle (TPA, PMJAY, preauth, packages, cash drawer) | A genuine differentiator; Epic does not do this out of the box |
| Multi-tenancy, RBAC (44 roles), audit/HIPAA logging | Strong schema + middleware; **full tenant RLS (reads + writes) is code-complete** — remaining work is operator runtime verification (`docs/GO_LIVE_ACTIVATION_CHECKLIST.md` Phase E) |
| Clinical AI substrate (Tiers A–H, governance, review queues) | Far ahead of mid-market peers — 99 governed modules, deep/quick tiers, Ollama manifests, evidence-pack gates — but all `enabled=false`: zero production clinical use yet. The gap is delivery, not capability (Pillar G) |
| Interoperability (FHIR R4 export, HL7v2 parse, SMART OAuth, ABDM tables) | Frameworks exist; **no live bidirectional device/system interfaces** |
| Stability | 11 journeys now green via the deterministic in-CI journey gate (S-Tier WS3); code-fixable high-severity findings from the 2026-05-23 triage closed, operator-gated items tracked in GO_LIVE |
| Front-end depth | Backend capability outruns UI surfacing (e.g. structured CPOE exists server-side; staff app still prescription-text-centric) |

Sequencing principle: **Phase 0 below is stabilization — nothing else on this
list matters until the 11 journeys hold green.** That milestone is now met via
the deterministic in-CI journey gate (S-Tier WS3); the live track is
`docs/S_TIER_ROADMAP.md` + `docs/GO_LIVE_ACTIVATION_CHECKLIST.md`. Epic's real
moat is that it never falls over mid-shift.

---

## 2. Pillar A — Reliability & trust (improve what exists)

These make the difference between "demo-ready" and "hospital runs on it".

| # | Item | Today | To do |
|---|---|---|---|
| A1 | **11 journeys green** (existing goal) | 8 critical / 54 high at baseline; swarm stopped 05-23 | Finish per `GOAL_2026-06-16.md`; hold green 3 ticks |
| A2 | **Tenant RLS enforced end-to-end** | Mostly done since the 05-23 triage: `AUTH_ENFORCE_TENANT_RLS: "true"` in the backend configmap, and a `vhhealth_app` NOSUPERUSER NOBYPASSRLS runtime role with SET LOCAL ROLE — but the role-provisioning SQL lives only in the `dalekdefender` overlay | Replicate `rls-runtime-role.sql` provisioning into the prod overlay/bootstrap, and add the deep test proving a tenant-B JWT cannot read tenant-A PHI through staff routes. Verify `logTenantRlsRolePosture()` is green in prod logs |
| A3 | **Downtime mode (BCA equivalent)** | `downtime_snapshots` table + scattered references | Epic ships read-only downtime viewers on ward PCs. Build: periodic per-ward snapshot export (census, active orders, MAR due list, allergies) to local encrypted files/printable packs; a documented manual-entry → backfill procedure. Test by killing the backend mid-shift |
| A4 | **DR/backup proof** | CloudNativePG 3-replica HA in-cluster | HA ≠ DR: define RPO/RTO, off-site (out-of-hospital) WAL archiving + PITR, and run a quarterly timed restore drill. One UPS failure or ransomware event currently takes data with it |
| A5 | **Load/perf testing** | None found | k6/Gatling profile of a realistic hospital day (OPD rush 8–11 AM, MAR storms at med-pass hours). Set SLOs (e.g. p95 < 400 ms on chart-open) and alert on them |
| A6 | **Observability maturity** | Sentry, Winston, slow-query log, canary checks | Add RED-metrics dashboards per route family, alert runbooks, on-call rota doc; trace sampling on clinical-write paths to 100% |
| A7 | **Secret rotation** | Open item in `PLATFORM_REMEDIATION_PLAN.md` (unchecked) | Rotate everything that ever sat in local `.env`/logs; move to sealed-secrets or external-secrets operator |
| A8 | **Security validation** | CodeQL, gitleaks, IDOR tests | Commission an external pen test + DPDP Act gap review before pilot; add SBOM + image signing verification gate in ArgoCD |
| A9 | **Doctor-ID confusion helper** | 15+ findings share this root cause (05-23 triage) | Single canonical resolver helper, adopted everywhere — highest-leverage code-only fix in the queue |
| A10 | **Allergy propagation & ER→IPD order carry-over** | Known residual findings | Allergies recorded anywhere must surface in CDS checks everywhere; ER orders must follow the patient into IPD |

---

## 3. Pillar B — Close the clinical loops (the core Epic differentiator)

Epic's safety reputation comes from closed loops: nothing is "ordered" until
it's verified given/done, with barcode checks at each handoff.

| # | Loop | Today | Missing |
|---|---|---|---|
| B1 | **Closed-loop medication (BCMA)** | MAR + 5-rights state machine, `mar_scan_screen.dart` exists | End-to-end barcode loop: wristband printing at admission, med-pack barcode/QR at dispensing, scan-patient + scan-med mandatory before administration (override = reason + audit). The pharmacy lifecycle (PENDING→CONFIRMED→PREPARING→READY→DISPATCHED→DELIVERED in `pharmacyConfig.js`) has no **pharmacist clinical-verification state** — add one where a pharmacist reviews the order against allergies/interactions before PREPARING. This is the single highest-value clinical feature on this list |
| B2 | **Drug knowledge base** | `drug_interactions` seeded only in `000_baseline.sql` — a hand-rolled list | License/integrate a real KB (Medi-Span, FDB, or India-appropriate alternative e.g. CIMS/CDSCO data): drug-drug, drug-allergy cross-sensitivity, drug-disease, dose-range by age/weight/renal function, IV compatibility. Wire into existing CDS pipeline. Rule-based checking with a toy interaction table is the biggest clinical-credibility gap vs Epic |
| B3 | **Closed-loop lab** | Specimens + status history + analyzer tables + QC runs | Specimen barcode label printing at collection, scan-on-receipt in lab, **bidirectional analyzer interfaces** (ASTM E1381/HL7 ORU drivers for the actual analyzers the pilot hospital owns), auto-result ingestion with delta checks, autoverification rules going live (service exists in AI tier) |
| B4 | **Closed-loop radiology** | Orders, worklist, AI report QA; PACS adapter table; no viewer | Deploy an actual PACS (Orthanc is the pragmatic on-prem choice) + embed OHIF viewer in staff/admin; DICOM MWL so modalities pull the worklist; images linked from the clinical timeline |
| B5 | **Closed-loop transfusion** | Blood requests, type & screen, stock | Crossmatch workflow, two-person bedside verification with barcode scan of unit + wristband, transfusion-reaction reporting (hemovigilance) |
| B6 | **Medication reconciliation** | Partial: discharge medication draft reconciles pre-admission therapy (`appointmentWorkflowController`) | Make it a formal three-point workflow: admission med-rec (home meds → inpatient orders), transfer-rec on ward/level changes, discharge-rec generating the take-home list with continue/stop/change decisions per drug. Epic treats this as a first-class transition-of-care step; auditors look for it |
| B7 | **Structured problem list** | Diagnoses with ICD-10 per encounter | Longitudinal problem list (active/resolved, onset, managing doctor) distinct from per-visit diagnosis; feeds CDS context and discharge summaries |
| B8 | **Terminology service** | ICD-10 in diagnoses, LOINC validation, SNOMED only in one migration | Central terminology module: SNOMED CT (India has a free national license), LOINC for all lab catalog rows, ICD-10 + ICD-11 ready. Map `investigation_test_catalog` and pharmacy catalog to standard codes — prerequisite for real interop and analytics |

---

## 4. Pillar C — Interoperability & ecosystem

| # | Item | Today | To do |
|---|---|---|---|
| C1 | **ABDM certification** | Full table set (consents, care contexts, ABHA), routes 503 (no gov creds) | For India, "Epic-level" = ABDM M1/M2/M3 certified. Get sandbox creds, pass the certification suites, go live with ABHA linking + Scan & Share OPD registration. This is also a sales unlock — government empanelment increasingly requires it |
| C2 | **HL7v2 live feeds** | Parser/generator exists | Stand up a real interface engine surface (even Mirth Connect alongside) emitting ADT/ORM/ORU to and from third-party systems the hospital already owns (existing LIS analyzers, insurance gateways) |
| C3 | **FHIR R4 server, not just export** | Bundle export + SMART OAuth | Read/write FHIR endpoints for the core resources (Patient, Encounter, Observation, MedicationRequest, ServiceRequest, DiagnosticReport) backed by the canonical timeline; conformance statement; this turns the SMART OAuth work into an actual app platform |
| C4 | **e-signature & document integrity** | Sign/attestation workflow on notes | Digital signature (DSC/eSign India stack) on discharge summaries, MCCD, consent forms; tamper-evident hash chain on `clinical_audit_events` |
| C5 | **Wearables/device ingestion** | Patient app "wearables connect" stub, virtual ward check-ins | Vitals monitor integration in ICU (HL7 ORU from monitors) before consumer wearables — clinical value is much higher |

---

## 5. Pillar D — Missing modules (true white-space)

Ordered by likelihood a pilot-class Indian hospital needs them.

| # | Module | Notes |
|---|---|---|
| D1 | **Oncology / chemo** | Protocol templates, cycle scheduling, cumulative-dose tracking (anthracyclines), BSA-based dosing, double-verification on chemo administration. None exists today; even basic support opens a large market segment |
| D2 | **Scheduling optimization (Cadence-class)** | Slots exist; missing: provider templates (recurring availability, leaves auto-blocking), waitlist auto-fill on cancellation, resource scheduling (rooms/equipment as bookable), overbooking rules. AI no-show prediction already exists — wire it into overbook suggestions |
| D3 | **Provider credentialing & privileging** | Registration numbers, qualifications, privileges (who may operate/prescribe schedule-X), expiry alerts. NABH asks for this |
| D4 | **Quality/accreditation pack (NABH)** | Quality indicators exist piecemeal. Build the NABH indicator set (hospital-acquired infection rates, med-error rate, AMA/LAMA %, average TAT) computed from data already captured, exportable for assessors |
| D5 | **Outbreak/infection-control workbench** | AI sentinel tables exist; needs the workflow: isolate flags on the bed board, contact tracing from ADT history, antibiogram from existing micro sensitivities data |
| D6 | **Research/registry capture (RDC-lite)** | Trials catalog + match results exist; add structured case-report forms bound to clinical data with export |
| D7 | **Dental / ophthalmology / dialysis depth** | Dialysis is basic-medium today (no machine integration); these are common Indian hospital revenue lines — schedule per demand from pilot |

---

## 6. Pillar E — Experience parity

| # | Item | Today | To do |
|---|---|---|---|
| E1 | **Surface CPOE in the staff app** | Backend has structured orders, order sets, state machines; staff UI leans on prescription text + forms | Doctor-facing order composer: searchable catalog, order sets one-tap, CDS interrupts inline, statuses visible. The backend work is done; this is UI |
| E2 | **Staff app localization** | Hardcoded English (`app_strings.dart`); patient app has 5 languages | Nurses are the least-English-comfortable user class. Port the patient app's l10n pipeline |
| E3 | **Accessibility** | `SCREEN_READER_TEST_PLAN.md` exists, untested | Execute it; add font-scaling checks (patient app has `font_scaler`, staff doesn't) |
| E4 | **Admin i18n** | English only | Lower priority; revisit post-pilot |
| E5 | **Chart review ergonomics** | Timeline rail shipped recently | Epic's killer ergonomic is information density: one-screen patient summary (allergies, actives meds, problems, last vitals, pending results) reachable in ≤1 tap from anywhere. Audit every clinical screen for tap-depth |
| E6 | **Patient portal: open results + proxy** | Results/records viewable; family members exist | Result release rules (auto-release after N hours / doctor hold), longitudinal trend graphs for labs, formal proxy access for dependents with consent trail |

---

## 7. Pillar F — Data & analytics (Clarity/Caboodle-class)

| # | Item | To do |
|---|---|---|
| F1 | **Analytics warehouse** | Metabase reads the OLTP DB today — that ceiling is low and risky (long scans vs. 30 s statement timeout). Add a read-replica-fed warehouse (even simple: logical replication → separate Postgres + dbt models) with star schemas for encounters, orders, revenue |
| F2 | **Operational dashboards from the warehouse** | Bed-flow forecast, OT utilization, department P&L, payer-mix — tables already capture the raw events |

---

## 8. Pillar G — AI integration (productionize the substrate)

Position check: the AI build-out is **done** — 99 governed modules (Tiers A–H),
graph runner with checkpoint/resume, decision memory, deep/quick model tiers,
in-cluster Ollama manifests, LAN-only clinical ingress, voice-to-SOAP, review
queues on all three surfaces, two-person approval + eval gates, pilot evidence
pack, tenant preflight script. All modules ship `enabled=false`,
decision-support-only. Per `CLINICAL_AI_ROLLOUT_PLAN.md`: *"the rollout problem
is now about who uses it, on what device, and over which network — not about
new AI features."* This pillar honors that — no new modules; it takes what
exists to production and wires it into the Pillar B/C/D loops.

| # | Item | Today | To do |
|---|---|---|---|
| G1 | **Deep tier live on real hardware** | Ollama StatefulSet manifests + `CLINICAL_AI_DEEP_*` env wired; GPU node is a procurement decision | Buy/allocate the GPU node (model choice per `HARDWARE_REQUIREMENTS.md`; 70B ideal, 14B acceptable), install nvidia-device-plugin, pin `CLINICAL_AI_ALLOW_EXTERNAL=false` per tenant. PHI-never-leaves-building is the compliance story that gets AI approved at all — everything below depends on it |
| G2 | **Stage-1 pilot, by the book** | `PER_TENANT_ROLLOUT_PLAYBOOK.md` defines stage_1 = `medication_reconciliation` + `patient_aftercare_instructions`; preflight script + evidence pack exist | Run it on one ward: preflight green with `-RequireNoWarnings`, one real doctor for a week (rollout plan's own validation rule), export evidence pack, signed pilot record. Do this **with** B6 — the med-rec AI module and the formal med-rec workflow are the same rollout |
| G3 | **Outcome instrumentation** | Generations/reviews/safety decisions are logged; no outcome KPIs | Per-module scoreboard from existing tables: acceptance rate, edit distance, override rate, time-to-sign vs baseline, safety-flag precision. Enable/disable decisions and stage promotions become data-driven; this is also the evidence NABH/DPDP reviewers and hospital boards ask for |
| G4 | **Pair modules with the closed loops** | Modules exist in isolation from the Pillar B work | Each loop gets its AI co-pilot at the same time the loop ships: B2 drug KB ↔ polypharmacy + antimicrobial stewardship + pediatric dosing modules (deterministic KB first, AI reasons on top — never instead); B3 analyzer interfaces ↔ lab autoverification + abnormal-result triage; B4 PACS ↔ radiology worklist prioritization + report QA; B6 ↔ med-rec module (G2); D2 scheduling ↔ no-show prediction feeding overbook suggestions; A&E ↔ ED triage assist; F1 warehouse ↔ denial prediction + payer-variance + acuity/inventory forecasting (Tier H) |
| G5 | **Knowledge layer** | `clinical_protocols` seeded (S2 closed); formulary import tooling just landed; RAG corpus tables exist | Curate per-hospital: import the pilot hospital's actual formulary, antibiograms (from micro data), local protocols into the RAG corpus; refresh cadence + ownership. Generic answers are how clinical AI loses trust on day one |
| G6 | **Ambient/voice rollout** | Voice-to-SOAP + ambient documentation + diarization shipped, consent-gated | Hospital-side ceremony: consent wording, audio retention policy, device policy, which roles may create voice-derived drafts. Pilot in OPD (highest doc burden per minute) after G2 proves the review loop |
| G7 | **Model lifecycle & regulatory posture** | Drift canary, eval gates, bias telemetry (S3), regulatory-pack exporter (S5) all shipped | Put them on a clock: scheduled eval re-runs per model update, drift alerts to on-call, quarterly bias report. Track CDSCO's evolving position on AI-as-medical-device in India; the decision-support-only + clinician-signs framing is the defensible line — keep it |
| G8 | **Patient-facing AI, multilingual** | Teach-back, family updates, chatbot, aftercare modules exist; publish-after-signoff only | Gate behind G2/G3 evidence. Patient-facing outputs must ship in the patient app's 5 languages (en/hi/ta/te/ml) — an English-only aftercare note read by a Tamil-speaking family is a safety gap, not a polish item |

---

## 9. What NOT to do

- Don't rebuild billing/TPA/PMJAY to look like Epic Resolute — the India-specific flow is the moat.
- Don't chase ONC/US certification unless targeting US customers; DPDP + ABDM + NABH is the relevant stack.
- Don't add new feature surface before Phase 0 holds green (existing rule in `GOAL_2026-06-16.md` — keep it).
- Don't build **new** AI modules — the rollout plan's own rule. 99 exist; the work is delivery, evidence, and loop-pairing (Pillar G).
- Don't enable AI modules ahead of their deterministic foundation: B2 drug KB before drug-safety AI surfaces broadly; clinicians will judge the whole platform by one bad interaction miss.
- Don't skip the playbook gates (preflight, evidence pack, signoff) to demo faster — they exist to make the first pilot survivable.

---

## 10. Phased plan

| Phase | Window | Contents | AI track (Pillar G) | Exit criteria |
|---|---|---|---|---|
| **0 — Stabilize** | now (S-Tier WS0–WS3; see `docs/S_TIER_ROADMAP.md`) | A1, A2, A7, A9, A10 | None — feature freeze applies to AI too | 11 journeys green × 3 ticks (in-CI journey gate); 0 critical/high in-flight; RLS runtime-verified (GO_LIVE Phase E) |
| **1 — Pilot-hard** | +0–3 months | A3 downtime mode, A4 DR drill, A5 load test, A6 observability, A8 pen test, B1 BCMA, B2 drug KB, B6 med-rec, E1 CPOE UI, E2 staff i18n | G1 GPU + deep tier live; G2 stage-1 ward pilot (med-rec + aftercare, rides on B6); G3 outcome scoreboard; G5 formulary/protocol corpus for pilot hospital | Pilot ward runs a full med-pass via barcode; restore drill < RTO; pen-test highs closed; stage-1 evidence pack signed with G3 metrics attached |
| **2 — Close the loops** | +3–9 months | B3 lab interfaces, B4 PACS+viewer, B5 transfusion, B7 problem list, B8 terminology, C1 ABDM cert, C4 e-sign, D2 scheduling, D4 NABH pack, E5/E6 | G4 loop-paired enables: lab autoverification + abnormal-result triage (with B3), radiology prioritization + report QA (with B4), drug-safety modules (after B2), no-show→overbooking (with D2); G6 ambient/voice in OPD; G7 lifecycle cadence | ABDM certified; analyzer results flow hands-free; NABH pack exports; ≥5 AI modules in production with acceptance >70% and zero unreviewed-output incidents |
| **3 — Ecosystem** | +9–18 months | C2 interface engine, C3 FHIR server, D1 oncology, D3 credentialing, D5 infection control, F1–F2 analytics | G4 Tier-H ops forecasting + revenue-cycle AI on the F1 warehouse; G8 multilingual patient-facing AI; CDS Hooks cards exposed via C3 to third-party apps | Third-party SMART app consumes the FHIR API; warehouse powers exec dashboards; AI scoreboard reviewed quarterly as a standing governance artifact |

---

## 11. Top 10 if forced to choose

1. A2 — finish tenant RLS rollout to prod (PHI risk, days of work)
2. A1 — journeys green (existing goal)
3. B2 — real drug knowledge base
4. B1 — closed-loop BCMA
5. A3 — downtime mode
6. A4 — off-site DR + restore drill
7. B6 + G2 — medication reconciliation workflow with its AI module as the stage-1 ward pilot (one rollout, two wins)
8. E1 — CPOE surfaced in staff UI
9. B3 — analyzer interfaces (+ G4 lab autoverification riding on them)
10. C1 — ABDM certification

---

*Update cadence: revisit at each phase exit. Keep findings-driven items synced
with the swarm queue rather than duplicating them here.*
