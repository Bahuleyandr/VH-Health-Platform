import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/features/appointments/widgets/appointment_card.dart';
import 'package:vhhealth/features/gamification/widgets/milestones_tab.dart';
import 'package:vhhealth/features/steps/models/step_models.dart';
import 'package:vhhealth/features/steps/widgets/step_profile_section.dart';
import 'package:vhhealth/features/steps/widgets/step_today_card.dart';
import 'package:vhhealth/generated/app_localizations.dart';

const _fiveLocales = ['en', 'hi', 'ta', 'te', 'ml'];

const _ownedKeys = [
  'appointmentCardToken',
  'appointmentCardReason',
  'appointmentCardNote',
  'appointmentListForDependent',
  'appointmentStatusScheduled',
  'appointmentStatusConfirmed',
  'appointmentStatusInProgress',
  'appointmentStatusCompleted',
  'appointmentStatusCancelled',
  'appointmentStatusNoShow',
  'gamificationClaimMilestoneFailed',
  'gamificationScreenTitle',
  'gamificationTabOverview',
  'gamificationTabMilestones',
  'gamificationTabAchievements',
  'gamificationTabMyRewards',
  'gamificationTabHistory',
  'gamificationBadgesEarned',
  'gamificationEarnedOn',
  'commonShareButton',
  'gamificationPointsActivity',
  'gamificationMilestoneFallback',
  'gamificationPointsRequired',
  'gamificationClaimButton',
  'gamificationPointsLabel',
  'gamificationNextTierWithPoints',
  'gamificationNextTier',
  'commonEditButton',
  'stepsDisplayNameRequired',
  'stepsDailyTargetNumberRequired',
  'stepsDailyTargetRange',
  'stepsProfileSaveFailed',
  'stepsWeekOf',
  'stepsAveragePerDay',
  'stepsCount',
  'stepsYourRank',
  'stepsLeaderboardYou',
  'stepsDailyTarget',
  'stepsEditTargetTitle',
  'stepsDisplayNameLabel',
  'stepsDisplayNameHint',
  'stepsDailyTargetLabel',
  'stepsDailyTargetExample',
  'stepsDailyTargetHelper',
  'stepsTodayActivity',
  'stepsDailyGoalReached',
  'stepsGoalProgress',
  'stepsDailyTab',
  'stepsWeeklyTab',
  'stepsMonthlyTab',
];

const _ownedSources = [
  'lib/core/services/api_client.dart',
  'lib/features/appointments/widgets/appointment_card.dart',
  'lib/features/appointments/widgets/appointments_list_tab.dart',
  'lib/features/gamification/screens/health_points_screen.dart',
  'lib/features/gamification/widgets/achievement_grid.dart',
  'lib/features/gamification/widgets/achievement_share_card.dart',
  'lib/features/gamification/widgets/history_tab.dart',
  'lib/features/gamification/widgets/milestones_tab.dart',
  'lib/features/gamification/widgets/overview_tab.dart',
  'lib/features/gamification/widgets/rewards_tab.dart',
  'lib/features/steps/screens/step_challenge_screen.dart',
  'lib/features/steps/widgets/step_history_section.dart',
  'lib/features/steps/widgets/step_leaderboard_section.dart',
  'lib/features/steps/widgets/step_profile_section.dart',
  'lib/features/steps/widgets/step_today_card.dart',
];

Map<String, dynamic> _readArb(String locale) =>
    jsonDecode(File('lib/l10n/intl_$locale.arb').readAsStringSync())
        as Map<String, dynamic>;

Widget _localizedApp(Widget home) => MaterialApp(
  locale: const Locale('ml'),
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: home,
);

