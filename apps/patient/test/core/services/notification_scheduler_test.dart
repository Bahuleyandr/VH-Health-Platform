import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/notification_scheduler.dart';

void main() {
  test('normal reminder notification IDs keep the legacy mapping', () {
    expect(NotificationScheduler.notificationIdForReminderSlot(42, 3), 4203);
  });

  test('ANC supplement projection IDs use a safe local namespace', () {
    final projectedId =
        NotificationScheduler.ancSupplementReminderIdOffset + 42;
    final notificationId = NotificationScheduler.notificationIdForReminderSlot(
      projectedId,
      3,
    );

    expect(notificationId, 700004203);
    expect(notificationId, lessThan(1 << 31));
  });
}
