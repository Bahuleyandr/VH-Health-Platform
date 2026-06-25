# OpenAPI Phase 5 — Appointments Typed Payloads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Type the request + response payloads for the whole `/api/v1/appointments/*` surface in the canonical OpenAPI spec via a new `appointments.mjs` overlay reusing the money-slice machinery, gated by a generalized static contract test + live `assertResponse` woven into deep tests.

**Architecture:** A per-subsystem overlay module (`apps/backend/scripts/openapi/schemas/appointments.mjs`) exports `{ schemas, operations }`; `generate-openapi.mjs` merges it at generate time and `buildOperation` attaches the typed requestBody/200. Schemas are authored from the EXACT service returns (the live contract test is the proof — never guess a shape or an enum). A generalized static gate (`openapiContracts.test.js`) iterates every `SCHEMA_MODULES` entry, replacing the money-only gate.

**Tech Stack:** Node 22, OpenAPI 3.0.3, ajv + ajv-formats, jest (`node --experimental-vm-modules ... --runInBand`), supertest, Prisma/Postgres (QA cluster).

**Spec:** `docs/superpowers/specs/2026-06-25-openapi-phase5-appointments-typed-payloads-design.md`.

---

## Conventions (apply throughout)

- **Backend dir:** all paths below are under `D:/Dev/Projects/VH Health/VH-Health-Platform`. npm/jest run from `apps/backend`.
- **Regenerate after any overlay edit:** `npm --prefix apps/backend run openapi:generate` then `npm --prefix apps/backend run openapi:sync-core` (keeps `packages/vhhealth_core/swagger/openapi.json` byte-identical).
- **Static gate:** `node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/openapiContracts.test.js --forceExit` (from `apps/backend`).
- **Deep tests:** require the QA cluster — `node apps/backend/scripts/qa-cluster-up.mjs` once, then `node --experimental-vm-modules node_modules/jest/bin/jest.js <file> --forceExit` from `apps/backend`. They run as `postgres`/`qa_writer`@`127.0.0.1:55432/vhhealth_test`.
- **`assertResponse(method, path, body)`** (from `src/tests/helpers/assertSchema.js`): pass the FULL `res.body` (the envelope), and the OpenAPI **path template** (`/api/v1/appointments/{id}/status`, not the concrete id). It throws with ajv errors on mismatch. It reads the committed `src/docs/openapi.json` at import — so **regenerate the spec before running deep tests** or it validates against a stale spec.
- **Type rules (from the money slice):** scalar/enum/datetime as-is; computed analytics numbers → `number`; any `*_minor` paise → `integer`; any Prisma `Decimal` → JSON `string` (appointments are expected to carry none — verify). Author `additionalProperties:false` from the EXACT return; use `additionalProperties:true` ONLY for genuinely-freeform/conditional blobs and add a `// LOOSE:` comment saying why (no silent escape hatch).
- **Enums are real:** appointment `status` ∈ `SCHEDULED|CONFIRMED|IN_PROGRESS|COMPLETED|RESCHEDULED|CANCELLED|NO_SHOW` (`src/config/appointmentConfig.js:3-11`); `visit_type` ∈ `NEW|FOLLOW_UP|EMERGENCY|TELE|LAB_ONLY|PAEDIATRIC_OPD` + null (`src/services/appointment/appointmentService.js:86-93`). Verify any other enum against its service before constraining.
- **Sequential authoring:** `appointments.mjs` is one shared file — do tasks T1→T6 in order; within a task, author group-by-group. If running subagents, never two writing `appointments.mjs` at once.

---

## File Structure

**Create:**
- `apps/backend/scripts/openapi/schemas/appointments.mjs` — the appointments overlay (`schemas` + `operations`). Grows across T2–T5.
- `apps/backend/src/tests/unit/openapiContracts.test.js` — generalized static gate iterating `SCHEMA_MODULES`.
- `apps/backend/src/tests/appointment-analytics-contract.deep.test.js` — live contract test for admin/analytics endpoints (T4).

**Modify:**
- `apps/backend/scripts/generate-openapi.mjs:12,14` — import + register `appointments` in `SCHEMA_MODULES`.
- `apps/backend/src/tests/appointment-deep.test.js` — weave `assertResponse(...)` after the core-domain requests (T2/T3).
- `apps/backend/src/docs/openapi.json` + `packages/vhhealth_core/swagger/openapi.json` — regenerated (never hand-edited).

