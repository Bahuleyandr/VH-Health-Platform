import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/widgets/contact_banner.dart';
import 'package:vhhealth/core/widgets/logout_button.dart';
import 'package:vhhealth/features/dashboard/widgets/stat_detail_panels.dart';
import 'package:vhhealth/features/dashboard/widgets/stats_strip.dart';
import 'package:vhhealth/generated/app_localizations.dart';

const _fiveLocales = ['en', 'hi', 'ta', 'te', 'ml'];

const _ownedKeys = [
  'navigationPageNotFound',
  'navigationGoHome',
  'dependentsLoadFailed',
  'permissionsNotificationsName',
  'permissionsNotificationsExplanation',
  'permissionsCameraName',
  'permissionsCameraExplanation',
  'permissionsPhotosName',
  'permissionsPhotosExplanation',
  'permissionsLocationName',
  'permissionsLocationExplanation',
  'permissionsCalendarName',
  'permissionsCalendarExplanation',
  'permissionsGenericName',
  'permissionsGenericExplanation',
  'permissionsRequiredTitle',
  'permissionsDisabledTitle',
  'permissionsDisabledBody',
  'circularDialTapToAccess',
  'contactBookByPhone',
  'deliveryTrackingLive',
  'deliveryTrackingEstimatedArrival',
  'deliveryTrackingDistance',
  'deliveryTrackingCall',
  'deliveryTrackingHospital',
  'logoutRevocationRetryQueued',
  'logoutRevocationRetryUnavailable',
  'logoutFailed',
  'loginLightMode',
  'loginDarkMode',
  'dashboardTodayRefreshFailed',
  'dashboardTodayRefreshTitle',
  'commonDoneButton',
  'dashboardHospitalId',
  'dashboardStepsBreakdown',
  'dashboardMetricLeft',
  'dashboardMetricActivity',
  'dashboardPointsBreakdown',
  'dashboardMetricTier',
  'dashboardMetricNext',
  'dashboardMetricCycle',
  'dashboardMetricPeriod',
  'dashboardMetricSteps',
  'feedbackHistoryEmptyTitle',
  'feedbackHistoryEmptySubtitle',
  'feedbackAverageRating',
  'messageThreadLoadFailed',
  'messageReplyHint',
  'dischargeSummariesRefreshFailed',
  'referralsRefreshFailed',
  'settingsAuthenticationFailed',
  'settingsVerifiedPhoneRequiredForDeletion',
  'commonDeleteButton',
  'commonUploadButton',
];

const _ownedSources = [
  'lib/core/navigation/app_router.dart',
  'lib/core/providers/dependents_provider.dart',
  'lib/core/utils/permissions_service.dart',
  'lib/core/widgets/circular_feature_dial.dart',
  'lib/core/widgets/contact_banner.dart',
  'lib/core/widgets/delivery_tracking_card.dart',
  'lib/core/widgets/logout_button.dart',
  'lib/features/auth/screens/login_screen.dart',
  'lib/features/dashboard/screens/dashboard_screen.dart',
  'lib/features/dashboard/widgets/command_center_today.dart',
  'lib/features/dashboard/widgets/daily_checkin_sheet.dart',
  'lib/features/dashboard/widgets/dashboard_header.dart',
  'lib/features/dashboard/widgets/language_menu_button.dart',
  'lib/features/dashboard/widgets/stat_detail_panels.dart',
  'lib/features/dashboard/widgets/stats_strip.dart',
  'lib/features/feedback/screens/feedback_history_screen.dart',
  'lib/features/notifications/screens/notifications_screen.dart',
  'lib/features/portal/screens/message_thread_screen.dart',
  'lib/features/portal/services/discharge_summaries_repository.dart',
  'lib/features/portal/services/patient_referrals_repository.dart',
  'lib/features/settings/controllers/settings_controller.dart',
  'lib/features/your_health/widgets/my_uploads_tab.dart',
];

Map<String, dynamic> _readArb(String locale) =>
    jsonDecode(File('lib/l10n/intl_$locale.arb').readAsStringSync())
        as Map<String, dynamic>;

Widget _localizedApp(Locale locale, Widget home) => MaterialApp(
  locale: locale,
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: home,
);

