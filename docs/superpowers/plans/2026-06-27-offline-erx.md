# Offline-first e-prescriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a doctor queue a text e-prescription while offline; on reconnect the server creates it (running its fail-closed CDS) or surfaces a loud, review-only conflict — and the offline UI never implies the safety check passed.

**Architecture:** Near-clone of the shipped CPOE offline slice. Reuse `dispositionForStatus`, `ConnectivitySyncService.enqueue`/drain, `OfflineSyncBadge`/`SyncStatusSheet` unchanged. Net-new: a shared prescription body builder, a pure offline-Rx intent (phone-mode never enqueues), a `/prescriptions` `ConflictRow` matcher + copy, and the screen's offline branch. **No backend code change** — offline dedup is already guaranteed by the queue's stable key under the existing `required:false` (a backend regression test locks that in).

**Tech Stack:** Node 22 + Express 5 + Jest/supertest (backend); Flutter 3.41 / Dart 3.11.5 + flutter_test (staff app + `vhhealth_core`).

**Spec:** `docs/superpowers/specs/2026-06-27-offline-erx-design.md`. **Branch:** `feat/offline-erx` (created; spec committed). **Deploy: HELD.**

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `apps/backend/src/tests/prescription-idempotency.deep.test.js` | 1 | NEW — proves keyed-replay → one row under `required:false` (no code change) |
| `apps/staff/lib/core/services/prescription_payloads.dart` | 2 | NEW pure `buildPrescriptionBody` (reproduces the exact online body) |
| `apps/staff/lib/features/doctor/screens/prescriptions_screen.dart` | 2,5 | online `_submit` body → builder (T2); offline branch (T5) |
| `apps/staff/test/core/services/prescription_payloads_test.dart` | 2 | NEW — body builder unit test |
| `apps/staff/lib/features/doctor/prescription_offline_rx.dart` | 3 | NEW pure `buildOfflineRxIntent` (phone-mode never enqueues) |
| `apps/staff/test/features/doctor/prescription_offline_rx_test.dart` | 3 | NEW — intent unit test |
| `packages/vhhealth_core/lib/widgets/offline_sync_badge.dart` | 4 | `ConflictRow`: `/prescriptions` matcher + copy + confirm |
| `packages/vhhealth_core/test/prescription_conflict_ux_test.dart` | 4 | NEW — prescription ConflictRow widget test |

**Dependency order:** Task 2 → Task 3 → Task 5 (3 uses the builder; 5 uses the intent). Tasks 1 and 4 are independent. Run sequentially 1→2→3→4→5.

---

## Task 1: Backend — keyed-replay dedup regression test (NO code change)

**Files:**
- Create: `apps/backend/src/tests/prescription-idempotency.deep.test.js`

**Context:** `POST /prescriptions/create` stays `requireIdempotencyKey({ required: false })` (decision 6 — flipping to `required:true` would 400 the online multipart photo path, and the offline drain is already dedup-safe because the queue always sends a stable key). This test locks in the offline-safety property: a keyed re-send (what a redrain is) replays the cached response and creates exactly one `e_prescriptions` row. The route has NO patient-relationship guard (only `rejectMobileClinicalWrite`), so no admission seed is needed — just seed a PATIENT + DOCTOR user under the default tenant and use a `deviceType:'desktop'` token.

- [ ] **Step 1: Read the controller's INSERT to confirm the count column.** Open `apps/backend/src/controllers/prescription/ePrescriptionController.js` `createPrescription` (~lines 1023-1052) and confirm the `e_prescriptions` column the body's `patient_id` is stored in (expected: `patient_id`) and the success response shape (the created id path). Adjust the test's `rxCount()` column + id accessor below if they differ.

- [ ] **Step 2: Write the deep test.** Create `apps/backend/src/tests/prescription-idempotency.deep.test.js`:

