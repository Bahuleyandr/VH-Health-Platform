# Per-tenant Clinical-AI Rollout Playbook

**Audience:** the implementation lead bringing a new hospital onto the
VH Health platform, *or* the platform admin enabling new clinical-AI
modules for an existing tenant.

**Companion docs:**
- [`CLINICAL_AI_ROLLOUT_PLAN.md`](CLINICAL_AI_ROLLOUT_PLAN.md) — the
  *engineering* rollout plan (network split, Flutter web build,
  Ollama deep tier). Per-phase status + commits live there.
- [`AI_FEATURE_GAP_BACKLOG.md`](AI_FEATURE_GAP_BACKLOG.md) — the
  full ~250-feature catalogue with per-module status. Use it to look
  up "do we have AI feature X?".
- [`HEALTHCARE_AI_SPEC_AUDIT.md`](HEALTHCARE_AI_SPEC_AUDIT.md) —
  entity / infra-layer audit against the 38-section healthcare-AI
  spec.

This playbook is the *operational* counterpart: which modules to
turn on, in what order, under which guardrails, for a given hospital.

---

## TL;DR

Default posture: **`enabled=false` everywhere**. The `clinical_ai_modules`
registry ships in this state for every tenant. A hospital admin enables
modules one at a time, per-tenant, after the four pre-flight checks
below pass.

For a typical 100-bed tertiary hospital with no prior AI experience, a
**3-stage pilot** over 6-8 weeks is right:

1. **Stage 1 (week 1–2):** Tier A explainers + 3 hand-picked Tier A
   assistants, English only, 2 ward staff + 1 reviewer. Goal: trust.
2. **Stage 2 (week 3–5):** Add Tier C order-set / dose-check / I&O
   summary + Tier H lab-TAT. Stage 1 modules go to all wards.
3. **Stage 3 (week 6–8):** Add Tier D ED triage modules + Tier E
   patient engagement (post-discharge / chronic-coach), local-Ollama
   for any module flagged CRITICAL.

Tier B (surgical), Tier F (interop), Tier G (public health) are
opt-in by department + integration partner — they do not belong in
the default rollout sequence.

If the hospital has no prior AI experience and no clinical-AI lead
on staff, **delay all Tier C/D/F/G/H rollouts until Stage 2** — they
all require clinician sign-off and you need someone who can run that
queue.

---

## 1. Pre-flight checklist

Before enabling **any** AI module on a new tenant, confirm all four:

### 1.1 Substrate is on production

- [ ] Migrations ≤139 applied (`SELECT MAX(id) FROM
      clinical_ai_modules WHERE module_key LIKE 'lab_tat_delay_prediction';`
      returns a row, all module rows present).
- [ ] `clinical_ai_generations`, `clinical_ai_reviews`,
      `clinical_ai_workflow_runs` tables exist and are accepting
      inserts.
- [ ] `runOutputDefenses` is wired (look for `defenses_passed` field
      on a recent inserted generation row).
- [ ] `LLM provider is reachable` — call `POST /api/v1/admin/clinical-
      ai/lab-patient-explanations` with an investigation_id you own,
      verify a 201 with `used_ai: true` and a non-zero `prompt_tokens`.

### 1.2 Reviewer queue is staffed

- [ ] At least one user with `DOCTOR`, `NURSE_MANAGER`, or
      `CLINICAL_LEAD` role on the tenant.
- [ ] That user knows where the review queue is — visit
      `/dashboard/clinical-ai` in the admin portal, point at the
      `/reviews` link, do a sample sign-off.
- [ ] For Tier D (ED) and Tier C high-stakes modules, a second
      reviewer is identified (covering off-shifts).

### 1.3 Tenant config sane

- [ ] `tenants.locale` set so language-aware modules pick the right
      output. Default is `en`; for multi-language Indian hospitals
      verify the `language` body parameter is being honoured by a
      sample patient-explainer call in `hi` or `ta`.
