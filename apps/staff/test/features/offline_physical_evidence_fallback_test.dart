import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/bloodbank/screens/transfusion_scan_screen.dart';
import 'package:vhhealth_staff/features/investigations/screens/specimen_scan_screen.dart';
import 'package:vhhealth_staff/features/nursing/screens/mar_scan_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  final strings = AppStrings.forLocale(const Locale('en'));

  Future<void> expectFallbackDialog(
    WidgetTester tester, {
    required Future<void> Function(BuildContext context) showFallback,
    required String paperFormSet,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => ElevatedButton(
            onPressed: () => showFallback(context),
            child: const Text('Record offline'),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Record offline'));
    await tester.pumpAndSettle();

    expect(find.text(strings.offlineClinicalFallbackTitle), findsOneWidget);
    expect(
      find.text(strings.offlineClinicalFallbackMessage(paperFormSet)),
      findsOneWidget,
    );
    expect(find.text(strings.offlineClinicalFallbackKeepOpen), findsOneWidget);
    expect(find.textContaining(paperFormSet), findsOneWidget);

    await tester.tap(find.text(strings.offlineClinicalFallbackKeepOpen));
    await tester.pumpAndSettle();
    expect(find.text(strings.offlineClinicalFallbackTitle), findsNothing);
  }

  testWidgets('MAR fallback names the department MAR sheets', (tester) async {
    await expectFallbackDialog(
      tester,
      showFallback: showMarAdministrationOfflineFallback,
      paperFormSet: strings.offlineClinicalFallbackMarSheets,
    );
  });

  testWidgets('specimen fallback names laboratory requisition forms', (
    tester,
  ) async {
    await expectFallbackDialog(
      tester,
      showFallback: showSpecimenCollectionOfflineFallback,
      paperFormSet: strings.offlineClinicalFallbackLaboratoryRequisitionForms,
    );
  });

  testWidgets('transfusion fallback names blood-bank verification slips', (
    tester,
  ) async {
    await expectFallbackDialog(
      tester,
      showFallback: showTransfusionVerificationOfflineFallback,
      paperFormSet: strings.offlineClinicalFallbackBloodBankVerificationSlips,
    );
  });

  test('physical-evidence screens contain no enqueue or pending-sync path', () {
    final screenPaths = {
      'lib/features/nursing/screens/mar_scan_screen.dart': (
        'showMarAdministrationOfflineFallback(context)',
        'offlineClinicalFallbackMarSheets',
      ),
      'lib/features/investigations/screens/specimen_scan_screen.dart': (
        'showSpecimenCollectionOfflineFallback(context)',
        'offlineClinicalFallbackLaboratoryRequisitionForms',
      ),
      'lib/features/bloodbank/screens/transfusion_scan_screen.dart': (
        'showTransfusionVerificationOfflineFallback(context)',
        'offlineClinicalFallbackBloodBankVerificationSlips',
      ),
    };

    for (final entry in screenPaths.entries) {
      final path = entry.key;
      final source = File(path).readAsStringSync();
      expect(source, isNot(contains('.enqueue(')), reason: path);
      expect(source, isNot(contains('_pendingSync')), reason: path);
      expect(
        source,
        isNot(contains('offlineRecordedPendingSync')),
        reason: path,
      );
      expect(source, contains(entry.value.$1), reason: path);
      expect(source, contains(entry.value.$2), reason: path);
    }

    final marDecision = File(
      'lib/features/nursing/mar_offline_administer.dart',
    ).readAsStringSync();
    expect(marDecision, isNot(contains('endpoint:')));
    expect(marDecision, isNot(contains('body:')));
    expect(marDecision, isNot(contains('enqueue')));
  });

  test('both missing MAR-cache branches retain the paper fallback', () {
    final source = File(
      'lib/features/nursing/screens/mar_scan_screen.dart',
    ).readAsStringSync();
    final missingCacheFallback = RegExp(
      r'if \(dose == null\) \{\s+await _showAndRetainMarFallback\(\);\s+return;\s+\}',
    );

    expect(source, isNot(contains('No offline data for this dose')));
    expect(missingCacheFallback.allMatches(source), hasLength(2));
  });

  test('MAR renders hard stop then offline paper before online administer', () {
    final source = File(
      'lib/features/nursing/screens/mar_scan_screen.dart',
    ).readAsStringSync();
    final actionPrecedence = RegExp(
      r'if \(marIsIdentityMismatch\(rights\)\).*?'
      r'else if \(!ConnectivitySyncService\.instance\.isOnline\).*?'
      r'else if \(allPassed\)',
      dotAll: true,
    );

    expect(actionPrecedence.hasMatch(source), isTrue);
  });
}