**Delete:**
- `apps/backend/src/tests/unit/openapiMoneyContracts.test.js` — superseded by the generalized `openapiContracts.test.js` (T1).

---

## Task 1: Overlay scaffold + register + generalized static gate (inert)

**Files:**
- Create: `apps/backend/scripts/openapi/schemas/appointments.mjs`
- Modify: `apps/backend/scripts/generate-openapi.mjs:12,14`
- Create: `apps/backend/src/tests/unit/openapiContracts.test.js`
- Delete: `apps/backend/src/tests/unit/openapiMoneyContracts.test.js`

- [ ] **Step 1: Create the empty overlay module**

`apps/backend/scripts/openapi/schemas/appointments.mjs`:
```javascript
// OpenAPI Phase 5 — Appointments overlay. Typed request/response schemas for the
// /api/v1/appointments/* surface. Authored from EXACT service returns (the live
// contract test is the proof). Grows across T2–T5. See the design spec.
import { envelope, listEnvelope, paginatedEnvelope } from './_helpers.mjs';

export const schemas = {};

export const operations = {};
```

- [ ] **Step 2: Register the module in the generator**

In `apps/backend/scripts/generate-openapi.mjs`, add the import next to the money import (line ~12) and add to `SCHEMA_MODULES` (line 14):
```javascript
import * as money from './openapi/schemas/money.mjs';
import * as appointments from './openapi/schemas/appointments.mjs';
// ...
const SCHEMA_MODULES = [money, appointments];
```

- [ ] **Step 3: Regenerate + confirm no change yet (empty overlay is inert)**

Run:
```bash
npm --prefix apps/backend run openapi:generate && npm --prefix apps/backend run openapi:sync-core
git diff --stat apps/backend/src/docs/openapi.json
```
Expected: no diff to `openapi.json` (empty `schemas`/`operations` add nothing). If the merge throws "duplicate schema name", a name collides with money — rename it in T2+.

- [ ] **Step 4: Write the generalized static gate**

Create `apps/backend/src/tests/unit/openapiContracts.test.js` (replaces the money-only gate; iterates every overlay so future slices are auto-covered):
```javascript
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as money from '../../../scripts/openapi/schemas/money.mjs';
import * as appointments from '../../../scripts/openapi/schemas/appointments.mjs';
import { ajvReadySpec } from '../helpers/openapiToAjv.js';

// Mirror the generator's SCHEMA_MODULES so the gate covers every overlay.
const MODULES = [money, appointments];

const __dirname = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(resolve(__dirname, '../../docs/openapi.json'), 'utf8'));

const allOperations = Object.assign({}, ...MODULES.map((m) => m.operations || {}));

describe('OpenAPI contract overlays (static gate)', () => {
  it('every overlay key matches a real (METHOD, path) in the generated spec', () => {
    const real = new Set();
    for (const [p, ops] of Object.entries(spec.paths)) {
      for (const m of Object.keys(ops)) real.add(`${m.toUpperCase()} ${p}`);
    }
    const missing = Object.keys(allOperations).filter((k) => !real.has(k));
    expect(missing).toEqual([]);
  });

  it('every overlay request/response schema exists in components.schemas', () => {
    const names = new Set(Object.keys(spec.components.schemas));
    const refs = [];
    for (const ov of Object.values(allOperations)) {
      if (ov.request) refs.push(ov.request);
      if (ov.response) refs.push(ov.response);
    }
    const dangling = refs.filter((n) => !names.has(n));
    expect(dangling).toEqual([]);
  });

  it('every components.schemas entry compiles under ajv (valid + resolvable $refs)', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema(ajvReadySpec(spec), 'openapi.json');
    for (const name of Object.keys(spec.components.schemas)) {
      expect(ajv.getSchema(`openapi.json#/components/schemas/${name}`)).toBeTruthy();
    }
  });
});
```

- [ ] **Step 5: Delete the superseded money-only gate**

```bash
git rm apps/backend/src/tests/unit/openapiMoneyContracts.test.js
```

- [ ] **Step 6: Run the generalized gate — must pass (money still covered, appointments empty)**

Run:
```bash
cd apps/backend && node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/openapiContracts.test.js --forceExit
```
Expected: 3 passing assertions (money operations still validate; appointments contributes nothing yet).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/scripts/openapi/schemas/appointments.mjs apps/backend/scripts/generate-openapi.mjs apps/backend/src/tests/unit/openapiContracts.test.js apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json
git rm apps/backend/src/tests/unit/openapiMoneyContracts.test.js
git commit -m "feat(openapi): appointments overlay scaffold + generalized static contract gate"
```

