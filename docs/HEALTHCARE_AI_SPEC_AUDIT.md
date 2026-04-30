# Healthcare-AI Spec — Audit + Gap Plan

**Audited:** 2026-04-30 against `main` at commit after the multi-agent + rollout series.
**Spec source:** the 38-section AI-enabled healthcare backend build spec the user shared.
**Audit method:** Prisma schema (237 models), `apps/backend/src/routes/`, `apps/backend/src/services/`, `apps/backend/src/migrations/` (109 migrations), Flutter apps `apps/staff` + `apps/patient`, Next.js `apps/admin`, `infra/kubernetes/`. Cross-referenced against each spec section's Entities + APIs + Features list.

**TL;DR:** the existing platform already covers ≈75% of the spec end-to-end. Gaps cluster in five areas: (1) explicit `Facility` / `Location` / `Room` granularity below tenant, (2) formal `Webhook` + `Integration` registry tables, (3) telemedicine session entities, (4) knowledge-base CRUD as a first-class module (current RAG is service-only), and (5) several spec-named entities that exist as differently-named tables (rename / alias rather than rebuild). Stack rewrite is **not needed** — the spec explicitly says "if existing stack differs, follow it" and Express/Prisma/Postgres meets the requirements.

**Companion docs (read alongside this one):**
- [`CLINICAL_AI_ROLLOUT_PLAN.md`](CLINICAL_AI_ROLLOUT_PLAN.md) —
  five-phase deployment plan for the multi-agent substrate that's
  already on `main`. **All shipped 2026-04-30.** That's "how to deploy
  what's built"; this audit is "what to build next at infra/entity level".
