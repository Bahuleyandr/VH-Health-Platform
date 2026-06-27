# Offline-First MAR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bedside MAR administration work offline — cache due doses, run the 5-rights check client-side, queue the administer write — without losing the safety check or risking a double-administration.

**Architecture:** Reuse the existing `vhhealth_core` offline stack (`ConnectivitySyncService`/`OfflineQueue`/idempotency/`SyncStatusSheet`). Add a shared encrypted-blob codec, an encrypted MAR due-dose cache, a pure client-side 5-rights port, an `administered_at` bedside-time accommodation on the backend, and wire the MAR screen to verify-from-cache + enqueue when offline.

**Tech Stack:** Flutter 3.41 / Dart (packages/vhhealth_core + apps/staff), Jest (backend, QA cluster), the `encrypt` (AES-GCM) + `flutter_secure_storage` + `sqflite` packages.

**Spec:** `docs/superpowers/specs/2026-06-27-offline-mar-design.md`
**Branch:** `feat/offline-mar` (created; spec committed `6a285437`).

**Grounded facts (verified — do not re-derive):**
- `ConnectivitySyncService.instance.enqueue({required String endpoint, required String method, required Map<String,dynamic> body, String? contextLabel}) → Future<int>` (`packages/vhhealth_core/lib/services/connectivity_sync_service.dart:87`). It mints the idempotency key internally (via `OfflineQueue.enqueue` → `IdempotencyKey.generate()`); the body is AES-256-GCM encrypted at the queue layer. Observable getters: `isOnline`, `isSyncing`, `pendingCount`, `conflictCount`; methods `discardConflict(int id)`, `retryConflict(int id)`, `syncPending()`.
- AES-GCM pattern (`offline_queue.dart:55-97`): `encrypt.IV.fromSecureRandom(12)` + `encrypt.AES(key, mode: encrypt.AESMode.gcm)`, format `iv_base64:ciphertext_base64`; key = 32 random bytes base64 in `VHSecureStorage.instance` under a named key.
- `VHSecureStorage.instance` is a `FlutterSecureStorage` → `.read(key:)` / `.write(key:, value:)`.
- `MedicalApiService.administerWithScan({required int maId, required String scannedPatientUid, required String scannedBarcode, String? overrideReason})` → `POST /clinical/mar/$maId/administer-with-scan` body `{scanned_patient_uid, scanned_barcode, override_reason?}` (`apps/staff/lib/core/services/medical_api_service.dart:453`). `getDueMedications(...)` → `GET /clinical/mar/due` returns rows `{id, patient_uid, medication_name, dose, dosage, route, scheduled_time, status, ...}` (the cache source; the screen takes `maId` from a due row).
- `MarScanScreen._administer({String? overrideReason})` (`mar_scan_screen.dart:108`) calls `administerWithScan` then `setState(() => _step = _Step.done)`; `_runVerify()` (line 86) calls `verify5Rights`; `marIsIdentityMismatch(rights)` (line 43) = `rights['patient']==false || rights['drug']==false`.
- Backend `evaluate5Rights({ma_id, scanned_patient_uid, scanned_barcode, windowMinutes=60})` computes `minutes_from_scheduled` via SQL `(CURRENT_TIMESTAMP AT TIME ZONE …) - scheduled_time`; `rightTime = Math.abs(minutesFromScheduled) <= windowMinutes`. `administerWithScan({ma_id, scanned_patient_uid, scanned_barcode, administeredBy, overrideReason, tenantId, windowMinutes})` hard-stops on `!rights.patient`/`!rights.drug`, gates `!allPassed && !overrideReason`, then UPDATEs `administered_at=NOW()`, `patient_scanned_at=NOW()`, `medication_scanned_at=NOW()` (`marFiveRightsService.js:178-326`). Dedup: row-id FSM (`status='scheduled'→'administered'`) + `uniq_mar_administered_dose` (mig 327) — UNCHANGED by this slice.
- Flutter tests: `flutter_test`, `TestWidgetsFlutterBinding.ensureInitialized()`, MethodChannel fake for secure storage (`auth_service_test.dart:5`), `MockClient` for http. Run: `cd packages/vhhealth_core && flutter test` / `cd apps/staff && flutter test` (or `melos run test` / `melos run analyze` at repo root).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/vhhealth_core/lib/services/secure_blob.dart` | **Create.** Shared AES-256-GCM encrypt/decrypt for a named secure-storage key (so the cache reuses the queue's proven crypto pattern, not a 2nd impl). | 1 |
| `packages/vhhealth_core/lib/services/mar_offline_cache.dart` | **Create.** Encrypted MAR due-dose cache (cacheDueDoses / getCachedDose / getCachedDoses + cached_at), keyed by patient. | 2 |
| `packages/vhhealth_core/lib/services/mar_five_rights.dart` | **Create.** Pure client-side `evaluateFiveRights` — the offline safety check. | 3 |
| `apps/backend/src/services/clinical/marFiveRightsService.js` | **Modify.** `evaluate5Rights` + `administerWithScan` accept optional `administeredAt`. | 4 |
| `apps/backend/src/routes/clinical/clinicalRoutes.js` | **Modify.** Thread `req.body.administered_at` into `administerWithScan`. | 4 |
| `apps/staff/lib/core/services/medical_api_service.dart` | **Modify.** `administerWithScan` gains `DateTime? administeredAt`. | 5 |
| `apps/staff/lib/features/nursing/screens/mar_scan_screen.dart` | **Modify.** Offline path: verify-from-cache + enqueue + "pending sync". | 5 |
| `packages/vhhealth_core/lib/widgets/offline_sync_badge.dart` | **Modify.** MAR-aware conflict message + confirm-on-discard in `SyncStatusSheet`. | 6 |
| `packages/vhhealth_core/test/secure_blob_test.dart`, `mar_offline_cache_test.dart`, `mar_five_rights_test.dart` | **Create.** Dart unit tests. | 1,2,3 |
| `apps/staff/test/features/nursing/mar_scan_offline_test.dart` | **Create.** Widget/flow test (mocked seam + forced offline). | 5 |
| `apps/backend/src/tests/mar-administered-at.deep.test.js` | **Create.** Backend deep test (QA cluster). | 4 |

---

## Task 1: Shared encrypted-blob codec

**Files:** Create `packages/vhhealth_core/lib/services/secure_blob.dart` + `test/secure_blob_test.dart`.

- [ ] **Step 1: Write the failing test**

```dart
// packages/vhhealth_core/test/secure_blob_test.dart
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/secure_blob.dart';

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final Map<String, String> store = {};
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
    final args = Map<String, dynamic>.from(call.arguments as Map);
    switch (call.method) {
      case 'read':
        return store[args['key']];
      case 'write':
        store[args['key']] = args['value'] as String;
        return null;
      case 'delete':
        store.remove(args['key']);
        return null;
      default:
        return null;
    }
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(_installSecureStorageFake);

  test('encrypt → decrypt round-trips and produces iv:ciphertext', () async {
    final codec = SecureBlobCodec('mar_cache_aes_key_test');
    final enc = await codec.encrypt('{"hello":"world"}');
    expect(enc.split(':').length, 2);
    expect(enc, isNot(contains('hello'))); // not plaintext
    expect(await codec.decrypt(enc), '{"hello":"world"}');
  });

  test('a tampered ciphertext fails to decrypt (GCM auth)', () async {
    final codec = SecureBlobCodec('mar_cache_aes_key_test');
    final enc = await codec.encrypt('secret');
    final parts = enc.split(':');
    final tampered = '${parts[0]}:${parts[1].substring(0, parts[1].length - 2)}AA';
    expect(() => codec.decrypt(tampered), throwsA(anything));
  });
}
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd packages/vhhealth_core && flutter test test/secure_blob_test.dart`
Expected: FAIL — `secure_blob.dart` not found.

- [ ] **Step 3: Implement**

```dart
// packages/vhhealth_core/lib/services/secure_blob.dart
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:encrypt/encrypt.dart' as encrypt;
import 'secure_storage.dart';

