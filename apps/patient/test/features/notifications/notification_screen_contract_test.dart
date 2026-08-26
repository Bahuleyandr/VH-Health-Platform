import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  final source = File(
    'lib/features/notifications/screens/notifications_screen.dart',
  ).readAsStringSync();

  test('notification screen reads the backend feed envelope fields', () {
    expect(source, contains("data['notifications']"));
    expect(source, contains("notif['message'] ?? notif['body']"));
    expect(source, contains("notif['is_read'] == true"));
    expect(source, contains("notifications[index]['is_read'] = true"));
  });

  test('notification screen uses the generated action contract and badge reconciliation', () {
    expect(source, contains('patient_notification_contract.g.dart'));
    expect(source, contains('patientNotificationContractFor(type)'));
    expect(source, contains('PatientNotificationActionKind.acknowledgeOnly'));
    expect(source, isNot(contains('switch (type)')));
    expect(source, contains('reconcileFromFeed(data)'));
    expect(source, contains('markOneReadLocally()'));
  });
}
