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
      patientUid: 'p',
      encounterId: null,
      medicationName: 'X',
      dose: '1',
      route: 'oral',
      frequency: 'OD',
      startDate: DateTime.utc(2026),
    );
    expect(body.containsKey('encounter_id'), isFalse);
  });
}
