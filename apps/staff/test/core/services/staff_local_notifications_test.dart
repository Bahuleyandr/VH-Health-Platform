import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/staff_local_notifications.dart';

void main() {
  tearDown(StaffLocalNotifications.instance.beginAuthenticatedSession);

  test('desktop toast gate only opens for unfocused Windows windows', () {
    expect(
      shouldShowDesktopToast(isWindows: true, windowFocused: false),
      isTrue,
    );
    expect(
      shouldShowDesktopToast(isWindows: true, windowFocused: true),
      isFalse,
    );
    expect(
      shouldShowDesktopToast(isWindows: false, windowFocused: false),
      isFalse,
    );
  });

  test('codeBlueToastBodyFromData prefers ward, bed, and reason', () {
    expect(
      codeBlueToastBodyFromData({
        'ward': 'ICU',
        'bedNumber': '4A',
        'reason': 'Cardiac arrest',
      }),
      'Ward ICU · Bed 4A · Cardiac arrest',
    );
  });

  test('codeBlueToastBodyFromData has an honest fallback', () {
    expect(codeBlueToastBodyFromData({}), 'Respond immediately');
  });

  test('notification activation routes only cheap deep links', () {
    expect(
      routeForNotificationPayload(staffMessageNotificationPayload),
      '/messaging',
    );
    expect(routeForNotificationPayload(codeBlueNotificationPayload), isNull);
    expect(routeForNotificationPayload('unknown'), isNull);
  });

  test('stableNotificationId is deterministic and keeps a fallback', () {
    expect(
      stableNotificationId('message-123', fallback: 9101),
      stableNotificationId('message-123', fallback: 9101),
    );
    expect(stableNotificationId('', fallback: 9101), 9101);
  });

  test('session gate closes synchronously and reopens only on login', () {
    final notifications = StaffLocalNotifications.instance;

    notifications.beginAuthenticatedSession();
    expect(notifications.acceptsSessionNotifications, isTrue);

    notifications.endAuthenticatedSession();
    expect(notifications.acceptsSessionNotifications, isFalse);

    notifications.beginAuthenticatedSession();
    expect(notifications.acceptsSessionNotifications, isTrue);
  });

  test(
    'closed session gate rejects Code Blue before platform delivery',
    () async {
      final notifications = StaffLocalNotifications.instance;
      notifications.endAuthenticatedSession();

      await notifications.showCodeBlueFromData(const {
        'ward': 'ICU',
        'bedNumber': '4A',
      }, force: true);

      expect(notifications.acceptsSessionNotifications, isFalse);
    },
  );
}