/// AES-256-GCM encrypt/decrypt for a named secure-storage key. Mirrors the
/// proven pattern in OfflineQueue (random 12-byte IV, `iv_base64:ciphertext`
/// envelope) so encrypted-at-rest clinical caches reuse one audited impl
/// instead of a second copy. The 256-bit key is generated once per [keyName]
/// and stored in the platform keychain via VHSecureStorage.
class SecureBlobCodec {
  SecureBlobCodec(this.keyName);
  final String keyName;
  encrypt.Key? _cached;

  Future<encrypt.Key> _key() async {
    if (_cached != null) return _cached!;
    final storage = VHSecureStorage.instance;
    var b64 = await storage.read(key: keyName);
    if (b64 == null) {
      final rnd = Random.secure();
      final bytes = Uint8List(32);
      for (var i = 0; i < 32; i++) {
        bytes[i] = rnd.nextInt(256);
      }
      b64 = base64Encode(bytes);
      await storage.write(key: keyName, value: b64);
    }
    _cached = encrypt.Key.fromBase64(b64);
    return _cached!;
  }

  Future<String> encrypt_(String plaintext) async {
    final key = await _key();
    final iv = encrypt.IV.fromSecureRandom(12);
    final enc = encrypt.Encrypter(encrypt.AES(key, mode: encrypt.AESMode.gcm));
    final ct = enc.encrypt(plaintext, iv: iv);
    return '${iv.base64}:${ct.base64}';
  }

  // Public names (encrypt/decrypt) wrap the impl to keep call sites clean.
  Future<String> encrypt(String plaintext) => encrypt_(plaintext);

