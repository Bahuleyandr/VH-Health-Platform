# Release notes — April 2026

> Consolidates the 2026-04-14 Phase 3 drop and the 2026-04-17 safety +
> production-readiness pass. Aimed at hospital ops + clinical leads:
> what changed, how to act, where to read more.

## Highlights

- **Clinical safety:** live 5-rights MAR scanner now reachable; CDS hard-block
  on prescriptions; drug-identifier table replaces fuzzy name matching.
- **Interop:** full ADT A01-A08 event coverage; HL7 ORU inbound with LOINC
  structural validation; 837 EDI claim generator.
- **Observability:** Sentry wired across all 5 repos; backend Winston logs
  fan warn → Sentry breadcrumbs + error → Sentry events.
- **Compliance:** data-retention cron enforcement landed with policy doc
  (7-year clinical floor, 6-year PHI access, DSAR erasure workflow documented).
- **Ops:** five operational runbooks under `docs/runbooks/`; CI schema-drift
  check added.

## What changed — by area

### Clinical safety (staff app + backend)

- **MAR 5-rights scanner now invocable.** A new *Due Medications* screen on
  nurse + admin dashboards (`/mar/due`) lists scheduled + held doses in a
  rolling window around "now" with patient name + bed context. Tap a row
  → bedside scan flow (`/mar/scan/:maId`). Prior to this, the scanner
  existed but nothing in the app fed it a `ma_id` — so the feature was
  effectively dead code.
- **Drug-identifier table.** `drug_identifiers (code, code_type, canonical_name,
  generic_name, brand_name, strength, dosage_form)` (migration 009) replaces
  the substring match previously used to check the "right drug." A scanned
  barcode that resolves strict-matches on ingredient/brand tokens; if it
  doesn't resolve, falls back to the legacy substring check so existing
  installs keep working. **Populate this table** as pharmacy receives new
  stock — rows can come from supplier catalogues (GTIN) or US NDC lookups.
- **Prescription CDS hard-block.** `POST /prescriptions/create` now rejects
  with 409 if safety check finds blockers and no override reason is supplied.
  Staff app shows the `cds_blocker_modal` with override UX.
- **Code Blue fan-out.** FCM high-priority messages + full-screen intent +
  wake-from-terminated on the staff app. Patient list board + SMS fallbacks
  pending — see roadmap 3.1.

### Interop (backend)

- **ADT A04-A08.** Registration (A04), pre-admit (A05), OP→IP conversion
  (A06), IP→OP conversion (A07), and demographic updates (A08) joined the
  existing A01-A03 handlers. `POST /hl7/receive` accepts all eight events;
  capabilities endpoint lists what's supported.
- **HL7 ORU inbound.** OBX segments land in `investigations.structured_results`
  (jsonb). Each observation row now carries a `loinc_valid` flag surfaced
  by the new `loincValidator` integration.
- **Terminology validators.** New `services/terminology/rxnormValidator.js`
  + `services/terminology/snomedValidator.js` alongside the existing LOINC
  one. Wired into prescription + diagnosis POST: malformed codes → 400,
  not-in-allowlist → warn + accept.
- **FHIR R4.** `GET /fhir/Patient/:id` + `GET /fhir/Appointment/:id` now
  return validated resources with required-element + bound-value-set
  checks. Official HL7 Java IG Publisher runs in CI on sample bundles
  (non-blocking; rebuild warnings incrementally).
- **837 EDI.** `GET /billing/837/:invoiceId` emits an X12 837 Professional
  claim envelope. Payer-specific companion-guide overrides pending.

### Observability (all 5 repos)

- **Backend.** Winston `logger.warn` → Sentry breadcrumbs; `logger.error`
  → Sentry events. Active only when `SENTRY_DSN` is set and outside tests.
- **Admin portal.** Sentry already wired (three instrumentation files +
  `withSentryConfig`). CI now supplies `JWT_SECRET`, `BACKEND_API_KEY`,
  `NEXT_PUBLIC_ALLOWED_ORIGIN` so `next build` + middleware don't crash
  closed when the secret is missing.
- **Patient + staff apps.** New `FirebaseCrashReporter` adapter implements
  the core `CrashReporter` interface. Install happens in each app's
  `main.dart` right after `Firebase.initializeApp()`.
- **Staff app.** Offline sync badge (mounted in `StaffScaffold`) surfaces
  queue depth + conflicts with per-item Discard/Retry.

