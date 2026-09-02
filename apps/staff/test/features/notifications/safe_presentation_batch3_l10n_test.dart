import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_staff/core/providers/notification_provider.dart';
import 'package:vhhealth_staff/core/utils/api_error_messages.dart';
import 'package:vhhealth_staff/core/utils/localized_failure.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

const _fiveLocales = ['en', 'hi', 'ta', 'te', 'ml'];

const _ownedKeys = [
  'presentation.notification_fallback_title',
  'presentation.bed_board_print.occupancy',
  'presentation.bed_board_print.occupancy_date',
  'presentation.bed_board_print.page',
  'presentation.bed_board_print.column.bed',
  'presentation.bed_board_print.column.status',
  'presentation.bed_board_print.column.patient',
  'presentation.bed_board_print.column.age',
  'presentation.bed_board_print.column.admitted',
  'presentation.bed_board_print.column.notes',
  'presentation.dietary_load_failed',
  'presentation.staff_phone.queries_load_failed',
  'presentation.staff_phone.query_submit_failed',
  'presentation.staff_phone.subject_required',
  'presentation.staff_phone.details_required',
  'presentation.photo_upload_failed',
  'presentation.order_sets.load_failed',
  'presentation.order_sets.item_count',
  'presentation.order_sets.item_load_failed',
  'presentation.billing_request_failed',
  'presentation.request_failed',
];

const _ownedSources = [
  'lib/core/providers/notification_provider.dart',
  'lib/core/services/bed_board_print_service.dart',
  'lib/core/services/billing_api_service.dart',
  'lib/core/services/care_pathway_api_service.dart',
  'lib/core/services/hr_api_service.dart',
  'lib/core/services/staff_evidence_upload_service.dart',
  'lib/features/dietary/screens/dietary_screen.dart',
  'lib/features/phone/services/staff_phone_api_service.dart',
  'lib/features/phone/screens/staff_query_screen.dart',
  'lib/features/productivity/screens/order_sets_screen.dart',
];

void main() {
  test('batch-3 Staff keys are explicit in all five locales', () {
    final strings = {
      for (final locale in _fiveLocales)
        locale: AppStrings.forLocale(Locale(locale)),
    };

    for (final key in _ownedKeys) {
      final english = strings['en']!.lookup(key);
      expect(english, isNotEmpty, reason: 'English missing $key');
      for (final locale in _fiveLocales.skip(1)) {
        final localized = strings[locale]!.lookup(key);
        expect(localized, isNotEmpty, reason: '$locale missing $key');
        expect(
          localized,
          isNot(english),
          reason: '$key silently uses English in $locale',
        );
      }
    }

    for (final locale in _fiveLocales) {
      final s = strings[locale]!;
      expect(s.bedBoardPrintOccupancyDate('DATE'), contains('DATE'));
      expect(s.bedBoardPrintPage(2, 8), allOf(contains('2'), contains('8')));
      expect(s.orderSetsItemCount(7), contains('7'));
    }
  });

  test('generic API fallback stays localized at the presentation boundary', () {
    final ml = AppStrings.forLocale(const Locale('ml'));
    final message = localizedApiErrorFromRaw(
      ml,
      const LocalizedApiFailure(
        fallbackLocalizationKey: 'presentation.billing_request_failed',
        localizationSource: ApiResponse(
          statusCode: 500,
          isSuccess: false,
          raw: <String, dynamic>{},
        ),
      ),
    );

    expect(message, ml.lookup('presentation.billing_request_failed'));
    expect(message, isNot('Billing request failed'));
  });

  test('empty notification titles use the active locale', () {
    final ml = AppStrings.forLocale(const Locale('ml'));
    final item = NotificationItem.fromApi(const <String, dynamic>{});

    expect(item.title, isEmpty);
    expect(item.titleFor(ml), ml.notificationFallbackTitle);
    expect(item.titleFor(ml), isNot('Notification'));
  });

  test('dead phone-home and log-only device fallbacks are not UI keys', () {
    final phoneService = File(
      'lib/features/phone/services/staff_phone_api_service.dart',
    ).readAsStringSync();
    final notificationProvider = File(
      'lib/core/providers/notification_provider.dart',
    ).readAsStringSync();
    final stringsSource = File('lib/l10n/app_strings.dart').readAsStringSync();

    expect(phoneService, isNot(contains('getHome(')));
    expect(phoneService, isNot(contains('/staff/phone/home')));
    expect(stringsSource, isNot(contains('staff_phone.home_load_failed')));
    expect(stringsSource, isNot(contains('device_registration_failed')));
    expect(stringsSource, isNot(contains('device_unregistration_failed')));
    expect(notificationProvider, contains('HrApiService.registerDevice'));
    expect(
      notificationProvider,
      contains("debugPrint('❌ Device registration error: \$e')"),
    );
    expect(
      notificationProvider,
      contains("debugPrint('❌ Device unregistration error: \$e')"),
    );
  });

  testWidgets('generic Staff presentation labels render in Malayalam', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('ml'),
        supportedLocales: AppStrings.supportedLocales,
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: Builder(
          builder: (context) {
            final s = AppStrings.of(context);
            return Scaffold(
              body: Column(
                children: [
                  Text(s.notificationFallbackTitle),
                  Text(s.bedBoardPrintOccupancy),
                  Text(s.dietaryLoadFailed),
                  Text(s.staffPhoneQueriesLoadFailed),
                  Text(s.orderSetsItemCount(3)),
                ],
              ),
            );
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    final ml = AppStrings.forLocale(const Locale('ml'));

    expect(find.text(ml.notificationFallbackTitle), findsOneWidget);
    expect(find.text(ml.bedBoardPrintOccupancy), findsOneWidget);
    expect(find.text(ml.dietaryLoadFailed), findsOneWidget);
    expect(find.text(ml.orderSetsItemCount(3)), findsOneWidget);
    expect(find.text('Notification'), findsNothing);
    expect(find.text('Bed Occupancy'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  test('batch-3 owned Staff sources do not retain routed English copy', () {
    final source = _ownedSources
        .map((path) => File(path).readAsStringSync())
        .join('\n');
    for (final literal in const [
      "title.isNotEmpty ? title : 'Notification'",
      "?? 'Notification'",
      "'Bed Occupancy · \$dateStr'",
      "'Page \${ctx.pageNumber} / \${ctx.pagesCount}'",
      "failureMessage('Billing request failed')",
      "'Request failed (\${response.statusCode})'",
      "failureMessage('Device registration failed')",
      "failureMessage('Device unregistration failed')",
      "failureMessage('Photo upload failed')",
      "failureMessage('Failed to load dietary orders')",
      "failureMessage('Could not load phone home')",
      "failureMessage('Could not load queries')",
      "failureMessage('Could not submit query')",
      "failureMessage('Failed to load order sets')",
      "'\${summary.itemCount} items'",
      "failureMessage('Failed to load')",
    ]) {
      expect(source, isNot(contains(literal)), reason: 'hardcoded: $literal');
    }
  });
}