  Future<String> decrypt(String envelope) async {
    final key = await _key();
    final parts = envelope.split(':');
    if (parts.length != 2) throw const FormatException('Invalid encrypted data');
    final iv = encrypt.IV.fromBase64(parts[0]);
    final enc = encrypt.Encrypter(encrypt.AES(key, mode: encrypt.AESMode.gcm));
    return enc.decrypt(encrypt.Encrypted.fromBase64(parts[1]), iv: iv);
  }
}
```

(Note: if `encrypt` as a method name collides awkwardly with the `encrypt` package import alias, keep the import alias `as encrypt` and the public method `encrypt` — Dart resolves the method on the instance vs the library prefix without conflict. If the analyzer complains, rename the public methods to `seal`/`open` and update the test + Task 2 call sites consistently.)

- [ ] **Step 4: Run, verify it passes**

Run: `cd packages/vhhealth_core && flutter test test/secure_blob_test.dart` → PASS (2 tests). Then `flutter analyze lib/services/secure_blob.dart`.

- [ ] **Step 5: Commit**

```bash
git add packages/vhhealth_core/lib/services/secure_blob.dart packages/vhhealth_core/test/secure_blob_test.dart
git commit -m "feat(core): SecureBlobCodec — shared AES-256-GCM encrypt/decrypt for named-key clinical caches"
```

(Follow-up, NOT this slice: migrate `OfflineQueue` onto `SecureBlobCodec` to drop its inline copy — left out to avoid touching the proven queue in the first offline slice.)

---

## Task 2: MAR due-dose cache

**Files:** Create `packages/vhhealth_core/lib/services/mar_offline_cache.dart` + `test/mar_offline_cache_test.dart`.

- [ ] **Step 1: Write the failing test**

```dart
// packages/vhhealth_core/test/mar_offline_cache_test.dart
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/mar_offline_cache.dart';

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final Map<String, String> store = {};
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
    final args = Map<String, dynamic>.from(call.arguments as Map);
    switch (call.method) {
      case 'read':
        return store[args['key']];
      case 'write':
        store[args['key']] = args['value'] as String;
        return null;
      case 'delete':
        store.remove(args['key']);
        return null;
      default:
        return null;
    }
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(_installSecureStorageFake);

  final patientUid = 'a1b2c3d4-0000-4000-8000-000000000001';
  final doses = [
    {'id': 11, 'patient_uid': patientUid, 'medication_name': 'Paracetamol', 'dose': '500mg', 'route': 'oral', 'scheduled_time': '2026-06-27T10:00:00Z', 'status': 'scheduled'},
    {'id': 12, 'patient_uid': patientUid, 'medication_name': 'Amoxicillin', 'dose': '250mg', 'route': 'oral', 'scheduled_time': '2026-06-27T12:00:00Z', 'status': 'scheduled'},
  ];

  test('cache → read round-trips encrypted + getCachedDose finds by maId', () async {
    await MarOfflineCache.cacheDueDoses(patientUid, doses);
    final got = await MarOfflineCache.getCachedDose(patientUid, 11);
    expect(got, isNotNull);
    expect(got!['medication_name'], 'Paracetamol');
    final all = await MarOfflineCache.getCachedDoses(patientUid);
    expect(all.length, 2);
  });

  test('getCachedDose returns null for an unknown maId', () async {
    await MarOfflineCache.cacheDueDoses(patientUid, doses);
    expect(await MarOfflineCache.getCachedDose(patientUid, 999), isNull);
  });

  test('cachedAt reflects the last cache write', () async {
    await MarOfflineCache.cacheDueDoses(patientUid, doses);
    final at = await MarOfflineCache.cachedAt(patientUid);
    expect(at, isNotNull);
  });
}
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd packages/vhhealth_core && flutter test test/mar_offline_cache_test.dart` → FAIL (module not found).

- [ ] **Step 3: Implement**

```dart
// packages/vhhealth_core/lib/services/mar_offline_cache.dart
import 'dart:convert';
import 'auth_service.dart';
import 'secure_blob.dart';
import 'secure_storage.dart';

/// Encrypted-at-rest cache of a patient's due MAR doses, so the bedside flow can
/// run the 5-rights check offline (see MarFiveRights). Keyed by the current
/// staff id + patient so a shared ward device never serves one nurse another's
/// cached snapshot. Read-only snapshot: the server stays authoritative; on drain
/// the queued administer is re-verified server-side.
class MarOfflineCache {
  static final SecureBlobCodec _codec = SecureBlobCodec('mar_offline_cache_aes_key');

  static Future<String> _key(String patientUid) async {
    final staffId = await AuthService.getStaffId();
    return 'mar_cache:${staffId ?? "anon"}:$patientUid';
  }

  /// Persist the patient's due-dose rows (from GET /clinical/mar/due or
  /// /clinical/mar/patient/{uid}). Overwrites the prior snapshot.
  static Future<void> cacheDueDoses(String patientUid, List<Map<String, dynamic>> doses) async {
    final envelope = {
      'cached_at': DateTime.now().toUtc().toIso8601String(),
      'doses': doses,
    };
    final blob = await _codec.encrypt(jsonEncode(envelope));
    await VHSecureStorage.instance.write(key: await _key(patientUid), value: blob);
  }

  static Future<Map<String, dynamic>?> _readEnvelope(String patientUid) async {
    final blob = await VHSecureStorage.instance.read(key: await _key(patientUid));
    if (blob == null) return null;
    try {
      return jsonDecode(await _codec.decrypt(blob)) as Map<String, dynamic>;
    } catch (_) {
      return null; // corrupt/key-rotated → treat as no cache
    }
  }

  static Future<List<Map<String, dynamic>>> getCachedDoses(String patientUid) async {
    final env = await _readEnvelope(patientUid);
    if (env == null) return const [];
    return (env['doses'] as List).cast<Map<String, dynamic>>();
  }

  static Future<Map<String, dynamic>?> getCachedDose(String patientUid, int maId) async {
    for (final d in await getCachedDoses(patientUid)) {
      if (d['id'] == maId) return d;
    }
    return null;
  }

