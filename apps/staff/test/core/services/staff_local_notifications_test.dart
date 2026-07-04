import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/staff_local_notifications.dart';

void main() {
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
}
