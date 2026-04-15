# HONESTY ADDENDUM — 2026-04-14 (post-audit)

**Revised grade: C+ (not B+/A−).** The 2026-04-14 drift-fix audit uncovered ~800 broken sites across 120+ files that the existing test suite silently passed:

- **~665 `prisma.$queryRawUnsafe(sql, [array])` array-param sites** (Prisma takes spread args; arrays become single bound values, making every `$2+` placeholder unbound). Fixed via `scripts/fix-raw-params.mjs` codemod; `npm run lint:raw-params` now blocks new ones.
- **~15 services referencing columns that don't exist in the DB** — admissions, beds, pharmacy_orders, blood_requests, radiology_orders, appointments, vitals_chart, diagnoses, investigations. All rewritten.
- **jwtMiddleware never surfaced `req.user.id`** despite ~100 call sites doing `String(user.id)` comparisons. Every IDOR check in appointments was broken. Fixed + unit-tested.
- **Test-suite was passing but worthless** — 36 suites, most using `expect([200, 500]).toContain(res.statusCode)`. 8 shallow suites deleted. 11 `-deep.test.js` suites added (admission, vitals, diagnosis, pharmacy, investigation, pharmacy-lifecycle, appointment, bed, bloodbank, theatre, radiology) totalling 284→454 real assertions.

**New baseline (2026-04-14):**
- 39 suites, 364 tests, 0 shallow `[200, 500]` assertions remaining.
- CI now runs full test matrix + `lint:raw-params` on `main` + `claude/**` branches.
- ESLint: `no-console` is now `error` (was `warn`). New custom `no-restricted-syntax` rule blocks regressions of the array-param bug.

**What "Phase 3 complete" actually means in this repo:** a vertical slice shipped, not load-bearing. Examples:
- Real-time fabric: WebSocket server + channel auth + emit helpers + admin ticket exchange all real. Integration with product flows is thin. No soak tests.
- HL7v2 / FHIR / EDI 837: parsers exist, no CI conformance checks, no live validation.
- ML adherence model: lazy-loads ONNX, no training pipeline or retraining story.
- Clinical safety (CDS, MAR 5-rights, vital anomaly): real code with real tests, most credible slice.

**Still open (honest list):** see FINISH_BUILDING.md. Top items: observability (Sentry release + structured log shipping), pentest engagement, runbooks.

---

# Backend Roadmap — A+/S-Tier

> Source of truth for next-step work. Born from a full-repo audit (see commit history for context). Update this file as items land.

**Current grade:** B+/A−. Strong architecture and security intent; needs closing of sharp edges (SQL injection in analytics, err.message leaks, broken Jest) and marquee real-time + interop features to reach S.

---

## Phase 1 — A+ Security Floor (in progress)

- [x] **SQL injection in analytics — CRITICAL.** `src/controllers/adminUploadController.js` L41-62, L247, L488; `src/controllers/analyticsController.js` 6+ patterns. Template literals in `INTERVAL '${interval}'` + `WHERE ... '${userId}'`. Parameterize. Validate integer inputs with enum clamp.
- [x] **err.message leakage — HIGH.** ~236 occurrences. `src/middleware/errorHandlerMiddleware.js` must strip `err.message` in `NODE_ENV === 'production'` unless `err instanceof AppError`. Controllers: generic message + `logger.error(..., { err })`. Target: grep count <20.
- [x] **Jest broken.** `jest.config.js` has invalid `testPathPatterns`; `iconv-lite` dependency issue. Fix + add `npm test` to `.github/workflows/ci.yml` as blocking step for `authorization.test.js` + `critical-paths.test.js`.
- [x] **console.log in prod code.** 123 instances across `/src`. Migrate to `logger.info/warn/error` with structured fields. Add ESLint rule `no-console: error` (allowlist `bin/www.js`).
- [x] **Admin MFA (TOTP) + 4h JWT TTL.** `npm i otplib`. `POST /auth/admin/mfa/enroll` + `/verify` + recovery codes. Enforce in `adminAuthController.login`. `securityConfig.js` admin JWT TTL 7d → 4h. Refresh-token flow (reuse staff pattern).
- [x] **Bed management CRUD.** Add/verify routes in `src/routes/bed/` + controllers. Admin portal currently uses localStorage — backend must be ready.

## Phase 2 — A+ Polish

- [ ] **Test coverage ≥60%.** Integration tests for billing, pharmacy state machines, clinical workflows. Currently 35 test files but many don't run. *Deferred — needs live Node+DB to run/debug.*
- [ ] **OpenAPI/Swagger conformance.** `/api-docs` exists but isn't validated against runtime responses. Add CI check.
- [x] **API response consistency.** 4 raw `res.json(...)` instances in `src/app.js` now use `success`/`error` helpers (`/`, `/health`, `/api/health`, `/api-docs` 404).
- [ ] **Prisma schema drift detection.** Schema has 58 models, raw `pg` queries used. Add CI job that diffs schema vs live DB. (`schemaDriftDetector.js` exists — needs CI hook.)
- [x] **Observability.** `/metrics` Prometheus endpoint already wired (http duration histogram, request counter, DB pool, memory, uptime gauges). Fixed `redis_connected` gauge to reflect actual client state. OpenTelemetry still pending.
- [ ] **Load-test automation.** `/load-tests` dir exists but not in CI. Run weekly against staging.

