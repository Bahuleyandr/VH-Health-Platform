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

- [ ] **Test coverage ≥60%.** Integration tests for billing, pharmacy state machines, clinical workflows. Currently 35 test files but many don't run.
- [ ] **OpenAPI/Swagger conformance.** `/api-docs` exists but isn't validated against runtime responses. Add CI check.
- [ ] **API response consistency.** 4 raw `res.json(...)` instances in `src/app.js` bypass `success/error` helpers. Standardize.
- [ ] **Prisma schema drift detection.** Schema has 58 models, raw `pg` queries used. Add CI job that diffs schema vs live DB.
- [ ] **Observability.** `/metrics` Prometheus endpoint. SLO/SLI definitions. OpenTelemetry request tracing.
- [ ] **Load-test automation.** `/load-tests` dir exists but not in CI. Run weekly against staging.

## Phase 3 — S-Tier Marquee

### 3A. Real-time Clinical Fabric
Socket.IO or SSE emitting from `vitalSignMonitor.js` (anomalies), bed table (status), `appointments` (queue position), `nurse_handovers` (posts). JWT-scoped event filtering. New route `/realtime/subscribe`. Powers the patient queue widget, staff census board, admin KPI dashboard.

### 3B. HL7 v2 + FHIR R4 with validation
`hl7-parser` + `fhir-kit-client`. Parse inbound ORM/ORU, map to `investigations` with LOINC-coded units. FHIR read endpoints for `Patient`/`Observation`/`DiagnosticReport`/`MedicationRequest` with conformance tests. ICD-10 + SNOMED + RxNorm validation on prescription POST. `/hl7` + `/fhir` routes already exist — need parsing + validation layers.

### 3C. Clinical Decision Support (CDS) exposure
`prescriptionSafetyCheck.js` already exists. Wire into every prescribing surface (staff app + patient visible). Hard-block allergy conflict; override requires reason + audit row in `prescription_safety_overrides` table.

### 3D. Revenue cycle
ICD-10 → CPT charge mapping table. Insurance pre-auth endpoint. 837 EDI claim generation (`edi-837` lib). Denial dashboard API. Patient payment portal endpoints (installments, co-pays).

### 3E. ML adherence prediction
Train simple logistic model (pandas/sklearn off-line → ONNX runtime in Node). Score per-patient refill risk. Expose via `/gamification/adherence-risk`. Admin cohort view + patient-app escalated reminders.

---

## How to resume in a new Claude session

```
cat docs/ROADMAP.md
```

Pick any unchecked item, reference it by its bullet text in your prompt, and Claude can pick up the thread. Unchecked items are ordered by priority within each phase.

## Related files

- Audit source: plan `/root/.claude/plans/calm-kindling-wirth.md` (session `01AVRjDoo6auYpyWaMEiEgZZ`).
- Core conventions: [CLAUDE.md](../CLAUDE.md) — security checklist, response envelope, route structure.
