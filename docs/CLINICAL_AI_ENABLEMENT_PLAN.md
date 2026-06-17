# Clinical-AI Module Enablement Plan — Non-Patient-Facing

**Created 2026-06-14.** Produced by a 10-agent inventory+synthesis+adversarial-verify
pass over the clinical-AI subsystem, then corrected against the code. Companion to
[`CLINICAL_AI_ROLLOUT_PLAN.md`](CLINICAL_AI_ROLLOUT_PLAN.md) (substrate/delivery) and
[`AI_FEATURE_GAP_BACKLOG.md`](AI_FEATURE_GAP_BACKLOG.md) (long-tail gaps).

**Premise (verified):** VH Health has **99 clinical-AI modules** but only **4 enabled by
default** (`discharge_summary`, `handover_summary`, `ai_roi_dashboard`, `ai_safety_reviewer`).
The substrate (engine, governance, RAG, surfaces) is at/above spec — **the value is
activation, not building more.** This plan sequences the **internal / clinical-staff +
back-office** modules only.

**Hard constraint:** all **patient-facing** modules stay **OFF** (Tier A explainers,
Tier E engagement, aftercare, IVR, chatbot, virtual ward). The 13 excluded keys are
listed at the bottom; the authoritative patient signal is `settings.surface` ∈
(`patient`, `patient_communication`, `virtual_ward`).

> ⚠️ **Enablement is via the `clinical_ai_tenant_modules` table** (per-tenant,
> `ON CONFLICT (tenant_id, module_key)`), **NOT** the seed `enabled` flag and **NOT**
> `clinical_ai_module_overrides`. The seed default is **inert once a module row exists** —
> the DB row wins. Always toggle + verify live DB state, never the code default.

---

## Shared prerequisites (gate the whole program)

1. **Local Ollama GPU deep tier** (hard gate for Waves 1 & 6). GPU node (≥24 GB VRAM
   for 14–32B; datacenter GPU for 70B) + nvidia-device-plugin in RKE2; set
   `CLINICAL_AI_DEEP_PROVIDER=ollama`, `CLINICAL_AI_DEEP_BASE_URL`, `CLINICAL_AI_DEEP_MODEL`,
   `CLINICAL_AI_ALLOW_EXTERNAL=false`; **pull the model** + keep-alive/preload (a cold model
   blows the 45s timeout → silent `template_fallback`). Readiness only probes endpoint
   reachability, **not** that the model is pulled — add a manual `ollama list` + a
   smoke-gen `used_ai:true` check (see deep-tier liveness gate below).
2. **Staff Flutter review-queue activation** (hard gate for every clinical wave). The
   queue/draft-detail/op-ai-assist screens are **built, wired, tested** but "underused" —
   the gap is hospital-side adoption: LAN clinical ingress (DNS `clinical.<hospital>.local`
   → internal nginx LB, hospital CA into `step-ca-internal`), then **one real doctor on the
   queue for a week** before scaling. Queue renders empty unless module enabled **AND** a
   trigger fires **AND** the reviewer's role ∈ that module's `reviewRoles`.
