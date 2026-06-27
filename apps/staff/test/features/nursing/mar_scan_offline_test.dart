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
}
