import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/patient_notification_privacy.dart';
import 'package:vhhealth/core/services/push_notification_service.dart';

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

  test(
    'only the typed opaque envelope reaches the notification tap payload',
    () {
      final payload = patientNotificationPayload({
        'title': 'Appointment with Dr. Rao',
        'body': 'Alex, biopsy at 10:30. Token 42.',
        'type': 'appointment_reminder',
        'appointment_id': 72,
        'token': 42,
        'prescriptionId': 91,
        'thread_id': 33,
        'deep_link': '/portal/messages/33',
        'unknown_clinical_field': 'biopsy',
        'notification_id': 'push_4de13e85-d72c-4f0f-a0dc-84fe9f47e139',
        'route': '/portal/messages/33',
        'action': 'open_record',
      });

      expect(payload, {
        'notification_id': 'push_4de13e85-d72c-4f0f-a0dc-84fe9f47e139',
        'route': '/notifications',
        'action': 'open_notification_inbox',
      });
    },
  );

  test(
    'invalid or record-shaped identifiers are dropped from the envelope',
    () {
      expect(
        patientNotificationPayload({
          'notification_id': '72',
          'event_id': 'patient-record-42',
          'route': '/portal/lab-results/72',
        }),
        {'route': '/notifications', 'action': 'open_notification_inbox'},
      );
    },
  );

  test('the push service routes the rebuilt envelope to the generic inbox', () {
    final payload = PushNotificationService.normalizePayload({
      'type': 'prescription',
      'prescriptionId': '91',
      'route': '/health',
      'notification_id': 'push_4de13e85-d72c-4f0f-a0dc-84fe9f47e139',
    });

    expect(PushNotificationService.routeFromPayload(payload), '/notifications');
  });
}
