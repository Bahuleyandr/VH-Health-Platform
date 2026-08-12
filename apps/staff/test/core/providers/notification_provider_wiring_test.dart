import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('authenticated routing initializes staff push registration', () {
    final source = File(
      'lib/core/navigation/app_router.dart',
    ).readAsStringSync();

    expect(
      source,
      contains("import '../providers/notification_provider.dart';"),
    );
    expect(
      source,
      matches(
        RegExp(
          r'if \(isLoggedIn\)[\s\S]*?context'
          r'\.read<NotificationProvider>\(\)'
          r'\.initialize\(\)',
        ),
      ),
    );
  });

  test('initialized providers retry unsynced authenticated registration', () {
    final source = File(
      'lib/core/providers/notification_provider.dart',
    ).readAsStringSync();

    expect(
      source,
      matches(
        RegExp(
          r'if \(_initialized\)[\s\S]*?'
          r'await _registerCurrentDevice\(_sessionGeneration\)',
        ),
      ),
    );
    expect(
      source,
      contains('currentAppDeviceMode == AppDeviceMode.web'),
      reason: 'Web registration must not evaluate dart:io Platform.isIOS.',
    );
  });

  test('successful login explicitly starts a fresh notification session', () {
    final source = File(
      'lib/features/auth/screens/login_screen.dart',
    ).readAsStringSync();

    expect(
      source,
      contains(
        'context.read<NotificationProvider>().beginAuthenticatedSession()',
      ),
    );
  });

  test('the authenticated provider owns the sole foreground FCM listener', () {
    final providerSource = File(
      'lib/core/providers/notification_provider.dart',
    ).readAsStringSync();
    final codeBlueSource = File(
      'lib/core/services/code_blue_notifier.dart',
    ).readAsStringSync();

    expect(providerSource, contains('_messaging.onMessage.listen'));
    expect(codeBlueSource, isNot(contains('FirebaseMessaging.onMessage')));
  });

  test(
    'background delivery and OS surfaces are gated by durable auth state',
    () {
      final mainSource = File('lib/main.dart').readAsStringSync();
      final localNotificationSource = File(
        'lib/core/services/staff_local_notifications.dart',
      ).readAsStringSync();

      expect(
        mainSource,
        matches(
          RegExp(
            r'_fcmBackgroundHandler[\s\S]*?mayPresentStaffPush\(\)'
            r'[\s\S]*?cancelSessionNotifications\(\)',
          ),
        ),
      );
      expect(
        localNotificationSource,
        matches(
          RegExp(
            r'cancelSessionNotifications\(\)[\s\S]*?_plugin\.cancelAll\(\)',
          ),
        ),
      );
    },
  );

  test('idle timeout tears down authenticated push before auth cleanup', () {
    final source = File('lib/main.dart').readAsStringSync();

    expect(
      source,
      matches(
        RegExp(
          r'SessionTimeoutProvider\([\s\S]*?beforeTimeoutCleanup:'
          r'[\s\S]*?stopStaffRealtimePollers\([\s\S]*?'
          r'unregisterNotificationBackend: true',
        ),
      ),
    );
  });
}
