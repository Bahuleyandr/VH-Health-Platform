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

  test(
    'offline: a matching scan may use paper fallback but never builds replay',
    () {
      final intent = buildOfflineAdministerIntent(
        dose: cachedDose,
        scannedPatientUid: pid,
        scannedBarcode: 'Paracetamol',
        at: DateTime.parse('2026-06-27T10:15:00Z'),
      );
      expect(intent.hardStop, isFalse);
      expect(intent.showPaperFallback, isTrue);
    },
  );

  test('offline: a patient/drug mismatch blocks the paper fallback', () {
    final intent = buildOfflineAdministerIntent(
      dose: cachedDose,
      scannedPatientUid: 'ffffffff-0000-4000-8000-000000000099',
      scannedBarcode: 'Paracetamol',
      at: DateTime.now().toUtc(),
    );
    expect(intent.hardStop, isTrue);
    expect(intent.showPaperFallback, isFalse);
  });

  test('offline: a soft-right failure routes directly to paper fallback', () {
    // at is 120 min after scheduled, so the time right fails. Patient and drug
    // still match, so C0A routes to paper without an electronic override.
    final intent = buildOfflineAdministerIntent(
      dose: cachedDose,
      scannedPatientUid: pid,
      scannedBarcode: 'Paracetamol',
      at: DateTime.parse('2026-06-27T12:00:00Z'),
    );
    expect(intent.rights.time, isFalse);
    expect(intent.hardStop, isFalse);
    expect(intent.showPaperFallback, isTrue);
  });
}