---

## Task 2: Core domain — Appointment object, book/status/cancel/reschedule/confirm/no-show/complete

**Endpoints (exact, from `src/routes/appointment/*`):**
`POST /api/v1/appointments/book` · `GET /api/v1/appointments/{id}` · `PUT /api/v1/appointments/{id}` · `DELETE /api/v1/appointments/{id}` · `PUT /api/v1/appointments/{id}/status` · `POST /api/v1/appointments/{id}/cancel` · `POST /api/v1/appointments/{id}/reschedule` · `POST /api/v1/appointments/{id}/confirm` · `POST /api/v1/appointments/{id}/no-show` · `POST /api/v1/appointments/{id}/complete`

**Files:**
- Modify: `apps/backend/scripts/openapi/schemas/appointments.mjs`
- Modify: `apps/backend/src/tests/appointment-deep.test.js` (weave `assertResponse`)

**Shape source (author from these — verify against the live return, do not trust paraphrase):** the `Appointment` core object = `src/services/appointment/appointmentService.js` status `RETURNING` (lines ~373-386) + the Prisma `appointments` model. `POST /book` returns a WRAPPER: `data: { appointment: Appointment, patient: {id,uid,name,phone,created}, doctor_name, booked_by }` (`controllers/appointment/appointmentCrudController.js:189-200`). `GET /{id}` returns the appointment fields directly in `data` plus conditional nested `patient`/`doctor`/`follow_up_context`/`pregnancy_context`/`allergies` (`appointmentQueryService.js:18-296`).

- [ ] **Step 1: Author the shared `Appointment` schema + core response/request schemas**

In `appointments.mjs`, set `schemas` to (this is the anchor object reused by every core endpoint; fields/enums are from the real service — confirm with an Explore read before finalizing nullable/required):
```javascript
export const schemas = {
  Appointment: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'uid', 'status', 'appointment_date', 'appointment_time', 'created_at', 'updated_at'],
    properties: {
      id: { type: 'integer' },
      uid: { type: 'string', format: 'uuid' },
      phone: { type: 'string', nullable: true },
      patient_id: { type: 'integer', nullable: true },
      doctor_id: { type: 'integer', nullable: true },
      patient_name: { type: 'string', nullable: true },
      doctor_name: { type: 'string', nullable: true },
      appointment_date: { type: 'string' }, // date (yyyy-mm-dd or ISO; keep string, do not over-constrain format)
      appointment_time: { type: 'string' }, // "HH:MM" or "walk-in"
      reason: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      status: { type: 'string', enum: ['SCHEDULED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'RESCHEDULED', 'CANCELLED', 'NO_SHOW'] },
      visit_type: { type: 'string', enum: ['NEW', 'FOLLOW_UP', 'EMERGENCY', 'TELE', 'LAB_ONLY', 'PAEDIATRIC_OPD'], nullable: true },
      department: { type: 'string', nullable: true },
      token_number: { type: 'string', nullable: true },
      queue_id: { type: 'integer', nullable: true },
      confirmed_at: { type: 'string', format: 'date-time', nullable: true },
      triage_acuity: { type: 'integer', nullable: true },
      visit_no: { type: 'string', nullable: true },
      parent_appointment_id: { type: 'integer', nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      // appointment_queue is hydrated conditionally + has its own shape — keep loose here,
      // typed strictly in T3 if a dedicated AppointmentQueue schema is added.
      appointment_queue: { type: 'object', additionalProperties: true, nullable: true }, // LOOSE: conditional hydration
    },
  },
  AppointmentResponse: envelope('Appointment'),

  // POST /book wrapper (data is NOT a bare Appointment)
  BookAppointmentRequest: {
    type: 'object',
    additionalProperties: true, // LOOSE: booking accepts many optional intake fields; tighten later if needed
    required: ['appointment_date', 'appointment_time'],
    properties: {
      patient_uid: { type: 'string', nullable: true },
      phone: { type: 'string', nullable: true },
      patient_name: { type: 'string', nullable: true },
      doctor_id: { type: 'integer', nullable: true },
      appointment_date: { type: 'string' },
      appointment_time: { type: 'string' },
      reason: { type: 'string', nullable: true },
      visit_type: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
    },
  },
  BookAppointmentResult: {
    type: 'object',
    additionalProperties: false,
    required: ['appointment'],
    properties: {
      appointment: { $ref: '#/components/schemas/Appointment' },
      patient: {
        type: 'object', additionalProperties: true,
        properties: { id: { type: 'integer' }, uid: { type: 'string' }, name: { type: 'string', nullable: true }, phone: { type: 'string' }, created: { type: 'boolean' } },
      },
      doctor_name: { type: 'string', nullable: true },
      booked_by: { type: 'string', nullable: true },
    },
  },
  BookAppointmentResponse: envelope('BookAppointmentResult'),

  // Request bodies for the workflow actions
  RescheduleAppointmentRequest: {
    type: 'object', additionalProperties: true,
    properties: { appointment_date: { type: 'string' }, appointment_time: { type: 'string' }, reason: { type: 'string', nullable: true } },
  },
  CancelAppointmentRequest: {
    type: 'object', additionalProperties: true,
    properties: { reason: { type: 'string', nullable: true } },
  },
  UpdateAppointmentStatusRequest: {
    type: 'object', additionalProperties: true, required: ['status'],
    properties: { status: { type: 'string', enum: ['SCHEDULED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'RESCHEDULED', 'CANCELLED', 'NO_SHOW'] }, notes: { type: 'string', nullable: true } },
  },
};
```
> Note on `GET /{id}`: its `data` is the appointment plus deeply-nested CONDITIONAL context (`follow_up_context`, `pregnancy_context`, `allergies[]`, `patient`, `doctor`). Author a separate `AppointmentDetail` schema = the `Appointment` properties **plus** those optional context keys, each `additionalProperties:true` / `nullable:true` (LOOSE — they are conditional and large). Add `AppointmentDetail` + `AppointmentDetailResponse = envelope('AppointmentDetail')` here, authored from `appointmentQueryService.js:18-296`.

