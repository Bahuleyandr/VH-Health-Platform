// ABHA self-enrolment wizard localisation (re-audit lane L).
//
// The wizard shipped with every user-visible string hardcoded in English
// inside a five-language app, so a Tamil-, Telugu-, Hindi- or Malayalam-
// speaking patient was asked for their Aadhaar number and consent in a
// language they may not read. These tests pin the fix from both directions:
// the localised text appears, AND the old English literals are gone.
//
// Assertions read expected copy back out of AppLocalizations rather than
// hardcoding translations, so a corrected translation does not break them —
// only a REGRESSION to hardcoded English does.

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/abdm_api_service.dart';
import 'package:vhhealth/features/abdm/screens/abdm_screen.dart';
import 'package:vhhealth/features/abdm/widgets/abha_enrolment_flow.dart';
import 'package:vhhealth/generated/app_localizations.dart';

Widget _harness(Widget child, Locale locale) => MaterialApp(
  locale: locale,
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: Scaffold(body: child),
);

Widget _flow() => AbhaEnrolmentFlow(onEnrolled: () {}, onCancelled: () {});

void main() {
  test('every ABDM key is declared in all five ARB files', () {
    Map<String, dynamic> readArb(String locale) =>
        jsonDecode(File('lib/l10n/intl_$locale.arb').readAsStringSync())
            as Map<String, dynamic>;

    final englishKeys = readArb('en').keys
        .where((key) => key.startsWith('abdm') && !key.startsWith('@'))
        .toSet();

    for (final locale in const ['hi', 'ta', 'te', 'ml']) {
      final localeKeys = readArb(locale).keys.toSet();
      final missing = englishKeys.difference(localeKeys).toList()..sort();
      expect(
        missing,
        isEmpty,
        reason: '$locale is missing ABDM keys: $missing',
      );
    }
  });

  testWidgets('the Aadhaar step renders localised copy in English', (
    tester,
  ) async {
    final en = await AppLocalizations.delegate.load(const Locale('en'));

    await tester.pumpWidget(_harness(_flow(), const Locale('en')));
    await tester.pumpAndSettle();

    expect(find.text(en.abhaEnrolTitle), findsOneWidget);
    expect(find.text(en.abhaEnrolAadhaarIntro), findsOneWidget);
    expect(find.text(en.abhaEnrolSendOtp), findsOneWidget);
    expect(find.text(en.commonBackButton), findsOneWidget);
  });

  for (final code in const ['ta', 'hi', 'te', 'ml']) {
    testWidgets('the Aadhaar step is not English under locale $code', (
      tester,
    ) async {
      final l10n = await AppLocalizations.delegate.load(Locale(code));

      await tester.pumpWidget(_harness(_flow(), Locale(code)));
      await tester.pumpAndSettle();

      expect(find.text(l10n.abhaEnrolTitle), findsOneWidget);
      expect(find.text(l10n.abhaEnrolAadhaarIntro), findsOneWidget);

      // The exact literals that used to be baked into the widget.
      expect(find.text('Create a new ABHA'), findsNothing);
      expect(find.text('Send OTP'), findsNothing);
      expect(
        find.textContaining('Your ABHA is created with Aadhaar OTP'),
        findsNothing,
      );
    });
  }

  testWidgets('the Aadhaar validator message is localised', (tester) async {
    final ta = await AppLocalizations.delegate.load(const Locale('ta'));

    await tester.pumpWidget(_harness(_flow(), const Locale('ta')));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('enrolment_aadhaar')),
      '12345',
    );
    // Form validation fails, so this never reaches ApiClient — no network.
    await tester.tap(find.byKey(const ValueKey('enrolment_start')));
    await tester.pumpAndSettle();

    expect(find.text(ta.abhaEnrolAadhaarInvalid), findsOneWidget);
    expect(find.text('Aadhaar number must be 12 digits'), findsNothing);
  });

  testWidgets('the enrolment entry button on My ABHA is localised', (
    tester,
  ) async {
    final hi = await AppLocalizations.delegate.load(const Locale('hi'));

    await tester.pumpWidget(
      _harness(
        MyAbhaTab(loadLinkage: () async => const AbhaLinkage(linked: false)),
        const Locale('hi'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('abha_enrol_entry')), findsOneWidget);
    expect(find.text(hi.abdmCreateAbhaCta), findsOneWidget);
    expect(find.textContaining('have an ABHA? Create one'), findsNothing);
  });

  testWidgets('the existing-ABHA link form is localised in Malayalam', (
    tester,
  ) async {
    final ml = await AppLocalizations.delegate.load(const Locale('ml'));

    await tester.pumpWidget(
      _harness(
        MyAbhaTab(loadLinkage: () async => const AbhaLinkage(linked: false)),
        const Locale('ml'),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text(ml.abdmRegister));
    await tester.pumpAndSettle();

    expect(find.text(ml.abdmLinkExistingExplanation), findsOneWidget);
    expect(
      find.widgetWithText(TextFormField, ml.abdmNumberRequiredLabel),
      findsOneWidget,
    );
    expect(
      find.widgetWithText(TextFormField, ml.abdmAddressOptionalLabel),
      findsOneWidget,
    );
    expect(find.text(ml.abdmLinkAction), findsOneWidget);
    expect(find.text(ml.abdmCreateAtPortalAction), findsOneWidget);
    expect(find.text('ABHA Address (optional)'), findsNothing);
    expect(find.text('Link ABHA'), findsNothing);
    expect(find.text('Create one at abha.abdm.gov.in'), findsNothing);
  });

  test('every string lane L added is translated in all five locales', () async {
    // Guards the class, not the instance: adding a key to English without
    // filling the other four ARBs would silently fall back to English on a
    // patient handset. Covers the enrolment wizard plus the two other
    // surfaces the lane wrote copy for — the Settings lock subtitle and the
    // biometric denied pane.
    final locales = <String, AppLocalizations>{
      for (final code in const ['en', 'hi', 'ta', 'te', 'ml'])
        code: await AppLocalizations.delegate.load(Locale(code)),
    };
    final en = locales['en']!;

    String? untranslated(String label, String Function(AppLocalizations) read) {
      final english = read(en);
      for (final entry in locales.entries) {
        if (entry.key == 'en') continue;
        if (read(entry.value) == english) return '$label (${entry.key})';
      }
      return null;
    }

    final gaps = <String?>[
      untranslated('abhaEnrolTitle', (l) => l.abhaEnrolTitle),
      untranslated('abhaEnrolAadhaarIntro', (l) => l.abhaEnrolAadhaarIntro),
      untranslated('abhaEnrolOtpIntro', (l) => l.abhaEnrolOtpIntro),
      untranslated('abhaEnrolDoneIntro', (l) => l.abhaEnrolDoneIntro),
      untranslated('abhaEnrolStartFailed', (l) => l.abhaEnrolStartFailed),
      untranslated('abhaEnrolOtpFailed', (l) => l.abhaEnrolOtpFailed),
      untranslated('abhaEnrolResendFailed', (l) => l.abhaEnrolResendFailed),
      untranslated(
        'abhaEnrolVerifyInProgress',
        (l) => l.abhaEnrolVerifyInProgress,
      ),
      untranslated('abhaEnrolAadhaarLabel', (l) => l.abhaEnrolAadhaarLabel),
      untranslated('abhaEnrolAadhaarHint', (l) => l.abhaEnrolAadhaarHint),
      untranslated('abhaEnrolAadhaarInvalid', (l) => l.abhaEnrolAadhaarInvalid),
      untranslated('abhaEnrolMobileLabel', (l) => l.abhaEnrolMobileLabel),
      untranslated('abhaEnrolMobileHint', (l) => l.abhaEnrolMobileHint),
      untranslated('abhaEnrolSendOtp', (l) => l.abhaEnrolSendOtp),
      untranslated('abhaEnrolResendOtp', (l) => l.abhaEnrolResendOtp),
      untranslated('abhaEnrolVerify', (l) => l.abhaEnrolVerify),
      untranslated('abhaEnrolViewMyAbha', (l) => l.abhaEnrolViewMyAbha),
      untranslated('abdmCreateAbhaCta', (l) => l.abdmCreateAbhaCta),
      untranslated('abdmMyAbhaTab', (l) => l.abdmMyAbhaTab),
      untranslated('abdmConsentRequestsTab', (l) => l.abdmConsentRequestsTab),
      untranslated(
        'abdmStatusCheckFailedDetail',
        (l) => l.abdmStatusCheckFailedDetail,
      ),
      untranslated('abdmLinkSuccess', (l) => l.abdmLinkSuccess),
      untranslated('abdmLinkFailed', (l) => l.abdmLinkFailed),
      untranslated(
        'abdmStatusCheckFailedTitle',
        (l) => l.abdmStatusCheckFailedTitle,
      ),
      untranslated(
        'abdmStatusUnknownExplanation',
        (l) => l.abdmStatusUnknownExplanation,
      ),
      untranslated('abdmCopyNumberTooltip', (l) => l.abdmCopyNumberTooltip),
      untranslated('abdmCopyNumberSuccess', (l) => l.abdmCopyNumberSuccess(30)),
      untranslated('abdmAddressLabel', (l) => l.abdmAddressLabel),
      untranslated(
        'abdmLinkExistingExplanation',
        (l) => l.abdmLinkExistingExplanation,
      ),
      untranslated('abdmNumberRequiredLabel', (l) => l.abdmNumberRequiredLabel),
      untranslated('abdmNumberRequiredError', (l) => l.abdmNumberRequiredError),
      untranslated('abdmNumberLengthError', (l) => l.abdmNumberLengthError),
      untranslated(
        'abdmAddressOptionalLabel',
        (l) => l.abdmAddressOptionalLabel,
      ),
      untranslated('abdmLinkAction', (l) => l.abdmLinkAction),
      untranslated('abdmNoAbhaPrompt', (l) => l.abdmNoAbhaPrompt),
      untranslated(
        'abdmCreateAtPortalAction',
        (l) => l.abdmCreateAtPortalAction,
      ),
      untranslated(
        'abdmConsentPurposeFallback',
        (l) => l.abdmConsentPurposeFallback,
      ),
      untranslated(
        'abdmConsentRequesterUnknown',
        (l) => l.abdmConsentRequesterUnknown,
      ),
      untranslated('abdmConsentDateUnknown', (l) => l.abdmConsentDateUnknown),
      untranslated(
        'abdmConsentStatusRequested',
        (l) => l.abdmConsentStatusRequested,
      ),
      untranslated(
        'abdmConsentStatusGranted',
        (l) => l.abdmConsentStatusGranted,
      ),
      untranslated('abdmConsentStatusDenied', (l) => l.abdmConsentStatusDenied),
      untranslated(
        'abdmConsentStatusExpired',
        (l) => l.abdmConsentStatusExpired,
      ),
      untranslated(
        'abdmConsentStatusRevoked',
        (l) => l.abdmConsentStatusRevoked,
      ),
      untranslated(
        'abdmConsentStatusUnknown',
        (l) => l.abdmConsentStatusUnknown,
      ),
      untranslated(
        'abdmConsentRequestedBy',
        (l) => l.abdmConsentRequestedBy('VH Health'),
      ),
      untranslated(
        'abdmConsentPeriod',
        (l) => l.abdmConsentPeriod('2026-01-01', '2026-01-31'),
      ),
      untranslated(
        'settingsBiometricLockSubtitle',
        (l) => l.settingsBiometricLockSubtitle,
      ),
      untranslated(
        'biometricGateLockedEscapeHint',
        (l) => l.biometricGateLockedEscapeHint,
      ),
      untranslated(
        'biometricGateOpenSettings',
        (l) => l.biometricGateOpenSettings,
      ),
      untranslated('biometricGateGoHome', (l) => l.biometricGateGoHome),
    ].whereType<String>().toList();

    // `abhaEnrolOtpLabel` ("OTP *") and the two ABHA example values are
    // intentionally identical everywhere, so they are excluded above.
    expect(gaps, isEmpty, reason: 'Untranslated strings: $gaps');
  });
}