void main() {
  test('safe presentation keys have generated five-locale parity', () async {
    final arbs = {for (final locale in _fiveLocales) locale: _readArb(locale)};

    for (final key in _ownedKeys) {
      final english = arbs['en']![key];
      expect(english, isA<String>(), reason: 'English is missing $key');
      for (final locale in _fiveLocales.skip(1)) {
        expect(
          arbs[locale]![key],
          isA<String>(),
          reason: '$locale is missing $key',
        );
        expect(
          arbs[locale]![key],
          isNot(english),
          reason: '$key silently falls back to English in $locale',
        );
      }
    }

    for (final locale in _fiveLocales) {
      final l10n = await AppLocalizations.delegate.load(Locale(locale));
      expect(l10n.navigationPageNotFound('/missing'), contains('/missing'));
      expect(l10n.permissionsRequiredTitle('Camera'), contains('Camera'));
      expect(l10n.circularDialTapToAccess('Feature'), contains('Feature'));
      expect(l10n.deliveryTrackingEstimatedArrival('12'), contains('12'));
      expect(l10n.deliveryTrackingDistance('3.5'), contains('3.5'));
      expect(l10n.dashboardHospitalId('VH-123'), contains('VH-123'));
      expect(l10n.feedbackAverageRating('4.5'), contains('4.5'));
    }
  });

  testWidgets('safe dashboard actions and labels render in Malayalam', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(800, 1200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final ml = await AppLocalizations.delegate.load(const Locale('ml'));

    await tester.pumpWidget(
      _localizedApp(
        const Locale('ml'),
        Scaffold(
          body: ListView(
            children: [
              ContactBanner.appointments(ml),
              const LogoutButton(),
              const SizedBox(
                height: 180,
                child: StatsStrip(stepsToday: 1200, stepGoal: 8000),
              ),
              SizedBox(
                height: 360,
                child: StepsBreakdownPanel(
                  stepsToday: 1200,
                  stepGoal: 8000,
                  onOpenFull: () {},
                ),
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text(ml.contactBookByPhone), findsOneWidget);
    expect(find.text(ml.settingsLogout), findsOneWidget);
    expect(find.text(ml.dashboardMetricSteps), findsOneWidget);
    expect(find.text(ml.dashboardStepsBreakdown), findsOneWidget);
    expect(find.text(ml.dashboardTodaySection), findsOneWidget);
    expect(find.text(ml.healthPointsGoal), findsOneWidget);
    expect(find.text(ml.dashboardMetricLeft), findsOneWidget);
    expect(find.text(ml.healthPointsDistance), findsOneWidget);
    expect(find.text(ml.dashboardMetricActivity), findsOneWidget);
    expect(find.text('Book by Phone'), findsNothing);
    expect(find.text('Log out'), findsNothing);
    expect(find.text('Steps breakdown'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  test('owned sources no longer carry the routed English literals', () {
    final source = _ownedSources
        .map((path) => File(path).readAsStringSync())
        .join('\n');

    for (final literal in const [
      "Text('Page not found:",
      "Text('Go Home')",
      "failureMessage('Failed to load dependents')",
      "failureMessage('Failed to link dependent')",
      "failureMessage('Failed to unlink dependent')",
      "title: Text('\$permissionName Required')",
      "child: const Text('Continue')",
      "title: Text('\$permissionName Disabled')",
      "child: const Text('Cancel')",
      "child: const Text('Close')",
      "child: const Text('Open')",
      "title: 'Book by Phone'",
      "title: 'Free Home Sample Collection'",
      "'Estimated arrival: ~\$etaMins min'",
      "'\$distanceKm km'",
      "tooltip: 'Call'",
      "message: 'Logout failed:",
      "tooltip: 'Light mode'",
      "tooltip: 'Dark mode'",
      "tooltip: 'Change Language'",
      "label: 'Your Health'",
      "label: 'Appointments'",
      "label: 'Pharmacy'",
      "label: 'Tests & Reports'",
      "label: 'Ask a Doubt'",
      "label: 'Trivia'",
      "label: 'Departments'",
      "label: 'About Us'",
      "'Today could not refresh right now.'",
      "title: 'Today could not refresh'",
      "child: const Text('Done')",
      "'Hospital ID \$hospitalId'",
      "title: 'Steps breakdown'",
      "label: 'Today'",
      "label: 'Goal'",
      "label: 'Left'",
      "label: 'Distance'",
      "label: 'Activity'",
      "title: 'Points breakdown'",
      "label: 'Tier'",
      "label: 'Rewards'",
      "label: 'Next'",
      "label: 'Cycle'",
      "label: 'Period'",
      "label: 'Steps'",
      "'out of 100'",
      "emptyTitle: 'No feedback submitted yet'",
      "emptySubtitle: 'Your feedback history will appear here'",
      "'Average rating: \$_averageRating'",
      "failureMessage('Failed to fetch notifications')",
      "failureMessage('Failed to load thread')",
      "failureMessage('Send failed')",
      "hintText: 'Reply…'",
      "failureMessage('Failed to load discharge summaries')",
      "failureMessage('Failed to refresh summaries')",
      "failureMessage('Failed to load discharge summary')",
      "failureMessage('Failed to load referrals')",
      "failureMessage('Failed to refresh referrals')",
      "message: 'Authentication failed:",
      "_showSnackBar('A verified phone number",
      "child: const Text('Delete')",
      ": const Text('Upload')",
    ]) {
      expect(source, isNot(contains(literal)), reason: 'hardcoded: $literal');
    }
  });
}