  static Future<DateTime?> cachedAt(String patientUid) async {
    final env = await _readEnvelope(patientUid);
    final s = env?['cached_at'] as String?;
    return s == null ? null : DateTime.tryParse(s);
  }
}
```

(Verify `AuthService.getStaffId()` exists — it is used by `OfflineQueue.enqueue` (`offline_queue.dart:188`). If its name differs, match the real one.)

- [ ] **Step 4: Run + analyze** → PASS (3 tests); `flutter analyze lib/services/mar_offline_cache.dart`.
- [ ] **Step 5: Commit**

```bash
git add packages/vhhealth_core/lib/services/mar_offline_cache.dart packages/vhhealth_core/test/mar_offline_cache_test.dart
git commit -m "feat(core): MarOfflineCache — encrypted, staff-scoped cache of a patient's due MAR doses"
```

---

## Task 3: Client-side 5-rights (the offline safety check)

**Files:** Create `packages/vhhealth_core/lib/services/mar_five_rights.dart` + `test/mar_five_rights_test.dart`.

- [ ] **Step 1: Write the failing test** (parity with the server algorithm)

```dart
// packages/vhhealth_core/test/mar_five_rights_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/mar_five_rights.dart';

void main() {
  final pid = 'A1B2C3D4-0000-4000-8000-000000000001';
  Map<String, dynamic> dose({String name = 'Paracetamol', String? d = '500mg', String? route = 'oral', String? sched}) => {
        'id': 11,
        'patient_uid': pid,
        'medication_name': name,
        'dose': d,
        'route': route,
        'scheduled_time': sched ?? DateTime.now().toUtc().toIso8601String(),
        'status': 'scheduled',
      };

  test('all rights pass for a matching scan within window', () {
    final r = evaluateFiveRights(dose: dose(), scannedPatientUid: pid.toLowerCase(), scannedBarcode: 'Paracetamol', at: DateTime.now().toUtc());
    expect(r.patient, isTrue);
    expect(r.drug, isTrue);
    expect(r.dose, isTrue);
    expect(r.route, isTrue);
    expect(r.time, isTrue);
    expect(r.allPassed, isTrue);
  });

  test('patient mismatch is a hard-stop (allPassed false)', () {
    final r = evaluateFiveRights(dose: dose(), scannedPatientUid: 'ffffffff-0000-4000-8000-000000000099', scannedBarcode: 'Paracetamol', at: DateTime.now().toUtc());
    expect(r.patient, isFalse);
    expect(r.allPassed, isFalse);
  });

  test('drug name substring matches either direction', () {
    expect(evaluateFiveRights(dose: dose(name: 'Paracetamol 500'), scannedPatientUid: pid, scannedBarcode: 'paracetamol', at: DateTime.now().toUtc()).drug, isTrue);
    expect(evaluateFiveRights(dose: dose(name: 'Para'), scannedPatientUid: pid, scannedBarcode: 'Paracetamol', at: DateTime.now().toUtc()).drug, isTrue);
    expect(evaluateFiveRights(dose: dose(name: 'Ibuprofen'), scannedPatientUid: pid, scannedBarcode: 'Paracetamol', at: DateTime.now().toUtc()).drug, isFalse);
  });

  test('dose falls back to dosage; route presence; time window 60 min', () {
    expect(evaluateFiveRights(dose: {...dose(d: null), 'dosage': '500mg'}, scannedPatientUid: pid, scannedBarcode: 'Paracetamol', at: DateTime.now().toUtc()).dose, isTrue);
    expect(evaluateFiveRights(dose: dose(route: null), scannedPatientUid: pid, scannedBarcode: 'Paracetamol', at: DateTime.now().toUtc()).route, isFalse);
    final sched = DateTime.now().toUtc();
    expect(evaluateFiveRights(dose: dose(sched: sched.toIso8601String()), scannedPatientUid: pid, scannedBarcode: 'Paracetamol', at: sched.add(const Duration(minutes: 90))).time, isFalse);
    expect(evaluateFiveRights(dose: dose(sched: sched.toIso8601String()), scannedPatientUid: pid, scannedBarcode: 'Paracetamol', at: sched.add(const Duration(minutes: 30))).time, isTrue);
  });
}
```

- [ ] **Step 2: Run, verify FAIL** (`cd packages/vhhealth_core && flutter test test/mar_five_rights_test.dart`).

- [ ] **Step 3: Implement** (faithful port of `marFiveRightsService.js` evaluate5Rights)

```dart
// packages/vhhealth_core/lib/services/mar_five_rights.dart
/// Client-side 5-rights for OFFLINE bedside MAR. A faithful port of the server's
/// evaluate5Rights (apps/backend/src/services/clinical/marFiveRightsService.js)
/// so a nurse gets the SAME safety check offline. The server re-verifies fully on
/// drain. Fidelity note: the server's `vhmp-` pack-barcode drug match needs a
/// pharmacy lookup unavailable offline, so offline drug-right is name-match ONLY
/// (never stronger than online).
const int kFiveRightsWindowMinutes = 60;

String _norm(String? s) => (s ?? '').trim().toLowerCase();

class FiveRights {
  const FiveRights({required this.patient, required this.drug, required this.dose, required this.route, required this.time});
  final bool patient, drug, dose, route, time;
  bool get allPassed => patient && drug && dose && route && time;
  Map<String, bool> toMap() => {'patient': patient, 'drug': drug, 'dose': dose, 'route': route, 'time': time};
}

