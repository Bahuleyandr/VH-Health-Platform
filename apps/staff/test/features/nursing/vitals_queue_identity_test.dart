import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/nursing/screens/vitals_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  group('quick-vitals positive patient identification (STF-4)', () {
    const uid = '11111111-1111-4111-8111-111111111111';
    final rows = [
      {
        'id': 51,
        'uid': uid,
        'name': 'Codex Test Patient',
        'hospital_number': 'VH-000051',
      },
      {'id': 62, 'uid': '22222222-2222-4222-8222-222222222222', 'name': 'B'},
    ];

    test('a scanned wristband UID resolves only by exact uid match', () {
      expect(resolveQuickVitalsPatient(rows, scannedUid: uid)?['id'], 51);
      expect(
        resolveQuickVitalsPatient(rows, scannedUid: uid.toUpperCase())?['id'],
        51,
      );
      expect(
        resolveQuickVitalsPatient(
          rows,
          scannedUid: '99999999-9999-4999-8999-999999999999',
        ),
        isNull,
      );
    });

    test('a manually verified ID resolves only by exact numeric id', () {
      expect(resolveQuickVitalsPatient(rows, manualId: 62)?['name'], 'B');
      expect(resolveQuickVitalsPatient(rows, manualId: 999), isNull);
      // Fuzzy search hits never auto-confirm without an exact identifier.
      expect(resolveQuickVitalsPatient(rows), isNull);
    });

    test('the record tab has no unverified free-typed submit path', () {
      final source = File(
        'lib/features/nursing/screens/vitals_screen.dart',
      ).readAsStringSync();

      // The submit path must chart against the confirmed patient, never
      // by parsing the free-typed field at submit time.
      expect(source, isNot(contains('int.parse(_patientIdCtrl.text')));
      expect(source, contains('vitalsScanConfirmRequired'));
      expect(source, contains('MobileScanner'));
    });
  });

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