- [ ] **Step 2: Wire the core operations**

Set `operations` in `appointments.mjs`:
```javascript
export const operations = {
  'POST /api/v1/appointments/book': { request: 'BookAppointmentRequest', response: 'BookAppointmentResponse' },
  'GET /api/v1/appointments/{id}': { response: 'AppointmentDetailResponse' },
  'PUT /api/v1/appointments/{id}': { response: 'AppointmentResponse' },
  'PUT /api/v1/appointments/{id}/status': { request: 'UpdateAppointmentStatusRequest', response: 'AppointmentResponse' },
  'POST /api/v1/appointments/{id}/cancel': { request: 'CancelAppointmentRequest', response: 'AppointmentResponse' },
  'POST /api/v1/appointments/{id}/reschedule': { request: 'RescheduleAppointmentRequest', response: 'AppointmentResponse' },
  'POST /api/v1/appointments/{id}/confirm': { response: 'AppointmentResponse' },
  'POST /api/v1/appointments/{id}/no-show': { response: 'AppointmentResponse' },
  'POST /api/v1/appointments/{id}/complete': { response: 'AppointmentResponse' },
  // DELETE /{id} returns a generic success (no body shape) — leave untyped (generic Success).
};
```
> Verify each path string exists verbatim in `src/docs/openapi.json` (`GET /api/v1/appointments/{id}` etc.). The static gate (T1) fails loudly on a typo.

- [ ] **Step 3: Regenerate + run the static gate**

```bash
npm --prefix apps/backend run openapi:generate && npm --prefix apps/backend run openapi:sync-core
cd apps/backend && node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/openapiContracts.test.js --forceExit
```
Expected: green (all appointment schemas compile + map to real paths). Fix any "missing path" / "dangling ref" / ajv-compile error before moving on.

- [ ] **Step 4: Weave live `assertResponse` into `appointment-deep.test.js`**