/// [dose] is a cached MAR row (id, patient_uid, medication_name, dose|dosage,
/// route, scheduled_time). [at] is the bedside time (used for the time-right and
/// later sent as administered_at). [windowMinutes] defaults to the server's 60.
FiveRights evaluateFiveRights({
  required Map<String, dynamic> dose,
  required String scannedPatientUid,
  required String scannedBarcode,
  required DateTime at,
  int windowMinutes = kFiveRightsWindowMinutes,
}) {
  final rightPatient = _norm(dose['patient_uid'] as String?) == _norm(scannedPatientUid);

  final medName = _norm(dose['medication_name'] as String?);
  final scanned = _norm(scannedBarcode);
  final rightDrug = medName.isNotEmpty && (medName.contains(scanned) || scanned.contains(medName));

  final doseStr = dose['dose'] as String? ?? dose['dosage'] as String?;
  final rightDose = doseStr != null && doseStr.trim().isNotEmpty;

  final routeStr = dose['route'] as String?;
  final rightRoute = routeStr != null && routeStr.trim().isNotEmpty;

  var rightTime = true;
  final schedStr = dose['scheduled_time'] as String?;
  final sched = schedStr == null ? null : DateTime.tryParse(schedStr);
  if (sched != null) {
    final minutes = at.toUtc().difference(sched.toUtc()).inMinutes;
    rightTime = minutes.abs() <= windowMinutes;
  }

  return FiveRights(patient: rightPatient, drug: rightDrug, dose: rightDose, route: rightRoute, time: rightTime);
}
```

- [ ] **Step 4: Run + analyze** → PASS; `flutter analyze lib/services/mar_five_rights.dart`.
- [ ] **Step 5: Commit**

```bash
git add packages/vhhealth_core/lib/services/mar_five_rights.dart packages/vhhealth_core/test/mar_five_rights_test.dart
git commit -m "feat(core): client-side 5-rights for offline MAR (faithful port of server evaluate5Rights)"
```

---

## Task 4: Backend — bedside-time accommodation + deep test

**Files:** Modify `apps/backend/src/services/clinical/marFiveRightsService.js` + `src/routes/clinical/clinicalRoutes.js`; create `src/tests/mar-administered-at.deep.test.js`. Run from `apps/backend`. QA cluster up via `node scripts/qa-cluster-up.mjs`.

- [ ] **Step 1: Write the failing deep test**

```js
// src/tests/mar-administered-at.deep.test.js
// administer-with-scan accepts an optional administered_at (the bedside time an
// offline dose was actually given). The time-right is evaluated against it (not
// drain-time), and it is recorded as administered_at — so a dose given offline
// at T but drained later records T and isn't spuriously time-rejected. Re-send
// dedup is unchanged (uniq_mar_administered_dose).
import { randomUUID } from 'crypto';
const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;
const prisma = (await import('../lib/prisma.js')).default;
const { administerWithScan } = await import('../services/clinical/marFiveRightsService.js');