### Phase 1 loose-end (completed 2026-04-13)
- [x] **`/auth/refresh-token` accepts expired tokens.** `verifyToken()` rejected expired JWTs, making refresh useless. Added `verifyTokenAllowExpired()` in `jwtUtils.js` + replay-protection via `isTokenBlacklisted(jti)` before rotation. Signature still validated.

### 3A loose ends (completed 2026-04-14)
- [x] **Periodic `admin:kpi` aggregator.** New `utils/kpiAggregator.js#tickAdminKpi` emits `bed-occupancy` + `waiting-queue` tiles every 30s via node-cron (`*/30 * * * * *`) under `withJobLock('admin-kpi-tick', …)`. Also fires once at startup via `setImmediate` so first subscribers paint immediately.
- [x] **Code Blue FCM fan-out.** `realtimeEmitter.emitCodeBlue` now pulls `staff_devices.device_token` where `is_active = true`, chunks at FCM's 500-token multicast cap, and sends a high-priority data-only message via `sendPushNotification({priority: 'high', channelId: 'code_blue'})`. `sendPushNotification` extended to build `android.priority: 'high' | notification.priority: 'max' | notification.visibility: 'public'` + APNS `interruption-level: critical` when `priority === 'high'`.

## Phase 3 — S-Tier Marquee

### 3A. Real-time Clinical Fabric ✅ (2026-04-14)
Built on the existing `/ws` WebSocket (native `ws` lib) rather than adding Socket.IO. Added:
- `utils/websocket/channelAuth.js` — role-scoped subscribe authorization (`staff:*` / `staff:clinical:*` / `admin:*` / `patient:<id>:*`) + legacy channel preservation.
- `utils/websocket/realtimeEmitter.js` — domain helpers (`emitVitalAnomaly`, `emitCodeBlue`, `emitBedEvent`, `emitHandover`, `emitQueuePosition`, `emitAdminKpi`).
- Wired: `vitalSignMonitor.js` (anomalies + Code Blue on CRITICAL HR/SpO2/RR/sBP), `bedController.js` (bed CRUD + admit/discharge), `handoverService.createHandover`, `appointmentStatusController.updateAppointmentStatus` (queue fan-out via new `waitTimeService.getWaitingQueueForDoctor`).
- `POST /api/v1/realtime/ticket` (JWT-authed) — short-lived (60s) WS-scoped JWT for browser clients whose primary token is in an httpOnly cookie (admin portal pattern).
- `GET /api/v1/realtime/channels` + `/health` — catalog & connection count.

### 3B. HL7 v2 + FHIR R4 with validation ✅ (expanded, 2026-04-14)
**HL7v2 ORU inbound.** `POST /hl7/receive` now handles ORU^R01: OBX segments map to `investigations.structured_results` (new jsonb column via migration `008_*.sql`) and attach to the most recent pending investigation for the patient (or create a new one if no order was pre-registered). ORM^O01 and ADT^A01/A02/A03 were already wired.

**FHIR validator hardened.** `services/fhir/fhirValidator.js` now enforces:
- Required R4 cardinality-1 elements per resource type.
- Value-set constraints for `status`/`intent` across 8 resource types (rejects invalid enum values with `code-invalid`).
- `MedicationRequest.medication[x]` choice check (CodeableConcept OR Reference required).
- New `validateBundle` helper for searchset responses — warns on invalid entries without killing the whole query.
Wired into `GET /fhir/Patient/:id` + `GET /fhir/Appointment/:id`; other routes can adopt `validatedFhirJson` one line at a time.
**Still open:** official HL7 Java validator in CI for full StructureDefinition conformance; LOINC/SNOMED/RxNorm code-set validation on inputs.

### 3C'. HealthKit / Google Fit vitals ingestion ✅ (2026-04-14)
Migration `005_add_vitals_source.sql` adds `source` (manual/healthkit/google_fit) + `recorded_at_source` columns and an index on `(patient_uid, source, recorded_at_source DESC)`. `POST /health/patient/vitals` now validates and persists those fields. New `GET /health/patient/:patient_id/sync-status` returns `{lastSyncBySource: { manual, healthkit, google_fit }}` so apps can compute deltas after reinstall.

