# Offline-first Drug-Chart Medication Orders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a ward clinician queue a single inpatient medication order from the drug chart while offline, dedup it with a mandatory idempotency key, and surface any server rejection on drain as a loud, clinically-framed conflict instead of a silent drop.

**Architecture:** Reuse the shipped MAR offline stack (`OfflineQueue` + `ConnectivitySyncService.enqueue` + `ConflictRow`). Three load-bearing changes: (1) flip `POST /emr/orders` to `requireIdempotencyKey({ required: true })`; (2) broaden the sync-drain conflict classification from `{409,422}` to `{400,403,409,422}` via a pure `dispositionForStatus` function so a `CDS_BLOCKER`/device-posture rejection becomes a visible conflict; (3) a pure `buildOfflineOrderIntent` that refuses to enqueue on phone-mode and builds a body byte-identical to the online call.

**Tech Stack:** Node 22 + Express 5 + Jest/supertest (backend); Flutter 3.41 / Dart 3.11.5 + flutter_test (staff app + `vhhealth_core`). Backend deep tests run against the QA Postgres cluster.

**Spec:** `docs/superpowers/specs/2026-06-27-offline-cpoe-design.md`. **Branch:** `feat/offline-cpoe` (already created; spec committed `f6c8f79f`). **Deploy: HELD.**

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `apps/backend/src/routes/emr/orderRoutes.js` | 1 | Flip `POST /orders` to `required: true` (one line) |
| `apps/backend/src/tests/cpoe-order-idempotency.deep.test.js` | 1 | NEW — HTTP deep test: missing key → 400, replay → one row |
| `apps/backend/src/tests/emr-contract.deep.test.js` (+ any journey test) | 1 | Add `Idempotency-Key` to existing `/emr/orders` POSTs (regression) |
| `packages/vhhealth_core/lib/services/connectivity_sync_service.dart` | 2 | NEW pure `SyncDisposition`/`dispositionForStatus`; broaden drain conflict branch |
| `packages/vhhealth_core/test/sync_disposition_test.dart` | 2 | NEW — exhaustive classifier unit test |
| `packages/vhhealth_core/lib/widgets/offline_sync_badge.dart` | 3 | `ConflictRow`: order matcher + clinical copy + confirm-on-discard |
| `packages/vhhealth_core/test/order_conflict_ux_test.dart` | 3 | NEW — order ConflictRow widget test |
| `apps/staff/lib/core/services/order_payloads.dart` | 4 | NEW pure `buildInpatientMedicationOrderBody` (single source of truth) |
| `apps/staff/lib/core/services/medical_api_service.dart` | 4 | `createInpatientMedicationOrder` calls the shared builder |
| `apps/staff/test/core/services/order_payloads_test.dart` | 4 | NEW — body builder unit test |
| `apps/staff/lib/features/ipd/drug_chart_offline_order.dart` | 5 | NEW pure `buildOfflineOrderIntent` (block-on-phone invariant) |
| `apps/staff/test/features/ipd/drug_chart_offline_order_test.dart` | 5 | NEW — intent unit test |
| `apps/staff/lib/features/ipd/screens/drug_chart_screen.dart` | 6 | Wire `_saveDraftRow` offline branch |

---

## Task 1: Backend — flip `POST /emr/orders` to idempotency `required: true` + deep test

**Files:**
- Modify: `apps/backend/src/routes/emr/orderRoutes.js:152`
- Create: `apps/backend/src/tests/cpoe-order-idempotency.deep.test.js`
- Modify: `apps/backend/src/tests/emr-contract.deep.test.js:178` (+ any other HTTP `POST /emr/orders` caller found in step 6)

**Context:** `POST /emr/orders` currently has `requireIdempotencyKey({ required: false, scope: 'clinical_order' })`. The offline queue always sends a stable `Idempotency-Key` (`VHHttpClient` auto-mints one — `packages/vhhealth_core/lib/services/http_client.dart:158`), so flipping to `required: true` is safe for the staff app and closes the duplicate-order gap. The admin portal only does `GET /emr/orders/patient/{uid}` — no POST caller breaks. `/orders/apply-set` (line 205) and `/orders/bulk` (line 250) stay `required: false` (composer follow-on). The QA cluster has migration 130 (`idempotency_keys`), so the middleware will not fail-open.

- [ ] **Step 1: Write the failing deep test**

Create `apps/backend/src/tests/cpoe-order-idempotency.deep.test.js`:

```javascript
// CPOE order-create idempotency contract (Epic #9 slice 2 — offline drug chart).
//
// POST /emr/orders is flipped to requireIdempotencyKey({ required: true }) so the
// offline queue's redrain of a lost-2xx can never create a SECOND clinical order.
// Proven over the real HTTP middleware chain (DOCTOR + deviceType:'desktop' token
// passes rejectMobileClinicalWrite and may write medication orders):
//   1. No Idempotency-Key            -> 400 (required:true gate fires pre-handler).
//   2. Same key + same body, twice   -> the 2nd is a cached REPLAY: identical 201
//                                       and EXACTLY ONE clinical_orders row.
import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PATIENT_UID = 'c0de0002-0001-4c0d-8c0d-c0de00020001';
const DOCTOR_UID = 'c0de0002-0002-4c0d-8c0d-c0de00020002';

function doctor() {
  const t = generateTestToken('DOCTOR', { uid: DOCTOR_UID, id: 880771, deviceType: 'desktop' });
  const h = (r) => r.set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`);
  return { post: (p) => h(request(app).post(p)) };
}
const D = doctor();