- [ ] `tenants.region` set if patient PHI must stay within India —
      `CLINICAL_AI_EXTERNAL_REGIONS` allowlist on the backend deployment
      should match.
- [ ] `numbering_series` rows seeded for any modules that emit
      identifiers.
- [ ] `data_retention_policies` rows reviewed for tables the modules
      read from.

### 1.4 Audit + observability working

- [ ] `audit_logs` capturing the per-module `CLINICAL_AI_*_GENERATED`
      events (sample query: last 24 h, group by `event_type`).
- [ ] HIPAA/PHI access logger is on for any module that reads patient
      data. The pattern `phiAccessLogger(recordType)` middleware should
      be present on routes the modules consume.
- [ ] An AI safety review cadence is on the calendar — minimum:
      **weekly** review of any draft with `severity ∈ {critical, high}`
      from the previous 7 days.

If any of the four fail, do not enable a module. Investigate first.

---

## 2. The enablement decision tree

For each module the hospital wants to turn on, walk this tree:

```
  Is the module's `module_key` registered in clinical_ai_modules?
      ├─ no → migration not applied; bring substrate up first.
      └─ yes
          │
          ▼
  Does the module's settings.requiresClinicianSignoff = true?
      ├─ yes → confirm a reviewer with one of the module's
      │        reviewRoles[] is online during the hospital's
      │        operating window. If not, defer.
      └─ no (operational forecasts mostly) → continue.
          │
          ▼
  Does settings.approvalPolicy = 'two_person_for_enablement'?
      ├─ yes → record a written approval from a second admin
      │        (per Phase B4 / E1 governance pattern). Without
      │        the second approval, the enablement bit will be
      │        rejected by the registry. CRITICAL-tier modules
      │        ALL carry this gate (renal/liver/preg dose, AKI,
      │        ADE, ED triage priority, stroke FAST, chest pain,
      │        trauma, MLC).
      └─ no → ADMIN/SUPER_ADMIN may enable directly.
          │
          ▼
  Does the module read PHI?
      ├─ yes → confirm:
      │        - hospitalName.en is set on tenants
      │        - phiAccessLogger middleware is on the route
      │        - if external LLM in use: the tenant's region matches
      │          CLINICAL_AI_EXTERNAL_REGIONS or the deep tier is
      │          local-Ollama-routed via CLINICAL_AI_DEEP_PROVIDER
      └─ no → continue.
          │
          ▼
  Has a similar tier been pilot-validated on this tenant?
      ├─ no → this should be a Stage-1 or Stage-2 module per §3.
      │        Don't pile a Tier D module onto a tenant that has
      │        never run a Tier A draft.
      └─ yes → enable.
```

If the answer to any branch is "no, but we want to anyway," document
the deviation in `clinical_ai_modules.settings.enablement_notes` so
the next operator can see why you bypassed the gate.

---

## 3. Recommended enablement order

A staged rollout that's worked on the dalekdefender pilot rig and
is the right starting shape for a new hospital with no prior AI
exposure.

### Stage 1 — trust-building (week 1–2)

| Module | Tier | Why first | Effort |
|---|---|---|---|
| `lab_patient_explanation` | A explainers | Patient-friendly, visible win | Low — investigation_id in, draft out |
| `radiology_patient_explanation` | A explainers | Same shape, different table | Low |
| `patient_report_explainer` | A explainers | Generic free-text fallback | Low |
| `prescription_patient_explainer` | A explainers | Adherence + safety win | Low |
| `invoice_patient_explainer` | A explainers | Billing transparency | Low |
| `lab_trend_summary` | A remainder | Doctor-facing trend narrative | Low |
| `audit_log_summary` | A remainder | Admin-facing visibility into AI itself | Low |
| `pending_report_tracker` | A remainder | Finds stale reports → action | Low |