In `apps/backend/src/tests/appointment-deep.test.js`, add the import at top:
```javascript
import { assertResponse } from './helpers/assertSchema.js';
```
After each existing core-endpoint request, add an `assertResponse` with the OpenAPI path template + full `res.body`. Example (book, then status) — match the test's existing variable names:
```javascript
// after the book POST that returns res with res.body.data.appointment
expect([200, 201]).toContain(res.statusCode);
assertResponse('POST', '/api/v1/appointments/book', res.body);

// after a status PUT
expect(statusRes.statusCode).toBe(200);
assertResponse('PUT', '/api/v1/appointments/{id}/status', statusRes.body);
```
Add one `assertResponse` per core endpoint the suite already exercises (book, status, reschedule, cancel/confirm/no-show/complete, GET /{id}). Do NOT add new endpoints to this suite — just assert the ones it already hits. (The double-booking suite is DB-layer only — no HTTP — leave it untouched.)

- [ ] **Step 5: Run the appointment deep test — must pass against the regenerated spec**

```bash
node apps/backend/scripts/qa-cluster-up.mjs
cd apps/backend && node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/appointment-deep.test.js --forceExit
```
Expected: PASS. If `assertResponse` throws, the schema doesn't match the real return — **fix the schema to the real shape** (add a missing field, relax a wrongly-required one, widen an enum), regenerate, re-run. This iterate-to-green is the whole point; the live return is the source of truth.

- [ ] **Step 6: Commit**

```bash
npm --prefix apps/backend run openapi:generate && npm --prefix apps/backend run openapi:sync-core
git add apps/backend/scripts/openapi/schemas/appointments.mjs apps/backend/src/tests/appointment-deep.test.js apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json
git commit -m "feat(openapi): type appointments core domain (book/status/lifecycle) + live contract assertions"
```

---

## Task 3: Queue, availability, list-variants, wait-time, workflow

**Endpoints:** `GET /api/v1/appointments/list` · `GET /api/v1/appointments` · `GET /api/v1/appointments/today/list` · `GET /api/v1/appointments/doctor/{doctor_id}` · `GET /api/v1/appointments/patient/{patient_id}` · `GET /api/v1/appointments/queue/today` · `GET /api/v1/appointments/queue/today/mine` · `GET /api/v1/appointments/slots` · `GET /api/v1/appointments/doctors/options` · `GET /api/v1/appointments/pending` · `POST /api/v1/appointments/walk-in` · `GET /api/v1/appointments/completed/recent` · `GET /api/v1/appointments/doctor/{doctorId}/wait-time` · `GET /api/v1/appointments/{id}/wait-time` · `POST /api/v1/appointments/{id}/advise-admission` · `GET /api/v1/appointments/{id}/history`

**Files:** Modify `apps/backend/scripts/openapi/schemas/appointments.mjs`; weave a few `assertResponse` into `appointment-deep.test.js` for the list/queue endpoints it already hits.

- [ ] **Step 1: Author the list + queue + slot schemas (from real returns)**

Add to `schemas`. Key real shapes (verify via `appointmentQueryService.js` + `appointmentQueueService.js:31-45` + the workflow controller):
- **List shape is `data:{items:[...]}` + `meta.pagination`**, NOT `data:array`. So use `paginatedEnvelope('Appointment')` for `/list`, `/`, `/today/list`, `/doctor/{doctor_id}`, `/patient/{patient_id}` (they return `{ items }` + `meta.pagination`). Reuse `Appointment` as the item.
- **Queue:** add `AppointmentQueue` (`{ id, queue_id, queue_date, queue_kind: enum[doctor,department,emergency,walk_in,op], queue_label, status: enum[draft,open,paused,closed], department_id?, department_name?, doctor_id?, doctor_uid? }`) and `TodayQueueResult = { queues: [ { ...AppointmentQueue, appointments: [QueueAppointment], appointment_count, completed_count, pending_count } ], timestamp }`; `TodayQueueResponse = envelope('TodayQueueResult')`. `QueueAppointment` = a slim appointment (`id, uid, token_number, patient_name, phone, appointment_time, status, triage_acuity?, department?, reason?`).
- **Slots / doctors-options:** author from `getAvailableSlots`/`getDoctorOptions` returns; these are list-ish — use `listEnvelope` of a `Slot` / `DoctorOption` schema (extract real fields).
- **wait-time / history / advise-admission:** small objects — extract real returns; `advise-admission` likely returns an `AppointmentResponse` (the updated appointment) — reuse it if so.
> Where a nested or conditional sub-object is large/variable, `additionalProperties:true` + `// LOOSE:` comment. Author strict where the return is stable.