void main() {
  test('batch-3 patient keys have five-locale placeholder parity', () async {
    final arbs = {for (final locale in _fiveLocales) locale: _readArb(locale)};
    for (final key in _ownedKeys) {
      final english = arbs['en']![key];
      expect(english, isA<String>(), reason: 'English is missing $key');
      for (final locale in _fiveLocales.skip(1)) {
        expect(
          arbs[locale]![key],
          isA<String>(),
          reason: '$locale missing $key',
        );
        expect(
          arbs[locale]![key],
          isNot(english),
          reason: '$key silently uses English in $locale',
        );
      }
    }

    for (final locale in _fiveLocales) {
      final l = await AppLocalizations.delegate.load(Locale(locale));
      expect(l.appointmentCardToken(42), contains('42'));
      expect(l.appointmentCardReason('Review'), contains('Review'));
      expect(
        l.gamificationBadgesEarned(2, 9),
        allOf(contains('2'), contains('9')),
      );
      expect(
        l.gamificationNextTierWithPoints('Gold', 50),
        allOf(contains('Gold'), contains('50')),
      );
      expect(
        l.stepsYourRank('3', '7000'),
        allOf(contains('3'), contains('7000')),
      );
      expect(
        l.stepsGoalProgress('75', 8000),
        allOf(contains('75'), contains('8000')),
      );
    }
  });

  testWidgets('appointment, milestone, and step chrome render in Malayalam', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(800, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final l = await AppLocalizations.delegate.load(const Locale('ml'));
    final nameController = TextEditingController();
    final goalController = TextEditingController(text: '8000');
    addTearDown(nameController.dispose);
    addTearDown(goalController.dispose);

    await tester.pumpWidget(
      _localizedApp(
        Scaffold(
          body: ListView(
            children: [
              AppointmentCard(
                appt: const AppointmentInfo(
                  id: 1,
                  doctorName: 'Dr. Test',
                  department: 'Test Department',
                  date: '2099-01-01',
                  time: '09:00',
                  status: 'confirmed',
                  tokenNumber: 42,
                  reason: 'Review',
                  confirmationNotes: 'Arrive early',
                ),
                onViewPrescription: (_) {},
                onReschedule: (_) {},
                onCancel: (_) {},
              ),
              SizedBox(
                height: 220,
                child: MilestonesTab(
                  milestones: const [
                    {
                      'id': 'm1',
                      'name': 'Server milestone',
                      'pointsRequired': 100,
                      'status': 'CLAIMABLE',
                    },
                  ],
                  loading: false,
                  claimingIds: const {},
                  onClaim: (_) {},
                  onRefresh: () async {},
                ),
              ),
              StepProfileSection(
                profile: const StepProfile(
                  displayName: 'Test User',
                  displayColor: '#2196F3',
                  dailyGoal: 8000,
                  optedIn: true,
                ),
                loadingProfile: false,
                savingProfile: false,
                editingProfile: false,
                nameController: nameController,
                goalController: goalController,
                editColor: '#2196F3',
                colorOptions: const ['#2196F3'],
                onEditPressed: () {},
                onCancelEdit: () {},
                onColorSelected: (_) {},
                onSave: () {},
              ),
              const StepTodayCard(
                today: DailyRow(
                  date: '2099-01-01',
                  steps: 6000,
                  distanceMeters: 4000,
                ),
                dailyGoal: 8000,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text(l.appointmentCardToken(42)), findsOneWidget);
    expect(find.text(l.appointmentStatusConfirmed), findsOneWidget);
    expect(find.text(l.gamificationPointsRequired(100)), findsOneWidget);
    expect(find.text(l.gamificationClaimButton), findsOneWidget);
    expect(find.text(l.commonEditButton), findsOneWidget);
    expect(find.text(l.stepsTodayActivity), findsOneWidget);
    expect(find.text('Token #42'), findsNothing);
    expect(find.text('100 points required'), findsNothing);
    expect(find.text("Today's Activity"), findsNothing);
    expect(tester.takeException(), isNull);
  });

  test('batch-3 owned sources do not retain routed English copy', () {
    final source = _ownedSources
        .map((path) => File(path).readAsStringSync())
        .join('\n');
    for (final literal in const [
      "message: 'Background refresh failed'",
      "'Token #\${appt.tokenNumber}'",
      "'Reason: \${appt.reason}'",
      "'Note: \${appt.confirmationNotes}'",
      "'Showing appointments for \${activeDep.name}'",
      "'Failed to claim milestone'",
      "title: 'Health Hub'",
      "Tab(text: 'Overview')",
      "Tab(text: 'Milestones')",
      "Tab(text: 'Achievements')",
      "Tab(text: 'My Rewards')",
      "'badges earned'",
      "'Earned on \$dateStr'",
      "const Text('Share')",
      "const Text('Refresh')",
      "'points required'",
      "const Text('Claim')",
      "'Display name cannot be empty'",
      "'Daily step target must be a number'",
      "'Failed to save profile'",
      "title: 'Step Challenge 🏃'",
      "'Week of \${row.weekStart}'",
      "'avg/day'",
      "'Your rank: #\${myRank!['rank']}'",
      "'How others see you on the leaderboard'",
      "              \"Today's Activity\",\n",
      "'🎉 Daily goal reached!'",
    ]) {
      expect(source, isNot(contains(literal)), reason: 'hardcoded: $literal');
    }
  });
}
