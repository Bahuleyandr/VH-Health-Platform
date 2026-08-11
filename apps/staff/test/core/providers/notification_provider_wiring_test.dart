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
          r'await _registerCurrentDevice\(\)',
        ),
      ),
    );
    expect(
      source,
      contains('currentAppDeviceMode == AppDeviceMode.web'),
      reason: 'Web registration must not evaluate dart:io Platform.isIOS.',
    );
  });
}
