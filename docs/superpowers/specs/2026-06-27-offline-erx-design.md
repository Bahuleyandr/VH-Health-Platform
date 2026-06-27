# Offline-first e-prescriptions — Design Spec

**Date:** 2026-06-27
**Epic:** ROADMAP §0 Tier-2 Epic #9 (offline-first clinical writes), **slice 3**
**Branch:** `feat/offline-erx`
**Status:** Approved (design), pre-implementation
**Predecessors:** slice 1 (MAR) `2026-06-27-offline-mar-design.md`; slice 2 (drug-chart/CPOE) `2026-06-27-offline-cpoe-design.md`

---

## 1. Goal

Let a doctor compose an e-prescription and queue it while the device is offline; on
reconnect, the server creates it (running its full fail-closed CDS) or surfaces a loud,
clinically-framed conflict. No prescription is silently dropped, and the offline UI never
falsely implies the safety check passed.

Slice 1 proved offline *administration*; slice 2 proved offline *order-creation*; this
slice proves offline *prescription-creation* — the third and last offline clinical-write
screen.

## 2. Grounding (what the 4 scouts established)

- **Write path** (`apps/staff/lib/features/doctor/screens/prescriptions_screen.dart`,
  `_NewEPrescriptionTab._submit` ~lines 851-1008): a standalone outpatient (optional
  inpatient) composer. `_submit` builds the body inline (~lines 918-934) then calls
  `createEPrescription(body, photo)` → `POST /prescriptions/create`. The body is:
  `{ patient_id:int, doctor_id:int, appointment_id?:int, admission_id?:int,
  visit_type?:'outpatient'|'inpatient', diagnosis?, clinical_notes?, medications:[…],
  follow_up_date?, follow_up_notes?, vitals?, override?:{reason} }`. **`medications` is a
  MULTI-ITEM array** of structured objects (drug, strength, dose, frequency, dose_times,
  duration, route, instructions, quantity, refills, prn/nte/daw flags). Online flow:
  pre-flight CDS (`POST /prescriptions/safety-check` → blocker modal) → create → optional
  pharmacy-order → PDF → optional sign. No offline handling today; blocking.

- **Backend dedup** (`apps/backend/src/routes/prescription/index.js:38`):
  `POST /prescriptions/create` has `requireIdempotencyKey({ required: false, scope:
  'prescription_create' })` + `rejectMobileClinicalWrite`. **It is NOT behind a
  `guardClinical*` patient-relationship guard** (unlike `/emr/orders`). `e_prescriptions`
  is unique only on `(tenant_id, prescription_number)` (mig 326; `prescription_number` =
  `RX-`+uuid, collision-resistant but NOT replay-proof). A keyless re-send creates a
  SECOND prescription. Clinical timeline/audit are best-effort post-commit (not in a tx
  with the INSERT). Controller `ePrescriptionController.js` `createPrescription`
  (~859-1328).

- **CDS / controlled-substance / e-sign** (`prescriptionSafetyCheck.js`
  `validatePrescriptionSafety`; `ePrescriptionController.js`):
  - **CDS at create is fail-CLOSED** (a DB exception → `SAFETY_CHECK_ERROR` blocker → 409).
    Blockers → `409 { blockers, warnings, requiresOverride:true }` unless `override.reason`
    (≥5 chars). Warnings non-blocking. The create-time check is identical to the pre-flight
    `/safety-check` (same function).
  - **No controlled-substance / Schedule-X / narcotic gate at create.** Scheduled-drug
    enforcement (witnessed register, Schedule H/H1/X) is entirely pharmacy-dispense-side,
    always online, pharmacist actor. So offline e-Rx is NOT blocked by scheduled-drug logic.
  - **E-signature** (`POST /prescriptions/{id}/sign`) is a plain timestamp UPDATE
    (`signed_at/signed_by/locked_at/lifecycle_status='signed'`) — no DSC/crypto/PIN. It is
    an immutability/audit gate, NOT required before clinical effectiveness or pharmacy
    dispense. It needs the server-assigned id, so it cannot be queued offline.
  - **Status FSM (dual-column):** `status` DEFAULT `'active'` (baseline) +
    `lifecycle_status` DEFAULT `'draft'` (mig 267). Create lands `lifecycle_status='draft'`,
    `status='active'`.
  - **Second 409 source:** appointment-uniqueness — if the appointment already has a
    non-cancelled prescription, create returns `409 "This OP visit already has a
    prescription…"` (different shape: `prescription_id` not `blockers`).

- **Reuse map** (scout D verdict = **NEAR-CLONE**): reusable as-is — `dispositionForStatus`
  ({400,403,409,422}→conflict), `ConnectivitySyncService.enqueue`/`syncPending`,
  `OfflineSyncBadge`/`SyncStatusSheet`, the `ConflictRow` infra, the device-posture block
  logic. Net-new (~120 lines Dart + 1 line JS): a prescription body builder, an offline-Rx
  intent, a `/prescriptions` ConflictRow matcher + copy, the screen's offline branch, and
  the idempotency flip.

