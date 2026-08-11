import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/patient_notification_privacy.dart';

void main() {
  test('remote display text never reaches the patient lock screen', () {
    final copy = patientLockScreenCopy(
      remoteTitle: 'Appointment with Dr. Rao',
      remoteBody: 'Alex, biopsy at 10:30. Token 42.',
      payload: const {
        'title': 'Injected title',
        'body': 'Injected clinical detail',
      },
    );

    expect(copy.title, 'VH Health');
    expect(copy.body, 'You have a new update. Open the app to view it.');
    expect(copy.title, isNot(contains('Rao')));
    expect(copy.body, isNot(contains('Alex')));
    expect(copy.body, isNot(contains('biopsy')));
    expect(copy.body, isNot(contains('42')));
  });

  test('display fields are removed from the notification tap payload', () {
    final payload = patientNotificationPayload({
      'title': 'Appointment with Dr. Rao',
      'body': 'Alex, biopsy at 10:30. Token 42.',
      'type': 'appointment_reminder',
      'appointment_id': 72,
    });

    expect(payload, {'type': 'appointment_reminder', 'appointment_id': '72'});
  });
}
