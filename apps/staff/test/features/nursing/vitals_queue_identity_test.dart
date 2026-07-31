import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/offline_action_ids.dart';
import 'package:vhhealth_staff/features/nursing/screens/vitals_screen.dart';

void main() {
  test('vitals compatibility intent has one frozen identity projection', () {
    final body = <String, dynamic>{
      'patient_id': 42,
      'record_type': 'VITALS',
      'vital_signs': {
        'blood_pressure': {'systolic': 120, 'diastolic': 80},
        'pulse': 72,
      },
      'recorded_by': 7,
    };

    final intent = VitalsOfflineQueueIntent.fromBody(body);

    expect(VitalsOfflineQueueIntent.endpoint, '/health/records');
    expect(VitalsOfflineQueueIntent.method, 'POST');
    expect(intent.actionId, OfflineActionIds.vitalsCapture);
    expect(intent.body, body);
    expect(
      () => intent.body['patient_id'] = 99,
      throwsUnsupportedError,
      reason: 'the queued snapshot must not be mutable after construction',
    );
  });
}
