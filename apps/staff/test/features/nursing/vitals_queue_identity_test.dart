import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  test('offline vitals exposes the governed paper and back-entry workflow', () {
    final strings = AppStrings.forLocale(const Locale('en'));

    expect(strings.vitalsOfflineRetiredTitle, contains('paper'));
    expect(strings.vitalsOfflineRetiredMessage, contains('paper chart'));
    expect(strings.vitalsOfflineRetiredMessage, contains('back-entry'));
  });

  test('vitals screen has no offline queue compatibility path', () {
    final source = File(
      'lib/features/nursing/screens/vitals_screen.dart',
    ).readAsStringSync();

    expect(source, isNot(contains('VitalsOfflineQueueIntent')));
    expect(source, isNot(contains('OfflineQueue.')));
    expect(source, contains('vitalsOfflineRetiredMessage'));
  });
}