const ORDER_BODY = {
  patient_uid: PATIENT_UID,
  order_type: 'medication',
  priority: 'routine',
  details: { medication_name: 'Paracetamol', dose: '500mg', route: 'oral', frequency: 'BD' },
};

async function orderCount() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS n FROM clinical_orders WHERE patient_uid = $1::uuid', PATIENT_UID);
  return Number(rows[0]?.n ?? 0);
}

async function clean() {
  for (const sql of [
    `DELETE FROM medication_safety_reviews WHERE patient_uid = $1::uuid`,
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid AND source_table = 'clinical_orders'`,
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid AND resource_table = 'clinical_orders'`,
    `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`,
  ]) await prisma.$executeRawUnsafe(sql, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});
}

d('CPOE order-create idempotency (POST /emr/orders required:true)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at) VALUES
        ($1::uuid,'9320000021','CPOE Idem Patient','PATIENT',true,NOW()),
        ($2::uuid,'9320000022','CPOE Idem Doctor','DOCTOR',true,NOW())`,
      PATIENT_UID, DOCTOR_UID);
  }, 60000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 60000);
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  });

  it('rejects a clinical order with NO Idempotency-Key (required:true)', async () => {
    const res = await D.post('/api/v1/emr/orders').send(ORDER_BODY);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/idempotency-key/i);
    expect(await orderCount()).toBe(0);
  });

  it('replays the same key+body: one order row, identical order id', async () => {
    // Run-unique key: idempotency_keys rows persist for 24h, so a FIXED key would
    // make a re-run replay a cached response pointing at a since-deleted order.
    const key = `cpoe-idem-${Date.now()}`;
    const first = await D.post('/api/v1/emr/orders').set('Idempotency-Key', key).send(ORDER_BODY);
    expect(first.statusCode).toBe(201);
    const firstOrderId = first.body?.data?.order?.id ?? first.body?.data?.id;
    expect(firstOrderId).toBeDefined();

    const second = await D.post('/api/v1/emr/orders').set('Idempotency-Key', key).send(ORDER_BODY);
    expect(second.statusCode).toBe(201);
    const secondOrderId = second.body?.data?.order?.id ?? second.body?.data?.id;

    expect(String(secondOrderId)).toBe(String(firstOrderId));
    expect(await orderCount()).toBe(1);
  });
});
```

- [ ] **Step 2: Bring up the QA cluster and run the test to verify the first case FAILS**

Run:
```bash
node apps/backend/scripts/qa-cluster-up.mjs
cd apps/backend
TEST_DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test \
  node --experimental-vm-modules node_modules/jest/bin/jest.js cpoe-order-idempotency --forceExit
```
Expected: the **"rejects … NO Idempotency-Key"** test FAILS (currently `required: false`, so the request reaches the handler and returns 201, not 400). The replay test may pass coincidentally (the queue isn't involved), but the missing-key test is the RED proof.

- [ ] **Step 3: Flip the route to `required: true`**

In `apps/backend/src/routes/emr/orderRoutes.js:152`, change ONLY the `POST /orders` mount:

```javascript
// before:
router.post('/orders', rejectMobileClinicalWrite, requireIdempotencyKey({ required: false, scope: 'clinical_order' }), guardClinicalOrderWrite, async (req, res, next) => {
// after:
router.post('/orders', rejectMobileClinicalWrite, requireIdempotencyKey({ required: true, scope: 'clinical_order' }), guardClinicalOrderWrite, async (req, res, next) => {
```

Do NOT touch `/orders/apply-set` (line 205) or `/orders/bulk` (line 250).

- [ ] **Step 4: Run the deep test to verify it PASSES**

Run:
```bash
cd apps/backend
TEST_DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test \
  node --experimental-vm-modules node_modules/jest/bin/jest.js cpoe-order-idempotency --forceExit
```
Expected: both tests PASS — missing key → 400, replay → one row + identical id.

- [ ] **Step 5: Lint the backend change**

Run:
```bash
cd apps/backend && npm run lint
```
Expected: 0 errors.

- [ ] **Step 6: Audit + fix existing HTTP callers that POST `/emr/orders` without a key (regression)**

Find every HTTP caller (NOT the service-layer `createOrder` callers, NOT `/orders/bulk`, NOT `/orders/:id/verify`):
```bash
cd apps/backend && grep -rn "post('/api/v1/emr/orders')\|post('/emr/orders')\|post(`/api/v1/emr/orders`)" src/tests
```
The known one is `apps/backend/src/tests/emr-contract.deep.test.js:178`. Add an `Idempotency-Key` header to each such create. For emr-contract:

```javascript
// before (line ~178):
const ord = await A.post('/api/v1/emr/orders').send({
  patient_uid: PATIENT_UID, encounter_id: encounterId, order_type: 'investigation',
  priority: 'routine', details: { test_name: 'CBC' },
});
// after (run-unique key — idempotency_keys rows persist 24h, so a FIXED key
// would make a re-run replay a cached response pointing at a deleted order):
const ord = await A.post('/api/v1/emr/orders').set('Idempotency-Key', `emr-contract-order-cbc-${Date.now()}`).send({
  patient_uid: PATIENT_UID, encounter_id: encounterId, order_type: 'investigation',
  priority: 'routine', details: { test_name: 'CBC' },
});
```
Apply the same `.set('Idempotency-Key', \`<label>-${Date.now()}\`)` to any other HTTP `POST /emr/orders` the grep finds (e.g. journey tests) — always a run-unique key per call site, never a fixed string.

- [ ] **Step 7: Run the affected suites to confirm no regression**

Run:
```bash
cd apps/backend
TEST_DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test \
  node --experimental-vm-modules node_modules/jest/bin/jest.js emr-contract cpoe-order-idempotency --forceExit
```
Expected: all green (emr-contract order-create now carries a key; idempotency test passes).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/routes/emr/orderRoutes.js \
        apps/backend/src/tests/cpoe-order-idempotency.deep.test.js \
        apps/backend/src/tests/emr-contract.deep.test.js
git commit -m "feat(orders): require Idempotency-Key on POST /emr/orders (offline dedup)

Flip the single-order clinical-order create to required:true so the offline
queue's redrain of a lost-2xx cannot create a duplicate order. Bulk/apply-set
unchanged. Adds an HTTP idempotency deep test and backfills the key on the
existing emr-contract order create.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Core — pure `dispositionForStatus` classifier + broaden the drain conflict branch

**Files:**
- Modify: `packages/vhhealth_core/lib/services/connectivity_sync_service.dart`
- Create: `packages/vhhealth_core/test/sync_disposition_test.dart`

**Context:** Today `syncPending` (lines 205–226) treats only `409/422` as conflicts; every other non-2xx is `incrementRetry` → silently dropped after 5 retries. A `400 CDS_BLOCKER` or a device-posture `403` on drain would vanish unseen — a clinical-safety hole. Extracting the decision into a pure `dispositionForStatus(int)` makes it exhaustively unit-testable, and the drain loop changes by one condition only (the success branch stays exactly as-is).

- [ ] **Step 1: Write the failing classifier test**

Create `packages/vhhealth_core/test/sync_disposition_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';

void main() {
  group('dispositionForStatus', () {
    test('2xx → success', () {
      for (final s in [200, 201, 202, 204, 299]) {
        expect(dispositionForStatus(s), SyncDisposition.success, reason: 'status $s');
      }
    });

    test('definitive client rejections → conflict (400/403/409/422)', () {
      for (final s in [400, 403, 409, 422]) {
        expect(dispositionForStatus(s), SyncDisposition.conflict, reason: 'status $s');
      }
    });

    test('transient / auth / server errors → retry (401/404/408/429/5xx)', () {
      for (final s in [401, 404, 408, 429, 500, 502, 503]) {
        expect(dispositionForStatus(s), SyncDisposition.retry, reason: 'status $s');
      }
    });
  });
}
```

- [ ] **Step 2: Run the test to verify it fails to COMPILE**

Run:
```bash
cd packages/vhhealth_core && flutter test test/sync_disposition_test.dart
```
Expected: FAIL — `SyncDisposition` / `dispositionForStatus` are undefined.

- [ ] **Step 3: Add the pure classifier**

In `packages/vhhealth_core/lib/services/connectivity_sync_service.dart`, add at top level **above** `class ConnectivitySyncService` (after the imports / doc comment):

```dart
/// How a drained offline write's HTTP status maps to a queue disposition.
enum SyncDisposition { success, conflict, retry }

/// Classify a drain response. A *definitive* client rejection that a blind retry
/// can never fix becomes a conflict the user must resolve; anything transient
/// (auth refresh, timeout, rate-limit, server error) is retried.
///
/// Conflict set: 400 (e.g. CDS_BLOCKER), 403 (device-posture clinical-write
/// gate), 409 (in-flight / state conflict), 422 (idempotency body mismatch /
/// validation). 401 stays transient — VHHttpClient refresh-retries it and a
/// persistent auth failure is a re-login problem, not a clinical conflict.
SyncDisposition dispositionForStatus(int statusCode) {
  if (statusCode >= 200 && statusCode < 300) return SyncDisposition.success;
  if (statusCode == 400 ||
      statusCode == 403 ||
      statusCode == 409 ||
      statusCode == 422) {
    return SyncDisposition.conflict;
  }
  return SyncDisposition.retry;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd packages/vhhealth_core && flutter test test/sync_disposition_test.dart
```
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the classifier into the drain loop**

In the same file, in `syncPending`, replace the conflict condition (currently lines ~210–226). Change ONLY the `else if` from the hard-coded `409 || 422` to the classifier; the `resp.isSuccess` success branch and the `else` retry branch stay:

```dart
          if (resp.isSuccess) {
            await OfflineQueue.remove(id);
            if (kDebugMode) {
              debugPrint('ConnectivitySync: synced id=$id ($endpoint)');
            }
          } else if (dispositionForStatus(resp.statusCode) ==
              SyncDisposition.conflict) {
            final reason =
                resp.message ?? 'Resource was modified on the server';
            await OfflineQueue.markConflict(id, reason);
            if (kDebugMode) {
              debugPrint(
                'ConnectivitySync: CONFLICT id=$id ($endpoint): $reason',
              );
            }
          } else {
            await OfflineQueue.incrementRetry(id);
            if (kDebugMode) {
              debugPrint(
                'ConnectivitySync: failed id=$id (${resp.statusCode})',
              );
            }
          }
```

- [ ] **Step 6: Analyze + run the core suite (no MAR regression)**

Run:
```bash
cd packages/vhhealth_core && flutter analyze && flutter test
```
Expected: analyze clean; all tests pass (MAR conflict UX still relies on 409/422, which remain in the conflict set — strictly preserved).

- [ ] **Step 7: Commit**

```bash
git add packages/vhhealth_core/lib/services/connectivity_sync_service.dart \
        packages/vhhealth_core/test/sync_disposition_test.dart
git commit -m "feat(sync): classify 400/403/409/422 drains as conflicts (no silent drop)

Extract a pure dispositionForStatus(); broaden the drain conflict branch from
{409,422} to {400,403,409,422} so a CDS_BLOCKER or device-posture rejection on
drain surfaces as a visible conflict instead of being retried 5x then dropped.
401 and other transients keep retrying. Strengthens MAR too.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Core — `ConflictRow` order branch (matcher + clinical copy + confirm-on-discard)

**Files:**
- Modify: `packages/vhhealth_core/lib/widgets/offline_sync_badge.dart`
- Create: `packages/vhhealth_core/test/order_conflict_ux_test.dart`

**Context:** `ConflictRow` already special-cases MAR (`_isMarConflict(endpoint) => endpoint.contains('/clinical/mar/')`) with clinical copy + a confirm-on-discard dialog; everything else discards immediately with the bare reason. Add the same treatment for a queued medication order (`/emr/orders`): discarding it means an ordered drug was never ordered, so it must be loud and confirm-gated.

- [ ] **Step 1: Write the failing widget test**

Create `packages/vhhealth_core/test/order_conflict_ux_test.dart`:

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
  final orderConflict = <String, dynamic>{
    'id': 12,
    'endpoint': '/emr/orders',
    'method': 'POST',
    'context_label': 'Medication order — Paracetamol',
    'conflict_reason': 'Allergy conflict: penicillin',
    'created_at': DateTime(2026, 6, 27, 11, 0).millisecondsSinceEpoch,
  };

  testWidgets('shows the not-placed clinical copy + the server reason', (tester) async {
    await _pumpRow(tester, conflict: orderConflict);
    expect(find.textContaining('not placed on the server'), findsOneWidget);
    expect(find.textContaining('Allergy conflict: penicillin'), findsOneWidget);
  });

  testWidgets('Discard opens a confirmation dialog; cancel does NOT discard', (tester) async {
    var discarded = false;
    await _pumpRow(tester, conflict: orderConflict, onDiscard: () => discarded = true);

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Discard medication order?'), findsOneWidget);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(discarded, isFalse);
  });

  testWidgets('confirming the dialog fires onDiscard exactly once', (tester) async {
    var discardCount = 0;
    await _pumpRow(tester, conflict: orderConflict, onDiscard: () => discardCount++);

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Discard').last);
    await tester.pumpAndSettle();
    expect(discardCount, 1);
  });

  testWidgets('Retry fires onRetry without a confirmation dialog', (tester) async {
    var retried = false;
    await _pumpRow(tester, conflict: orderConflict, onRetry: () => retried = true);

    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(retried, isTrue);
    expect(find.textContaining('Discard medication order?'), findsNothing);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd packages/vhhealth_core && flutter test test/order_conflict_ux_test.dart
```
Expected: FAIL — no `not placed on the server` copy; Discard fires immediately with no dialog.

- [ ] **Step 3: Add the order matcher**

In `packages/vhhealth_core/lib/widgets/offline_sync_badge.dart`, in `class ConflictRow`, add after `_isMarConflict` (line ~332):

```dart
  /// True for a queued clinical ORDER create (`/emr/orders`). Discarding one
  /// means an ordered medication was never ordered — so it gets clinical
  /// framing + a confirm-on-discard guard, like MAR.
  static bool _isOrderConflict(String endpoint) =>
      endpoint.contains('/emr/orders');
```

- [ ] **Step 4: Gate discard for orders too (with order-specific copy)**

Replace `_handleDiscard` (lines ~334–363) with:

```dart
  Future<void> _handleDiscard(BuildContext context, String endpoint) async {
    final isMar = _isMarConflict(endpoint);
    final isOrder = _isOrderConflict(endpoint);
    if (!isMar && !isOrder) {
      onDiscard();
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        title: Text(
          isOrder ? 'Discard medication order?' : 'Discard administration record?',
        ),
        content: Text(
          isOrder
              ? 'Discard this medication order? It was NOT placed on the server.'
              : 'Discard this administration record? The medication was given but '
                  'will NOT be recorded.',
        ),
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

- [ ] **Step 5: Add the order clinical copy in `build`**

In `ConflictRow.build` (lines ~365–396), add the `isOrder` local and a third reason branch. Change:

```dart
    final isMar = _isMarConflict(endpoint);
```
to:
```dart
    final isMar = _isMarConflict(endpoint);
    final isOrder = _isOrderConflict(endpoint);
```

and replace the `reasonWidget` assignment (the `isMar ? ... : Text(reason, ...)` expression) with:

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
            : Text(
                reason,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: Colors.red.shade700,
                ),
              );
```

- [ ] **Step 6: Run both ConflictRow suites**

Run:
```bash
cd packages/vhhealth_core && flutter test test/order_conflict_ux_test.dart test/mar_conflict_ux_test.dart
```
Expected: both PASS (order branch added; MAR + generic behavior unchanged).

- [ ] **Step 7: Analyze + commit**

```bash
cd packages/vhhealth_core && flutter analyze
```
Expected: clean. Then:
```bash
git add packages/vhhealth_core/lib/widgets/offline_sync_badge.dart \
        packages/vhhealth_core/test/order_conflict_ux_test.dart
git commit -m "feat(sync-ux): clinical conflict framing + confirm-on-discard for /emr/orders

A discarded medication-order conflict = an ordered drug that was never ordered.
ConflictRow now detects /emr/orders, shows 'not placed on the server — review
needed', and gates Discard behind a confirmation dialog, mirroring MAR.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Staff — extract the shared `buildInpatientMedicationOrderBody`

**Files:**
- Create: `apps/staff/lib/core/services/order_payloads.dart`
- Modify: `apps/staff/lib/core/services/medical_api_service.dart` (`createInpatientMedicationOrder`, ~line 522)
- Create: `apps/staff/test/core/services/order_payloads_test.dart`

**Context:** The drug-chart online write (`createInpatientMedicationOrder`, `medical_api_service.dart:536`) builds its `POST /emr/orders` body inline. To guarantee the offline queued body is byte-identical, extract that map into ONE pure builder both paths call. The original used Dart null-aware map entries (`'encounter_id': ?encounterId`, etc.); `if (x != null) 'key': x` produces the identical map (key present unless value is null).

- [ ] **Step 1: Write the failing builder test**

Create `apps/staff/test/core/services/order_payloads_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/order_payloads.dart';

void main() {
  test('builds the canonical medication order body; omits null optionals', () {
    final body = buildInpatientMedicationOrderBody(
      patientUid: 'p-uid',
      encounterId: 'enc-1',
      medicationName: 'Paracetamol',
      dose: '500mg',
      route: 'oral',
      frequency: 'BD',
      doseTimes: ['morning', 'night'],
      startDate: DateTime.utc(2026, 6, 27, 9),
    );
    expect(body['patient_uid'], 'p-uid');
    expect(body['encounter_id'], 'enc-1');
    expect(body['order_type'], 'medication');
    expect(body['priority'], 'routine');
    expect(body['start_date'], '2026-06-27T09:00:00.000Z');
    final details = body['details'] as Map<String, dynamic>;
    expect(details['medication_name'], 'Paracetamol');
    expect(details['dose'], '500mg');
    expect(details['route'], 'oral');
    expect(details['frequency'], 'BD');
    expect(details['dose_times'], ['morning', 'night']);
    expect(details.containsKey('food_timing'), isFalse);
    expect(details.containsKey('instructions'), isFalse);
    expect(details.containsKey('duration_days'), isFalse);
  });

  test('omits encounter_id when null', () {
    final body = buildInpatientMedicationOrderBody(
      patientUid: 'p', encounterId: null, medicationName: 'X',
      dose: '1', route: 'oral', frequency: 'OD', startDate: DateTime.utc(2026),
    );
    expect(body.containsKey('encounter_id'), isFalse);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails to compile**

Run:
```bash
cd apps/staff && flutter test test/core/services/order_payloads_test.dart
```
Expected: FAIL — `order_payloads.dart` / `buildInpatientMedicationOrderBody` undefined.

- [ ] **Step 3: Create the pure builder**

Create `apps/staff/lib/core/services/order_payloads.dart`:

```dart
// lib/core/services/order_payloads.dart
//
// Pure POST /emr/orders request-body builders, shared by the online API method
// (MedicalApiService.createInpatientMedicationOrder) and the offline enqueue
// path (buildOfflineOrderIntent). Keeping the body in ONE place guarantees the
// queued offline request is byte-identical to the online one. No Flutter imports.

/// Build the POST /emr/orders body for a single inpatient MEDICATION order.
/// Field shape matches the canonical nested-`details` contract in
/// apps/backend orderRoutes.js. Optional fields are omitted when null.
Map<String, dynamic> buildInpatientMedicationOrderBody({
  required String patientUid,
  String? encounterId,
  required String medicationName,
  required String dose,
  required String route,
  required String frequency,
  int? durationDays,
  List<String>? doseTimes,
  String? foodTiming,
  String? instructions,
  String priority = 'routine',
  required DateTime startDate,
}) {
  return {
    'patient_uid': patientUid,
    if (encounterId != null) 'encounter_id': encounterId,
    'order_type': 'medication',
    'priority': priority,
    'start_date': startDate.toUtc().toIso8601String(),
    'details': {
      'medication_name': medicationName,
      'dose': dose,
      'route': route,
      'frequency': frequency,
      if (durationDays != null) 'duration_days': durationDays,
      if (doseTimes != null) 'dose_times': doseTimes,
      if (foodTiming != null) 'food_timing': foodTiming,
      if (instructions != null) 'instructions': instructions,
    },
  };
}
```

- [ ] **Step 4: Run the builder test to verify it passes**

Run:
```bash
cd apps/staff && flutter test test/core/services/order_payloads_test.dart
```
Expected: PASS.

- [ ] **Step 5: Refactor `createInpatientMedicationOrder` to call the builder**

In `apps/staff/lib/core/services/medical_api_service.dart`, add the import near the top (with the other relative imports):

```dart
import 'order_payloads.dart';
```

Replace the body of `createInpatientMedicationOrder` (lines ~536–552, the inline `_post('/emr/orders', {...})` map) with a call to the shared builder. The method signature is unchanged; only its body changes:

```dart
  static Future<Map<String, dynamic>> createInpatientMedicationOrder({
    required String patientUid,
    required String? encounterId,
    required String medicationName,
    required String dose,
    required String route,
    required String frequency,
    int? durationDays,
    List<String>? doseTimes,
    String? foodTiming,
    String? instructions,
    String priority = 'routine',
    DateTime? startDate,
  }) async {
    return _post('/emr/orders', buildInpatientMedicationOrderBody(
      patientUid: patientUid,
      encounterId: encounterId,
      medicationName: medicationName,
      dose: dose,
      route: route,
      frequency: frequency,
      durationDays: durationDays,
      doseTimes: doseTimes,
      foodTiming: foodTiming,
      instructions: instructions,
      priority: priority,
      startDate: startDate ?? DateTime.now(),
    ));
  }
```

This produces a map identical to the previous inline version (null optionals omitted, `start_date` = `(startDate ?? now).toUtc().toIso8601String()`).

- [ ] **Step 6: Analyze + run staff tests**

Run:
```bash
cd apps/staff && flutter analyze && flutter test test/core/services/order_payloads_test.dart
```
Expected: analyze clean; test passes. (If `flutter analyze` reports an unused-import or workspace-resolution error, run `flutter pub get` at the repo root first.)

- [ ] **Step 7: Commit**

```bash
git add apps/staff/lib/core/services/order_payloads.dart \
        apps/staff/lib/core/services/medical_api_service.dart \
        apps/staff/test/core/services/order_payloads_test.dart
git commit -m "refactor(staff): extract shared buildInpatientMedicationOrderBody

Single source of truth for the POST /emr/orders body so the offline queued
request is byte-identical to the online call. createInpatientMedicationOrder
now delegates to it; no behavior change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Staff — pure `buildOfflineOrderIntent` (block-on-phone invariant)

**Files:**
- Create: `apps/staff/lib/features/ipd/drug_chart_offline_order.dart`
- Create: `apps/staff/test/features/ipd/drug_chart_offline_order_test.dart`

**Context:** This is the safety core of the slice. Clinical order writes are desktop/tablet-only (`rejectMobileClinicalWrite`); the staff app's posture is `currentDeviceType` (`apps/staff/lib/core/platform_info.dart`, values `mobile|tablet|desktop|web`). The pure intent **must never enqueue when the device is phone-mode or unknown** — queuing there only 403s on drain. The body comes from the Task-4 builder, so it is byte-identical to the online write.

- [ ] **Step 1: Write the failing intent test**

Create `apps/staff/test/features/ipd/drug_chart_offline_order_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/order_payloads.dart';
import 'package:vhhealth_staff/features/ipd/drug_chart_offline_order.dart';

void main() {
  OfflineOrderIntent build(String deviceType) => buildOfflineOrderIntent(
        deviceType: deviceType,
        patientUid: 'p-uid',
        encounterId: 'enc-1',
        medicationName: 'Paracetamol',
        dose: '500mg',
        route: 'oral',
        frequency: 'BD',
        doseTimes: ['morning', 'night'],
        startDate: DateTime.utc(2026, 6, 27, 9),
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

  test('tablet enqueues with the /emr/orders endpoint', () {
    final i = build('tablet');
    expect(i.block, isFalse);
    expect(i.enqueue, isTrue);
    expect(i.endpoint, '/emr/orders');
    expect(i.reason, isNull);
  });

  test('desktop enqueues', () {
    expect(build('desktop').enqueue, isTrue);
  });

  test('queued body is byte-identical to the online builder', () {
    final i = build('tablet');
    final online = buildInpatientMedicationOrderBody(
      patientUid: 'p-uid',
      encounterId: 'enc-1',
      medicationName: 'Paracetamol',
      dose: '500mg',
      route: 'oral',
      frequency: 'BD',
      doseTimes: ['morning', 'night'],
      startDate: DateTime.utc(2026, 6, 27, 9),
    );
    expect(i.body, online);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails to compile**

Run:
```bash
cd apps/staff && flutter test test/features/ipd/drug_chart_offline_order_test.dart
```
Expected: FAIL — `drug_chart_offline_order.dart` / `buildOfflineOrderIntent` / `OfflineOrderIntent` undefined.

- [ ] **Step 3: Create the pure intent helper**

Create `apps/staff/lib/features/ipd/drug_chart_offline_order.dart`:

```dart
// lib/features/ipd/drug_chart_offline_order.dart
//
// Pure decision for the OFFLINE drug-chart medication-order path. Keeps the
// screen thin and the safety branch unit-testable.
//
// INVARIANT: a device that cannot place clinical orders (phone-mode or an
// empty/unknown deviceType) NEVER enqueues — queuing there would only 403 on
// drain (rejectMobileClinicalWrite). This mirrors the backend device gate.

import '../../core/services/order_payloads.dart';

class OfflineOrderIntent {
  const OfflineOrderIntent({
    required this.block,
    required this.enqueue,
    required this.endpoint,
    required this.body,
    required this.reason,
  });

  /// Device cannot place clinical orders → abort, do NOT enqueue.
  final bool block;

  /// Safe to queue the order create.
  final bool enqueue;

  final String endpoint;
  final Map<String, dynamic> body;

  /// User-facing block reason (null when [enqueue] is true).
  final String? reason;
}

/// Decide whether a drug-chart medication order can be queued offline and build
/// the byte-identical POST /emr/orders body. [deviceType] is the staff app's
/// current posture (`currentDeviceType`): clinical order writes are
/// desktop/tablet-only, so 'mobile' or an empty/unknown value is blocked.
OfflineOrderIntent buildOfflineOrderIntent({
  required String deviceType,
  required String patientUid,
  String? encounterId,
  required String medicationName,
  required String dose,
  required String route,
  required String frequency,
  List<String>? doseTimes,
  String? foodTiming,
  String? instructions,
  String priority = 'routine',
  required DateTime startDate,
}) {
  final dt = deviceType.trim().toLowerCase();
  final block = dt == 'mobile' || dt.isEmpty;
  return OfflineOrderIntent(
    block: block,
    enqueue: !block,
    endpoint: '/emr/orders',
    body: buildInpatientMedicationOrderBody(
      patientUid: patientUid,
      encounterId: encounterId,
      medicationName: medicationName,
      dose: dose,
      route: route,
      frequency: frequency,
      doseTimes: doseTimes,
      foodTiming: foodTiming,
      instructions: instructions,
      priority: priority,
      startDate: startDate,
    ),
    reason: block
        ? 'Medication orders can only be placed from a desktop or tablet workstation.'
        : null,
  );
}
```

- [ ] **Step 4: Run the intent test to verify it passes**

Run:
```bash
cd apps/staff && flutter test test/features/ipd/drug_chart_offline_order_test.dart
```
Expected: PASS (5 tests). The byte-identical test confirms the offline body equals the online builder output.

- [ ] **Step 5: Analyze + commit**

```bash
cd apps/staff && flutter analyze
```
Expected: clean. Then:
```bash
git add apps/staff/lib/features/ipd/drug_chart_offline_order.dart \
        apps/staff/test/features/ipd/drug_chart_offline_order_test.dart
git commit -m "feat(staff): pure buildOfflineOrderIntent (phone-mode never enqueues)

SAFETY INVARIANT: an offline drug-chart medication order is only queued from a
desktop/tablet posture; phone-mode or unknown deviceType is blocked (it would
403 on drain). Body comes from the shared builder, byte-identical to online.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Staff — wire `_saveDraftRow` offline branch + closeout

**Files:**
- Modify: `apps/staff/lib/features/ipd/screens/drug_chart_screen.dart` (`_saveDraftRow`, lines ~135–186; imports)

**Context:** `_saveDraftRow` currently always calls `MedicalApiService.createInpatientMedicationOrder` (blocking). Add an offline branch: when `ConnectivitySyncService.instance.isOnline` is false, build the intent; if blocked, toast and keep the row; else enqueue and remove the row. The online path is unchanged. Per the MAR precedent, the screen wiring itself is not widget-tested (the `ConnectivitySyncService` singleton + the screen's `initState` HTTP `_load()` are not injectable); the safety decision lives in the Task-5 pure helper, which IS fully tested. The live offline→reconnect→drain round-trip is the documented MANUAL boundary.

- [ ] **Step 1: Add imports**

In `apps/staff/lib/features/ipd/screens/drug_chart_screen.dart`, add to the import block (top of file):

```dart
import 'package:vhhealth_core/services/connectivity_sync_service.dart';

import '../../../core/platform_info.dart';
import '../drug_chart_offline_order.dart';
```

- [ ] **Step 2: Add the offline branch in `_saveDraftRow`**

Inside `_saveDraftRow`, after `setState(() => row.saving = true);` and immediately inside the `try {`, add the offline branch BEFORE the existing `await MedicalApiService.createInpatientMedicationOrder(...)` call:

```dart
    setState(() => row.saving = true);
    try {
      if (!ConnectivitySyncService.instance.isOnline) {
        final intent = buildOfflineOrderIntent(
          deviceType: currentDeviceType,
          patientUid: _text(_admission['patient_uid']),
          encounterId: _text(_admission['encounter_id']).isEmpty
              ? null
              : _text(_admission['encounter_id']),
          medicationName: drug,
          dose: dose,
          route: row.route,
          frequency: _frequencyForTimes(doseTimes),
          doseTimes: doseTimes,
          foodTiming: row.foodTiming.isEmpty ? null : row.foodTiming,
          instructions: row.notesCtrl.text.trim().isEmpty
              ? null
              : row.notesCtrl.text.trim(),
          startDate: DateTime.now(),
        );
        if (intent.block) {
          if (!mounted) return;
          _showSnack(intent.reason!, isError: true);
          return; // keep the row; NEVER enqueue on a blocked device
        }
        await ConnectivitySyncService.instance.enqueue(
          endpoint: intent.endpoint,
          method: 'POST',
          body: intent.body,
          contextLabel: 'Medication order — $drug',
        );
        if (!mounted) return;
        _removeDraftRow(row);
        _showSnack('Medication order queued — will sync when back online.');
        return;
      }
      await MedicalApiService.createInpatientMedicationOrder(
        patientUid: _text(_admission['patient_uid']),
        encounterId: _text(_admission['encounter_id']).isEmpty
            ? null
            : _text(_admission['encounter_id']),
        medicationName: drug,
        dose: dose,
        route: row.route,
        frequency: _frequencyForTimes(doseTimes),
        doseTimes: doseTimes,
        foodTiming: row.foodTiming.isEmpty ? null : row.foodTiming,
        instructions: row.notesCtrl.text.trim().isEmpty
            ? null
            : row.notesCtrl.text.trim(),
      );
      if (!mounted) return;
      _removeDraftRow(row);
      await _load();
      if (!mounted) return;
      _showSnack(AppStrings.of(context).drugChartSavedToast);
    } catch (e) {
      if (!mounted) return;
      _showSnack(e.toString().replaceFirst('Exception: ', ''), isError: true);
    } finally {
      if (mounted && _draftRows.contains(row)) {
        setState(() => row.saving = false);
      }
    }
```

(The `finally` still resets `saving` for the blocked-and-kept row; for the enqueued-and-removed row, `_draftRows.contains(row)` is false so no `setState` runs — matching the existing online success path.)

- [ ] **Step 3: Analyze the staff app**

Run:
```bash
cd apps/staff && flutter analyze
```
Expected: clean (no unused imports; `currentDeviceType`, `ConnectivitySyncService`, `buildOfflineOrderIntent` all referenced).

- [ ] **Step 4: Run the full Flutter gate (core + staff, no regressions)**

Run:
```bash
cd packages/vhhealth_core && flutter analyze && flutter test
cd ../../apps/staff && flutter analyze && flutter test
```
Expected: all green. (If workspace resolution errors appear, run `flutter pub get` at the repo root first.)

- [ ] **Step 5: Commit the wiring**

```bash
git add apps/staff/lib/features/ipd/screens/drug_chart_screen.dart
git commit -m "feat(staff): queue drug-chart medication orders offline

When offline, _saveDraftRow builds the offline intent: a blocked (phone-mode)
device toasts and keeps the row; otherwise the order is enqueued via
ConnectivitySyncService and the row clears with a 'queued — will sync' toast.
Online path unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: Final backend gate on the QA cluster**

Run:
```bash
node apps/backend/scripts/qa-cluster-up.mjs
cd apps/backend && npm run lint
TEST_DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test \
  node --experimental-vm-modules node_modules/jest/bin/jest.js cpoe-order-idempotency emr-contract --forceExit
```
Expected: lint clean; both suites green.

- [ ] **Step 7: Closeout (use superpowers:finishing-a-development-branch)**

After the final reviewer approves:
1. Merge `feat/offline-cpoe` `--no-ff` to `main`.
2. Push **both** remotes: `git push github main` and `git push origin main`.
3. Delete the branch.
4. Tick ROADMAP §9 — slice 2 (drug-chart medication orders offline) DONE.
5. Update the `project_vh_health_offline_clinical_writes` memory (slice-2 SHA + the `dispositionForStatus` and `buildOfflineOrderIntent`/`buildInpatientMedicationOrderBody` learnings; note the `required:true` flip is scoped to `POST /orders`).

**Deploy stays HELD** — plain pushes don't deploy; only tags publish images. The live offline→reconnect→drain round-trip is verified MANUALLY (no airplane-mode in CI).

---

## Honest boundaries / out of scope

- **Manual-only:** the live offline → reconnect → drain round-trip (no airplane-mode in CI). Automated tests cover the classifier, the conflict UX, the body builder, and the block-on-phone intent + the backend idempotency contract.
- **Not screen-tested:** `_saveDraftRow`'s offline glue (the `ConnectivitySyncService` singleton + `initState`'s HTTP `_load()` are not injectable). The safety decision is in the Task-5 pure helper, which is fully tested — same approach as the MAR slice.
- **Follow-ons:** CPOE composer offline (`/orders/bulk` atomic partial-failure), non-medication order types, offline allergy pre-warn (needs MAR-style cache priming), `deviceType`-on-refresh regression test (refresh already preserves it).
