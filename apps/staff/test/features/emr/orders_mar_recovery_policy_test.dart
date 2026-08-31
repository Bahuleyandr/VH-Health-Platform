import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/platform_info.dart';
import 'package:vhhealth_staff/features/emr/screens/orders_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  test('MAR recovery is prescriber-authorized but phone-mode blocked', () {
    expect(
      canRunMedicationOrderMarRecovery('DOCTOR', AppDeviceMode.desktop),
      isTrue,
    );
    expect(
      canRunMedicationOrderMarRecovery('DOCTOR', AppDeviceMode.tablet),
      isTrue,
    );
    expect(
      canRunMedicationOrderMarRecovery('DOCTOR', AppDeviceMode.mobile),
      isFalse,
    );
    expect(
      canRunMedicationOrderMarRecovery(
        'NURSING_INCHARGE',
        AppDeviceMode.desktop,
      ),
      isFalse,
    );
  });

  test('phone-mode recovery explanation has five-locale technical parity', () {
    final english = AppStrings.forLocale(const Locale('en'));
    const key = 'orders.mar_recovery.desktop_only';
    for (final locale in const ['hi', 'ta', 'te', 'ml']) {
      final localized = AppStrings.forLocale(Locale(locale));
      expect(localized.lookup(key), isNot(key), reason: locale);
      expect(localized.lookup(key), isNot(english.lookup(key)), reason: locale);
    }
  });

  test('ICU MAR carryover review copy has five-locale technical parity', () {
    final english = AppStrings.forLocale(const Locale('en'));
    const key = 'orders.icu_mar_review.banner';
    for (final locale in const ['hi', 'ta', 'te', 'ml']) {
      final localized = AppStrings.forLocale(Locale(locale));
      expect(localized.lookup(key), isNot(key), reason: locale);
      expect(localized.lookup(key), isNot(english.lookup(key)), reason: locale);
      expect(localized.ordersIcuMarReviewBanner(81), contains('81'));
    }
  });

  testWidgets('ICU MAR review banner is visible and review-only', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        locale: Locale('en'),
        supportedLocales: AppStrings.supportedLocales,
        home: Scaffold(body: IcuMarReviewBanner(icuAdmissionId: 81)),
      ),
    );

    expect(find.byKey(const Key('icu-mar-review-banner-81')), findsOneWidget);
    expect(find.textContaining('81'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
    expect(find.byType(TextButton), findsNothing);
  });
}