### Compliance (backend)

- **Data retention policy.** `docs/DATA_RETENTION_POLICY.md` documents
  per-table retention + legal basis. 7 years for clinical rows
  (`medication_administrations`, `prescription_safety_overrides`,
  `claim_denials`, etc.), 6 years for PHI access logs, 90 days for audit
  logs, 2 years inactive for drug identifiers.
- **Subject rights.** `docs/DATA_SUBJECT_RIGHTS.md` covers DPDPA erasure
  (with clinical-retention override), DSAR access, rectification,
  portability. DSAR tooling (scripts + admin page) sits as a follow-up.
- **Retention crons.** `retention-clinical-audit` (warns on overdue rows
  past 7-year window), `retention-e2e-keys` (nulls `users.e2e_public_key`
  when `deactivated_at` set), `retention-drug-identifiers` (purges inactive
  rows >2y), `retention-phi-access` (deletes `phi_access_logs` past 6y).

### Ops

- **Runbooks.** Five new runbooks under `docs/runbooks/`:
  `db-restore.md`, `r2-restore.md`, `cert-rotation.md`,
  `code-blue-misfire.md`, `chatbot-provider-switch.md`. Each follows the
  same shape: When / Prereqs / Steps / Verify / Rollback / Page.
- **CI additions.** Backend now runs `scripts/ci-schema-drift.mjs` after
  migrations — fails the build if any expected table is missing from the
  DB. Swagger structural validation + Spectral lint were already wired.
- **Branch-protection runbook.** `docs/CI_REQUIRED_CHECKS.md` lists the
  exact `gh api` block for enforcing required checks per repo. Blocked on
  GitHub Pro for private free-tier repos — see the doc for the free-tier
  pre-push-hook fallback.

## Breaking changes

**None in the runtime contract.** Response envelopes and route paths are
unchanged. New optional fields (`rxnorm_code`, `snomed_code`, etc.) are
additive. The admin dashboard's `/admin/stats/appointments` response now
includes `waiting` / `in_progress` / `inProgress` keys (previously absent)
— clients that already read `completed` keep working.

## Migration notes

- Run migrations 003-010 under `src/migrations/` on any DB that hasn't
  picked them up: `node scripts/ci-setup-db.mjs`. CI does this
  automatically on PRs.
- New env vars (all optional until activated):
  - `SENTRY_DSN` — activates Sentry on the backend.
  - `CHATBOT_PROVIDER`, `CHATBOT_BASE_URL`, `CHATBOT_MODEL`, `CHATBOT_API_KEY`
    — swap the symptom-checker LLM between Anthropic and any
    OpenAI-compatible endpoint (Ollama / vLLM / LM Studio).
  - `EDI_SUBMITTER_*`, `EDI_BILLING_*` — 837 claim envelope identity.
  - `ADMIN_IP_ALLOWLIST` — admin portal IP gate (comma-separated exact IPs,
    unset = disabled).

## Known issues

- **Dashboard queue panel was showing zeros** due to two root causes —
  fixed 2026-04-17. Shape mismatch in the stats service + a `regclass`
  deserialisation bug in the `tableExists` helper that was silently
  zeroing **every** admin metric. Upgrade to pull this fix before pointing
  the admin portal at populated prod data.
- **Branch protection not enforced** on private repos without GitHub Pro.
  See `docs/CI_REQUIRED_CHECKS.md` for the pre-push-hook fallback.
- **DSAR export / erasure scripts** scoped but not built — see the TODO
  block at the bottom of `DATA_SUBJECT_RIGHTS.md`.
- **Due-meds list** ships the flow but doesn't yet surface the drug
  identifier's `resolved_drug` info in the 5-rights result UI — the field
  is on the wire, the UI can choose to render or ignore.

## Pointers

- Full open-item list: [`docs/FINISH_BUILDING.md`](./FINISH_BUILDING.md)
- Runbooks index: [`docs/runbooks/README.md`](./runbooks/README.md)
- Retention policy: [`docs/DATA_RETENTION_POLICY.md`](./DATA_RETENTION_POLICY.md)
- Subject rights: [`docs/DATA_SUBJECT_RIGHTS.md`](./DATA_SUBJECT_RIGHTS.md)
- Branch-protection setup: [`docs/CI_REQUIRED_CHECKS.md`](./CI_REQUIRED_CHECKS.md)