- [ ] **Step 2: Wire the operations** for every endpoint above in `operations` (response schema each; `walk-in`/`advise-admission` get a request schema if they take a body). Use the exact path templates.

- [ ] **Step 3: Regenerate + static gate green**
```bash
npm --prefix apps/backend run openapi:generate && npm --prefix apps/backend run openapi:sync-core
cd apps/backend && node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/openapiContracts.test.js --forceExit
```

- [ ] **Step 4: Live-assert the list/queue endpoints the deep test already hits** (add `assertResponse('GET','/api/v1/appointments/list', res.body)` etc. after the relevant requests in `appointment-deep.test.js`). Run the suite; iterate the schema to green.
```bash
cd apps/backend && node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/appointment-deep.test.js --forceExit
```

- [ ] **Step 5: Commit**
```bash
git add apps/backend/scripts/openapi/schemas/appointments.mjs apps/backend/src/tests/appointment-deep.test.js apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json
git commit -m "feat(openapi): type appointments queue/availability/list/wait-time payloads"
```

---

## Task 4: Admin analytics & operations (computed shapes) + new analytics contract deep test

**Endpoints:** `GET /api/v1/appointments/admin/analytics` · `GET /api/v1/appointments/admin/search` · `GET /api/v1/appointments/admin/conflicts` · `GET /api/v1/appointments/admin/no-shows` · `GET /api/v1/appointments/admin/export` · `GET /api/v1/appointments/admin/capacity` · `POST /api/v1/appointments/admin/bulk-update-status` · `GET /api/v1/appointments/admin/sla-dashboard` · `GET /api/v1/appointments/admin/audit-trail` (+ `bulk-delete`, `override-book`, `resolve-conflict`, `send-reminders`, `documents` — type response-only; `admin/test` → leave generic).

**Shape source (computed — author from the inline route handlers):** analytics = `appointmentAdminRoutes.js:26-128`; capacity = `:445-505`; bulk-update = `:510-549`; etc. **Computed counters/rates → `number`** (e.g. `completion_rate`, `no_show_rate`, `utilization_percentage`). `export` returns JSON or CSV depending on `?format` — for the JSON path type the array; the CSV path returns `text/csv` (not JSON) → its 200 has no JSON schema, leave it generic (note it).

**Files:** Modify `appointments.mjs`; Create `apps/backend/src/tests/appointment-analytics-contract.deep.test.js`.

- [ ] **Step 1: Author analytics schemas** — `AppointmentAnalytics` (`{ timeframe: enum[7d,30d,90d,1y], overall: {total_appointments,scheduled,completed,cancelled,no_shows,completion_rate:number,no_show_rate:number,unique_patients,active_doctors}, trends: [{date,total,completed,cancelled}], departmentBreakdown: [{department,appointments,completed,avg_wait_time_minutes}], peakHours: [{hour,appointments,avg_duration}], generatedAt, requestedBy }`), `AppointmentCapacity`, `BulkUpdateStatusResult`, `AppointmentSearchResult` (paginated), `ConflictsResult`, `NoShowsResult`, `SlaDashboardResult`, `AuditTrailResult` — each from its handler. Wrap with `envelope(...)`/`paginatedEnvelope(...)` per the real shape. Add the matching `*Response` schemas.

- [ ] **Step 2: Wire the admin operations** in `operations` (response each; `bulk-update-status` + `override-book` + `resolve-conflict` + `send-reminders` get request schemas). Exact path templates.

- [ ] **Step 3: Regenerate + static gate green** (same commands as Task 3 Step 3).

- [ ] **Step 4: Write the analytics contract deep test**

Create `apps/backend/src/tests/appointment-analytics-contract.deep.test.js` (mirror `billing-v2-invoice-contract.deep.test.js` + the fixture pattern from `appointment-deep.test.js:12-21,72-121`). It seeds a patient + doctor + admin (raw SQL), books/seeds a couple of appointments so analytics have data, then for each admin endpoint: request → `expect(200)` → `assertResponse('GET','/api/v1/appointments/admin/analytics', res.body)` etc. Use `generateTestToken('ADMIN', {...})` for auth. Skeleton:
```javascript
import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { assertResponse } from './helpers/assertSchema.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const ADMIN_UID = 'a8888888-8888-4888-8888-888888888a04';
function admin() {
  const t = generateTestToken('ADMIN', { uid: ADMIN_UID, id: 1 });
  return (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`);
}

