# Clinical Text De-identifier (v1) — Design

- **Date:** 2026-06-16
- **Status:** Approved (design); implementation pending
- **Branch:** `feat/clinical-text-deidentifier` (off `main`)
- **Module:** `clinical_text_deidentifier` (NEW registry entry, `enabled:false`)
- **Surface:** Governance/research; not patient-facing. Deterministic — **no LLM**.

## 1. Context

The platform has rich PHI **detection** (`hallucinationDefenses.js` regexes: UID/phone/email/MRN) and **log-masking** (`piiMask.js`, `logMasking.js` `scrubPhiFromString`/`scrubPhiDeep`, `sentryScrubber.js`, `phiRedactionFormat.js`), but **no de-identification transformer** — nothing takes clinical free text and returns safe-to-share text. Several modules each roll their own inline scrub (`training_simulation_coach` scrubs phone/MRN/name/email/**Aadhaar**; `consent_aware_family_update`; `voice_patient_assistant_ivr`), and `researchRegistryService.exportRegistry` (`:672`) pseudonymizes the ID column (`subject_code`, `includePhi=false`) but applies **no de-id to free-text / autofilled fields** — a real leak path on export.

v1 builds the missing primitive: a **deterministic, chart-anchored de-identification transformer**, wired into research export (the highest-value gap) and available as the shared primitive the ad-hoc scrubbers can adopt.

## 2. Goals / non-goals

**Goals (v1):**
- A reusable, deterministic `deidentifyText(text, { knownIdentifiers, mode, salt })` that removes PHI and returns `{ text, redactions, residualFlags }`.
- **Chart-anchored** name/ID removal: redact the patient's *actual* identifiers (fetched from the DB) by exact value — solving names deterministically — plus a regex sweep for *other* people's structured identifiers.
- Two output modes: **typed redaction** (`[REDACTED:NAME]`, default) and opt-in **stable pseudonymization** (`[NAME-7f3a]`, same value → same token within a dataset, preserving research linkage).
- Coverage: NAME & ADDRESS (chart-anchored), MRN, PHONE, EMAIL, AADHAAR, UID, DATE, URL, AGE>89. Residual scan → `RESIDUAL_PHI_SUSPECTED`.
- **Fail-closed**: on error, return empty text + an error flag — never the original.
- Wire into `exportRegistry(..., { deidentify:true })`: free-text/autofilled fields per subject run through the transformer.
- Register `clinical_text_deidentifier` (`enabled:false`); deterministic so no provider/model config.

**Non-goals (v1):**
- NER / LLM-based name catching for *unknown* names (probabilistic — v2).
- Refactoring the existing inline scrubbers to call the primitive (noted as a follow-up; YAGNI now).
- A formal Safe-Harbor / Expert-Determination *certification* — output is **best-effort de-identified + a residual-risk report**, not a compliance attestation (human sign-off stays separate).
- Reversible de-id / re-identification key escrow.
- Provider/staff-name redaction lists (v2; v1 anchors on the patient + next-of-kin).
- Any patient-facing surface.

## 3. Locked decisions
1. **Approach B — context-anchored + regex** (deterministic; no model). Chart-truth solves names; regex catches structured identifiers of others.
2. **Typed redaction default + opt-in stable-pseudonym mode** (same detection core; the label formatter differs).
3. **Best-effort + residual-risk report**, never "certified safe."
4. **Fail-closed** — failure never emits original text.
5. v1 consumer = **research export**; primitive is shared for later adopters.

## 4. Architecture & flow

```
deidentifyText(text, { knownIdentifiers = [], mode = 'redact', salt = null })   ← PURE, no DB/LLM
  1. Normalize knownIdentifiers → [{ value, category }]  (NAME, PHONE, EMAIL, MRN, AADHAAR, ADDRESS, DATE(DOB))
  2. Sort known values by length DESC (longest-first; avoids partial-overlap leaks, e.g. surname inside full name)
  3. Redact each known value (case-insensitive, word-boundary where sane) → placeholder(category)  (NAME, ADDRESS, DOB, + patient's own PHONE/EMAIL/MRN/AADHAAR)
  4. Regex sweep for STRUCTURED identifiers of anyone (UID/PHONE/EMAIL/MRN/AADHAAR/URL/AGE≥90) → placeholder(category)
  5. placeholder(category): mode==='redact' → `[REDACTED:${category}]`
                            mode==='pseudonymize' → `[${category}-${hmac(value, salt).slice(0,4)}]`  (stable per value+salt)
  6. residual scan: any leftover identifier-shaped token (UID/phone/email/MRN/Aadhaar pattern) → RESIDUAL_PHI_SUSPECTED;
     any ABSOLUTE DATE token (dd/mm/yyyy, yyyy-mm-dd, "12 Jun 2026") → RESIDUAL_DATE flag (v1 does NOT auto-redact generic
     dates — blanket redaction destroys temporal research utility; date-shifting is the v2 answer. DOB is removed via step 3.)
  7. return { text, redactions:[{category,count}], residualFlags:[{code,severity,metadata}] }
  (on any throw → return { text:'', redactions:[], residualFlags:[{code:'DEID_FAILED',severity:'critical'}] })

collectKnownIdentifiers(patientUid, { tenantId })   ← chart-anchored assembler
  reads users (name, phone, email, birthday→DOB, address) + next-of-kin / emergency_contact (name, phone)
  → [{ value, category }]   (skips null/blank; tenant-scoped read)

researchRegistryService.exportRegistry(registryId, { deidentify:false, salt, ... })   ← v1 consumer
  when deidentify:true → for each subject row, free-text + autofilled string fields pass through
  deidentifyText(value, { knownIdentifiers: collectKnownIdentifiers(subject.patient_uid), mode:'pseudonymize', salt: <per-export salt> })
  (pseudonymize so the same person reads consistently across the export; subject_code already pseudonymous)
```

**Pseudonymization keying:** `hmac(value, salt)` truncated — deterministic within one `salt`, so the same name maps to the same token across a dataset (linkage preserved) while remaining one-way (not reversible without the value). The export passes a single per-export `salt`. Documented as a **surrogate, not encryption**.

**Ordering correctness:** known values redacted longest-first so "Ramesh Kumar" is replaced before "Kumar" can leak as a partial. Structured regex runs after, on the already-name-redacted text.

## 5. Components (files)

**New:**
- `apps/backend/src/services/ai/deidentificationService.js` — `deidentifyText(...)` (pure core) + `collectKnownIdentifiers(patientUid, {tenantId})` (chart assembler, reads DB). Exports both; `__testing__` for the pure internals (placeholder/ordering/regex).
- Tests: `deidentificationService.test.js` (unit, pure), `clinicalTextDeid.deep.test.js` (real-PG: export de-id + identifier assembly).

**Changed:**
- `clinicalAiModuleService.js` — add `clinical_text_deidentifier` (`enabled:false`, `surface:'governance'`, `risk:'critical'`, `requiresCitations:false`, `reviewRoles:['ADMIN','SUPER_ADMIN','COMPLIANCE_OFFICER']`, `outputSchema` describing `{ text, redactions }`, `retentionDays` long).
- `researchRegistryService.js` — `exportRegistry` accepts `{ deidentify, salt }`; when set, runs free-text/autofilled string fields through `deidentifyText` per subject (chart-anchored, pseudonymize mode). Default `deidentify:false` (no behavior change).

**No new migration** — reuses `users` + registry tables.

## 6. Detection coverage & primitives reused
- **Auto-redacted via regex:** reuse `hallucinationDefenses.js` `UID_RE / PHONE_RE / EMAIL_RE / MRN_RE` (export them or mirror); add `AADHAAR_RE` (`\b\d{4}\s?\d{4}\s?\d{4}\b`, shape-only — no Verhoeff checksum), `URL_RE`, `AGE_RE` (age ≥ 90, Safe Harbor).
- **Chart-anchored (exact-value redaction):** NAME, ADDRESS, DOB + the patient's own PHONE/EMAIL/MRN/AADHAAR — from `collectKnownIdentifiers`. The deterministic answer to the name problem.
- **Residual scan (flag, not redact):** re-run the structured regexes on the output — any survivor → `RESIDUAL_PHI_SUSPECTED` (medium); plus `DATE_RE` (dd/mm/yyyy, yyyy-mm-dd, "12 Jun 2026") → `RESIDUAL_DATE` (medium). Generic dates are surfaced, not auto-redacted (preserve temporal research utility; date-shifting = v2). Callers never assume "clean."

## 7. Gating, security, honesty
- `clinical_text_deidentifier` stays `enabled:false`; tenant-scoped reads (RLS) in `collectKnownIdentifiers`. Governance surface.
- Deterministic — committed config unaffected (no provider/model).
- **Honesty:** every result is "best-effort de-identified + residual-risk report." No code path labels output "safe to release" / "HIPAA-certified." Consistent with `hallucinationDefenses` ("heuristic, not proof") and `consent_phi_policy_sentinel` (governance review remains human).

## 8. Error handling
- `deidentifyText` never throws — internal errors → `{ text:'', residualFlags:[{code:'DEID_FAILED',severity:'critical'}] }` (fail-closed; PHI never passes through on failure).
- `collectKnownIdentifiers` DB error → `AppError` to the caller (the export decides whether to abort; it must NOT export un-de-identified text if de-id was requested and failed).
- `exportRegistry` with `deidentify:true`: if a field's de-id fails-closed (empty), the cell is emptied (never the raw value) and a per-export `deid_residual` count is surfaced.

## 9. Test plan (TDD)
- **Unit (pure):** each category redacted (chart-anchored name/phone/email/MRN/Aadhaar/address/DOB + regex UID/date/url/age); longest-first ordering (no partial-name leak); redact vs pseudonymize formatter; **pseudonym stability** (same value+salt → same token; different salt → different token); residual flag fires on a planted leftover; **fail-closed** (a thrown internal → empty text, never original); empty/no-known-identifiers path.
- **Integration (real PG):** seed a patient + a registry subject + a free-text CRF response containing the patient's name/phone → `exportRegistry({deidentify:true,salt})` emits the field with name/phone replaced (pseudonymized), `subject_code` still present, `includePhi:false` unaffected; `collectKnownIdentifiers` returns the seeded identifiers; module-disabled gate (if wired) → no-op/denied per design.
- **Gates:** `npm run test:ci` (all chunks), `npm run lint` (raw-params/PHI), local gitleaks/semgrep. No Ollama smoke needed (deterministic, no model).

## 10. Code-grounded anchors
- Detection primitives: `hallucinationDefenses.js:26-29` (UID/PHONE/EMAIL/MRN regexes), `detectPhiLeaks` allowlist pattern (`:138`).
- Log-scrub reference (shape, not reused as-is): `utils/logMasking.js` `scrubPhiFromString`/`scrubPhiDeep`.
- Patient identifier read: `clinicalTimelineService.js:113` `getPatient` (name/phone/email/birthday/address) — mirror for `collectKnownIdentifiers`; ground the emergency-contact/next-of-kin column at implementation (read-first).
- Consumer: `researchRegistryService.js:672` `exportRegistry` (`{ format, includePhi, tenantId }`; `subject_code` vs `patient_uid` at `:702`).
- Module registry shape: `clinicalAiModuleService.js` `consent_phi_policy_sentinel` (`:1488`) — mirror fields.

## 11. Future (v2+)
- **Consistent date-shifting** (per-patient offset preserving intervals) so absolute dates are removed without losing temporal research utility — the research-grade answer to the `RESIDUAL_DATE` flag.
- NER / LLM-assisted catching of *unknown* names (probabilistic; behind the deterministic pass, only ever *adds* redactions).
- Provider/staff-name redaction via a staff-name list.
- Adopt the primitive in `training_simulation_coach` / `consent_aware_family_update` / `voice_patient_assistant_ivr` (retire their inline scrubs).
- An on-demand admin endpoint (de-identify a chosen admission's notes) + audit row.
- Formal Safe-Harbor checklist / Expert-Determination workflow on top of the residual report.