const TENANT = randomUUID();
const PATIENT = randomUUID();
const NURSE = randomUUID();
const PHONE = `+9197${String(Math.floor(Math.random()*1e8)).padStart(8,'0')}`;
let maId;

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM medication_administrations WHERE patient_uid=$1::uuid`, PATIENT).catch(()=>{});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid)`, PATIENT, NURSE).catch(()=>{});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id=$1::uuid`, TENANT).catch(()=>{});
}

d('MAR administer-with-scan bedside administered_at', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(`INSERT INTO tenants (id,slug,name) VALUES ($1::uuid,$2,'MAR AdmAt') ON CONFLICT (id) DO NOTHING`, TENANT, `maradmat-${TENANT.slice(0,8)}`);
    await prisma.$executeRawUnsafe(`INSERT INTO users (uid,phone,name,role,is_active,tenant_id,updated_at) VALUES ($1::uuid,$2,'P','PATIENT',true,$3::uuid,NOW())`, PATIENT, PHONE, TENANT);
    await prisma.$executeRawUnsafe(`INSERT INTO users (uid,phone,name,role,is_active,tenant_id,updated_at) VALUES ($1::uuid,$2,'N','NURSING_STAFF',true,$3::uuid,NOW())`, NURSE, `${PHONE}1`, TENANT);
  }, 60_000);
  afterAll(async () => { await cleanup(); await prisma.$disconnect().catch(()=>{}); });

  async function seedDose(scheduledOffsetMin) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations (patient_uid, medication_name, dose, route, scheduled_time, status, tenant_id)
       VALUES ($1::uuid,'Paracetamol','500mg','oral', NOW() + ($2 || ' minutes')::interval, 'scheduled', $3::uuid) RETURNING id`,
      PATIENT, String(scheduledOffsetMin), TENANT);
    return rows[0].id;
  }

  it('records the passed bedside time + evaluates time-right against it', async () => {
    // Dose scheduled 90 min ago → at drain-time NOW() the time-right would FAIL
    // (>60). But administered_at = 30 min after scheduled (within window) → passes.
    maId = await seedDose(-90);
    const scheduled = (await prisma.$queryRawUnsafe(`SELECT scheduled_time FROM medication_administrations WHERE id=$1`, maId))[0].scheduled_time;
    const bedsideAt = new Date(new Date(scheduled).getTime() + 30 * 60_000).toISOString();
    const rec = await administerWithScan({
      ma_id: maId, scanned_patient_uid: PATIENT, scanned_barcode: 'Paracetamol',
      administeredBy: NURSE, tenantId: TENANT, administeredAt: bedsideAt,
    });
    expect(rec.status).toBe('administered');
    // recorded administered_at ≈ bedsideAt (not NOW)
    expect(Math.abs(new Date(rec.administered_at).getTime() - new Date(bedsideAt).getTime())).toBeLessThan(2000);
    expect(rec.all_rights_passed).toBe(true);
  }, 30_000);

  it('rejects an absurd future administered_at', async () => {
    const id = await seedDose(0);
    const future = new Date(Date.now() + 48 * 3600_000).toISOString();
    await expect(administerWithScan({ ma_id: id, scanned_patient_uid: PATIENT, scanned_barcode: 'Paracetamol', administeredBy: NURSE, tenantId: TENANT, administeredAt: future }))
      .rejects.toThrow();
  }, 30_000);

  it('a re-send does not double-administer (dedup unchanged)', async () => {
    // maId already administered above; re-sending 409s, no second administered row.
    await expect(administerWithScan({ ma_id: maId, scanned_patient_uid: PATIENT, scanned_barcode: 'Paracetamol', administeredBy: NURSE, tenantId: TENANT }))
      .rejects.toThrow();
  }, 30_000);
});
```

- [ ] **Step 2: Run, verify FAIL** (administeredAt unsupported → administered_at ≈ NOW, not bedside): `node --experimental-vm-modules --max-old-space-size=4096 node_modules/jest/bin/jest.js --runInBand mar-administered-at --forceExit`.

- [ ] **Step 3: Implement the backend change**

In `marFiveRightsService.js`:
1. `evaluate5Rights` — add `at = null` param; when provided, compute `minutes_from_scheduled` against it. Change the SELECT's time expression to use a bound param when `at` is set:
```js
export async function evaluate5Rights({ ma_id, scanned_patient_uid, scanned_barcode, windowMinutes = DEFAULT_WINDOW_MINUTES, at = null }) {
  // ...validation...
  const atSql = at ? '$2::timestamptz' : "(CURRENT_TIMESTAMP AT TIME ZONE current_setting('TimeZone'))";
  const params = at ? [ma_id, at] : [ma_id];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, medication_name, dose, dosage, route, scheduled_time, status, tenant_id,
            CASE WHEN scheduled_time IS NULL THEN NULL
                 ELSE ROUND(EXTRACT(EPOCH FROM (${atSql} - scheduled_time)) / 60)::int END AS minutes_from_scheduled
       FROM medication_administrations WHERE id = $1`,
    ...params);
  // ...rest unchanged...
}
```
2. `administerWithScan` — add `administeredAt = null` param; bound-check it; pass `at` into `evaluate5Rights`; use it (COALESCE) in the UPDATE:
```js
export async function administerWithScan({ ma_id, scanned_patient_uid, scanned_barcode, administeredBy, overrideReason = null, tenantId = null, windowMinutes = DEFAULT_WINDOW_MINUTES, administeredAt = null }) {
  // Bound a client-supplied bedside time: not in the future, not absurdly old
  // (a bad device clock must not corrupt the record). 12h back covers a long
  // offline window; reject beyond that.
  let admAt = null;
  if (administeredAt) {
    const t = new Date(administeredAt);
    if (Number.isNaN(t.getTime())) throw AppError.badRequest('administered_at is not a valid time');
    const skewMs = Date.now() - t.getTime();
    if (skewMs < -60_000 || skewMs > 12 * 3600_000) throw AppError.badRequest('administered_at is out of the accepted range');
    admAt = t.toISOString();
  }
  const evaluation = await evaluate5Rights({ ma_id, scanned_patient_uid, scanned_barcode, windowMinutes, at: admAt });
  // ...hard-stops + gate unchanged...
  const record = await setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE medication_administrations
         SET status='administered',
             administered_at       = COALESCE($9::timestamptz, NOW()),
             administered_by       = $2::uuid,
             scanned_patient_uid   = $3::uuid,
             scanned_barcode       = $4,
             rights_passed         = $5::jsonb,
             all_rights_passed     = $6,
             override_reason       = $7,
             patient_scanned_at    = COALESCE($9::timestamptz, NOW()),
             medication_scanned_at = COALESCE($9::timestamptz, NOW())
       WHERE id = $1 AND tenant_id = $8::uuid
       RETURNING id, patient_uid, medication_name, dose, dosage, route, scheduled_time,
                 status, notes, tenant_id, created_at, updated_at,
                 administered_at, administered_by, rights_passed, all_rights_passed,
                 override_reason, patient_scanned_at, medication_scanned_at`,
      ma_id, administeredBy, scanned_patient_uid, scanned_barcode,
      JSON.stringify(evaluation.rights), evaluation.allPassed, overrideReason, tid, admAt);
    // ...recordCanonicalClinicalEvent unchanged...
    return rows[0];
  });
  return record;
}
```
In `clinicalRoutes.js`, the administer-with-scan route handler: read `administered_at` off `req.body` and pass it:
```js
const record = await marFiveRightsService.administerWithScan({
  ma_id: parseInt(id, 10), scanned_patient_uid, scanned_barcode,
  administeredBy: req.user.uid,
  overrideReason: override_reason && override_reason.trim().length >= 5 ? override_reason.trim() : null,
  tenantId: req.tenantId,
  administeredAt: req.body?.administered_at || null,
});
```
(Read the real handler first; add only the `administeredAt` line + destructure `administered_at` if needed.)

- [ ] **Step 4: Run the deep test → GREEN**; then a MAR regression: `node --experimental-vm-modules --max-old-space-size=4096 node_modules/jest/bin/jest.js --runInBand mar-administered-at mar-aliases clinical-mar-contract --forceExit` + `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/clinical/marFiveRightsService.js apps/backend/src/routes/clinical/clinicalRoutes.js apps/backend/src/tests/mar-administered-at.deep.test.js
git commit -m "feat(mar): administer-with-scan accepts a bounded bedside administered_at (offline time-right + record)"
```

---

## Task 5: Staff app — offline administer wiring

**Files:** Modify `apps/staff/lib/core/services/medical_api_service.dart` + `apps/staff/lib/features/nursing/screens/mar_scan_screen.dart`; create `apps/staff/test/features/nursing/mar_scan_offline_test.dart`.

- [ ] **Step 1: Add `administeredAt` to the API method**

```dart
// medical_api_service.dart — administerWithScan
static Future<Map<String, dynamic>> administerWithScan({
  required int maId,
  required String scannedPatientUid,
  required String scannedBarcode,
  String? overrideReason,
  DateTime? administeredAt,
}) async {
  return _post('/clinical/mar/$maId/administer-with-scan', {
    'scanned_patient_uid': scannedPatientUid,
    'scanned_barcode': scannedBarcode,
    'override_reason': ?overrideReason,
    if (administeredAt != null) 'administered_at': administeredAt.toUtc().toIso8601String(),
  });
}
```

- [ ] **Step 2: Write the failing flow test**

```dart
// apps/staff/test/features/nursing/mar_scan_offline_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/nursing/mar_offline_administer.dart';

