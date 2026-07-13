import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/intl.dart';
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

  testWidgets(
    'renders only future or active booked visits and recorded BP/weight',
    (tester) async {
      final now = DateTime.now();
      final semanticFutureDate = DateTime(
        now.year,
        now.month,
        now.day,
      ).add(const Duration(days: 20));
      tester.view.physicalSize = const Size(1080, 3000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(
        _LocalizedHarness(
          child: AncTimelineScreen(
            repository: _FakeMaternityRepository(_factsTimeline(now)),
            reminderScheduler: _FakeAncSupplementReminderScheduler(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Future scheduled + active attendance bookings render with their
      // factual booking details.
      expect(find.text('Booked visits'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('anc_booked_visit_501')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('anc_booked_visit_504')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('anc_booked_visit_505')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('anc_booked_visit_506')),
        findsOneWidget,
      );
      expect(find.textContaining('10:30'), findsOneWidget);
      expect(find.textContaining('Obstetrics'), findsOneWidget);
      expect(find.textContaining('Reason: ANC review'), findsOneWidget);
      expect(find.text('Scheduled'), findsOneWidget);
      expect(find.text('In progress'), findsOneWidget);
      expect(find.text('Checked in'), findsOneWidget);
      expect(find.text('Waiting'), findsOneWidget);

      // The appointment's backend date remains the displayed calendar day;
      // its attached offset must not move it into the following day.
      final expectedDate = DateFormat.yMMMd('en').format(semanticFutureDate);
      final shiftedDate = DateFormat.yMMMd(
        'en',
      ).format(semanticFutureDate.add(const Duration(days: 1)));
      expect(find.textContaining(expectedDate), findsOneWidget);
      expect(find.textContaining(shiftedDate), findsNothing);

      // Completed and stale past bookings never render — the completed one
      // is already represented by a recorded ANC visit.
      expect(find.byKey(const ValueKey('anc_booked_visit_502')), findsNothing);
      expect(find.byKey(const ValueKey('anc_booked_visit_503')), findsNothing);
      expect(find.textContaining('CompletedDept'), findsNothing);
      expect(find.textContaining('StaleDept'), findsNothing);

      // Recorded BP and weight facts show units and recorded timestamps.
      expect(find.text('Recorded BP & weight'), findsOneWidget);
      expect(find.text('118/76 mmHg'), findsOneWidget);
      expect(find.text('62.4 kg'), findsOneWidget);
      expect(find.text('63 kg'), findsOneWidget);
      expect(find.textContaining('Jul 1, 2026'), findsOneWidget);

      // A row with no BP pair and no weight has nothing factual to show.
      expect(find.byKey(const ValueKey('anc_general_vital_603')), findsNothing);
      // Readings without a valid recorded timestamp fail closed, and raw
      // malformed timestamp text never reaches the UI.
      expect(find.byKey(const ValueKey('anc_general_vital_604')), findsNothing);
      expect(find.byKey(const ValueKey('anc_general_vital_605')), findsNothing);
      expect(find.text('199/111 mmHg'), findsNothing);
      expect(find.text('99 kg'), findsNothing);
      expect(find.textContaining('not-a-recorded-time'), findsNothing);
    },
  );

  testWidgets(
    'hides booked visit and vitals sections when the response lacks them',
    (tester) async {
      tester.view.physicalSize = const Size(1080, 3000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(
        _LocalizedHarness(
          child: AncTimelineScreen(
            repository: _FakeMaternityRepository(_sampleTimeline()),
            reminderScheduler: _FakeAncSupplementReminderScheduler(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Booked visits'), findsNothing);
      expect(find.text('Recorded BP & weight'), findsNothing);
    },
  );
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

String _isoDate(DateTime date) {
  return '${date.year.toString().padLeft(4, '0')}-'
      '${date.month.toString().padLeft(2, '0')}-'
      '${date.day.toString().padLeft(2, '0')}';
}

/// Timeline exercising the F1 booked-visit filter and general-vitals facts.
/// Booking dates are relative to today so the test never goes stale.
AncTimelineData _factsTimeline(DateTime now) {
  final future =
      '${_isoDate(now.add(const Duration(days: 20)))}'
      'T23:30:00-12:00';
  final past = _isoDate(now.subtract(const Duration(days: 20)));
  return AncTimelineData(
    pregnancy: const AncPregnancy(
      id: 7,
      eddDate: '2026-11-20',
      gestationalAgeLabel: '24w 2d',
      gestationalWeeks: 24,
      gestationalDays: 2,
    ),
    visits: const [
      AncVisit(visitNumber: 1, visitDate: '2026-05-02', weightKg: 60),
    ],
    supplements: const [],
    fetalKicks: const [],
    packages: const [],
    advice: const [],
    bookedVisits: [
      AncBookedVisit(
        id: 501,
        appointmentDate: future,
        appointmentTime: '10:30:00',
        status: 'SCHEDULED',
        department: 'Obstetrics',
        reason: 'ANC review',
      ),
      AncBookedVisit(
        id: 502,
        appointmentDate: past,
        appointmentTime: '09:00:00',
        status: 'COMPLETED',
        department: 'CompletedDept',
      ),
      AncBookedVisit(
        id: 503,
        appointmentDate: past,
        appointmentTime: '11:00:00',
        status: 'SCHEDULED',
        department: 'StaleDept',
      ),
      AncBookedVisit(
        id: 504,
        appointmentDate: past,
        status: 'IN_PROGRESS',
        department: 'Labour ward',
      ),
      AncBookedVisit(
        id: 505,
        appointmentDate: past,
        status: 'CHECKED_IN',
        department: 'ANC reception',
      ),
      AncBookedVisit(
        id: 506,
        appointmentDate: past,
        status: 'WAITING',
        department: 'ANC waiting area',
      ),
    ],
    generalVitals: const [
      AncGeneralVital(
        id: 601,
        recordedAt: '2026-07-01T09:15:00.000Z',
        systolicBp: 118,
        diastolicBp: 76,
        weightKg: 62.4,
      ),
      AncGeneralVital(
        id: 602,
        recordedAt: '2026-07-02T09:15:00.000Z',
        weightKg: 63,
      ),
      AncGeneralVital(id: 603),
      AncGeneralVital(
        id: 604,
        recordedAt: 'not-a-recorded-time',
        systolicBp: 199,
        diastolicBp: 111,
        weightKg: 99,
      ),
      AncGeneralVital(id: 605, systolicBp: 188, diastolicBp: 110, weightKg: 98),
    ],
  );
}
