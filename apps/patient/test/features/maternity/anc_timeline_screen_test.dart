import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/maternity/models/anc_timeline.dart';
import 'package:vhhealth/features/maternity/screens/anc_timeline_screen.dart';
import 'package:vhhealth/features/maternity/services/maternity_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  testWidgets(
    'renders trimester danger signs prominently and toggles reminders',
    (tester) async {
      final repository = _FakeMaternityRepository(_sampleTimeline());
      final scheduler = _FakeAncSupplementReminderScheduler();

      await tester.pumpWidget(
        _LocalizedHarness(
          child: AncTimelineScreen(
            repository: repository,
            reminderScheduler: scheduler,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(repository.lastLanguageCode, 'en');
      expect(find.text('Danger signs'), findsWidgets);
      expect(find.text('Severe headache or bleeding'), findsOneWidget);

      final dangerTop = tester.getTopLeft(
        find.text('Severe headache or bleeding'),
      );
      final kickTop = tester.getTopLeft(find.text('Fetal kick counter'));
      expect(dangerTop.dy, lessThan(kickTop.dy));

      await tester.drag(find.byType(ListView).last, const Offset(0, -900));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('anc_supplement_reminder_12')),
      );
      await tester.pumpAndSettle();

      expect(repository.lastToggledSupplementId, 12);
      expect(repository.lastToggleEnabled, isTrue);
      expect(scheduler.scheduledIds, [12]);
      expect(scheduler.cancelledIds, isEmpty);
      expect(find.text('On'), findsOneWidget);
      expect(find.text('Supplement reminder turned on'), findsOneWidget);
    },
  );

  testWidgets('shows empty state when there is no active pregnancy', (
    tester,
  ) async {
    await tester.pumpWidget(
      _LocalizedHarness(
        child: AncTimelineScreen(
          repository: _FakeMaternityRepository(_emptyTimeline()),
          reminderScheduler: _FakeAncSupplementReminderScheduler(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No active pregnancy on record'), findsOneWidget);
    expect(
      find.textContaining('your doctor will register your pregnancy'),
      findsOneWidget,
    );
  });
}

class _LocalizedHarness extends StatelessWidget {
  const _LocalizedHarness({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: child,
    );
  }
}

class _FakeMaternityRepository implements MaternityRepository {
  _FakeMaternityRepository(this.timeline);

  AncTimelineData timeline;
  String? lastLanguageCode;
  int? lastToggledSupplementId;
  bool? lastToggleEnabled;

  @override
  Future<AncTimelineData> loadTimeline({required String languageCode}) async {
    lastLanguageCode = languageCode;
    return timeline;
  }

  @override
  Future<AncFetalKick> recordFetalKicks({
    required int kickCount,
    required int observationWindowMinutes,
    String? notes,
  }) async {
    return AncFetalKick(
      id: 99,
      logDate: '2026-07-03',
      kickCount: kickCount,
      observationWindowMinutes: observationWindowMinutes,
      notes: notes,
    );
  }

  @override
  Future<AncSupplement> setSupplementReminder({
    required AncSupplement supplement,
    required bool enabled,
  }) async {
    lastToggledSupplementId = supplement.id;
    lastToggleEnabled = enabled;
    final updated = supplement.copyWith(reminderEnabled: enabled);
    timeline = timeline.copyWith(
      supplements: timeline.supplements
          .map((item) => item.id == supplement.id ? updated : item)
          .toList(growable: false),
    );
    return updated;
  }
}

class _FakeAncSupplementReminderScheduler
    implements AncSupplementReminderScheduler {
  final scheduledIds = <int>[];
  final cancelledIds = <int>[];

  @override
  Future<void> schedule(AncSupplement supplement) async {
    scheduledIds.add(supplement.id);
  }

  @override
  Future<void> cancel(AncSupplement supplement) async {
    cancelledIds.add(supplement.id);
  }
}

AncTimelineData _sampleTimeline() {
  return const AncTimelineData(
    pregnancy: AncPregnancy(
      id: 7,
      eddDate: '2026-11-20',
      gestationalAgeLabel: '24w 2d',
      gestationalWeeks: 24,
      gestationalDays: 2,
    ),
    visits: [
      AncVisit(
        visitNumber: 2,
        visitDate: '2026-07-01',
        gestationalAgeWeeks: 24,
        bpSystolic: 118,
        bpDiastolic: 76,
        weightKg: 62.4,
        fetalHeartRateBpm: 142,
        nextVisitDate: '2026-08-01',
      ),
    ],
    supplements: [
      AncSupplement(
        id: 12,
        supplement: 'iron',
        dose: '60 mg',
        frequency: 'once_daily',
        startDate: '2026-07-01',
        reminderEnabled: false,
        doseTimes: ['09:00'],
      ),
    ],
    fetalKicks: [AncFetalKick(logDate: '2026-07-02', kickCount: 10)],
    packages: [],
    advice: [
      AncAdvice(
        id: 1,
        trimester: 2,
        category: 'danger_signs',
        title: 'Danger signs',
        content: 'Severe headache or bleeding',
        contentStatus: 'reviewed',
      ),
      AncAdvice(
        id: 2,
        trimester: 2,
        category: 'fetal_movement',
        title: null,
        content: 'Track baby movements every day.',
        contentStatus: 'reviewed',
      ),
    ],
  );
}

AncTimelineData _emptyTimeline() {
  return const AncTimelineData(
    pregnancy: null,
    visits: [],
    supplements: [],
    fetalKicks: [],
    packages: [],
    advice: [],
  );
}