3. **Real RAG data + (optional) wire the curated KB into generation.** Populate
   `clinical_ai_corpus` (signed discharge summaries + per-patient docs) — this is the **only**
   corpus generation consumes today (`retrieveRelevant`). **The citation gate is satisfiable
   from the per-patient chart packet alone**, so the curated KB (formulary/antibiogram/
   protocols, mig 113) is **non-blocking "forward" grounding**, not a gate. It is currently
   **admin-debug-only** (`knowledgeBaseRoutes.js:448`) — to make it reach generation, a code
   change must call `retrieveFromKnowledgeBases` in the generation path (see New Internal
   Use #6, the highest-leverage item). KB itself also needs `CLINICAL_AI_EMBED_URL` +
   `CLINICAL_AI_EMBED_MODEL=nomic-embed-text` (both **undocumented in `.env.example` — add
   them**), source data present, the importer run, **per-doc approval** (`decideKnowledgeDocument`;
   imports land `pending` = dark; no bulk-approve), and `knowledge_access_policies` per role.
4. **Governance reviewer staffing + gates (per-module, per-tenant).** 69 modules require
   clinician signoff and declare `reviewRoles[]`; a module whose roles no real user holds
   queues drafts nobody can sign. For high/critical or `two_person_for_enablement` modules:
   a distinct **second approver** (`decideApproval` blocks self-approval), an **accepted
   `clinical_ai_model_eval_runs`** row passing `assertAcceptedEvalGate`, and a governance
   lead. Configure the `clinical_ai_guardrails` singleton (kill-switch, daily token/cost
   limits) before go-live. Seed + activate a reviewed **v1 prompt per tenant** (mig 012 only
   seeds the default tenant).
5. **Per-tenant pre-flight + first-pilot proof.** Run
   `scripts/check-clinical-ai-tenant-preflight.ps1 -RequireNoWarnings`, then a **loop-closed**
   internal pilot — **`discharge_summary` + `handover_summary`** on one ward (substituting the
   built-in med_rec+aftercare pilot, since aftercare is patient-facing). Expansion past Wave 1
   gated on a real `clinical_ai_reviews` row created → routed to a `reviewRoles` holder →
   signed (not merely "generation ran").

**Cross-cutting code gap:** **CareTeam ABAC** (docs §1, red) — no CareTeam table; chart access
is tenant-scoped, not care-team-scoped. OK for single-ward pilot; **build before Waves 3/5/6
scale across departments.**

---

## The waves (internal-only, ordered)

| Wave | Theme | Modules | Deep tier? | Reviewers |
|---|---|---|---|---|
| **1** | Doc drafts — the seed-on anchors | `discharge_summary`, `handover_summary` | **Yes** (discharge) | DOCTOR + MEDICAL_RECORDS / NURSING_STAFF |
| **2** | Standing chart-context summaries | `patient_record_summary`, `daily_ward_round_brief`, `clinical_task_extractor` | No | DOCTOR + NURSING + MED_RECORDS (first **two-person** gate via record_summary) |
| **3** | OPD doctor-facing decision-support | `op_visit_prep`, `op_investigation_review`, `op_follow_up_plan`, `op_referral_draft`, `referral_letter`, `teleconsult_pre_visit_summary` | No | DOCTOR (lights up the built `/op-ai-assist` surface) |
| **4** | Back-office revenue cycle | `clinical_coding_assist`, `denial_risk_assist`, `charge_capture_audit`, `discharge_readiness`, `appeal_letter_generator`, `prior_authorization_generator` | No | Coder / MED_RECORDS / BILLING (not clinicians) |
| **5** | Inpatient safety sentinels (rules-authoritative) | `antimicrobial_stewardship`, `deterioration_early_warning`, `polypharmacy_ai_review`, `pathway_bundle_compliance`, `icu_ventilator_sedation_bundle`, `sepsis_bundle_sentinel`, `infection_control_sentinel`, `lab_autoverification_delta` | No | DOCTOR + NURSING/PHARMACY/IC/lab (24×7 coverage) |
| **6a** | Critical **deep-tier** assistants | `medication_reconciliation`, `abnormal_result_triage`, `op_differential_red_flags`, `obstetric_risk_assistant` | **Yes** | specialty DOCTOR + PHARMACY/NURSING; two-person + eval |
| **6b** | Critical **quick-tier** assistants | `pediatric_dosing_safety`, `pharmacogenomics_support`, `ed_triage_boarding_predictor`, `abdm_longitudinal_risk` | No | specialty DOCTOR + PHARMACY (eval/two-person, no GPU) |
| **7** | Ops & supply-chain forecasts (advisory) | `bed_discharge_forecast`, `housekeeping_bed_turnover`, `pharmacy_stockout_predictor`, `blood_bank_demand_forecast`, `acuity_staffing_forecast`, `staff_roster_optimizer`, `staff_burnout_workload_risk`, `ot_case_time_predictor`, `ot_block_scheduling`, `appointment_no_show_predictor`, `biomed_device_maintenance`, `inventory_intelligence`, `procurement_negotiation_assistant`, `discharge_summary_compose`† | No | operational owners (bed/pharmacy/OT/HR/biomed/procurement) |
| **8** | Radiology / doc-intelligence / records-quality | `radiology_report_qa`, `radiology_worklist_prioritizer`, `document_intelligence_ocr`, `chart_completion_auditor` | No | RADIOLOGIST / MEDICAL_RECORDS |

*(Wave 6 was split into 6a/6b per the dependency-ordering review — only 4 of the 8 are truly
`model_tier:'deep'`; the quick-tier four can start before the GPU node is proven.)*

**† `discharge_summary_compose` requires a fix before enabling — see correction C1.**

`radiology_ai_interpretation` (DICOM + external model) is **excluded** from the internal
sequence — needs a named integration partner + `INTEGRATION_ADMIN` + external-model governance.

---

## Mandatory corrections (from adversarial verification)

**C1 — `discharge_summary_compose` will FAIL-CLOSE, not run degraded.** Its default
`composeChildren` include `patient_aftercare_instructions` (patient-facing, OFF). The runner
calls `requireEnabledModule()` on every child → throws `forbidden` for any disabled child, so
the whole compose run fails at precheck. **Before enabling compose, set a tenant
`composeChildren` override omitting aftercare** (e.g. `['medication_reconciliation',
'discharge_readiness','clinical_coding_assist']`) and verify a run completes.

**C2 — Make the reviewer-staffing pre-flight per-module.** `check-clinical-ai-tenant-preflight.ps1`
only counts a fixed clinical allowlist tenant-wide; it misses `RADIOLOGIST`, `MEDICAL_RECORDS`,
`BILLING_STAFF/INCHARGE`, coder roles — so **Waves 4 & 8 can pass `-RequireNoWarnings` with
zero eligible reviewers**. Extend the script to read each enabled module's `reviewRoles` and
**FAIL** if any maps to zero active users. Until then, gate Waves 4 & 8 on a manual
reviewer-staffed sign-off.

**C3 — Add a deep-tier "producing real AI" gate.** No assertion confirms a deep/critical
module returns `used_ai:true` — a CRITICAL module (e.g. `medication_reconciliation`) can clear
two-person + eval + canary and go live **silently emitting template drafts**. Before flipping
`enabled=true` on any deep-tagged module, require an operator-attested smoke gen with
`ai_metadata.used_ai=true` (and `ollama list` confirming the model is pulled), recorded in the
enablement audit. Treat silent `template_fallback` as a blocking failure.

> **Substrate landed (deep-tier readiness gate).** The code-side of C3 now exists in
> `apps/backend/src/services/ai/localLlmClient.js`:
> - `checkDeepModuleReadiness(moduleKey, { tenantId, tenantRegion, smoke })` → structured
>   verdict `{ deepTier, modelPulled, smokeRan, smokeUsedAi, ready, reason }`. For Ollama it
>   parses `GET /api/tags` to confirm `CLINICAL_AI_DEEP_MODEL` is actually **pulled** (not just
>   that the endpoint answers), then runs a smoke gen requiring `used_ai=true`. Non-deep modules
>   short-circuit `ready:true` (the gate never blocks the quick tier).
> - `assertDeepModuleLive(moduleKey, opts)` → throws `CLINICAL_AI_DEEP_MODULE_NOT_LIVE` (with the
>   verdict attached) when not live. **Wire this into the enablement path** that flips a deep
>   module ON, and record the returned verdict in the enablement audit.
> - `getClinicalAiRuntimeStatus({ live:true })` now surfaces a `deepTier.deepModelPulled`
>   boolean (admin `/status` surface), and silent deep/critical template fallbacks at runtime
>   increment `clinical_ai_deep_template_fallback_total{module,tier}` on `/metrics` + emit a
>   WARN — so the degradation C3 warns about is observable even outside the enablement gate.
> When `scripts/check-clinical-ai-tenant-preflight.ps1` is built, call `assertDeepModuleLive`
> for each enabled deep-tagged module and FAIL `-RequireNoWarnings` on a not-live verdict.

---

## New internal uses (forward roadmap — net-new value, not just toggles)

1. **Wire the curated KB into generation** *(highest leverage, ~1–2 wk)* — call
   `retrieveFromKnowledgeBases` in the generation path for `antimicrobial_stewardship`,
   `pathway_bundle_compliance`, `medication_reconciliation`, `op_investigation_review`,
   `op_follow_up_plan`. Converts the entire B5.5 curated-KB investment from dark to live.
2. **Ambient scribe** *(~2–3 wk)* — whole-consultation audio → structured note (diarization/
   STT/consent substrate already exists; net-new = capture UX + audio-retention governance).
3. **Revenue-cycle automation loop** *(~2 wk after payer master)* — coding → denial → appeal →
   prior-auth as a standing queue; needs Payer/TPA/Tariff master (docs §16).
4. **Results/inbox safety net** *(~3 wk)* — `abnormal_result_triage` + `lab_autoverification_delta`
   + `clinical_task_extractor` → per-clinician ack-tracked results inbox + escalation; needs the
   generic Tasks/Workflow/EscalationRule system (docs §26).
5. **Ops forecasts → live alerts** *(~1–2 wk)* — promote Wave 7 forecasts into
   `hospital_command_center` alerts (no auto-action).
6. **Quality/RCA committee workflow** *(~2 wk)* — `quality_case_review` + `rca_draft_generator`
   as a standing M&M/RCA queue triggered from incidents/readmissions.

---

## Excluded — patient-facing, stay OFF

`lab_patient_explanation`, `radiology_patient_explanation`, `patient_report_explainer`,
`prescription_patient_explainer`, `invoice_patient_explainer`, `patient_aftercare_instructions`,
`post_op_instruction_draft`, `patient_teach_back_comprehension`, `consent_aware_family_update`,
`patient_communication_translation`, `patient_record_chatbot`, `voice_patient_assistant_ivr`,
`virtual_ward_triage`.

> If a new `settings.surface='patient'` module is added to the registry, add it here in the
> same change, and add an enablement-time assertion that no patient-surface module is toggled on.