```javascript
// e-Rx prescription-create idempotency (offline-drain dedup, required:false).
//
// POST /prescriptions/create stays required:false. The OFFLINE queue always sends a
// stable Idempotency-Key, and the idempotency middleware dedups any KEYED request
// regardless of the required flag — so a redrain of a lost-2xx cannot create a second
// prescription. Proven here: same key+body twice -> 201 both times, the 2nd is a cached
// REPLAY (identical body), and exactly ONE e_prescriptions row.
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { API_KEY, generateTestToken } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'a7e50003-0001-4a7e-8a7e-a7e500030001';
const DOCTOR_UID = 'a7e50003-0002-4a7e-8a7e-a7e500030002';
let patientId;
let doctorId;

function doctor() {
  const t = generateTestToken('DOCTOR', { uid: DOCTOR_UID, id: 770881, deviceType: 'desktop', tenant_id: TENANT_ID });
  return { post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}
const D = doctor();

function rxBody() {
  return {
    patient_id: patientId,
    doctor_id: doctorId,
    diagnosis: 'Fever',
    clinical_notes: null,
    medications: [{
      name: 'Paracetamol', medication_name: 'Paracetamol', strength: '500mg',
      dosage: '1 tab', frequency: 'BD', route: 'oral', duration: '5 days', days: 5,
      quantity: '10', refills: 0,
    }],
  };
}

async function rxCount() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS n FROM e_prescriptions WHERE patient_id = $1', patientId);
  return Number(rows[0]?.n ?? 0);
}

async function clean() {
  if (patientId) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM prescription_safety_overrides WHERE prescription_id IN (SELECT id FROM e_prescriptions WHERE patient_id = $1)`, patientId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM e_prescriptions WHERE patient_id = $1`, patientId).catch(() => {});
  }
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});
}

d('e-Rx prescription-create idempotency (offline-drain dedup, required:false)', () => {
  beforeAll(async () => {
    await clean();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid,'9330000031','eRx Idem Patient','PATIENT',true,$2::uuid,NOW()) RETURNING id`,
      PATIENT_UID, TENANT_ID);
    patientId = p[0].id;
    const dr = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid,'9330000032','eRx Idem Doctor','DOCTOR',true,$2::uuid,NOW()) RETURNING id`,
      DOCTOR_UID, TENANT_ID);
    doctorId = dr[0].id;
  }, 60000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 60000);
  beforeEach(async () => {
    if (patientId) await prisma.$executeRawUnsafe(`DELETE FROM e_prescriptions WHERE patient_id = $1`, patientId).catch(() => {});
  });

  it('replays the same key+body: 201 twice, identical cached body, exactly one row', async () => {
    // Run-unique key: idempotency_keys rows persist 24h, so a FIXED key would replay a
    // cached response pointing at a since-deleted prescription on a re-run.
    const key = `erx-idem-${Date.now()}`;
    const first = await D.post('/api/v1/prescriptions/create').set('Idempotency-Key', key).send(rxBody());
    expect(first.statusCode).toBe(201);

    const second = await D.post('/api/v1/prescriptions/create').set('Idempotency-Key', key).send(rxBody());
    expect(second.statusCode).toBe(201);
    // The replay returns the ORIGINAL cached response verbatim (same requestId, same id).
    expect(second.body).toEqual(first.body);
    expect(await rxCount()).toBe(1);
  });
});
```

