# VH Health AI Feature Tracker

Last verified: 2026-04-23 (appeal letter generator v1 shipped)

This tracker records the 40 future-proofing AI features proposed for VH Health and maps each one to the current repo state. Update this file whenever a feature graduates from "Not started" to "Partial" or from "Partial" to "Implemented v1".

Status definitions:

- `Implemented v1`: Working backend/service/API/admin surface exists for the core workflow. Further production hardening may still be listed.
- `Partial`: A meaningful adjacent foundation exists, but the named workflow is not complete end to end.
- `Not started`: No dedicated workflow exists yet.

Current count:

- Implemented v1: 6 / 40
- Partial: 19 / 40
- Not started: 15 / 40
- Remaining to fully implement: 34 / 40

| # | Feature | Status | Current repo state | Next build unit |
|---:|---|---|---|---|
| 1 | Document Intelligence / OCR AI | Implemented v1 | `document_intelligence_ocr`, `documentIntelligenceService.js`, native text/PDF/photo upload adapter, Admin/IT upload panel, and review queue exist. Text/PDF text-layer extraction works locally; image OCR can use local Tesseract when configured and otherwise falls back safely to review. | Add production object storage handoff and optional cloud OCR/provider adapters behind governance. |
| 2 | Nursing Ambient Documentation | Partial | `ambient_visit_documentation` and ambient encounter flow exist for multi-speaker clinical notes. | Add nursing-specific bedside schema: wounds, drains, IV lines, I/O, mobility, falls, shift charting. |
| 3 | Clinical Task Extractor | Implemented v1 | `clinical_task_extractor`, `clinicalTaskExtractorService.js`, `clinical_ai_task_candidates`, Admin/IT API, and dashboard review queue exist. V1 creates cited candidates and never auto-assigns work. | Add clinician-facing queue and optional post-review task assignment integration. |
| 4 | Infection-Control Surveillance | Implemented v1 | `infection_control_sentinel`, `infectionControlSentinelService.js`, admin audit/review panel. | Add continuous realtime ward surveillance and cluster/outbreak automation. |
| 5 | Antimicrobial Stewardship Assistant | Implemented v1 | `antimicrobial_stewardship`, `antimicrobialStewardshipService.js`, `clinical_ai_antimicrobial_reviews`, Admin/IT API, and dashboard review queue exist. V1 reviews cultures, duration, renal dosing, IV-to-oral switch, duplicate spectrum, de-escalation, and allergy conflicts without changing orders. | Add continuous stewardship rounds, local antibiogram integration, and policy-pack customization. |
| 6 | Patient Teach-Back / Comprehension AI | Implemented v1 | `patient_teach_back_comprehension`, `patientTeachBackService.js`, `clinical_ai_teach_back_sessions`, EMR + Admin/IT APIs, and dashboard review queue exist. V1 generates category-covered questions (medications, warning signs, follow-up, diet/activity, wound care, emergency escalation) in the patient's language, scores answers, and flags misunderstandings for clinician review without altering care plans. | Add patient-facing chat/IVR delivery, longitudinal comprehension tracking across admissions, and accepted-draft-only gating. |
| 7 | Consent-Aware Family Update Generator | Partial | Consent/PHI sentinel and patient communication translation exist. | Add caregiver/family update draft module gated by consent scope. |
| 8 | Appeal Letter Generator for Denied Claims | Implemented v1 | `appeal_letter_generator`, `appealLetterGeneratorService.js`, `clinical_ai_appeal_letters`, Admin/IT APIs (generate/review/submit/payer-response), and dashboard panel exist. V1 classifies denial reasons (medical necessity, prior-auth missing, documentation insufficient, coding, duplicate, timely filing, bundled, non-covered, coverage) and drafts a cover letter, medical necessity narrative, evidence bundle, and requested action from cited chart evidence. Billing coordinator reviews, edits, and submits; module never auto-submits. | Add payer-specific templates, appeal outcome analytics, and integration with denial-risk assist for proactive appeal prep. |
| 9 | Payer Contract Variance / Underpayment AI | Not started | No contract variance or payment reconciliation AI workflow found. | Add contract/tariff ingestion plus expected-vs-paid variance engine. |
| 10 | Acuity-Based Staffing Forecast | Partial | Roster optimizer exists; deterioration/NEWS2 risk exists. They are not connected for acuity-weighted staffing. | Add acuity load model and feed it into staffing demand. |
| 11 | ED Triage and Boarding Predictor | Not started | No ED triage/boarding predictor workflow found. | Add ED intake risk, specialty/bed prediction, and boarding bottleneck dashboard. |
| 12 | Sepsis / Stroke / ACS Bundle Compliance AI | Partial | `sepsis_bundle_sentinel` is implemented. Stroke, ACS, VTE, insulin, and other pathways are not. | Generalize bundle sentinel framework across pathway packs. |
| 13 | ICU Ventilator / Sedation Bundle Reviewer | Not started | No dedicated ventilator/sedation bundle reviewer found. | Add VAP bundle, sedation interruption, SBT readiness, delirium, and ventilator-day review. |
| 14 | Radiology Report QA / Discrepancy Assistant | Partial | Imaging inference, PACS adapter, and radiologist queue exist. | Add report QA checks: laterality, missing impression, critical-result communication, indication mismatch. |
| 15 | Radiology Worklist Prioritizer | Partial | Imaging queue has severity and critical finding support, but not full worklist prioritization. | Rank studies by vitals, location, modality, diagnosis, prior imaging, ED/ICU status. |
| 16 | Lab Autoverification / Delta Check Assistant | Not started | Abnormal result triage exists, but no lab delta/autoverification workflow. | Add specimen/delta/critical-value assistant for lab review. |
| 17 | Blood Bank Demand and Compatibility Forecast | Not started | No blood bank AI workflow found. | Add component demand forecast, crossmatch urgency, MTP readiness, stock risk. |
| 18 | Pharmacogenomics / PGx Support | Not started | No genotype-aware medication support found. | Add PGx data model and medication guidance rules. |
| 19 | Pregnancy / Obstetric Risk Assistant | Not started | No obstetric risk workflow found. | Add ANC, preeclampsia, fetal growth, postpartum follow-up risk assistant. |
| 20 | Pediatric Dosing Safety AI | Not started | Medication safety foundations exist, but no pediatric dosing module. | Add weight/age/max-dose and pediatric pathway checks. |
| 21 | Hospital Command Center AI | Partial | Bed forecast and operational AI pieces exist, but no unified command center. | Add cross-department command center over bed, OT, housekeeping, transport, radiology, pharmacy. |
| 22 | Housekeeping and Bed Turnover Optimizer | Not started | Housekeeping workflows exist outside AI; no AI turnover optimizer found. | Add bed cleaning prediction, isolation-room priority, bed-ready delay reduction. |
| 23 | OT Block Scheduling Optimizer | Partial | OT case-time predictor exists. | Add block allocation, cancellation prediction, instrument readiness, surgeon utilization. |
| 24 | Inventory AI Beyond Pharmacy | Partial | Pharmacy stockout predictor exists. | Expand inventory AI to linen, implants, consumables, oxygen, PPE, lab reagents, contrast. |
| 25 | Biomedical Device Maintenance Predictor | Not started | No device maintenance predictor found. | Add device usage/service-log ingestion and failure/downtime forecast. |
| 26 | Cybersecurity / Medical Device Anomaly Detector | Not started | Governance/audit/security foundations exist, but no SOC anomaly AI. | Add admin action, device traffic, impossible login, suspicious export detection. |
| 27 | Staff Burnout / Workload Risk Predictor | Not started | Roster and HR data exist, but no privacy-gated burnout predictor. | Add workload risk model with strict privacy/governance controls. |
| 28 | Training and Simulation Coach | Not started | Canary/adversarial tests exist, but no staff training simulation coach. | Add de-identified incident-to-training-case generator. |
| 29 | Policy Diff / Regulation Watcher | Partial | Admin policy copilot/governance surfaces exist. | Add watcher for policies, payer rules, accreditation updates, and impact mapping. |
| 30 | Procurement Negotiation Assistant | Not started | No procurement negotiation AI found. | Add quote comparison, reorder volume prediction, historical price anomaly checks. |
| 31 | Model Registry and Evaluation Workbench | Partial | Prompt experiments, drift canary, safety scorecard, governance report exist. | Add formal model registry, eval datasets, deployment approvals, lineage. |
| 32 | Dataset Labeling and Review Studio | Partial | Clinical review queues exist for AI drafts. | Add generic labeling studio for imaging, coding, denial, deterioration, triage outcomes. |
| 33 | Synthetic Clinical Case Generator | Partial | Canary/adversarial testing foundations exist. | Add synthetic/de-identified case generator for CI, demos, edge cases, and canaries. |
| 34 | Federated Learning / Privacy-Preserving Training Layer | Not started | No federated training layer found. | Add long-term site-local training architecture with privacy-preserving aggregation. |
| 35 | AI Agent Lifecycle Manager | Partial | Module registry, self-healing agent, governance, audit, and kill-switch-like module controls exist. | Add dedicated agent registry with owner, permissions, scopes, expiry, evals, lineage. |
| 36 | Clinical Knowledge Graph | Partial | RAG corpus and patient timeline foundations exist, but no graph model. | Add graph schema linking patient, diagnoses, meds, labs, procedures, providers, encounters, payers. |
| 37 | Multimodal Patient Timeline | Partial | Patient timeline plus document, imaging, voice, and ambient data exist as separate workflows. | Build unified multimodal timeline across chart, documents, imaging, audio, claims, messages. |
| 38 | Voice Patient Assistant / IVR | Partial | STT, patient chatbot, virtual ward, and translation foundations exist. | Add consent-gated voice/IVR bot for prep, aftercare, meds, reminders, virtual ward. |
| 39 | AI Explainability Dashboard | Partial | Citations, hallucination defenses, safety review scorecard, and governance report exist. | Add per-draft evidence map, unsupported claims, bias/numeric checks, reviewer edit deltas. |
| 40 | AI ROI Dashboard | Partial | Usage, token/cost, review, and acceptance metrics exist. | Add ROI metrics: time saved, denial prevented, documentation hours, cost per useful draft. |

Recommended next build order:

1. AI ROI Dashboard
2. Nursing Ambient Documentation
3. Consent-Aware Family Update Generator
4. Payer Contract Variance / Underpayment AI