**Rationale:** Tier A patient explainers are decision-support-only
patient-facing content (no clinical action). Wrong drafts can be caught
by the reviewer and never reach a patient. The other three are admin/
doctor-facing dashboards. Together they let the hospital see what AI
output looks like, how the review queue works, what citations come
back — without staking patient-care decisions on it.

**Don't enable yet:** anything with critical-risk approval policy,
anything with patient-app-side notification dispatch, anything
ED-related.

### Stage 2 — clinical assistants (week 3–5)

Assuming Stage 1 stuck — reviewer queue is being worked, no PHI leaks
in audit, drafts are being signed off and not auto-rejected.

Add these:

| Module | Tier | Why now | Notes |
|---|---|---|---|
| `clinical_note_cleanup` | C | Doctor productivity + safe (rewrites their own dictation) | No 2-person gate |
| `missing_questions_assistant` | C | Same | No 2-person gate |
| `missing_examination_assistant` | C | Same | No 2-person gate |
| `missing_tests_assistant` | C | Same | No 2-person gate |
| `order_set_suggestion` | C | High productivity ROI; rule-authoritative below | No 2-person gate |
| `intake_output_summary` | C | Nurse-facing, narrative output | No 2-person gate |
| `medical_certificate_draft` | C | Discharge-time win | No 2-person gate |
| `clinic_letter_draft` | C | OPD productivity | No 2-person gate |
| `lab_tat_delay_prediction` | H | Operational forecast, no clinical decision | No 2-person gate |
| `radiology_tat_delay_prediction` | H | Same | No 2-person gate |

**Two-person modules in Tier C** (`renal_dose_check`, `liver_dose_check`,
`pregnancy_lactation_warning`, `adverse_drug_event_detector`,
`fall_risk_prediction`, `pressure_ulcer_risk_prediction`,
`aki_risk_alert`, `icu_round_summary`) — wait until Stage 3 unless the
hospital has explicit clinical AI lead + safety committee.

### Stage 3 — high-stakes + ED + patient engagement (week 6–8)

By now Stage 2 reviewers know the rhythm. Bring in:

- **All Tier C critical-risk modules** with two-person enablement.
- **Tier D emergency / triage** if the hospital has an emergency
  department and an EM physician who has signed off as reviewer.
- **Tier E patient engagement** for chronic-disease coaching, post-
  discharge check-ins. *Only after* the hospital's notification
  delivery (SMS / WhatsApp / push) has been validated end-to-end on
  Stage 1 drafts that were signed off and dispatched.
- **Local-Ollama deep-tier** for any CRITICAL module whose drafts
  contain PHI. Provision the GPU node + nvidia plugin first; flip
  `CLINICAL_AI_DEEP_PROVIDER=ollama` and
  `CLINICAL_AI_ALLOW_EXTERNAL=false` on the tenant config.

### Department-specific tiers (no fixed week)

These do not belong in the default rollout — enable when the relevant
department is ready:

- **Tier B (surgical)** — only when an OR + anesthesia team is named,
  and the surgical safety committee has reviewed the surgical-consent
  + WHO-checklist outputs. Two-person gate on consent draft + complications.
- **Tier F (interop)** — only when an integration partner is identified
  (ABDM HIE-CM, an external EMR, a payer). INTEGRATION_ADMIN role must
  be assigned. Sign-off + dispatch are separate steps.
- **Tier G (public health)** — only with DPO sign-off. PHI
  de-identification needs Safe-Harbor review for the hospital's local
  privacy regime (DPDP / HIPAA / GDPR depending on jurisdiction).

---

## 4. Critical-risk module enablement runbook

Modules whose `settings.approvalPolicy === 'two_person_for_enablement'`
need a documented two-admin approval before flipping `enabled=true`.

**Mechanics:**