void main() {
  final pid = 'a1b2c3d4-0000-4000-8000-000000000001';
  final cachedDose = {'id': 11, 'patient_uid': pid, 'medication_name': 'Paracetamol', 'dose': '500mg', 'route': 'oral', 'scheduled_time': DateTime.now().toUtc().toIso8601String(), 'status': 'scheduled'};

  test('offline: a matching scan produces an enqueue intent with administered_at', () {
    final intent = buildOfflineAdministerIntent(dose: cachedDose, scannedPatientUid: pid, scannedBarcode: 'Paracetamol', at: DateTime.parse('2026-06-27T10:15:00Z'));
    expect(intent.hardStop, isFalse);
    expect(intent.enqueue, isTrue);
    expect(intent.endpoint, '/clinical/mar/11/administer-with-scan');
    expect(intent.body['administered_at'], '2026-06-27T10:15:00.000Z');
    expect(intent.body['scanned_patient_uid'], pid);
  });

  test('offline: a patient/drug mismatch is a hard-stop — no enqueue', () {
    final intent = buildOfflineAdministerIntent(dose: cachedDose, scannedPatientUid: 'ffffffff-0000-4000-8000-000000000099', scannedBarcode: 'Paracetamol', at: DateTime.now().toUtc());
    expect(intent.hardStop, isTrue);
    expect(intent.enqueue, isFalse);
  });
}
```

- [ ] **Step 3: Implement a tiny pure helper** the screen + test share — `apps/staff/lib/features/nursing/mar_offline_administer.dart`:

```dart
import 'package:vhhealth_core/services/mar_five_rights.dart';

/// Pure decision for the OFFLINE administer path — keeps the screen thin and
/// the safety branch unit-testable. Hard-stop (patient/drug) → never enqueue.
class OfflineAdministerIntent {
  const OfflineAdministerIntent({required this.hardStop, required this.enqueue, required this.endpoint, required this.body, required this.rights});
  final bool hardStop;       // patient/drug mismatch → abort + re-scan
  final bool enqueue;        // safe to queue the administer
  final String endpoint;
  final Map<String, dynamic> body;
  final FiveRights rights;
}

