# OpenAPI Phase 5 — Appointments Typed Payloads — Design

**Status:** Approved design (2026-06-25). Sub-project of the OpenAPI contract-pipeline epic (ROADMAP §0 T2 #5; epic spec `2026-06-24-openapi-contract-pipeline-design.md`). The **money slice** of Phase 5 is done (`main e6f521b1`, ~75 endpoints); this is the **first non-money slice: Appointments**.

## Goal

Type the request + response payloads for the **whole `/api/v1/appointments/*` surface (~50 endpoints)** in the canonical OpenAPI spec (`apps/backend/src/docs/openapi.json`), using the established per-subsystem overlay + two-layer contract gate, so the Flutter (`vhhealth_core`) + admin-TS clients get typed appointment payloads and any spec↔implementation drift fails CI.

## Why appointments first

Of the untyped surface (~2,555 endpoints), appointments is the highest-value, lowest-friction non-money slice: the endpoints return clean scalar/enum/datetime domain objects (no Prisma `Decimal` money, no freeform LLM blobs), the subsystem is heavily consumed by the patient + staff apps (booking/queue), and two deep-test suites already exist to carry live contract assertions:
- `apps/backend/src/tests/appointment-deep.test.js`
- `apps/backend/src/tests/appointment-double-booking-deep.test.js`

Clinical-AI (the ROADMAP's "~193 types") is actually ~335 mostly-jsonb governance/workflow-state endpoints with freeform AI text — lowest value, deferred to a later round.

## Scope (decided)

- **Whole `/appointments/*` surface (~50 endpoints), incl. analytics aggregates** (no-show rate / avg-wait / busiest-hour / volume counters).
- **Both request and response bodies.**
- **Comprehensive contract tests** — static ajv gate + live `assertResponse` woven into the two existing deep tests, plus a new `appointment-analytics-contract.deep.test.js` for endpoints those don't reach, so **every typed response gets ≥1 live assertion**.
- **Out of scope:** the other non-money slices (discharge / payroll / investigations / EMR / clinical-AI — later rounds, each its own spec→plan→build). Admin-client `ApiData` adoption only **if** an admin appointments client exists (conditional in T5; otherwise skipped).

## Machinery (already exists from the money slice — reused, not rebuilt)

- **Overlay modules** `apps/backend/scripts/openapi/schemas/<sub>.mjs` export `{ schemas, operations: { '<METHOD> <path>': { request?, response? } } }`; `apps/backend/scripts/generate-openapi.mjs` merges every entry in its `SCHEMA_MODULES` array at generate time (sorted, dup-guarded); `buildOperation` attaches the typed requestBody/200 (else a generic `Success`). So far only `money.mjs` is registered.
- **Helpers** `apps/backend/scripts/openapi/schemas/_helpers.mjs`: `envelope(payload)` (no `additionalProperties:false` → tolerates envelope `requestId`/`meta`), `listEnvelope(item)` (`data:array` + freeform `meta`), `countListEnvelope(key,item)`, `paginatedEnvelope`.
- **Live assert helpers** `apps/backend/src/tests/helpers/assertSchema.js` (`assertData(name,obj)` / `assertResponse(method,path,body)`) + `openapiToAjv.js` (`ajvReadySpec()` rewrites `nullable:true` → type-union/anyOf so ajv accepts the OpenAPI-3.0.3 spec).
- **Static gate** currently `apps/backend/src/tests/unit/openapiMoneyContracts.test.js` (money-specific).

## Design

### 1. New overlay module
`apps/backend/scripts/openapi/schemas/appointments.mjs`, added to `SCHEMA_MODULES` in `generate-openapi.mjs`. No new merge/build machinery.

### 2. Generalize the static gate (DRY improvement)
Refactor the money-specific `openapiMoneyContracts.test.js` into an **overlay-agnostic** `apps/backend/src/tests/unit/openapiContracts.test.js` that imports `SCHEMA_MODULES` and, for **every** registered overlay, asserts: (a) every schema ajv-compiles under `ajvReadySpec()`, (b) every `operations` key resolves to a real `{method, path}` in the generated spec, (c) no dangling `$ref`s. Money + appointments + every future slice are then covered by one gate (a new slice needs no new static-gate file). The money assertions are preserved (just iterated, not deleted).

### 3. Schema set (the ~50 endpoints, grouped)
- **Core domain:** `Appointment` / `AppointmentDetail`; status-transition results for book / start / complete / cancel / reschedule / no-show; `QueueItem` + queue/position/status views; slot & availability lookups.
- **Request bodies:** `BookAppointmentRequest`, `RescheduleAppointmentRequest`, `CancelAppointmentRequest`, status-update bodies, and any query-ish POST bodies.
- **Analytics aggregates:** no-show rate, average wait time, busiest hour, volume/utilization counters — computed **number** fields.
- Lists use `listEnvelope` (`data:array` + `meta.pagination`); single objects use `envelope`.

### 4. Type rules (carried from money, verified per-field against real service returns)
- Mostly scalar / enum / datetime. **Enums** (`status`, `visit_type`, etc.) are authored from the **actual service**, not guessed — the money lesson was that over-constraining an unverified enum breaks the live contract test; when unsure, use a plain `string`.
- Analytics floats → `number`. Any `*_minor` paise → `integer`. Any Prisma `Decimal` (e.g. a `consultation_fee`, if present) → JSON **string** (verify; appointments are expected to carry none).
- `additionalProperties:false` authored from the exact service return; `additionalProperties:true` **only** where a response key is genuinely conditional, and commented (never a silent escape hatch).
- **Author from EXACT service returns** — dispatch an Explore agent per endpoint-group to extract the real field shapes before authoring; the live contract test is the proof. `appointments.mjs` is a shared file → endpoint-groups are typed **sequentially** (no parallel writers).

### 5. Contract testing
- **Static (generalized gate):** compiles every appointments schema + maps every `operations` key to a real path + no dangling `$ref`s.
- **Live:** weave `assertResponse(method, path, body)` into `appointment-deep.test.js` + `appointment-double-booking-deep.test.js`; add `apps/backend/src/tests/appointment-analytics-contract.deep.test.js` (and any small fixtures) so **every typed `/appointments/*` response is live-asserted at least once** — no "typed but never proven" endpoint. Deep tests run against the QA DB (`postgres@127.0.0.1:55432/vhhealth_test` after `node apps/backend/scripts/qa-cluster-up.mjs`).

### 6. Build decomposition (T1–T5; smaller than money's T1–T9)
- **T1** — `appointments.mjs` scaffold + register in `SCHEMA_MODULES`; generalize the static gate to `openapiContracts.test.js` (covers money + appointments, inert for appointments until schemas land).
- **T2** — core domain objects + request bodies (book/reschedule/cancel/start/complete/no-show), typed + live-asserted in the 2 existing deep tests.
- **T3** — queue / position / availability / slot endpoints.
- **T4** — analytics aggregates + the new analytics contract deep test.
- **T5** — closeout: full backend gate (lint + spectral 0-err + openapi-drift 0 + core-sync 0 + the contract suites), conditional admin-client `ApiData` adoption if an admin appointments client exists, merge `--no-ff` → both remotes, ROADMAP + memory.

## Risks & mitigations
- **Analytics conditional/looser shapes** — type strict where stable; `additionalProperties:true` (commented) only where a key is genuinely conditional. The live test catches a wrong shape immediately.
- **Endpoints with no existing deep-test coverage** — add targeted cases / the analytics contract test so no response is typed-but-unproven.
- **Appointment `status` enum is legacy/large** — extract the real set from the service/state-machine; if uncertain, plain `string` (don't false-trip the gate).
- **`appointments.mjs` is one shared file** — type endpoint-groups sequentially (no parallel agents writing the same file), mirroring the money build.

## Success criteria
- Every `/appointments/*` operation has a typed 200 response (+ a typed request body where it accepts one).
- The generalized static ajv gate is green (money + appointments).
- Every typed response is live-asserted ≥1×; the appointment deep suites + the new analytics contract test pass on the QA DB.
- Backend gates green: lint + spectral 0-err + `openapi:check` (drift 0) + `openapi:check-core` (sync 0) + the contract suites.
- Merged `--no-ff` to both remotes (GitHub + Forgejo); ROADMAP §0 T2 #5 updated + memory. Deploy stays HELD.