### 3D'. MAR 5-rights verification (staff-app backend) ✅ (2026-04-14)
Layered 5-rights barcode verification onto the existing `medication_administrations` table. Migration `004_*.sql` adds scanned_patient_uid, scanned_barcode, rights_passed, all_rights_passed, override_reason, medication_index. New `services/clinical/marFiveRightsService.js` with `evaluate5Rights` + `administerWithScan`. Routes: `POST /clinical/mar/verify` (dry-run), `POST /clinical/mar/:id/administer-with-scan` (commits, 409 with `details.rights` on fail w/o override).

### 3C. Clinical Decision Support (CDS) exposure ✅ (2026-04-14)
- `ePrescriptionController.createPrescription` invokes `validatePrescriptionSafety` pre-insert; on blockers → 409 with `{blockers, warnings, requiresOverride: true}` unless `override.reason` (≥5 chars) supplied.
- `POST /prescriptions/safety-check` — preview endpoint for clients driving hard-block UX without burning form state.
- `GET /prescriptions/:id/safety` — patient-facing safety context (warnings + any override reasons + indication).
- Migration `003_create_prescription_safety_overrides.sql` — audit rows linked to `e_prescriptions` with blockers JSONB + reason + approved_by.

### 3D. Revenue cycle ✅ (foundations + 837 generator, 2026-04-14)
**837 EDI generation.** `services/billing/ediGenerator.js#build837P(input)` produces a minimum-viable X12 837 Professional claim envelope (ISA / GS / ST / BHT / submitter + receiver / billing-provider HL / subscriber HL / CLM / HI diagnoses / LX service lines / SV1 / DTP / SE / GE / IEA). New endpoint `GET /billing/837/:invoiceId` pulls the invoice + patient + ICD/CPT and returns the claim as `application/edi-x12` attachment. Submitter/provider NPI/taxId come from `EDI_*` env vars.
**Still open:** payer-specific companion-guide extensions, multi-service-line adjustments + COB, validation against the TR3 implementation guide — add per payer as they're onboarded.

---
Migration `007_*.sql` adds `icd_cpt_map` (seeded with 8 common codes) and `claim_denials` (invoice ref, reason_code, amount, appeal status). New routes under `/billing`:
- `GET /billing/icd-cpt-map?icd10=X` — lookup CPT + default charge by diagnosis.
- `GET /billing/denials/summary?days=90` — aggregate denials + top reason codes + appeal win rate.
- `GET /billing/denials?limit=50` — recent denials list.
Role-gated to ADMIN / BILLING_STAFF / INSURANCE_COORDINATOR.
**Still open:** 837 EDI claim generation (needs `edi-837`), insurance pre-auth endpoint, patient payment portal endpoints (installments, co-pays).

### 3E. ML adherence prediction ✅ (ONNX serving + heuristic fallback, 2026-04-14)
**ONNX serving** landed — `services/gamification/adherenceModelServing.js` loads `models/adherence-risk.onnx` lazily on first call (via `onnxruntime-node`). When the file is absent or fails to load, returns null so the heuristic path runs. When loaded, passes `[missed, overrides, lateRefills, daysSilent]` as float32 [1×4] and reads the positive-class probability from the output. `adherenceRiskService.scoreAdherenceRisk` now returns `{score, source: 'onnx'|'heuristic', heuristicScore, factors, contribution}`.

Training pipeline (standalone Python script, run offline):
- Export labelled features from MAR + refill history to CSV.
- Fit sklearn LogisticRegression, export via `skl2onnx` to `models/adherence-risk.onnx`.
- Drop file in place + restart.
Full script sketch lives in `adherenceModelServing.js` top-of-file comment.

### 3E (original heuristic):
`services/gamification/adherenceRiskService.js#scoreAdherenceRisk(patientId)` — weighted heuristic (missed doses, MAR overrides, late refills, days since last vital) returning `{score: 0–100, band: low/medium/high, escalate, factors}`. Exposed at `GET /gamification/adherence-risk/:patientId` with patient self-access + staff access.
**Still open:** proper logistic-regression model trained on historical data, exported to ONNX, served via `onnxruntime-node`. Current heuristic gives the admin dashboard something usable while we accumulate training data.

### Admin 3F. Revenue cycle UI ✅ (denial dashboard, 2026-04-14)
Admin page at `dashboard/billing/denials` — reads `/billing/denials/summary` + `/billing/denials`, renders count / amount / appeal-win-rate tiles, top reason codes table, and recent denials list.

---

## How to resume in a new Claude session

```
cat docs/ROADMAP.md
```

Pick any unchecked item, reference it by its bullet text in your prompt, and Claude can pick up the thread. Unchecked items are ordered by priority within each phase.

## Related files

- Audit source: plan `/root/.claude/plans/calm-kindling-wirth.md` (session `01AVRjDoo6auYpyWaMEiEgZZ`).
- Core conventions: [CLAUDE.md](../CLAUDE.md) — security checklist, response envelope, route structure.