OfflineAdministerIntent buildOfflineAdministerIntent({
  required Map<String, dynamic> dose,
  required String scannedPatientUid,
  required String scannedBarcode,
  required DateTime at,
  String? overrideReason,
}) {
  final rights = evaluateFiveRights(dose: dose, scannedPatientUid: scannedPatientUid, scannedBarcode: scannedBarcode, at: at);
  final hardStop = !rights.patient || !rights.drug;
  // Soft-fail without an override can't be auto-queued (the UI must collect a reason).
  final softBlocked = !rights.allPassed && (overrideReason == null || overrideReason.trim().length < 5);
  final maId = dose['id'];
  return OfflineAdministerIntent(
    hardStop: hardStop,
    enqueue: !hardStop && !softBlocked,
    endpoint: '/clinical/mar/$maId/administer-with-scan',
    body: {
      'scanned_patient_uid': scannedPatientUid,
      'scanned_barcode': scannedBarcode,
      if (overrideReason != null && overrideReason.trim().isNotEmpty) 'override_reason': overrideReason.trim(),
      'administered_at': at.toUtc().toIso8601String(),
    },
    rights: rights,
  );
}
```

- [ ] **Step 4: Run the flow test → GREEN** (`cd apps/staff && flutter test test/features/nursing/mar_scan_offline_test.dart`).

- [ ] **Step 5: Wire the screen** — in `mar_scan_screen.dart`, when offline (or when the online write throws a connectivity error), use the cache + `buildOfflineAdministerIntent`; on `hardStop` show the re-scan error (no enqueue); on `enqueue` call `ConnectivitySyncService.instance.enqueue(endpoint: intent.endpoint, method: 'POST', body: intent.body, contextLabel: 'MAR: ${dose['medication_name']}')` then `setState(() => _step = _Step.done)` with a "Recorded — pending sync" variant. For `_runVerify` offline, read `MarOfflineCache.getCachedDose(_patientUid!, widget.maId)` and compute `evaluateFiveRights` instead of the server call. Add an `OfflineSyncBadge` to the screen's AppBar. (Use `ConnectivitySyncService.instance.isOnline` to branch; on an online administer, also pass `administeredAt: DateTime.now()` so the recorded time is the actual bedside time even online — harmless + consistent.) Read the screen and make these edits additively; keep the online happy path intact.

- [ ] **Step 6: analyze + the staff suite** → `cd apps/staff && flutter analyze && flutter test`.
- [ ] **Step 7: Commit**

```bash
git add apps/staff/lib/core/services/medical_api_service.dart apps/staff/lib/features/nursing/mar_offline_administer.dart "apps/staff/lib/features/nursing/screens/mar_scan_screen.dart" apps/staff/test/features/nursing/mar_scan_offline_test.dart
git commit -m "feat(staff): offline MAR administer — verify from cache + enqueue with bedside administered_at"
```

---

## Task 6: MAR conflict UX + closeout

**Files:** Modify `packages/vhhealth_core/lib/widgets/offline_sync_badge.dart` (the `SyncStatusSheet`).

- [ ] **Step 1: Make MAR conflicts clinically clear + confirm-on-discard.** Read `SyncStatusSheet`. For a conflict whose `context_label`/endpoint indicates MAR (`endpoint` contains `/clinical/mar/`), render a clinical message ("This administration couldn't be recorded on the server. Review: <conflict_reason>. The medication was given offline.") and gate the Discard action behind a confirmation dialog (discarding = an un-recorded administration). Keep the generic conflict rendering for non-MAR. Add a widget test asserting: a MAR conflict shows the clinical copy + tapping Discard opens a confirm dialog (mock the `ConnectivitySyncService` conflict list).

- [ ] **Step 2: Run the badge test + analyze** (`cd packages/vhhealth_core && flutter test test/offline_sync_badge_test.dart` if one exists, else the new test; `flutter analyze`).

- [ ] **Step 3: Commit**

```bash
git add packages/vhhealth_core/lib/widgets/offline_sync_badge.dart packages/vhhealth_core/test/
git commit -m "feat(core): MAR-aware conflict copy + confirm-on-discard in the offline sync sheet"
```

- [ ] **Step 4: Full gate** — from repo root `melos run analyze` + `melos run test` (Flutter workspace) and from `apps/backend` the MAR jest + `npm run lint`. Document the MANUAL device round-trip recipe in the spec's testing section (airplane-mode a real/emulated device: cache loads online → go offline → scan + administer → "pending sync" → go online → drains → induce a server 409 [discontinue the order server-side first] → conflict surfaces). State honestly that the offline→drain round-trip is manual (no airplane-mode in CI; deploy HELD); the automated tests cover the client logic (mocked seam) + the backend change.

---

## Closeout

Use **superpowers:finishing-a-development-branch**. Verify the Flutter workspace gate (`melos run analyze` + `melos run test`) + the backend MAR jest + lint are green; merge `feat/offline-mar` to `main` `--no-ff`; push BOTH remotes; delete the branch; tick ROADMAP §0 Epic #9 + a new offline-clinical-writes memory. **Deploy stays HELD.** PR states the offline→drain round-trip is verified MANUALLY (per the recipe), and that drug-right offline is name-match-only (pack-barcode is server-only, re-verified on drain).

---

## Self-Review

**Spec coverage:** Unit 1 cache → Task 2 (+ shared codec Task 1). Unit 2 client-5-rights → Task 3. Unit 3 offline administer → Task 5 (+ the API `administeredAt` + the pure intent helper). Unit 4 backend administered_at → Task 4. Unit 5 conflict UX → Task 6. The safety principle (hard-stops never enqueue; server authoritative on drain; conflicts visible) is enforced in Task 5's `buildOfflineAdministerIntent` (hard-stop→no enqueue) + Task 6 (conflict surfacing) + Task 4 (dedup unchanged). Honest manual boundary → Task 6 Step 4 + Closeout.

**Placeholder scan:** No TBD. Task 5 Step 5 ("wire the screen … read the screen and make these edits additively") is a locate-and-integrate instruction, but the exact enqueue call, the intent helper, the cache call, and the `_step` transition are all fully specified — the screen edit is mechanical given the pure helper does the decision. The `encrypt`-method-name note in Task 1 gives a concrete fallback (`seal`/`open`).

**Type/name consistency:** `SecureBlobCodec(keyName).encrypt/decrypt` (Task 1) ← used by `MarOfflineCache` (Task 2). `evaluateFiveRights({dose, scannedPatientUid, scannedBarcode, at, windowMinutes})→FiveRights{patient,drug,dose,route,time,allPassed}` (Task 3) ← used by `buildOfflineAdministerIntent` (Task 5) + mirrors the backend (Task 4). `administeredAt`/`administered_at` is consistent across the API method (Task 5), the body, the backend param + bound (Task 4), and the deep test. `ConnectivitySyncService.instance.enqueue({endpoint, method, body, contextLabel})` matches the grounded signature.