describe('appointment analytics contract', () => {
  beforeAll(async () => { /* seed admin + a doctor + 2 appointments via prisma.$queryRawUnsafe, like appointment-deep.test.js */ });
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it('admin analytics matches the spec', async () => {
    const res = await admin()('/api/v1/appointments/admin/analytics?timeframe=30d');
    expect(res.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/appointments/admin/analytics', res.body);
  });
  // + capacity, no-shows, conflicts, sla-dashboard, audit-trail, search
});
```

- [ ] **Step 5: Run it; iterate schemas to green**
```bash
cd apps/backend && node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/appointment-analytics-contract.deep.test.js --forceExit
```
Expected: PASS. Fix schema↔return mismatches (computed-number types, optional keys) until green.

- [ ] **Step 6: Commit**
```bash
git add apps/backend/scripts/openapi/schemas/appointments.mjs apps/backend/src/tests/appointment-analytics-contract.deep.test.js apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json
git commit -m "feat(openapi): type appointments admin analytics/ops + analytics contract deep test"
```

---

## Task 5: Document/records sub-domain under /appointments (bounded, looser typing)

**Endpoints:** `/api/v1/appointments/patient/records/all` · `/patient/records/upload` · `/patient/records/{id}` (GET, DELETE) · `/patient/records/{id}/extraction` (+ `/process`, `/extraction-review`) · `/documents/upload` · `/api/v1/appointments/{appointment_id}/documents`.

**Rationale (recorded — not a silent skip):** these are a **document-management / PHI-upload sub-domain** (multipart upload, R2 storage, AI-extraction jsonb), not the appointment domain — mounted under `/appointments/*` for historical routing. They belong with a future "documents/records" slice. This round types their **response envelopes** at the structural level so none is left fully generic, but leaves genuinely-freeform `data` (multipart upload results, AI-extraction blobs) as `additionalProperties:true` with a `// LOOSE:` note.

**Files:** Modify `appointments.mjs`.

- [ ] **Step 1: Author lightweight document schemas** — `PatientRecord` (extract the stable fields: `id, patient_id?, file_name?, file_type?, uploaded_at?, ...` from `docController`), `PatientRecordsListResponse = listEnvelope('PatientRecord')`, `RecordExtractionResult` (`additionalProperties:true` — AI/jsonb, LOOSE), `AppointmentDocumentsResult`. Strict where the return is stable; LOOSE (+ comment) for upload/extraction payloads. Do NOT type the multipart REQUEST bodies (file uploads aren't JSON) — response-only here.

- [ ] **Step 2: Wire response-only operations** for these paths in `operations`. For `upload`/`extraction/process` whose responses are freeform, point them at the LOOSE result schema (so the envelope is still validated). Skip request bodies (multipart).

- [ ] **Step 3: Regenerate + static gate green.**

- [ ] **Step 4: Live-assert what's reachable** — if `appointment-deep.test.js` or another suite already hits `GET /patient/records/all` or `GET /{appointment_id}/documents`, weave `assertResponse` there. Do NOT build new multipart-upload test fixtures this round (out of scope; note it). Run any touched suite to green.

- [ ] **Step 5: Commit**
```bash
git add apps/backend/scripts/openapi/schemas/appointments.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json
git commit -m "feat(openapi): type appointment document/records envelopes (bounded; freeform payloads LOOSE)"
```

---

## Task 6: Closeout

- [ ] **Step 1: Full backend gate**

Run from `apps/backend`:
```bash
npm run lint
npm run openapi:check        # drift 0 (committed spec == regenerated)
npm run openapi:check-core   # core byte-sync 0
node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/openapiContracts.test.js src/tests/appointment-deep.test.js src/tests/appointment-double-booking.deep.test.js src/tests/appointment-analytics-contract.deep.test.js --forceExit
npx --yes @stoplight/spectral-cli lint src/docs/openapi.json --ruleset .spectral.yaml 2>&1 | tail -3   # 0 errors (use the repo's spectral script if different — check package.json openapi:* / lint scripts)
```
Expected: lint clean; drift 0; core-sync 0; all contract + appointment suites green; spectral 0 errors. (If the repo wires spectral via an npm script, use that — confirm the exact `openapi:*` script names in `apps/backend/package.json`.)

- [ ] **Step 2: Coverage check — every `/appointments/*` op has a typed 200 (or a recorded reason)**

Run a quick audit: list spec paths under `/api/v1/appointments` whose 200 schema is still `#/components/schemas/Success` (generic) and confirm each is intentional (DELETE/{id}, admin/test, CSV export path, multipart uploads). Record the intentional-generic list in the commit/closeout note — no silent gaps.
```bash
node -e "const s=require('./apps/backend/src/docs/openapi.json');for(const[p,ops]of Object.entries(s.paths)){if(!p.startsWith('/api/v1/appointments'))continue;for(const[m,o]of Object.entries(ops)){const r=o.responses?.['200']?.content?.['application/json']?.schema?.['\$ref']||'';if(r.endsWith('/Success'))console.log(m.toUpperCase(),p)}}"
```

- [ ] **Step 3: Conditional admin-client adoption**

Check whether the admin portal has an appointments API client with hand-written response types (`apps/admin/src/lib/api/appointment*.ts` or similar). If one exists, convert its response types to spec-derived `ApiData<...>` (mirror the money slice's `ledgerReports.ts`/`billing.ts` adoption + `openapi-data.ts`), run admin `tsc` + jest + build. If none exists, skip (note it). Do NOT migrate Flutter call sites (out of scope — Phase 4 kept the generated Dart client unconsumed).

- [ ] **Step 4: Finish the branch**

Merge `--no-ff` → main, push `github`; push `origin` (Forgejo). Delete the branch.
```bash
git checkout main && git merge --no-ff <branch> -m "Merge: OpenAPI Phase 5 — Appointments typed payloads"
git push github main && (git push origin main || echo "Forgejo pending — push origin main when reachable")
git branch -d <branch>
```

- [ ] **Step 5: ROADMAP + memory**

- In `docs/ROADMAP.md` §0 T2 #5, add an Appointments-slice DONE entry (cite the merge SHA): whole `/appointments/*` surface typed via `appointments.mjs`, generalized static gate, live contract assertions; note any intentional-generic endpoints + that the document/records sub-domain got bounded/loose typing. Update "Remaining" (other non-money slices).
- Update memory `project_vh_health_openapi_pipeline.md` + its `MEMORY.md` index line: Appointments slice done, the generalized `openapiContracts.test.js` gate, the per-endpoint wrapper/list/computed-shape gotchas, the document sub-domain boundary.
- Commit the ROADMAP change on main; push both remotes.

---

## Self-Review

- **Spec coverage:** overlay module (T1) ✓; generalize static gate (T1) ✓; core domain + request bodies (T2) ✓; queue/availability/list (T3) ✓; analytics + new contract deep test (T4) ✓; whole-surface incl. document sub-domain (T5, bounded) ✓; comprehensive contract tests = static gate + live `assertResponse` in the 2 deep tests + new analytics test (T2/T3/T4) ✓; closeout/gate/coverage-audit/admin-adoption/merge/ROADMAP/memory (T6) ✓. Both request + response ✓ (request bodies in T2/T4). No spec requirement unmapped.
- **Placeholder scan:** the per-endpoint exact field lists in T3–T5 are deliberately authored-at-build-time from cited service files (the money-slice recipe — the live contract test is the proof), NOT hand-waving; T1, the gate, the `Appointment` anchor schema, and the book worked example are fully concrete. `// LOOSE:` blobs are explicitly justified, never silent.
- **Consistency:** `Appointment` (T2) is the shared item reused by T2/T3 lists + queue; `envelope`/`listEnvelope`/`paginatedEnvelope` used per the real shape (object=envelope, `data:array`=listEnvelope, `data:{items}+meta`=paginatedEnvelope); `assertResponse(method, pathTemplate, res.body)` signature identical everywhere; the generalized gate's `MODULES` array mirrors the generator's `SCHEMA_MODULES`; enums (`status` 7 / `visit_type` 6) identical in the schema + the status-request body.
- **Ordering safety:** T1 proves the machinery inert; T2 anchors `Appointment` + proves one endpoint live before scaling; T3/T4 extend; T5 bounds the messy sub-domain; T6 gates + audits coverage before merge. `appointments.mjs` edited sequentially (one shared file).