1. **First admin** opens the admin portal → Clinical AI → Module
   Registry → finds the module → clicks "Request enablement".
   Captures their justification (≥1 sentence: "for which department,
   which patient-class, why now").
2. **Second admin** (different uid, role ≥ ADMIN) reviews and clicks
   "Approve enablement". Captures their justification.
3. The registry writes both in `clinical_ai_modules.settings.
   enablement_audit` and flips `enabled=true`.

**If you don't have two admins available**, the module stays disabled.
This is intentional — these modules carry the highest patient-harm
potential and a single admin should not be able to flip them on.

**Critical-risk modules:** all listed in the migrations as
`approvalPolicy: 'two_person_for_enablement'`. As of 2026-05-01:

- Tier A: `voice_to_prescription_draft` (rx-side, doctor-cosign)
- Tier C: `renal_dose_check`, `liver_dose_check`,
  `pregnancy_lactation_warning`, `adverse_drug_event_detector`,
  `aki_risk_alert`
- Tier D: `triage_priority_suggestion`, `stroke_fast_check_assistant`,
  `chest_pain_protocol_assistant`, `trauma_checklist_assistant`,
  `mlc_documentation_assistant`
- Tier E: `mental_health_screening_bot`
- Tier F: `medical_record_bundle_generator` (insurance scope only),
  all five if any external dispatch is wired
- Tier G: `phi_deidentification`
- Tier H: `tariff_optimization_insights`, `package_compliance_check`

(The actual list is what the migration declares; this is the snapshot
at the time of writing.)

---

## 5. Ongoing operations

### Weekly

- Review the `clinical_ai_reviews` queue. Anything pending > 7 days
  is a process failure — escalate.
- Pull `clinical_ai_generations` rows where any
  `safety_flags[*].severity ∈ {critical, high}`. Any of these signed
  off without a flag-acknowledgement note in `clinical_ai_reviews.
  reviewer_note` is a governance hole — either the reviewer didn't
  read the flag, or the flag is noise. Discuss in the safety meeting.
- Spot-check 5 random signed drafts per week — does the signed text
  match what the patient / staff actually saw downstream?

### Monthly

- Pull `clinical_ai_module_eval_runs` per enabled module. Any module
  whose accuracy / F1 dropped > 5pp month-over-month gets a drift
  investigation (`driftCanaryService` per the S3 substrate).
- Run `regulatoryReadinessService.assembleReadinessPack` (S5
  exporter, admin route at `/admin/clinical-ai/readiness-pack`).
  Archive in the hospital compliance binder.
- Before any stage expansion, export a pilot evidence pack from Admin →
  Clinical AI → Regulatory Readiness Pack (or POST
  `/admin/clinical-ai/pilot-evidence-pack`). The pack must show
  `summary.pilot_ready=true`: tenant-scoped generations exist, every
  final review has a reviewer note, risky modules have accepted eval
  evidence, and schema-unavailable sections are visible instead of silent.
- Then create a pilot signoff from the same screen (or POST
  `/admin/clinical-ai/pilot-signoffs`) and record the reviewer decision.
  Expansion stays blocked until
  `/admin/clinical-ai/pilot-signoffs/gate` returns
  `stage_expansion_allowed=true` for the exact stage + module set.
- Review `bias_signals` rows from the past 30 days. Any slice
  underperforming overall pass rate by ≥15pp gets a remediation plan.

### Per-incident

- A clinician rejects a draft as harmful (`decision='rejected'` with
  `reviewer_note` mentioning safety) → file an `ai_incident` row,
  notify the AI safety committee, run an RCA via
  `rca_draft_generator`.
- A patient downstream complains about an AI-generated message (post-
  discharge check-in misread the chart, etc.) → pull the generation,
  the review row, audit log, fold into the safety-review cadence.

---

## 6. Local-LLM deep tier — when + how

When PHI must not leave the building. Per the rollout plan Phase 4
this is wired but the GPU node is hospital-side.

**When to flip:**

- Hospital is in a jurisdiction where DPDP / HIPAA business-associate
  framing is contentious for cloud LLM providers (most Indian hospitals
  on the conservative end).
- Hospital has procured a GPU node (typically 1× consumer or workstation
  GPU with ≥24GB VRAM for a 32B model; 1× datacenter GPU for 70B).
- nvidia-device-plugin is installed in the RKE2 cluster.

**How:**

1. Pull a model on the GPU node: `ollama pull
   llama3.1:70b-instruct-q4_K_M` (or a model the safety committee has
   approved).
2. Set the deep-tier env vars on the backend ConfigMap:
   ```
   CLINICAL_AI_DEEP_PROVIDER=ollama
   CLINICAL_AI_DEEP_BASE_URL=http://ollama-svc.<ns>.svc.cluster.local:11434
   CLINICAL_AI_DEEP_MODEL=llama3.1:70b-instruct-q4_K_M
   CLINICAL_AI_ALLOW_EXTERNAL=false   # for this tenant
   ```
3. Modules tier-routed to deep (declared in
   `clinical_ai_modules.settings.model_tier='deep'` or
   `clinical_ai_modules.settings.modelTier='deep'`) will route to
   Ollama instead of any external provider. Quick-tier modules stay
   on whatever they were configured for.
4. **Verify with a smoke test:** run
   `scripts/smoke-clinical-ai-local-ollama.ps1` against a backend started with
   the deep-tier env vars above. The smoke calls the real admission
   `medication_reconciliation` workflow and checks the API response plus
   `clinical_ai_generations` for `provider=ollama`, `metadata.tier=deep`,
   `metadata.generation_mode=ai`, and `metadata.provider_status=used`.

**Don't flip until** at least one critical-risk module has been
pilot-evaluated against the local model — output quality on 70B
local models is meaningfully different from frontier cloud models for
some clinical reasoning tasks. The eval suite (`clinical_ai_canary_runs`
+ `model_eval_runs`) should re-baseline before cutover.

---

## 7. Common pitfalls + recovery

### "Drafts are being signed off without anyone reading them"

Symptom: average time-from-draft-to-sign-off is < 30s.

Cause: reviewer queue is being click-through-rubber-stamped.

Fix: enforce a "reviewer must paste in 1+ sentence into
`clinical_ai_reviews.reviewer_note` on accept/edit/sign" gate in both
the backend and frontend. If the reviewer is genuinely just
confirming, the friction surfaces it. If they're rubber-stamping, the
friction blocks it.

### "Module enabled but no drafts arriving in the queue"

Symptom: `clinical_ai_reviews` count for the module is 0 after
several days enabled.

Cause: usually the integration that should call the module hasn't
been wired (e.g. patient explainer expected to fire on lab-result-ready
event but no one's calling the endpoint).

Fix: trace the trigger — is the admin/staff app actually calling the
POST? Hit the endpoint manually, confirm a row gets created. If the
endpoint works but no caller exists, the rollout is decorative.

### "Draft has hallucinated a citation"

Symptom: `source_citations[].source_id` references a record that
doesn't exist.

Cause: `runOutputDefenses` should catch this — check
`safety_flags[]` for a `citation_invalid` flag. If the draft was
signed off anyway, that's the bug.

Fix: the defenses helper has an `enforce_citations: true` mode that
*blocks* generation if all citations fail validation. Flip that on
for the affected module. Until then, manually reject drafts with
`citation_invalid` flags.

### "Patient received a wrong-language message"

Symptom: Hindi-only patient got an English chronic-disease coach
message.

Cause: the calling code didn't pass `language` in the body, or
`tenants.locale` was wrong.

Fix: backend services default `language='en'` when the body field
is missing. Either:
- the caller (cron job / staff-app dispatch) needs to look up
  `users.preferred_language` per recipient, or
- `tenants.locale` needs to be set so the service-side default
  switches to the right one.

### "Draft contains real patient identifiers it shouldn't"

Symptom: an explainer draft mentions a phone number, MRN, or full name.

This is a S1 / consentPhiPolicySentinel violation — `runOutputDefenses`
should catch it. If it slips through:

1. Disable the module immediately (`UPDATE clinical_ai_modules SET
   enabled=false WHERE module_key=$1` on the affected tenant).
2. Pull the generation row + raw output.
3. File a privacy incident (`patient_data_rights_requests` if a
   patient is involved; `breach_incidents` if it's a notifiable
   breach under the local regulator).
4. Re-enable only after the regex / classifier in
   `hallucinationDefenses.detectPhiLeaks` is updated to catch the
   shape of leak that occurred.

---

## 8. Disable / rollback

A hospital can `enabled=false` any module at any time without losing
historical drafts. Any in-flight reviews stay pending; no new drafts
generate. To roll back further:

- **Disable + delete pending reviews:** `UPDATE clinical_ai_reviews
  SET decision='deferred', decision_reason='module_rolled_back'
  WHERE module_key=$1 AND decision='pending';`
- **Quarantine a module across all tenants:** flip
  `clinical_ai_modules.quarantine_status='quarantined'`. This
  blocks all generation regardless of per-tenant enablement.
- **Roll back a model version:** the model registry workbench
  supports stage transitions (sandbox → staging → production →
  deprecated → quarantined). Demote to deprecated to stop new
  generations using that version; existing generations remain.

Rollback is always preferable to "let's see what happens" when a
module behaves unexpectedly. The substrate is built for it.

---

## 9. Per-tenant rollout checklist (printable)

A condensed version of the above for the hospital's project lead.

**Pre-flight (one-time per tenant)**
- [ ] Migrations ≤139 applied
- [ ] LLM provider reachable (smoke test passes)
- [ ] At least one reviewer with appropriate role identified
- [ ] `tenants.locale` and `tenants.region` set
- [ ] Audit + PHI logging confirmed on at least one route
- [ ] Weekly safety-review meeting on the calendar

**Stage 1 (week 1–2)**
- [ ] Tier A explainers (5 modules) enabled
- [ ] 3 Tier A remainder modules enabled (`lab_trend_summary`,
      `audit_log_summary`, `pending_report_tracker`)
- [ ] At least 10 drafts signed off (any module)
- [ ] No `severity=critical` flags un-acknowledged
- [ ] Pilot evidence pack exported and blocked items cleared before
      expanding beyond the first pilot ward/module set
- [ ] Pilot signoff approved and the stage-expansion gate is open

**Stage 2 (week 3–5)**
- [ ] 8 Tier C non-critical-risk modules enabled
- [ ] 2 Tier H operational forecasts enabled
- [ ] Reviewer queue median age < 24 h
- [ ] Pilot evidence pack archived for Stage 1 module set
- [ ] Pilot signoff archived for Stage 1 module set
- [ ] First monthly readiness-pack archived

**Stage 3 (week 6–8)**
- [ ] Two-person approval recorded for each critical-risk module
      to be enabled
- [ ] Tier C critical-risk modules enabled
- [ ] Tier D ED modules enabled (if ED in scope)
- [ ] Tier E patient-engagement modules enabled (if patient-app
      delivery validated)
- [ ] Local-Ollama deep tier in use for any module with `modelTier=deep`
      and PHI in input

**Anytime**
- [ ] Tier B / F / G enabled per department + integration partner
      readiness, not by week.

---

## 10. When to update this doc

Update this playbook when:

- A new tier ships (current state: Tier A–H all shipped 2026-05-01).
- A module's `approvalPolicy` changes (critical-risk gate added or
  removed).
- A new common pitfall is observed at a pilot site — add a §7 entry.
- The deep-tier env var contract changes.

Don't try to mirror the per-module status here — that lives in
`AI_FEATURE_GAP_BACKLOG.md`. Don't try to mirror the rollout-phase
status — that lives in `CLINICAL_AI_ROLLOUT_PLAN.md`. This doc is
*operations*: who turns what on, when, with what guardrails.