## 3. Decisions (from brainstorming)

1. **Approach: mirror CPOE slice 2.** No architectural fork.
2. **Offline CDS posture: queue CDS-unchecked.** The pre-flight CDS is a server call and
   can't run offline; the server runs its full fail-closed CDS at create-on-drain. Safe
   because a prescription that fails CDS on drain is never created (the 409 blocks the
   INSERT) — it surfaces as a conflict the prescriber resolves online (re-submit with an
   override reason if appropriate).
3. **Conflict model: review-only** (matching CPOE) — show the server reason, confirm-on-
   discard, retry. Handles both 409 sources (CDS-blocker and appointment-duplicate) + 403
   + 400 uniformly via `dispositionForStatus`.
4. **Honest offline UI** — offline SKIPS the pre-flight CDS modal and the queued-toast must
   not imply safety ("Prescription queued — will be safety-checked on sync", never "safe"
   / "created").
5. **Scope: text prescriptions only.** The `OfflineQueue` is JSON; a photo-attachment
   prescription stays online-only (rare; noted, not built). E-sign / pharmacy-order / PDF /
   follow-up-booking are post-drain online steps, out of scope. The multi-item array is
   atomic per the server (all-or-nothing) — no per-item handling.
6. **Idempotency flip scoped to `POST /prescriptions/create`** → `required:true`. Safe:
   the staff app auto-mints a stable `Idempotency-Key` via `VHHttpClient` on every POST.
   The backend task verifies blast radius (other callers) + backfills any keyless
   `/prescriptions/create` test, exactly as CPOE-T1 did.

## 4. Architecture

Mirror CPOE: the offline action is exactly one write (`POST /prescriptions/create`). Work
concentrates in a safe enqueue decision (pure, testable) and the loud conflict on drain
(shared `dispositionForStatus` + `ConflictRow` extension). The body is built once by a
shared pure builder so the offline request is byte-identical to the online one.

## 5. Components / files

### 5.1 Backend (1 line + test)

- **Modify** `apps/backend/src/routes/prescription/index.js` — `POST /prescriptions/create`
  → `requireIdempotencyKey({ required: true, scope: 'prescription_create' })`. Leave
  `/prescriptions/:id/order-pharmacy`, `/prescriptions/:id/refill`, `/prescriptions/:id/sign`
  unchanged.
- **Test** (deep, QA cluster): same prescription + same `Idempotency-Key` → exactly one
  `e_prescriptions` row + replayed response; missing key → 400. **No relationship seed
  needed** (the route has no `guardClinical*` guard) — seed a PATIENT + a DOCTOR user under
  the default tenant; mint a `deviceType:'desktop'` doctor token (passes
  `rejectMobileClinicalWrite`). A no-allergy patient → CDS passes → 201. Backfill a
  run-unique key on any existing test that POSTs `/prescriptions/create` keyless.

### 5.2 Shared core (`packages/vhhealth_core`)