- [ ] **Step 3: Bring up the QA cluster and run the test.**
```bash
node apps/backend/scripts/qa-cluster-up.mjs
cd apps/backend
TEST_DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test \
  node --experimental-vm-modules node_modules/jest/bin/jest.js prescription-idempotency --forceExit
```
Expected: PASS — both 201, `second.body` deep-equals `first.body`, one row. If the first POST is NOT 201, read the response body: a `409 { blockers }` means the seeded patient tripped CDS (shouldn't, with no allergies) — adjust the medication; a non-`patient_id` count column → fix `rxCount()` per Step 1.

- [ ] **Step 4: Lint + commit.**
```bash
cd apps/backend && npm run lint
```
Expected: 0 errors. Then from repo root:
```bash
git add apps/backend/src/tests/prescription-idempotency.deep.test.js
git commit -m "test(prescriptions): lock in keyed-replay dedup for offline e-Rx drains

POST /prescriptions/create stays required:false; the offline queue's stable key
already dedups a redrain. This deep test proves keyed-replay -> 201 + identical
cached body + exactly one e_prescriptions row. No production change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Staff — shared `buildPrescriptionBody` + refactor the online `_submit` body

**Files:**
- Create: `apps/staff/lib/core/services/prescription_payloads.dart`
- Modify: `apps/staff/lib/features/doctor/screens/prescriptions_screen.dart` (`_submit`, the inline body at ~lines 918-934)
- Create: `apps/staff/test/core/services/prescription_payloads_test.dart`

**Context:** The e-Rx screen builds its `POST /prescriptions/create` body inline in `_submit` (~lines 918-934). To guarantee the offline queued body is byte-identical to the online one, extract that into ONE pure builder both paths call. The builder must reproduce the screen's CURRENT body EXACTLY. The current inline body is:
```dart
final body = <String, dynamic>{
  'patient_id': _patientId,
  'doctor_id': _doctorId,
  if (_appointmentId != null) 'appointment_id': _appointmentId,
  'diagnosis': _diagnosisCtrl.text.trim(),
  'clinical_notes': _clinicalNotesCtrl.text.trim().isEmpty ? null : _clinicalNotesCtrl.text.trim(),
  'medications': meds,
  if (_followUpDate != null) 'follow_up_date': DateFormat('yyyy-MM-dd').format(_followUpDate!),
  if (_followUpNotesCtrl.text.trim().isNotEmpty) 'follow_up_notes': _followUpNotesCtrl.text.trim(),
  if (overrideReason != null) 'override': {'reason': overrideReason},
};
final vitals = _buildVitals();
if (vitals != null) body['vitals'] = vitals;
```
Note: NO `admission_id`, NO `visit_type`. `diagnosis` is always present (may be empty). `clinical_notes` is an always-present key (null when empty).

- [ ] **Step 1: Write the failing builder test.** Create `apps/staff/test/core/services/prescription_payloads_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/prescription_payloads.dart';

void main() {
  final meds = [
    {'name': 'Paracetamol', 'strength': '500mg', 'frequency': 'BD'},
    {'name': 'Amoxicillin', 'strength': '500mg', 'frequency': 'TDS'},
  ];

  test('builds the canonical prescription body with the full field set', () {
    final body = buildPrescriptionBody(
      patientId: 11,
      doctorId: 22,
      appointmentId: 33,
      diagnosis: 'Fever',
      clinicalNotes: 'rest + fluids',
      medications: meds,
      followUpDate: '2026-07-04',
      followUpNotes: 'review CBC',
      override: {'reason': 'attending cleared the allergy flag'},
      vitals: {'temp': '101F'},
    );
    expect(body['patient_id'], 11);
    expect(body['doctor_id'], 22);
    expect(body['appointment_id'], 33);
    expect(body['diagnosis'], 'Fever');
    expect(body['clinical_notes'], 'rest + fluids');
    expect(body['medications'], meds);
    expect((body['medications'] as List).length, 2);
    expect(body['follow_up_date'], '2026-07-04');
    expect(body['follow_up_notes'], 'review CBC');
    expect(body['override'], {'reason': 'attending cleared the allergy flag'});
    expect(body['vitals'], {'temp': '101F'});
    // Never sends admission_id / visit_type (the screen doesn't).
    expect(body.containsKey('admission_id'), isFalse);
    expect(body.containsKey('visit_type'), isFalse);
  });

  test('omits optionals; clinical_notes key present-but-null; diagnosis present-when-empty', () {
    final body = buildPrescriptionBody(
      patientId: 1, doctorId: 2, diagnosis: '', clinicalNotes: null, medications: meds,
    );
    expect(body.containsKey('appointment_id'), isFalse);
    expect(body['diagnosis'], '');                 // always present, even empty
    expect(body.containsKey('clinical_notes'), isTrue); // key always present
    expect(body['clinical_notes'], isNull);        // value null when empty
    expect(body.containsKey('follow_up_date'), isFalse);
    expect(body.containsKey('follow_up_notes'), isFalse);
    expect(body.containsKey('override'), isFalse);
    expect(body.containsKey('vitals'), isFalse);
  });

  test('omits follow_up_notes when empty string', () {
    final body = buildPrescriptionBody(
      patientId: 1, doctorId: 2, diagnosis: 'x', medications: meds, followUpNotes: '',
    );
    expect(body.containsKey('follow_up_notes'), isFalse);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails to compile.**
```bash
cd apps/staff && flutter test test/core/services/prescription_payloads_test.dart
```
Expected: FAIL — `prescription_payloads.dart` / `buildPrescriptionBody` undefined. (If flutter errors on workspace resolution, run `flutter pub get` at the repo root first.)

- [ ] **Step 3: Create the pure builder.** Create `apps/staff/lib/core/services/prescription_payloads.dart`:

```dart
// lib/core/services/prescription_payloads.dart
//
// Pure POST /prescriptions/create request-body builder, shared by the online e-Rx
// submit path (prescriptions_screen._submit) and the offline enqueue path
// (buildOfflineRxIntent). Keeping the body in ONE place guarantees the queued offline
// request is byte-identical to the online one. No Flutter imports.
//
// Reproduces the screen's CURRENT inline body EXACTLY: the screen does NOT send
// admission_id or visit_type; `diagnosis` is always present (may be empty); `clinical_notes`
// is an always-present key whose value is null when empty.

/// Build the POST /prescriptions/create body for an e-prescription (multi-item).
Map<String, dynamic> buildPrescriptionBody({
  required int patientId,
  required int doctorId,
  int? appointmentId,
  required String diagnosis,
  String? clinicalNotes,
  required List<Map<String, dynamic>> medications,
  String? followUpDate,
  String? followUpNotes,
  Map<String, dynamic>? override,
  Map<String, dynamic>? vitals,
}) {
  return {
    'patient_id': patientId,
    'doctor_id': doctorId,
    if (appointmentId != null) 'appointment_id': appointmentId,
    'diagnosis': diagnosis,
    'clinical_notes': clinicalNotes,
    'medications': medications,
    if (followUpDate != null) 'follow_up_date': followUpDate,
    if (followUpNotes != null && followUpNotes.isNotEmpty) 'follow_up_notes': followUpNotes,
    if (override != null) 'override': override,
    if (vitals != null) 'vitals': vitals,
  };
}
```

- [ ] **Step 4: Run the builder test — PASS.**
```bash
cd apps/staff && flutter test test/core/services/prescription_payloads_test.dart
```

- [ ] **Step 5: Refactor the online `_submit` body to call the builder.** In `prescriptions_screen.dart`, add the import (with the other relative imports near the top):
```dart
import '../../../core/services/prescription_payloads.dart';
```
Replace the inline body block (the `final body = <String, dynamic>{ ... };` through `if (vitals != null) body['vitals'] = vitals;`, ~lines 918-934) with:
```dart
      final body = buildPrescriptionBody(
        patientId: _patientId!,
        doctorId: _doctorId!,
        appointmentId: _appointmentId,
        diagnosis: _diagnosisCtrl.text.trim(),
        clinicalNotes: _clinicalNotesCtrl.text.trim().isEmpty
            ? null
            : _clinicalNotesCtrl.text.trim(),
        medications: meds,
        followUpDate: _followUpDate != null
            ? DateFormat('yyyy-MM-dd').format(_followUpDate!)
            : null,
        followUpNotes: _followUpNotesCtrl.text.trim().isEmpty
            ? null
            : _followUpNotesCtrl.text.trim(),
        override: overrideReason != null ? {'reason': overrideReason} : null,
        vitals: _buildVitals(),
      );
```
This produces a map identical to the previous inline version (`_patientId`/`_doctorId` are non-null here — the early-return at the top of `_submit` guarantees it; the `!` is safe). Everything after (`editingPrescriptionId`, create/update, pharmacy, PDF) is unchanged.

- [ ] **Step 6: Analyze + run the staff suite (no regression).**
```bash
cd apps/staff && flutter analyze && flutter test test/core/services/prescription_payloads_test.dart
```
Expected: analyze clean; builder test passes. (If analyze flags `_buildVitals` return type vs the `Map<String,dynamic>?` param, confirm `_buildVitals()` returns `Map<String, dynamic>?` — it does in the current screen.)

- [ ] **Step 7: Commit.**
```bash
git add apps/staff/lib/core/services/prescription_payloads.dart \
        apps/staff/lib/features/doctor/screens/prescriptions_screen.dart \
        apps/staff/test/core/services/prescription_payloads_test.dart
git commit -m "refactor(staff): extract shared buildPrescriptionBody

Single source of truth for the POST /prescriptions/create body so the offline
queued request is byte-identical to the online call. _submit now delegates to it;
no behavior change (reproduces the exact current body incl vitals/override).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Staff — pure `buildOfflineRxIntent` (phone-mode never enqueues)

**Files:**
- Create: `apps/staff/lib/features/doctor/prescription_offline_rx.dart`
- Create: `apps/staff/test/features/doctor/prescription_offline_rx_test.dart`

**Context:** The safety core. Clinical writes are desktop/tablet-only (`rejectMobileClinicalWrite`); the staff app's posture is `currentDeviceType` (`apps/staff/lib/core/platform_info.dart`, values `mobile|tablet|desktop|web`). The pure intent MUST never enqueue on phone-mode/unknown (it would 403 on drain). The body comes from Task 2's `buildPrescriptionBody`, so it's byte-identical to online. The offline path omits `override` (no CDS blocker is seen offline).

- [ ] **Step 1: Write the failing intent test.** Create `apps/staff/test/features/doctor/prescription_offline_rx_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/prescription_payloads.dart';
import 'package:vhhealth_staff/features/doctor/prescription_offline_rx.dart';

void main() {
  final meds = [
    {'name': 'Paracetamol', 'strength': '500mg', 'frequency': 'BD'},
  ];

  OfflineRxIntent build(String deviceType) => buildOfflineRxIntent(
        deviceType: deviceType,
        patientId: 11,
        doctorId: 22,
        appointmentId: 33,
        diagnosis: 'Fever',
        clinicalNotes: 'rest',
        medications: meds,
        followUpDate: '2026-07-04',
        followUpNotes: 'review',
        vitals: {'temp': '101F'},
      );

  test('phone-mode (mobile) blocks — never enqueues', () {
    final i = build('mobile');
    expect(i.block, isTrue);
    expect(i.enqueue, isFalse);
    expect(i.reason, isNotNull);
  });

  test('empty / unknown deviceType blocks (fail-closed)', () {
    expect(build('').block, isTrue);
    expect(build('   ').block, isTrue);
  });

  test('tablet enqueues with the /prescriptions/create endpoint', () {
    final i = build('tablet');
    expect(i.block, isFalse);
    expect(i.enqueue, isTrue);
    expect(i.endpoint, '/prescriptions/create');
    expect(i.reason, isNull);
  });

  test('desktop enqueues', () {
    expect(build('desktop').enqueue, isTrue);
  });

  test('queued body equals the online builder output (no override offline)', () {
    final i = build('tablet');
    final online = buildPrescriptionBody(
      patientId: 11,
      doctorId: 22,
      appointmentId: 33,
      diagnosis: 'Fever',
      clinicalNotes: 'rest',
      medications: meds,
      followUpDate: '2026-07-04',
      followUpNotes: 'review',
      vitals: {'temp': '101F'},
    );
    expect(i.body, online);
    expect(i.body.containsKey('override'), isFalse);
  });
}
```

- [ ] **Step 2: Run to verify it fails to compile.**
```bash
cd apps/staff && flutter test test/features/doctor/prescription_offline_rx_test.dart
```
Expected: FAIL — `prescription_offline_rx.dart` / `buildOfflineRxIntent` / `OfflineRxIntent` undefined.

- [ ] **Step 3: Create the pure intent helper.** Create `apps/staff/lib/features/doctor/prescription_offline_rx.dart`:

```dart
// lib/features/doctor/prescription_offline_rx.dart
//
// Pure decision for the OFFLINE e-prescription path. Keeps the screen thin and the
// safety branch unit-testable.
//
// INVARIANT: a device that cannot place clinical orders (phone-mode or an empty/unknown
// deviceType) NEVER enqueues — queuing there would only 403 on drain
// (rejectMobileClinicalWrite). This mirrors the backend device gate.

import '../../core/services/prescription_payloads.dart';

class OfflineRxIntent {
  const OfflineRxIntent({
    required this.block,
    required this.enqueue,
    required this.endpoint,
    required this.body,
    required this.reason,
  });

  /// Device cannot place clinical writes → abort, do NOT enqueue.
  final bool block;

  /// Safe to queue the prescription create.
  final bool enqueue;

  final String endpoint;
  final Map<String, dynamic> body;

  /// User-facing block reason (null when [enqueue] is true).
  final String? reason;
}

/// Decide whether an e-prescription can be queued offline and build the byte-identical
/// POST /prescriptions/create body. [deviceType] is the staff app's current posture
/// (`currentDeviceType`): clinical writes are desktop/tablet-only, so 'mobile' or an
/// empty/unknown value is blocked. The offline body omits `override` (no CDS blocker is
/// seen offline — a block surfaces on drain as a conflict).
OfflineRxIntent buildOfflineRxIntent({
  required String deviceType,
  required int patientId,
  required int doctorId,
  int? appointmentId,
  required String diagnosis,
  String? clinicalNotes,
  required List<Map<String, dynamic>> medications,
  String? followUpDate,
  String? followUpNotes,
  Map<String, dynamic>? vitals,
}) {
  final dt = deviceType.trim().toLowerCase();
  final block = dt == 'mobile' || dt.isEmpty;
  return OfflineRxIntent(
    block: block,
    enqueue: !block,
    endpoint: '/prescriptions/create',
    body: buildPrescriptionBody(
      patientId: patientId,
      doctorId: doctorId,
      appointmentId: appointmentId,
      diagnosis: diagnosis,
      clinicalNotes: clinicalNotes,
      medications: medications,
      followUpDate: followUpDate,
      followUpNotes: followUpNotes,
      vitals: vitals,
    ),
    reason: block
        ? 'Prescriptions can only be created from a desktop or tablet workstation.'
        : null,
  );
}
```

- [ ] **Step 4: Run the intent test — PASS (5 tests).**
```bash
cd apps/staff && flutter test test/features/doctor/prescription_offline_rx_test.dart
```

- [ ] **Step 5: Analyze + commit.**
```bash
cd apps/staff && flutter analyze
```
Expected: clean. Then:
```bash
git add apps/staff/lib/features/doctor/prescription_offline_rx.dart \
        apps/staff/test/features/doctor/prescription_offline_rx_test.dart
git commit -m "feat(staff): pure buildOfflineRxIntent (phone-mode never enqueues)

SAFETY INVARIANT: an offline e-prescription is only queued from a desktop/tablet
posture; phone-mode or unknown deviceType is blocked (it would 403 on drain).
Body comes from the shared builder, byte-identical to online (override omitted).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Core — `ConflictRow` prescription branch (matcher + copy + confirm)

**Files:**
- Modify: `packages/vhhealth_core/lib/widgets/offline_sync_badge.dart`
- Create: `packages/vhhealth_core/test/prescription_conflict_ux_test.dart`

**Context:** `ConflictRow` already special-cases MAR (`/clinical/mar/`) and orders (`/emr/orders`) with clinical copy + confirm-on-discard. Add the same for a queued prescription (`/prescriptions/`). MAR + order + generic behavior must stay unchanged.

- [ ] **Step 1: Write the failing widget test.** Create `packages/vhhealth_core/test/prescription_conflict_ux_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/widgets/offline_sync_badge.dart';

Future<void> _pumpRow(
  WidgetTester tester, {
  required Map<String, dynamic> conflict,
  VoidCallback? onDiscard,
  VoidCallback? onRetry,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: ConflictRow(
          conflict: conflict,
          onDiscard: onDiscard ?? () {},
          onRetry: onRetry ?? () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  final rxConflict = <String, dynamic>{
    'id': 21,
    'endpoint': '/prescriptions/create',
    'method': 'POST',
    'context_label': 'Prescription — Paracetamol',
    'conflict_reason': 'Prescription blocked by clinical safety check',
    'created_at': DateTime(2026, 6, 27, 12, 0).millisecondsSinceEpoch,
  };

  testWidgets('shows the not-recorded clinical copy + the server reason', (tester) async {
    await _pumpRow(tester, conflict: rxConflict);
    expect(find.textContaining('not recorded on the server'), findsOneWidget);
    expect(find.textContaining('Prescription blocked by clinical safety check'), findsOneWidget);
  });

  testWidgets('Discard opens a confirmation dialog; cancel does NOT discard', (tester) async {
    var discarded = false;
    await _pumpRow(tester, conflict: rxConflict, onDiscard: () => discarded = true);

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Discard prescription?'), findsOneWidget);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(discarded, isFalse);
  });

  testWidgets('confirming the dialog fires onDiscard exactly once', (tester) async {
    var discardCount = 0;
    await _pumpRow(tester, conflict: rxConflict, onDiscard: () => discardCount++);

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Discard').last);
    await tester.pumpAndSettle();
    expect(discardCount, 1);
  });

  testWidgets('Retry fires onRetry without a confirmation dialog', (tester) async {
    var retried = false;
    await _pumpRow(tester, conflict: rxConflict, onRetry: () => retried = true);

    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(retried, isTrue);
    expect(find.textContaining('Discard prescription?'), findsNothing);
  });
}
```

- [ ] **Step 2: Run to verify it fails.**
```bash
cd packages/vhhealth_core && flutter test test/prescription_conflict_ux_test.dart
```
Expected: FAIL — no `not recorded on the server` prescription copy; Discard fires immediately with no dialog.

- [ ] **Step 3: Add the prescription matcher.** In `offline_sync_badge.dart`, in `class ConflictRow`, add right AFTER `_isOrderConflict`:
```dart
  /// True for a queued e-PRESCRIPTION create (`/prescriptions/`). Discarding one means a
  /// prescription the clinician composed was never recorded — clinical framing + confirm.
  static bool _isPrescriptionConflict(String endpoint) =>
      endpoint.contains('/prescriptions/');
```

- [ ] **Step 4: Gate discard for prescriptions too.** Replace `_handleDiscard` (currently handles `isMar`/`isOrder`) with the three-way version:
```dart
  Future<void> _handleDiscard(BuildContext context, String endpoint) async {
    final isMar = _isMarConflict(endpoint);
    final isOrder = _isOrderConflict(endpoint);
    final isRx = _isPrescriptionConflict(endpoint);
    if (!isMar && !isOrder && !isRx) {
      onDiscard();
      return;
    }
    final String title;
    final String message;
    if (isRx) {
      title = 'Discard prescription?';
      message = 'Discard this prescription? It was NOT recorded on the server.';
    } else if (isOrder) {
      title = 'Discard medication order?';
      message = 'Discard this medication order? It was NOT placed on the server.';
    } else {
      title = 'Discard administration record?';
      message = 'Discard this administration record? The medication was given but '
          'will NOT be recorded.';
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogCtx).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            style: TextButton.styleFrom(foregroundColor: Colors.red.shade700),
            onPressed: () => Navigator.of(dialogCtx).pop(true),
            child: const Text('Discard'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      onDiscard();
    }
  }
```

- [ ] **Step 5: Add the prescription clinical copy in `build`.** In `ConflictRow.build`, find:
```dart
    final isMar = _isMarConflict(endpoint);
    final isOrder = _isOrderConflict(endpoint);
```
and add:
```dart
    final isRx = _isPrescriptionConflict(endpoint);
```
Then replace the `reasonWidget` expression (the `isMar ? ... : isOrder ? ... : Text(reason, ...)` chain) with the four-branch version (insert the `isRx` branch BEFORE the generic fallback):
```dart
    final reasonWidget = isMar
        ? Text(
            'Administration not recorded on the server — review needed. '
            '$reason. The medication was given offline.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: Colors.red.shade700,
              fontWeight: FontWeight.w600,
            ),
          )
        : isOrder
            ? Text(
                'Medication order not placed on the server — review needed. $reason.',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: Colors.red.shade700,
                  fontWeight: FontWeight.w600,
                ),
              )
            : isRx
                ? Text(
                    'Prescription not recorded on the server — review needed. $reason.',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: Colors.red.shade700,
                      fontWeight: FontWeight.w600,
                    ),
                  )
                : Text(
                    reason,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: Colors.red.shade700,
                    ),
                  );
```
Keep the MAR + order branch text byte-identical to what's already there — only ADD the `isRx` branch.

- [ ] **Step 6: Run the prescription + MAR + order ConflictRow suites.**
```bash
cd packages/vhhealth_core && flutter test test/prescription_conflict_ux_test.dart test/order_conflict_ux_test.dart test/mar_conflict_ux_test.dart
```
Expected: all PASS (prescription branch added; MAR + order + generic unchanged).

- [ ] **Step 7: Analyze + commit.**
```bash
cd packages/vhhealth_core && flutter analyze
```
Expected: clean. Then:
```bash
git add packages/vhhealth_core/lib/widgets/offline_sync_badge.dart \
        packages/vhhealth_core/test/prescription_conflict_ux_test.dart
git commit -m "feat(sync-ux): clinical conflict framing + confirm-on-discard for /prescriptions

A discarded prescription conflict = a prescription the clinician composed that was
never recorded. ConflictRow now detects /prescriptions/, shows 'not recorded on the
server — review needed', and gates Discard behind a confirmation dialog, like MAR/orders.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Staff — wire `_submit` offline branch + closeout

**Files:**
- Modify: `apps/staff/lib/features/doctor/screens/prescriptions_screen.dart` (`_submit`, imports)

**Context:** `_submit` currently always runs the online flow (pre-flight CDS → create → pharmacy → PDF). Add an offline branch at the top of the `try` (after `final meds = ...`): offline → skip the pre-flight CDS modal, build the intent; block → toast + keep the form; photo present → keep online-only; else enqueue + reset the form + an HONEST toast. The online path (already refactored in Task 2 to use the builder) is otherwise unchanged. Per the MAR/CPOE precedent the screen wiring isn't widget-tested (the `ConnectivitySyncService` singleton + the screen's online submit path aren't injectable) — the safety decision lives in the Task-3 pure helper, which IS tested.

- [ ] **Step 1: Add imports.** In `prescriptions_screen.dart`, add:
```dart
import 'package:vhhealth_core/services/connectivity_sync_service.dart';

import '../../../core/platform_info.dart';
import '../prescription_offline_rx.dart';
```
(Place the package import with the other `package:` imports; the two relative imports with the existing relative imports — `prescription_offline_rx.dart` is at `lib/features/doctor/`, so from `lib/features/doctor/screens/` it is `../prescription_offline_rx.dart`; `platform_info.dart` is at `lib/core/`, so `../../../core/platform_info.dart`.)

- [ ] **Step 2: Add the offline branch in `_submit`.** Inside the `try {` of `_submit`, immediately AFTER `final meds = _medications.map((m) => m.toJson()).toList();` and BEFORE the `// ── CDS hard-block preview ──` block, insert:
```dart
      if (!ConnectivitySyncService.instance.isOnline) {
        // Photo prescriptions can't be queued — the offline queue is JSON-only.
        if (_handwrittenPhoto != null) {
          if (mounted) {
            ErrorToast.show(
              context,
              'Photo prescriptions need a connection. Reconnect and try again.',
            );
            setState(() => _submitting = false);
          }
          return;
        }
        final intent = buildOfflineRxIntent(
          deviceType: currentDeviceType,
          patientId: _patientId!,
          doctorId: _doctorId!,
          appointmentId: _appointmentId,
          diagnosis: _diagnosisCtrl.text.trim(),
          clinicalNotes: _clinicalNotesCtrl.text.trim().isEmpty
              ? null
              : _clinicalNotesCtrl.text.trim(),
          medications: meds,
          followUpDate: _followUpDate != null
              ? DateFormat('yyyy-MM-dd').format(_followUpDate!)
              : null,
          followUpNotes: _followUpNotesCtrl.text.trim().isEmpty
              ? null
              : _followUpNotesCtrl.text.trim(),
          vitals: _buildVitals(),
        );
        if (intent.block) {
          if (mounted) {
            ErrorToast.show(context, intent.reason!);
            setState(() => _submitting = false);
          }
          return; // keep the form; NEVER enqueue on a blocked device
        }
        final firstName = meds.isNotEmpty
            ? (meds.first['name'] ?? meds.first['medication_name'] ?? 'medication')
            : 'medication';
        await ConnectivitySyncService.instance.enqueue(
          endpoint: intent.endpoint,
          method: 'POST',
          body: intent.body,
          contextLabel: 'Prescription — $firstName',
        );
        if (mounted) {
          SuccessToast.show(
            context,
            'Prescription queued — will be safety-checked on sync',
          );
          _formKey.currentState!.reset();
          setState(() {
            if (widget.prefilledAppointment == null) {
              _resetPrescriptionDraft(keepPatientContext: false);
            }
            _submitting = false;
          });
        }
        return;
      }
```
Leave the online block (CDS pre-flight → `buildPrescriptionBody` → create → pharmacy → PDF → reset), the `catch`, and the `finally` exactly as they are.

- [ ] **Step 3: Analyze the staff app.**
```bash
cd apps/staff && flutter analyze
```
Expected: clean — all three new imports referenced (`currentDeviceType`, `ConnectivitySyncService`, `buildOfflineRxIntent`); no unused imports.

- [ ] **Step 4: Run the full Flutter gate (core + staff, no regressions).**
```bash
cd packages/vhhealth_core && flutter analyze && flutter test
cd ../../apps/staff && flutter analyze && flutter test
```
Expected: all green. (Run `flutter pub get` at the repo root first if workspace resolution errors appear.)

- [ ] **Step 5: Commit the wiring.**
```bash
git add apps/staff/lib/features/doctor/screens/prescriptions_screen.dart
git commit -m "feat(staff): queue e-prescriptions offline

When offline, _submit skips the server CDS pre-check and builds the offline intent:
a blocked (phone-mode) device toasts and keeps the form; a photo Rx stays online-only;
otherwise the prescription is enqueued via ConnectivitySyncService and the form clears
with an HONEST 'queued — will be safety-checked on sync' toast (never 'safe'/'created').
Online path unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: Final backend gate on the QA cluster.**
```bash
node apps/backend/scripts/qa-cluster-up.mjs
cd apps/backend && npm run lint
TEST_DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test \
  node --experimental-vm-modules node_modules/jest/bin/jest.js prescription-idempotency prescription-deep --forceExit
```
Expected: lint clean; both suites green (the existing `prescription-deep` still passes — required stays false, no keyless 400).

- [ ] **Step 7: Closeout (use superpowers:finishing-a-development-branch).**
After the final reviewer approves:
1. Merge `feat/offline-erx` `--no-ff` to `main`.
2. Push **both** remotes: `git push github main` and `git push origin main`.
3. Delete the branch.
4. Tick ROADMAP §9 — Epic #9 slice 3 (e-Rx) DONE, completing the offline clinical-write trilogy (MAR + CPOE + e-Rx).
5. Update the `project_vh_health_offline_clinical_writes` memory (slice-3 SHA + the dropped-flip rationale + the multipart-keyless-dup follow-on).

**Deploy stays HELD.** The live offline→reconnect→drain round-trip is verified MANUALLY (no airplane-mode in CI).

---

## Honest boundaries / out of scope

- **Manual-only:** the live offline → reconnect → drain round-trip (no airplane-mode in CI).
- **Not screen-tested:** `_submit`'s offline glue (singleton + online submit path not injectable) — the safety decision is in the Task-3 pure helper, fully tested. Same approach as MAR/CPOE.
- **No backend code change:** the route stays `required:false`; offline dedup is guaranteed by the queue's stable key (Task 1 locks this in). The online handwritten-photo keyless-dup gap (`VHHttpClient.multipart` sends no key) is pre-existing and a documented follow-on.
- **Text prescriptions only:** a photo-bearing prescription stays online-only (the queue is JSON).
- **Follow-ons:** offline e-signature / pharmacy-order / PDF (post-drain online steps); the multipart-key change to close the photo keyless-dup.