- [`AI_FEATURE_GAP_BACKLOG.md`](AI_FEATURE_GAP_BACKLOG.md) —
  ~250-feature AI-catalogue audit at the **module / feature layer**
  (vs this doc's entity / infra layer). Surfaces five substrate-level
  safety holes (S1–S5: prompt-injection gate on document ingest,
  empty `clinical_protocols` seed, demographic bias monitoring,
  CDS Hooks card adapter, regulatory-readiness pack exporter)
  worth fixing before new modules.

When a question is "do we have entity X?" → start here. When it's
"do we have AI feature Y?" → start at the backlog. Phase D2 (CDS
Hooks) and Phase E (compliance hardening) in this doc overlap with
backlog items S4 and S5; treat them as the same work item, not
duplicates.

---

## How to read this doc

Each spec section gets a verdict table:

| Spec entity / capability | VH Health equivalent | Verdict |
|---|---|---|

Verdicts:
- ✅ **present** — exists with substantively the same fields/behaviour
- 🟡 **partial** — exists but missing some sub-features the spec calls out
- 🔴 **missing** — no equivalent today; remediation needed
- ⏩ **better than spec** — VH Health goes beyond the spec's minimum
- ➖ **out of scope / different choice** — intentional divergence (rare)

After the matrices: the **top-10 prioritised gaps** + a **remediation roadmap** that bolts onto the existing clinical-AI rollout plan.

---

## §1 — User roles + access model

| Spec | VH Health | Verdict |
|---|---|---|
| `SUPER_ADMIN`, `TENANT_ADMIN` | `SUPER_ADMIN`, `ADMIN` (acts as tenant admin) | ✅ |
| `SECURITY_ADMIN`, `COMPLIANCE_OFFICER`, `DATA_PROTECTION_OFFICER`, `AI_GOVERNANCE_ADMIN` | Conflated into `ADMIN`/`IT_ADMIN`/`SUPER_ADMIN`. `AI_GOVERNANCE` exists in some module reviewRoles but no formal user role | 🟡 |
| `HOSPITAL_ADMIN`, `FACILITY_MANAGER`, `DEPARTMENT_ADMIN` | `ADMIN` covers hospital_admin; no facility/department admin role | 🟡 |
| `FRONT_DESK`, `APPOINTMENT_MANAGER`, `MEDICAL_RECORDS_OFFICER` | `RECEPTIONIST`, `MEDICAL_RECORDS` | 🟡 (no APPOINTMENT_MANAGER) |
| `DOCTOR`, `CONSULTANT`, `JUNIOR_DOCTOR`, `RESIDENT` | `DOCTOR` only — no seniority differentiation | 🟡 |
| `NURSE`, `HEAD_NURSE` | `NURSING_STAFF`, `NURSE_MANAGER` (seen in module reviewRoles) | ✅ |
| `PHARMACIST`, `LAB_TECHNICIAN`, `RADIOLOGY_TECHNICIAN`, `RADIOLOGIST` | `PHARMACY_STAFF`, `LAB_STAFF`, `RADIOLOGIST` (no separate technician role; LAB_STAFF + RADIOLOGY_STAFF cover) | ✅ |
| `DIETITIAN`, `PHYSIOTHERAPIST`, `COUNSELLOR`, `CARE_COORDINATOR` | `DIETITIAN`, `PHYSIOTHERAPIST` exist; no COUNSELLOR / CARE_COORDINATOR | 🟡 |
| `BILLING_STAFF`, `INSURANCE_STAFF`, `CLAIMS_MANAGER` | `BILLING_STAFF`, `INSURANCE_COORDINATOR` (no CLAIMS_MANAGER) | 🟡 |
| `INVENTORY_MANAGER`, `PROCUREMENT_MANAGER` | `MATERIALS_MANAGER`, `PROCUREMENT_LEAD` (seen in clinical_ai module reviewRoles) | ✅ |
| `HOUSEKEEPING`, `AMBULANCE_COORDINATOR` | `HOUSEKEEPING_STAFF`; no ambulance role | 🟡 |
| `PATIENT`, `PATIENT_GUARDIAN`, `PATIENT_CAREGIVER` | `PATIENT`; guardians captured via `family_members` table but no separate role | 🟡 |
| `API_CLIENT`, `INTEGRATION_ADMIN`, `WEBHOOK_CLIENT` | API key auth via `API_KEY_*` env vars (not formal role); no integration_admin | 🟡 |
| Break-glass with reason + alert + audit | `clinical_ai_break_glass_sessions` ✅ |
| MFA TOTP | `otp_sessions`, `otp_logs` exist; no formal `mfa_devices` (TOTP) table | 🟡 |
| Session/device list + revoke | `user_sessions`, `staff_auth_sessions`, `user_devices`, `staff_devices` ✅ |
| Patient-relationship ABAC | partially — IDOR checks via `String()` comparisons exist | 🟡 |
| Care-team membership ABAC | no formal CareTeam table | 🔴 |

**Verdict overall:** 🟡 partial. Roles broadly map; canonical naming differs and several spec roles are unrepresented. CareTeam ABAC is a real gap.

---

## §2 — Tenancy + organisation

| Spec | VH Health | Verdict |
|---|---|---|
| `Tenant` | `tenants` ✅ |
| `Facility` | **🔴 missing** — `hospitals` table exists but `Facility` ≠ `Hospital` (a hospital can have multiple facilities; VH Health treats them as 1:1) |
| `Department` | `departments` ✅ |
| `Location`, `Ward`, `Room`, `Bed` | `wards`, `beds` ✅ ; **🔴 no `Location`, no `Room`** (bed lives directly under ward) |
| `CareTeam` | 🔴 missing |
| `StaffProfile`, `PractitionerProfile` | `staff`, `doctors` (separate tables) — practitioner-profile concept partially covered but inconsistent | 🟡 |
| `Shift`, `WorkingHours`, `Holiday` | `staff_attendance`, `staff_roster_runs`, `staff_roster_preferences` — shift planning exists | ✅ |
| `ServiceCatalog`, `Specialty`, `FacilitySettings` | 🔴 no service_catalog table; specialties live as inline strings on doctors |
| Multi-facility per tenant | 🔴 not modelled — single hospital per tenant assumption |

**Verdict:** 🟡 partial. Multi-facility + Location/Room granularity is the clearest infra gap. ServiceCatalog as a first-class entity would clean up billing/scheduling.

---

## §3 — Auth + security

| Spec | VH Health | Verdict |
|---|---|---|
| Email/password, phone OTP | ✅ |
| JWT + refresh + rotation | ✅ (`refresh-token` endpoint, `invalidated_tokens` table) |
| MFA TOTP | 🟡 OTP-only (SMS/email); TOTP scaffolding referenced in `apps/admin` `totpRoutes.js` but no schema |
| SSO | 🔴 not present |
| API keys for machine clients | 🟡 env-var keys (`API_KEY_PATIENT`, `API_KEY_STAFF`, `API_KEY_ADMIN`) only; no DB-backed `api_clients`/`api_keys` |
| OAuth2 / SMART-on-FHIR foundation | 🔴 not present |
| Rate limiting | ✅ (`rateLimitMiddleware`, multiple profiles) |
| IP allowlist for admin | ✅ (`adminIpAllowlist`) |
| Account lockout | ✅ (`_checkStaffLockout`, admin lockout) |
| Security event logging | ✅ (`auth_logs`, `security_events`, `securityWebhook`) |
| Helmet/CORS/HSTS | ✅ |

**Verdict:** ✅ broadly present, with two real gaps: TOTP (MFA) + DB-backed API client registry.

---

## §4 — Patient master index

| Spec | VH Health | Verdict |
|---|---|---|
| `Patient` | `users` (PATIENT role) + `patient_records` ✅ |
| `PatientIdentifier` (multi-type — MRN, UHID, ABHA, mobile, Aadhaar token, passport, insurance, external) | 🔴 single `patient_uid` (UUID) only — multi-identifier table missing |
| `PatientContact`, `PatientAddress` | inline fields on `users` | 🟡 |
| `EmergencyContact`, `Guardian`, `PatientRelationship` | `family_members` table covers ✅ |
| `PatientPreference`, `PatientRiskProfile` | 🟡 risk concepts captured via `clinical_ai_*` tables; no consolidated PatientRiskProfile |
| `PatientDuplicateCandidate`, `PatientMergeRequest` | 🔴 missing |
| `PatientConsentPreference` | `patient_consents`, `patient_data_rights_requests` ✅ |
| ABHA-aware registration | 🟡 `abdm_consents`, `abdm_data_requests` exist; no formal `ABHAProfile` |
| Restricted/employee chart, VIP | 🔴 no `restricted_chart` flag visible |
| QR for registration | 🔴 not present |

**Verdict:** 🟡 substantial. Multi-identifier table + duplicate/merge workflow are real gaps that will hurt as soon as a hospital onboards real data.

---

## §5 — Appointments + queue + front desk

| Spec | VH Health | Verdict |
|---|---|---|
| `Appointment`, `AppointmentSlot`, `AppointmentType` | `appointments`, `appointment_status_history`, `appointment_documents` ✅ (slot table inferred) |
| `QueueEntry`, `CheckIn`, `Token` | live in `appointment_status_history` + `clinical_ai_no_show_predictions` | 🟡 |
| `NoShowPrediction` | `clinical_ai_no_show_predictions` ✅ |
| `ReferralSource`, `VisitReason` | `referrals` ✅; visit reason inline on appointments |
| Online booking, walk-in, emergency, reschedule, cancel | ✅ |
| Reminders | ✅ (`scheduled_notifications`, `reminders`) |
| Token / live queue display | 🟡 — token system referenced but no dedicated queue table |
| AI symptom-based routing | `chatbot` service + AI no-show / queue optimisation exist | ✅ |
| Pre-visit questionnaire / digital intake | 🟡 partial via investigation_bookings flow |

**Verdict:** ✅ mostly present. Queue/Token structure could be extracted to a dedicated module for clarity.

---

## §6 — Encounter / visit / EMR

| Spec | VH Health | Verdict |
|---|---|---|
| `Encounter` | `consultations` (semantically equivalent) ✅ |
| `ClinicalNote`, `SOAPNote` | `clinical_notes`, `clinical_voice_notes` ✅ |
| `Diagnosis`, `DifferentialDiagnosis`, `ProblemListItem` | `diagnoses`, `cds_alerts` (CDS), `clinical_ai_explainability_reports` ✅ |
| `Allergy` | `allergies`, `patient_allergies` ✅ |
| `PastMedicalHistory`, `FamilyHistory`, `SocialHistory`, `SurgicalHistory`, `MedicationHistory` | inline on `medical_records` / `health_records` | 🟡 |
| `CarePlan`, `FollowUpPlan` | 🔴 no dedicated table; plans inline in clinical_notes/discharge |
| `Referral` | `referrals` ✅ |
| `ClinicalTemplate`, `ClinicalForm`, `FormResponse` | 🔴 missing as first-class; templates exist for investigations only |
| ICD/SNOMED coding | `icd10_codes`, `icd_cpt_map` ✅ |
| Encounter close/sign + version history + co-sign | partial — `prescription_safety_overrides` for prescriptions; no formal sign workflow on consultations | 🟡 |
| AI chart summary, SOAP draft, differential, missing-data, RAG | **⏩ goes well beyond spec** — `clinicalAiWorkflowService`, `clinicalDebateService`, `decisionMemoryService`, full graph runner |

**Verdict:** 🟡 broadly present; CarePlan + ClinicalTemplate are real gaps. AI surface is **better than spec asks**.

---

## §7 — Vitals, observations, devices

| Spec | VH Health | Verdict |
|---|---|---|
| `Observation`, `VitalSign` | `patient_vitals`, `vitals_chart`, `news2_scores` ✅ |
| `Device`, `DeviceReading` | `devices` ✅ + `clinical_ai_biomed_devices` ⏩ |
| `NursingObservation`, `IntakeOutput` | `intake_output`, `nurse_handovers` ✅ |
| `GrowthChartEntry` | 🔴 missing |
| `PainScore`, `FallRiskAssessment` | 🟡 fall risk implicit in clinical safety; no dedicated table |
| `EarlyWarningScore` | `news2_scores` ✅ (NEWS2 implementation) |
| Device data ingestion | `devices`, `clinical_ai_biomed_maintenance_predictions` ✅ |
| AI deterioration risk | `clinical_ai_deterioration_snapshots`, `deteriorationEarlyWarningService` ⏩ |

**Verdict:** ✅ strong, with a couple specialty tables (growth chart, pain/fall) missing.

---

## §8 — Prescription, medication, pharmacy

| Spec entity | VH Health | Verdict |
|---|---|---|
| `Medication`, `DrugCatalogItem`, `FormularyItem` | `medications`, `drug_interactions`, `e_prescriptions` ✅ |
| `Prescription`, `PrescriptionItem` | `prescriptions`, `e_prescriptions`, `prescription_safety_overrides` ✅ |
| `MedicationRequest`, `MedicationAdministration`, `MedicationDispense` | `medication_administrations`, `pharmacy_orders`, `pharmacy_order_history` ✅ |
| Drug/allergy/interaction/duplicate/renal/liver/pregnancy/pediatric/geriatric/high-risk rules | `clinical_ai_pediatric_dose_checks`, `clinical_ai_polypharmacy_reviews`, `clinical_ai_pgx_advisories`, `clinical_ai_antimicrobial_reviews`, `prescription_safety_overrides` ⏩ |
| `PharmacyOrder`, `PharmacyInvoice`, `PharmacyInventoryItem`, `InventoryBatch`, `StockMovement`, `Supplier`, `PurchaseOrder`, `GoodsReceipt`, `ExpiryAlert`, `SubstituteMedication` | `pharmacy_orders`, `clinical_ai_inventory_alerts` (forecast); inventory/batch/supplier/PO **🔴 not modelled** |
| AI medication reconciliation | `clinicalAiWorkflowService` discharge_compose covers ✅ |
| Antibiotic stewardship | `clinical_ai_antimicrobial_reviews`, `antimicrobialStewardshipService` ⏩ |

**Verdict:** 🟡 medication/clinical-rules side is **strong+**; pharmacy supply chain (inventory batches, suppliers, POs, expiry) is missing.

---

## §9 — Laboratory

| Spec entity | VH Health | Verdict |
|---|---|---|
| `LabTest`, `LabPanel`, `LabOrder`, `LabOrderItem` | `investigation_test_catalog`, `investigation_templates`, `investigations`, `investigation_bookings` ✅ |
| `Specimen`, `SampleCollection` | inline on investigations | 🟡 |
| `LabResult`, `LabResultValue`, `LabReport` | `investigations`, `investigation_files` ✅ |
| `LabReferenceRange`, `LabCriticalValueRule` | 🟡 reference ranges inline; critical-value rules baked into LOINC validator (`hl7/loincValidator.js`) |
| `LabMachineIntegration`, `LabQualityControlEntry` | 🔴 not modelled (HL7 ingestion exists but no machine registry) |
| Result verification, signing, PDF report | ✅ via investigation flow |
| AI lab interpretation, trend, patient-friendly | `labAutoverificationService`, `clinical_ai_lab_autoverifications`, `longitudinalRiskService` ⏩ |
| FHIR Observation/DiagnosticReport mapping | ✅ via `fhirAdapter.js` |

**Verdict:** ✅ strong. Specimen + lab-machine integration would benefit from explicit modelling for QA/QC trace.

---

## §10 — Radiology + imaging

| Spec entity | VH Health | Verdict |
|---|---|---|
| `RadiologyOrder` | `radiology_orders` ✅ |
| `ImagingStudy`, `ImagingSeries` | `clinical_ai_imaging_studies` ✅ |
| `ImagingReport`, `RadiologyTemplate` | `clinical_ai_radiology_report_reviews`, `clinical_ai_radiology_worklist_priorities` ✅ |
| `PACSIntegration`, `DICOMMetadata` | `imagingPacsAdapterService`, `imagingPacsAdapterService` ✅ |
| AI summary/discrepancy detection | `radiologyReportQaService` ⏩ |

**Verdict:** ✅ present.

---

## §11 — Documents, files, OCR, medical records

| Spec entity | VH Health | Verdict |
|---|---|---|
| `FileObject`, `Document`, `DocumentVersion`, `DocumentReference` | `file_metadata`, `appointment_documents`, `clinical_document_intake`, `clinical_document_extraction_events` ✅ |
| `DocumentExtraction`, `OCRJob` | `clinical_document_extraction_events`, `documentOcrAdapter`, `documentIntelligenceService` ✅ |
| `MedicalRecordBundle` | 🔴 no formal bundle entity (FHIR adapter generates them on demand) |
| `RecordReleaseRequest`, `RecordAccessGrant` | 🟡 `patient_data_rights_requests` covers part; no dedicated release-grant table |
| AI doc summary / classify / extract | `documentIntelligenceService` ⏩ |
| FHIR DocumentReference mapping | ✅ |

**Verdict:** ✅ strong; release-request + bundle entities would close the loop.

---

## §12 — Inpatient, admission, bed, ICU, nursing

| Spec entity | VH Health | Verdict |
|---|---|---|
| `Admission`, `AdmissionRequest` | `admissions` ✅ (no separate request) |
| `BedAssignment`, `Transfer` | `bed_transfers` ✅ |
| `WardRound`, `NursingNote`, `NursingTask`, `MedicationAdministrationRecord`, `IntakeOutputChart` | `nurse_handovers`, `intake_output`, `medication_administrations`, `clinical_notes` ✅ |
| `ProcedureOrder`, `DietOrder` | `clinical_orders`, `diet_orders` ✅ |
| `DischargePlanning`, `HandoverNote`, `ICUFlowSheet` | `nurse_handovers`, `clinical_ai_ventilator_bundle_audits` ✅ |
| Sepsis/AKI/deterioration alerts | `clinical_ai_sepsis_bundle_audits`, `clinical_ai_deterioration_snapshots`, `news2_scores` ⏩ |
| AI inpatient daily summary, nurse handover, discharge readiness, risk flagging | full coverage via clinical_ai services + workflow runner ⏩ |

**Verdict:** ✅ strong; well beyond spec on AI side.

---

## §13 — Emergency + triage

| Spec entity | VH Health | Verdict |
|---|---|---|
| `EmergencyVisit`, `TriageAssessment`, `TriageCategory` | 🔴 no dedicated emergency_visits table; triage logic in `clinical_ai_ed_triage_predictions` only |
| `EmergencyAlert` | `system_alerts`, `clinical_alerts`, `sos_alerts` ✅ |
| `AmbulanceRequest` | 🔴 missing |
| `MLCRecord` (medico-legal case) | 🔴 missing |
| AI triage routing | `edTriageBoardingService`, `clinical_ai_ed_triage_predictions` ✅ |
| Emergency consent | inline via patient_consents | 🟡 |

**Verdict:** 🟡 AI triage is solid; the operational ED entities (visit, ambulance, MLC) are missing.

---

## §14 — Surgery + OT + procedures

| Spec entity | VH Health | Verdict |
|---|---|---|
| `Procedure`, `ProcedureOrder`, `SurgeryCase`, `OTBooking` | `ot_schedules`, `clinical_ai_ot_block_suggestions`, `clinical_ai_ot_duration_predictions`, `clinical_orders` ✅ |
| `PreOpChecklist`, `IntraOpNote`, `PostOpNote`, `AnesthesiaRecord` | 🔴 missing as separate tables |
| `Implant` | 🔴 missing |
| `SurgicalConsent` | covered by `patient_consents` (generic) | 🟡 |
| `SurgicalSafetyChecklist` (WHO-style) | 🔴 missing |
| AI pre-op + surgical instructions | partial via clinicalAiWorkflowService | 🟡 |

**Verdict:** 🟡 OT scheduling/AI is strong; clinical OT documentation entities are missing.

---

## §15 — Discharge

| Spec | VH Health | Verdict |
|---|---|---|
| `DischargeSummary`, `DischargeMedication`, `DischargeInstruction`, `FollowUpAppointment`, `DischargeChecklist`, `DischargeApproval` | `dischargeSummaryGenerator`, just-shipped `dischargeComposeService` (4-child meta-workflow), `discharge-compose` admin UI ⏩ |
| Multi-department clearance | partial via clinical_ai_workflow_runs governance pause | 🟡 |
| Multilingual instructions | `clinical_ai_translations`, `translationService` ✅ |
| AI discharge summary draft + missing-info check + patient instructions | full coverage ⏩ |

**Verdict:** ⏩ better than spec.

---

## §16 — Billing + payments + insurance + claims

| Spec entity | VH Health | Verdict |
|---|---|---|
| `BillingAccount`, `ChargeItem`, `Invoice`, `InvoiceItem` | `invoices`, `payment_transactions`, `clinical_ai_charge_capture_audits` ✅ |
| `Payment`, `Refund`, `CreditNote` | `payment_transactions` ✅; refund/credit-note as columns/types | 🟡 |
| `Package`, `Estimate`, `TariffPlan` | 🔴 missing |
| `InsurancePolicy`, `InsurancePreauth`, `Claim`, `ClaimDocument`, `ClaimStatusHistory` | `insurance_claims`, `claim_denials`, `clinical_ai_prior_auth_requests`, `clinical_ai_appeal_letters` ✅ |
| `Payer`, `TPA` | `clinical_ai_payer_contracts`, `clinical_ai_payer_variance_reviews` (analysis only) | 🟡 — no master `payers`/`tpas` |
| AI claim denial-risk + billing leakage + coding | `clinical_ai_payer_variance_reviews`, charge_capture_audits, appeal_letters ⏩ |

**Verdict:** 🟡 billing/insurance infrastructure is broad but missing master data tables (Package, TariffPlan, Payer, TPA) that hospitals need for setup.

---

## §17 — Patient app / portal

| Spec | VH Health | Verdict |
|---|---|---|
| Patient registration, login, profile | `apps/patient` Flutter ✅ |
| Appointment booking, reminders, queue status | ✅ |
| Teleconsultation link | 🔴 (no telemedicine entity yet) |
| Prescriptions, lab reports, radiology, discharge summaries, invoices | ✅ |
| Health timeline, care plans | 🟡 (timeline yes; care plans 🔴) |
| Medication reminders, follow-up reminders | `medication_reminders`, `scheduled_notifications` ✅ |
| Upload external reports | `clinical_document_intake` ✅ |
| Consent management, ABHA linking | `patient_consents`, `abdm_consents` ✅ |
| Patient health assistant (`patientChatbotService`) | ✅ |
| Multilingual explanations | `translationService` ✅ |
| Red-flag escalation | partially via `sosService`, `cds_alerts` | 🟡 |
| Secure messaging with care team | `messaging` route exists | ✅ |
| Family/guardian access | `family_members` ✅ |
| Feedback + ratings | `feedback`, `patient_feedback` ✅ |
| Patient-AI rules (no diagnosis, must cite, refuse if insufficient, etc.) | enforced by `hallucinationDefenses`, `runOutputDefenses`, `patientChatbotService` ⏩ |

**Verdict:** ✅ strong, telemedicine + dedicated CarePlan are the two visible gaps.

---

## §18 — Communications + notifications

| Spec | VH Health | Verdict |
|---|---|---|
| `Notification`, `NotificationTemplate`, `Message`, `Conversation`, `Reminder`, `CommunicationPreference`, `DeliveryLog` | `notifications`, `notification_templates`, `notification_outbox`, `notification_delivery_log`, `failed_notifications`, `scheduled_notifications`, `messaging` route ✅ |
| Channels: SMS, WhatsApp, email, push, in-app, voice | SMS (`smsService`), email, FCM push ✅ ; WhatsApp 🟡 ; voice 🔴 |
| Multilingual templates | `clinical_ai_translations` ✅ |
| Delivery status | ✅ |
| Opt-in/opt-out | inline preferences | 🟡 |

**Verdict:** ✅ strong. WhatsApp + voice channels + dedicated CommunicationPreference table would close the loop.

---

## §19 — Consent, privacy, compliance

| Spec | VH Health | Verdict |
|---|---|---|
| `Consent`, `ConsentArtifact`, `ConsentPurpose`, `ConsentRevocation` | `patient_consents`, `abdm_consents` ✅ |
| `DataProcessingActivity` | 🔴 missing |
| `PrivacyRequest`, `DataAccessRequest`, `DataExportRequest`, `DataDeletionRequest` | `patient_data_rights_requests`, `gdpr_erasure_log` ✅ |
| `LegalHold` | `legal_holds` ✅ |
| `AuditLog` | `audit_log`, `audit_logs`, `hipaa_access_log` ✅ |
| `SecurityEvent`, `BreachIncident` | `security_events`; **🔴 no `BreachIncident` table** |
| Compliance dashboard, breach workflow | partial — `clinical_ai_privacy_sentinel_audits` covers AI-side; full breach workflow 🟡 |
| Consent-aware AI access | enforced via `consentPhiPolicySentinelService` ✅ |

**Verdict:** 🟡 strong on consent + audit; gaps are formal `DataProcessingActivity` (Article 30 GDPR record) + `BreachIncident` workflow + compliance dashboard.

---

## §20 — ABDM / ABHA / India interop

| Spec | VH Health | Verdict |
|---|---|---|
| `ABHAProfile`, `ABDMFacilityMapping`, `ABDMPractitionerMapping` | 🟡 — `abdm_consents`, `abdm_data_requests` exist; no `abha_profile` master table |
| `ABDMCareContext`, `ABDMConsentRequest`, `ABDMConsentArtifact`, `ABDMDataTransfer` | partial in `abdm_consents` + `abdm_data_requests`; not split as spec | 🟡 |
| `ABDMWebhookEvent`, `ABDMIntegrationLog` | 🔴 missing |
| HFR/HPR mapping | 🔴 missing |
| HIP mode (link care contexts, notify HIE-CM, respond to consented data fetch) | partial | 🟡 |
| HIU mode (consent request, fetch records) | partial | 🟡 |
| FHIR DocumentBundle generation | `fhirAdapter` ✅ |
| Idempotent webhook | depends on event_outbox; no formal idempotency on ABDM webhooks | 🟡 |
| Sandbox/prod env config | 🔴 not visible |

**Verdict:** 🟡 foundation exists; full ABDM HIP+HIU compliance requires real work — explicit mapping tables, webhook log, env separation.

---

## §21 — FHIR interoperability

| Spec | VH Health | Verdict |
|---|---|---|
| FHIR R4 read endpoints (Patient, Encounter, Observation, DiagnosticReport, MedicationRequest, DocumentReference) | `apps/backend/src/routes/fhir/fhirRoutes.js` (15 routes) + `fhirAdapter` ✅ |
| FHIR Bundle generation | ✅ |
| FHIR validation | `fhirValidator` ✅ |
| FHIR resource versioning | 🟡 partial (audit log captures changes) |
| FHIR CapabilityStatement | 🟡 likely partial (`/metadata` referenced but I should verify) |
| SMART-on-FHIR-ready OAuth scopes | 🔴 missing |
| CDS Hooks endpoints | 🔴 missing |
| FHIR conformance CI | `_reusable-backend-fhir.yml` workflow ✅ |

**Verdict:** ✅ FHIR adapter is real and CI-tested. SMART-on-FHIR scopes + CDS Hooks are the two interop gaps.

---

## §22 — AI platform

| Spec entity | VH Health | Verdict |
|---|---|---|
| `AIProvider`, `AIModel`, `AIModelVersion` | `localLlmClient` provider abstraction (5 providers + tier split) + `clinical_ai_model_registry` ⏩ |
| `AIPromptTemplate`, `AIPromptVersion` | `clinical_ai_prompts`, `clinical_ai_prompt_experiments`, `clinical_ai_prompt_assignments` ⏩ |
| `AIRequestLog`, `AIResponseLog` | `clinical_ai_generations` (one row per call w/ tokens, cost, latency, raw output) ⏩ |
| `AISuggestion`, `AIReview`, `AIFeedback` | `clinical_ai_reviews`, `clinical_ai_feedback`, `clinical_ai_decision_memory` (cross-run learning) ⏩ |
| `AIRiskFlag`, `AIIncident` | `clinical_ai_safety_reviews`, `runOutputDefenses` ⏩ |
| `AIEvaluationSet`, `AIEvaluationRun` | `clinical_ai_model_eval_runs`, `clinical_ai_canary_runs`, `clinical_ai_canary_cases` ⏩ |
| `AIGuardrailRule` | `clinical_ai_guardrails`, `hallucinationDefenses` ⏩ |
| `AIUsageMetric`, `AIModelAccessPolicy` | `clinical_ai_roi_snapshots`, per-tenant `clinical_ai_tenant_modules` ⏩ |
| Central AIService, ModelRouter, PromptTemplateService, GuardrailService, RetrievalService, StructuredOutputValidator, AIReviewService, AIAuditService, AIEvaluationService, AIIncidentService | ALL present as services ⏩ |
| AI guardrails (no signing, no finalising, no auto-discharge, must cite, must say insufficient data, no system-prompt leakage, prompt-injection protection, output validation, PHI leakage check, feature-flag disable, model rollback, human feedback, audit export) | enforced via `runOutputDefenses` + module config + workflow review queue ⏩ |
| 30+ AI task types | most present, several beyond spec (debate, decision-memory, federated learning, agent lifecycle) ⏩ |
| Workflow graph runner with crash-resume + pause/resume + subgraph composition | shipped this session ⏩ |

**Verdict:** ⏩ **substantially better than spec** — VH Health's AI platform is the strongest part of the codebase.

---

## §23 — RAG / knowledge base

| Spec entity | VH Health | Verdict |
|---|---|---|
| `KnowledgeBase`, `KnowledgeDocument`, `KnowledgeChunk`, `KnowledgeEmbedding` | 🔴 no first-class entity tables — `ragService.js` exists but operates on `clinical_ai_kg_nodes`/`edges` (knowledge graph, not document chunks) and on signed-discharge-summary RAG corpus inline |
| `KnowledgeSource`, `KnowledgeAccessPolicy`, `RetrievalLog` | partial via clinical_ai logs; no formal access-policy table | 🟡 |
| Permission-filtered retrieval | partial — discharge summary RAG is tenant-scoped, but per-user permission filter isn't visible | 🟡 |
| Source citation | enforced — every AI draft has source_citations ✅ |
| Document versioning + approval workflow | partial via clinical_ai_approvals | 🟡 |
| RAG evaluation, stale-doc detection | `ragService` corpus-health probes; partial | 🟡 |

**Verdict:** ✅ — **shipped 2026-04-30 (Phase A1 across 4 PRs).** The full
Knowledge Base CRUD module is now on `main`: `knowledge_bases` /
`knowledge_documents` / `knowledge_chunks` / `knowledge_access_policies` /
`knowledge_retrieval_logs` tables + the upload → S1 prompt-injection gate
→ chunk → embed → permission-filtered retrieval pipeline + admin UI.
Hospitals can upload SOPs / antibiotic policy / patient-education docs and
have them flow into AI prompts under tenant + role isolation. See
`docs/AI_FEATURE_GAP_BACKLOG.md` for the remaining substrate posture.

---

## §24 — Analytics + reporting + command center

| Spec | VH Health | Verdict |
|---|---|---|
| Hospital overview, OPD/IPD/ER volume, doctor productivity, queue wait, lab/radiology turnaround, pharmacy stock, revenue, claims, discharge delays, patient satisfaction, AI usage, AI safety, compliance | `clinical_ai_command_center_snapshots`, `aiRoiDashboardService`, `analyticsRoutes`, `aiExplainabilityDashboardService` ⏩ |
| `ReportDefinition`, `ReportRun`, `Dashboard`, `Metric`, `MetricSnapshot`, `Cohort`, `PopulationHealthSignal` | 🟡 dashboards rendered runtime; no formal definition tables |
| AI predictive analytics (no-show, bed demand, discharge delay, stock, claim denial, disease cluster, readmission risk) | broad coverage via clinical_ai services ⏩ |

**Verdict:** ✅ strong on prediction + dashboards; formal report-definition / cohort entities would help a "build your own report" tool.

---

## §25 — Telemedicine

| Spec entity | VH Health | Verdict |
|---|---|---|
| `Teleconsultation`, `VideoSession`, `ChatSession`, `RemoteConsent`, `RemotePrescription` | 🔴 **entirely missing** as entities |
| Pre-consult form, remote consent, AI teleconsult note draft, AI pre-visit summary | 🔴 missing |

**Verdict:** 🔴 **largest functional gap** — telemedicine is in the spec but not built. Would need: video provider abstraction, session entity, recording integration with `clinical_voice_notes`/`clinical_ambient_encounters` (which exist for in-person ambient).

---

## §26 — Tasks, workflow, automation

| Spec entity | VH Health | Verdict |
|---|---|---|
| `Task`, `Workflow`, `WorkflowStep`, `WorkflowRun`, `Approval`, `EscalationRule`, `SLA`, `AutomationRule` | 🟡 `clinical_ai_workflow_runs` (graph runner, just shipped), `clinical_ai_approvals`, `clinical_ai_task_candidates` cover AI workflows; no general `tasks`/`workflows`/`approvals`/`automation_rules` for non-AI work |
| Domain-event-triggered automation | `event_outbox` exists; rules engine 🔴 |

**Verdict:** 🟡 AI workflow engine is **better than spec**; non-AI staff/admin task system is genuinely missing. A doctor's "follow up on this patient" task currently has no home outside notifications.

---

## §27 — Integrations + webhooks

| Spec entity | VH Health | Verdict |
|---|---|---|
| `Integration`, `WebhookSubscription`, `WebhookDelivery`, `ExternalSystemMapping`, `IntegrationCredential`, `IntegrationLog` | 🔴 **none modelled** as first-class |
| ABDM, FHIR, lab machines, PACS/DICOM, SMS, WhatsApp, email, payment, insurance/TPA, accounting, pharmacy vendor, wearables, ambulance, SSO | each integration has ad-hoc service files (`smsService`, `imagingPacsAdapterService`, `priorAuthorizationPayerAdapterService`, etc.) but no central registry |
| Signed webhooks, retry, idempotency | partial — `event_outbox` provides retry; no signed webhook framework | 🟡 |

**Verdict:** 🔴 a real gap for a SaaS platform. Each integration is custom; a central `integrations` registry + `webhook_subscriptions` table would let hospitals self-serve.

---

## §28 — Event bus

| Spec | VH Health | Verdict |
|---|---|---|
| Internal event bus | `event_outbox`, `eventOutboxService`, `publishEvent` ✅ |
| Required fields (id, eventType, tenantId, aggregate*, actorUserId, patientId, payloadJson, metadataJson, timestamps) | ✅ |
| Persistent event log | `event_outbox` table ✅ |
| Background processing, retry | ✅ |
| Failed event replay endpoint | 🟡 partial |
| Future Kafka/NATS migration path | clean abstraction in place ✅ |

**Verdict:** ✅ present.

---

## §29 — Database model list

237 Prisma models cover most spec groups. Specific gaps already called out in earlier sections. Notable:
- Spec lists ~200 models. VH Health has 237. The deltas:
  - **VH Health-only**: 70+ `clinical_ai_*` tables, payroll/HR-deep tables (salary_*, payslip_*), gamification (`step_*`, `health_milestones`), `clinical_ambient_*`, virtual_ward
  - **Spec-only / missing**: `Facility`, `Location`, `Room`, `CareTeam`, `CarePlan`, `FollowUpPlan`, `ClinicalForm`/`FormResponse`, `PatientIdentifier`, `PatientMergeRequest`, `Payer`/`TPA`/`TariffPlan`/`Package`, `KnowledgeBase`/`KnowledgeDocument`/`KnowledgeChunk`, `WebhookSubscription`/`WebhookDelivery`/`Integration`, `Teleconsultation`/`VideoSession`, `Task`/`Workflow`/`Approval` (non-AI), `BreachIncident`, `DataProcessingActivity`, `MedicalRecordBundle`/`RecordReleaseRequest`, `EmergencyVisit`/`TriageAssessment`/`AmbulanceRequest`/`MLCRecord`, `PreOpChecklist`/`IntraOpNote`/`PostOpNote`/`AnesthesiaRecord`/`Implant`, `PainScore`/`FallRiskAssessment`/`GrowthChartEntry`, `LabMachineIntegration`/`LabQualityControlEntry`, `SubstituteMedication`/`InventoryBatch`/`PharmacyInventoryItem`/`Supplier`/`PurchaseOrder`/`GoodsReceipt`/`ExpiryAlert`

**Verdict:** ⏩ on AI; 🟡 on operational entities (~25 tables genuinely missing).

---

## §30 — AI structured output schemas

Spec defines 7 canonical AI output JSON shapes (chart summary, SOAP draft, lab interpretation, prescription safety, patient explanation, discharge summary, document extraction). VH Health enforces structured outputs via:

- `clinical_ai_modules.settings.outputSchema` per module (already declares required keys)
- `runOutputDefenses` in `hallucinationDefenses.js` validates citation coverage, PHI leakage, numeric coherence, bias markers
- `aiExplainabilityDashboardService` runs evidence-map + trust-band evaluation per draft

**Verdict:** ⏩ better than spec — actual validation is enforced, not just schema declarations.

---

## §31 — AI safety + review workflow

Spec defines: GENERATED → PENDING_REVIEW → ACCEPTED / EDITED_ACCEPTED / REJECTED / EXPIRED / ESCALATED.

VH Health: `clinical_ai_reviews.decision` field carries `pending` / `accepted` / `rejected` / `edited` / `needs_revision` / `deferred`. 12-step workflow in §31 is implemented end-to-end (workflow graph runner from this session's Phase 4 work).

**Verdict:** ⏩

---

## §32 — Admin configuration

| Spec | VH Health | Verdict |
|---|---|---|
| `FeatureFlag` | `featureFlagMiddleware`, `featureFlagRoutes` ✅ |
| `TenantSetting`, `FacilitySetting`, `DepartmentSetting` | partial via `clinical_ai_tenant_modules` + `tenants` columns | 🟡 |
| `Template`, `NumberingSeries`, `ApprovalPolicy`, `DataRetentionPolicy` | 🔴 numbering + retention policy tables missing |
| Per-task AI provider/model selection | `clinical_ai_modules` + `clinical_ai_tenant_modules` overrides ⏩ |

**Verdict:** 🟡 feature flags ✅; numbering/templates/retention as first-class is a gap.

---

## §33 — Observability + ops

| Spec | VH Health | Verdict |
|---|---|---|
| Structured logs, request IDs, correlation IDs | Winston + `requestIdMiddleware` ✅ |
| Health, readiness, metrics endpoints | `/health/metrics`, `circuitBreakerStatus` ✅ |
| Background job dashboard | partial — cron jobs, `routeHealthService` | 🟡 |
| Slow-query logging, audit export | `prismaReadOnly`, `>1000ms` slow-query log ✅; audit export 🟡 |
| AI usage / safety / integration health dashboards | `aiRoiDashboardService`, `aiExplainabilityDashboardService`, `clinical_ai_command_center_snapshots` ⏩ |

**Verdict:** ✅ strong.

---

## §34 — Security requirements

Comprehensive list (helmet, CORS, rate limit, validation, SQL-injection-via-ORM, virus scanning, signed download URLs, encryption at rest, RBAC tests, MFA for privileged, API key hashing, refresh rotation, account lockout, prompt-injection protection): **all present** in `apps/backend/CLAUDE.md` security architecture section.

Specific gaps:
- 🟡 Object-storage signed download URLs — file_metadata uses R2 with signed URLs (need to verify per-file)
- 🟡 Encryption at rest for sensitive fields — broad TLS in transit ✓; field-level encryption for PHI columns 🔴 not visible
- 🟡 Idempotency keys for critical POST endpoints — partial (event_outbox + workflow runs)
- ✅ Prompt injection protection — explicit `runOutputDefenses` + retrieval scoped to tenant + system prompts not echoed

**Verdict:** ✅ broadly comprehensive; field-level PHI encryption + idempotency-key middleware are the two visible gaps.

---

## §35 — Testing requirements

VH Health: 1,305 backend unit tests (post-Phase 5), Jest + supertest. CI runs ESLint + raw-params lint + secrets scan + FHIR conformance + schema-drift detection.

Coverage:
- ✅ Unit + integration
- ✅ Authorization (`src/tests/authorization.test.js`)
- ✅ Tenant isolation (`src/tests/tenant-rls.deep.test.js`)
- ✅ AI evaluation (golden cases via `clinical_ai_canary_runs`)
- 🟡 RBAC matrix tests for the spec's full 50-role list 🔴 (existing tests cover the actual roles, not the spec's superset)
- 🟡 Prompt-injection tests for AI/RAG — `hallucinationDefenses.test.js` exists; not as comprehensive as spec asks
- ✅ Schema drift CI gate (`check-schema-drift.mjs`)

**Verdict:** ✅ test infra mature; just need more coverage if new spec roles/entities are added.

---

## §36 — Delivery phases

The spec's Phase 0–6 maps roughly to:
- Phase 0 (Foundation) — ✅ done
- Phase 1 (Core OPD) — ✅ done
- Phase 2 (AI Quick Wins) — ⏩ done + much beyond
- Phase 3 (Hospital Operations) — ✅ mostly done; gap: pharmacy supply-chain, payer/TPA master
- Phase 4 (IPD + Advanced Clinical) — ✅ done; gaps: OT documentation tables, telemedicine
- Phase 5 (Interoperability) — 🟡 FHIR adapter ✅; ABDM HIP/HIU 🟡 partial; SMART-on-FHIR + CDS Hooks 🔴
- Phase 6 (Advanced AI Governance) — ⏩ done; well beyond spec

**Verdict:** the multi-agent + workflow rollout this session essentially completed Phase 6 ahead of Phase 5 closure.

---

# Top-10 prioritised gaps

Ranked by the impact-on-deployment × effort matrix.

| # | Gap | Why it matters | Effort | Phase |
|---|---|---|---|---|
| 1 | ✅ **Knowledge Base CRUD** — SHIPPED 2026-04-30 (Phase A1, 4 PRs) | hospitals can now upload SOPs / antibiotic policy / patient-ed material that AI cites under tenant + role isolation | done | A |
| 2 | **Telemedicine module** (Teleconsultation, VideoSession, ChatSession, RemotePrescription) | Spec calls it out; patient app advertises but can't deliver | 1-2 weeks (+ video provider integration) | B |
| 3 | **Webhook + Integration registry** (Integration, WebhookSubscription, WebhookDelivery, ExternalSystemMapping) | SaaS hospitals expect to subscribe to events without contacting us; integrations are currently bespoke per-vendor | 1 week | A |
| 4 | **Patient identifier multi-type table** + duplicate/merge workflow | Hospitals onboarding real patient data hit duplicate-MRN issues immediately; merge workflow with approval is regulatory hygiene | 4-5 days | A |
| 5 | **Multi-facility under tenant** (Facility, Location, Room) + service catalog | Today a tenant ≈ a hospital; real chains have multiple facilities per legal entity | 1 week + migration of existing rows | C |
| 6 | **Generic Tasks/Workflow/Approval system** (non-AI) | "Follow up on this patient" / "review this lab report" tasks have no home; staff use notifications as a poor proxy | 1 week | B |
| 7 | **Surgery clinical entities** (PreOpChecklist, IntraOpNote, PostOpNote, AnesthesiaRecord, Implant, SurgicalSafetyChecklist) | OT scheduling is solid; OT documentation isn't — operative note quality and implant tracking are clinical-safety items | 1-2 weeks | C |
| 8 | **Payer / TPA / TariffPlan / Package masters** | Current claims module has rows but no master data — billing setup for a new hospital is 100% manual config | 1 week | B |
| 9 | **TOTP MFA + DB-backed API client registry** | Spec asks for it; current SMS/email OTP is acceptable but not best practice for admin/clinician workstations | 4-5 days | B |
| 10 | **CDS Hooks + SMART-on-FHIR scopes + ABDM HIP/HIU full flow** | Each is its own deliverable; CDS Hooks is small, ABDM is the larger one | CDS 4d, SMART 1w, ABDM 2-3w | D |

Other smaller gaps (carry forward as a punch list, not standalone phases):
- `CarePlan` + `FollowUpPlan` first-class entities (ride along with Tasks/Workflow phase)
- Pharmacy supply-chain (Supplier, PO, GoodsReceipt, InventoryBatch, ExpiryAlert)
- ED operational entities (EmergencyVisit, AmbulanceRequest, MLCRecord)
- DataProcessingActivity (GDPR Article 30) + BreachIncident workflow
- Numbering series + DataRetentionPolicy as first-class
- Field-level PHI column encryption
- Idempotency-key middleware
- WhatsApp + voice notification channels

---

# Remediation roadmap — phased, layered on the existing rollout plan

This bolts onto `docs/CLINICAL_AI_ROLLOUT_PLAN.md` (which closed with all 5 phases shipped) as a continuation. Each phase is a contained PR series.

## Phase A — RAG productisation + tenant operability (≈3 weeks)

Highest user impact for the multi-agent system already on `main`. Lets a hospital actually use the AI on their own SOPs.

- **A1**: ✅ **SHIPPED 2026-04-30** — Knowledge Base CRUD module across four PRs:
  - PR1: migration 113 (knowledge_bases / documents / chunks / access_policies / retrieval_logs) + KB CRUD service + admin routes.
  - PR2: knowledgeDocumentService — inline-text + multipart-upload pipeline (extract → S1 prompt-injection gate → chunk via ragService.chunkText → embed via ragService.embedText into 768-dim pgvector); per-document processing_status state machine (pending → extracting → chunking → embedding → indexed | failed | blocked).
  - PR3: knowledgeRetrievalService — permission-filtered RAG via EXISTS subquery on knowledge_access_policies (read | write | manage rank); every retrieval audited in knowledge_retrieval_logs by tenant + KB + module + role; degrades to typed source codes on infra issues.
  - PR4: KnowledgeBasePanel admin UI — KB CRUD, inline-text ingest with S1 verdict surfaced via toast + status badge, document reindex / delete, role + permission grants, retrieval tester. File-upload UI deferred to a small follow-up (backend already accepts multipart).
- **A2**: Multi-identifier patient table + duplicate detection + merge-with-approval workflow.
- **A3**: Webhook + Integration registry — `Integration`, `WebhookSubscription`, `WebhookDelivery`, `ExternalSystemMapping`, `IntegrationCredential`, `IntegrationLog`; signed webhook framework; admin UI for subscription management.

## Phase B — Operational completeness (≈3 weeks)

Closes the ops gaps that block hospital onboarding.

- **B1**: Telemedicine — `Teleconsultation`, `VideoSession`, `ChatSession`, `RemotePrescription` + provider abstraction (so hospitals can plug Zoom / Jitsi / Daily.co); patient + staff Flutter screens; AI teleconsult note draft.
- **B2**: Generic Tasks/Workflow/Approval (non-AI) — `Task`, `Workflow`, `WorkflowStep`, `WorkflowRun`, `Approval`, `EscalationRule`, `SLA`, `AutomationRule`; reuse the workflow graph runner where possible.
- **B3**: Payer / TPA / TariffPlan / Package masters; refactor `insurance_claims` to reference master data.
- **B4**: TOTP MFA (full schema + flow) + DB-backed `api_clients` / `api_keys` registry.

## Phase C — Org structure + clinical depth (≈3 weeks)

- **C1**: Multi-facility under tenant — `Facility`, `Location`, `Room`, `ServiceCatalog`. Backwards-compat: existing `hospitals` rows seed a default Facility per tenant; new hospitals can add more. Migrate existing FK references.
- **C2**: Surgery clinical entities — `PreOpChecklist`, `IntraOpNote`, `PostOpNote`, `AnesthesiaRecord`, `Implant`, `SurgicalSafetyChecklist` (WHO checklist). Wire into `ot_schedules`.
- **C3**: `CarePlan` + `FollowUpPlan` first-class. Pull plans out of inline `clinical_notes` text into structured entities.
- **C4**: Pharmacy supply chain — `Supplier`, `PurchaseOrder`, `GoodsReceipt`, `InventoryBatch`, `ExpiryAlert`, `SubstituteMedication`. Hook into existing `clinical_ai_inventory_alerts` forecasts.

## Phase D — Interop + India compliance (≈4 weeks)

- **D1**: ABDM HIP/HIU full flow — `ABHAProfile`, `ABDMFacilityMapping`, `ABDMPractitionerMapping`, `ABDMCareContext` (separate from generic `abdm_consents`), `ABDMConsentRequest`/`ABDMConsentArtifact` (split), `ABDMDataTransfer`, `ABDMWebhookEvent`, `ABDMIntegrationLog`. Sandbox/prod env separation.
- **D2**: CDS Hooks endpoints — patient-view, order-select, order-sign, medication-prescribe, encounter-start, encounter-close. Reuse existing AI services as the brain behind the hooks.
- **D3**: SMART-on-FHIR OAuth scopes — extend the existing OAuth surface with FHIR-scoped tokens.
- **D4**: ED operational entities — `EmergencyVisit`, `TriageAssessment`, `EmergencyAlert`, `AmbulanceRequest`, `MLCRecord`. Wire into existing `clinical_ai_ed_triage_predictions`.

## Phase E — Compliance hardening + smaller items (≈2 weeks)

- **E1**: `DataProcessingActivity` (GDPR Article 30 record) + `BreachIncident` workflow + compliance dashboard.
- **E2**: Numbering series + DataRetentionPolicy as first-class config.
- **E3**: Field-level PHI column encryption (envelope encryption with KMS); rotate columns on the highest-PHI tables (patient name, phone, address, medical_records.notes).
- **E4**: Idempotency-key middleware for critical POST endpoints (orders, payments, prescriptions, claims).
- **E5**: WhatsApp + voice notification channels.

## Phase F — Spec polish (≈1 week)

- **F1**: Formal user roles for the spec gaps (CONSULTANT/JUNIOR_DOCTOR/RESIDENT seniority, COUNSELLOR, CARE_COORDINATOR, CLAIMS_MANAGER, AMBULANCE_COORDINATOR, INTEGRATION_ADMIN, WEBHOOK_CLIENT, AI_GOVERNANCE_ADMIN, DATA_PROTECTION_OFFICER).
- **F2**: Pain-score + fall-risk + growth-chart entities for completeness.
- **F3**: Spec-driven role-matrix tests; documentation pass.

**Total runway:** roughly 16 weeks of focused work to close the 38-section spec to 95%+ coverage.

---

# What's deliberately NOT going to change

These are intentional design decisions where VH Health diverges from the spec — none should be treated as gaps.

- **Stack**: Express + raw Prisma (not NestJS). Spec says "if existing repo has different stack, follow it" — we follow that.
- **AI surface scope**: VH Health's clinical AI catalog (~70 services) is broader than the spec's ~30. We keep all of them; the spec is a floor not a ceiling.
- **Workflow graph runner**: spec asks for "Workflow + WorkflowStep + WorkflowRun"; we have a richer DAG runner with subgraph composition + checkpoint resume + pause-for-approval. Don't downgrade to the simpler model.
- **Decision memory + differential debate**: not in the spec; keep them. They're load-bearing for clinical-AI safety.
- **Multi-tenant model**: PostgreSQL RLS + `setTenant` GUC is the chosen approach; not changing.
- **Flutter for clinician + patient apps**: the spec talks about a backend; the staff/patient-side stack is right where it should be.

---

# Summary

| | Value |
|---|---|
| Spec sections | 38 |
| Spec entities (rough count) | ~200 |
| VH Health Prisma models | 237 |
| Spec coverage estimate | ≈75% |
| Sections where VH Health is **better than spec** | §6 EMR, §15 Discharge, §22 AI platform, §23 Decision memory, §24 Analytics, §31 AI safety workflow |
| Largest single functional gap | Telemedicine (§25) |
| Largest single AI gap | ✅ Knowledge Base CRUD (§23) — shipped 2026-04-30 |
| Largest single ops gap | Webhook + Integration registry (§27) |
| Largest single org gap | Multi-facility under tenant (§2) |
| Recommended phasing | 5 phases (A–E) over ≈16 weeks; Phase F polish |

The system is well-architected and substantially complete. The remediation plan is **incremental, no rewrites, no stack churn**. Each phase is self-contained and ships independently. Phase A unlocks the most user value; Phase D unlocks India go-live (ABDM compliance).

The clinical-AI rollout that closed earlier this session (`docs/CLINICAL_AI_ROLLOUT_PLAN.md`) and this audit's remediation roadmap should be read as **two parts of one plan**. Don't merge them; they have different audiences (rollout = how to deploy what's built; audit = what to build next).
