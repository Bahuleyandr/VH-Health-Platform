import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/nursing/mar_offline_administer.dart';

void main() {
  final pid = 'a1b2c3d4-0000-4000-8000-000000000001';
  final cachedDose = {
    'id': 11,
    'patient_uid': pid,
    'medication_name': 'Paracetamol',
    'dose': '500mg',
    'route': 'oral',
    // Within the 60-min window of the matching test's `at` (10:15Z) so the
    // time-right passes deterministically (not wall-clock dependent).
    'scheduled_time': '2026-06-27T10:00:00.000Z',
    'status': 'scheduled',
  };

  test('offline: a matching scan produces an enqueue intent with administered_at', () {
    final intent = buildOfflineAdministerIntent(
      dose: cachedDose,
      scannedPatientUid: pid,
      scannedBarcode: 'Paracetamol',
      at: DateTime.parse('2026-06-27T10:15:00Z'),
    );
    expect(intent.hardStop, isFalse);
    expect(intent.enqueue, isTrue);
    expect(intent.endpoint, '/clinical/mar/11/administer-with-scan');
    expect(intent.body['administered_at'], '2026-06-27T10:15:00.000Z');
    expect(intent.body['scanned_patient_uid'], pid);
  });

  test('offline: a patient/drug mismatch is a hard-stop — no enqueue', () {
    final intent = buildOfflineAdministerIntent(
      dose: cachedDose,
      scannedPatientUid: 'ffffffff-0000-4000-8000-000000000099',
      scannedBarcode: 'Paracetamol',
      at: DateTime.now().toUtc(),
    );
    expect(intent.hardStop, isTrue);
    expect(intent.enqueue, isFalse);
  });

  test('offline: a soft-fail (time outside window) without an override does NOT enqueue', () {
    // at is 120 min after scheduled → time-right fails (>60). Patient + drug
    // still match, so it is a soft-fail (not a hard-stop) — and without a valid
    // override reason it must NOT auto-enqueue (the UI must collect the reason).
    final intent = buildOfflineAdministerIntent(
      dose: cachedDose,
      scannedPatientUid: pid,
      scannedBarcode: 'Paracetamol',
      at: DateTime.parse('2026-06-27T12:00:00Z'),
    );
    expect(intent.rights.time, isFalse);
    expect(intent.hardStop, isFalse);
    expect(intent.enqueue, isFalse);
  });

  test('offline: a soft-fail WITH a valid override enqueues + carries the reason', () {
    final intent = buildOfflineAdministerIntent(
      dose: cachedDose,
      scannedPatientUid: pid,
      scannedBarcode: 'Paracetamol',
      at: DateTime.parse('2026-06-27T12:00:00Z'),
      overrideReason: 'Late administration documented per charge nurse',
    );
    expect(intent.hardStop, isFalse);
    expect(intent.enqueue, isTrue);
    expect(intent.body['override_reason'], 'Late administration documented per charge nurse');
    expect(intent.body['administered_at'], '2026-06-27T12:00:00.000Z');
  });
}