- **Modify** `lib/widgets/offline_sync_badge.dart` `ConflictRow`:
  - add `static bool _isPrescriptionConflict(String endpoint) => endpoint.contains('/prescriptions/');`
  - `_handleDiscard`: confirm-on-discard for prescriptions too (title "Discard
    prescription?", content "Discard this prescription? It was NOT recorded on the server.").
  - `build` `reasonWidget`: add a prescription branch — "Prescription not recorded on the
    server — review needed. `<reason>`." MAR + order + generic branches unchanged.

### 5.3 Staff app (`apps/staff`)

- **Create** `lib/core/services/prescription_payloads.dart` (pure, no Flutter imports) —
  `Map<String,dynamic> buildPrescriptionBody({ required int patientId, required int doctorId,
  int? appointmentId, int? admissionId, String visitType='outpatient', String? diagnosis,
  String? clinicalNotes, required List<Map<String,dynamic>> medications, String? followUpDate,
  String? followUpNotes, Map<String,dynamic>? vitals, Map<String,dynamic>? override })`.
  Returns the canonical `/prescriptions/create` body (optionals omitted when null;
  `medications` passed through). **It must reproduce the screen's CURRENT inline body
  exactly** (all fields it sends today, incl. `vitals` and `override`) — the exact field
  set is pinned during plan-writing from `_submit` (~lines 918-934). The online `_submit`
  path is refactored to call this builder too, so the online request is unchanged and the
  offline request is byte-identical by construction.
- **Create** `lib/features/doctor/prescription_offline_rx.dart` (pure) —
  `class OfflineRxIntent { bool block; bool enqueue; String endpoint; Map<String,dynamic> body;
  String? reason; }` and `OfflineRxIntent buildOfflineRxIntent({ required String deviceType,
  required int patientId, required int doctorId, int? appointmentId, int? admissionId,
  String visitType='outpatient', String? diagnosis, String? clinicalNotes,
  required List<Map<String,dynamic>> medications, String? followUpDate, String? followUpNotes,
  Map<String,dynamic>? vitals })`. Passes `vitals` through; **omits `override`** (offline
  composes without a seen blocker — a CDS block surfaces on drain as a conflict).
  **Safety invariant:** `block = deviceType.trim().toLowerCase() == 'mobile' ||
  <trimmed>.isEmpty`; `enqueue = !block` (the only enqueue path). `endpoint =
  '/prescriptions/create'`. `body = buildPrescriptionBody(...)`. `reason` = a user-facing
  block message when blocked, else null.
- **Modify** `lib/features/doctor/screens/prescriptions_screen.dart` `_submit`:
  - online path refactored to build its body via `buildPrescriptionBody(...)` (passing the
    current `vitals`/`override`) — behavior-preserving, guarantees online == offline.
  - if `ConnectivitySyncService.instance.isOnline` is false → **skip the pre-flight CDS
    modal**, build `buildOfflineRxIntent(...)`; `intent.block` → error toast + keep the
    form (no enqueue); else `ConnectivitySyncService.instance.enqueue(endpoint: intent.endpoint,
    method: 'POST', body: intent.body, contextLabel: 'Prescription — <patient/first-drug>')`
    + reset the form + an honest toast ("Prescription queued — will be safety-checked on
    sync"). Do NOT run pharmacy-order / PDF / sign offline. A photo-bearing prescription →
    keep online-only (toast: needs connectivity).
  - online path unchanged.
  - `patient_id` / `doctor_id` are ints already available to the screen.

## 6. Data flow

- **Online:** unchanged — pre-flight CDS modal → blocking create → pharmacy/PDF/sign.
- **Offline:** compose → (skip pre-flight CDS) → `buildOfflineRxIntent` → (phone-mode? block
  & toast) → `enqueue` (encrypted, staff-scoped, stable idempotency key) → "queued — will
  be safety-checked on sync" → on reconnect `syncPending` drains:
  - **2xx** → cleared;
  - **400 / 403 / 409 (CDS-blocker OR appointment-duplicate) / 422** → conflict surfaced in
    the badge with the server reason; clinician Discards (confirmed) or Retries;
  - **408/429/5xx** → transient retry.

No prescription is on the server until the server accepts it post-CDS, which is exactly
why queuing CDS-unchecked is safe.

## 7. Safety invariants

1. **Phone-mode never enqueues** — pure-helper `block` guard + the screen's existing gating.
2. **No prescription silently dropped** — both 409 sources + 403 + 400 → visible conflict
   (`dispositionForStatus`, already shipped).
3. **Re-send can't duplicate** — `required:true` idempotency + the queue's stable key.
4. **Discarding a prescription conflict requires confirmation.**
5. **Honest offline UI** — offline never claims CDS passed; the server's fail-closed CDS is
   authoritative on drain.

## 8. Testing

- **Backend deep test** (QA cluster): idempotency `required:true` — replay → one row;
  missing key → 400. No relationship seed.
- **Dart unit** (`buildPrescriptionBody`): canonical body — `patient_id`/`doctor_id` ints,
  `visit_type`, multi-item `medications` array passes through, `vitals`/`override` included
  when present, null optionals omitted.
- **Dart unit** (`buildOfflineRxIntent`): phone-mode/empty-device → block, no enqueue;
  desktop/tablet → enqueue with `endpoint == '/prescriptions/create'`; body == online builder.
- **Dart widget** (`ConflictRow`): prescription endpoint → clinical copy + confirm-on-
  discard; MAR + order + generic paths unchanged.
- **Regression:** full `vhhealth_core` + `apps/staff` flutter test + analyze; backend
  prescription deep test green.

### Honest boundary

The live **offline → reconnect → drain** round-trip is **manual** (no airplane-mode in CI).
The screen wiring is not widget-tested (the `ConnectivitySyncService` singleton + the
screen's online submit path aren't injectable) — same approach as MAR + CPOE. Deploy stays
**HELD**.

## 9. Out of scope (follow-ons)

- Photo-attachment prescriptions offline (multipart; the queue is JSON-only).
- Offline e-signature (needs the server-assigned id; sign stays online-after-drain).
- Offline pharmacy-order / PDF / follow-up-booking (post-drain online steps).
- A richer conflict schema surfacing `blockers[]` detail (current copy uses the server
  message string — sufficient for review-only).

## 10. Closeout (per standing workflow)

Subagent-driven build on `feat/offline-erx` → full gate → merge `--no-ff` to main → push
**both** remotes (`github` + `origin`) → delete branch → tick ROADMAP §9 (Epic #9 slice 3,
completing the offline clinical-write trilogy) → update the
`project_vh_health_offline_clinical_writes` memory. **Deploy HELD.**
