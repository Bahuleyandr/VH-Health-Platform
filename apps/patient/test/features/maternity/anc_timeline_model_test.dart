import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/maternity/models/anc_timeline.dart';

void main() {
  Map<String, dynamic> timelineWith(Map<String, dynamic> extra) {
    return {
      'pregnancy': {
        'id': 7,
        'edd_date': '2026-11-20',
        'gestational_age': {'label': '24w 2d', 'weeks': 24, 'days': 2},
      },
      'visits': [
        {'visit_number': 1, 'visit_date': '2026-05-02'},
      ],
      'supplements': <Object?>[],
      'fetal_kicks': <Object?>[],
      ...extra,
    };
  }

  group('AncTimelineData.fromResponses booked_visits/general_vitals', () {
    test('null timeline response keeps empty defaults', () {
      final data = AncTimelineData.fromResponses(
        timelineData: null,
        packagesData: const [],
        adviceData: const {'advice': []},
      );

      expect(data.bookedVisits, isEmpty);
      expect(data.generalVitals, isEmpty);
    });

    test('timeline without the optional keys keeps empty defaults', () {
      final data = AncTimelineData.fromResponses(
        timelineData: timelineWith(const {}),
        packagesData: const [],
        adviceData: const {'advice': []},
      );

      expect(data.bookedVisits, isEmpty);
      expect(data.generalVitals, isEmpty);
      expect(data.visits, hasLength(1));
    });

    test('malformed optional values fall back to empty lists', () {
      final data = AncTimelineData.fromResponses(
        timelineData: timelineWith({
          'booked_visits': 'not-a-list',
          'general_vitals': {'recorded_at': 'not-a-list-either'},
        }),
        packagesData: const [],
        adviceData: const {'advice': []},
      );

      expect(data.bookedVisits, isEmpty);
      expect(data.generalVitals, isEmpty);
    });

    test('non-map entries inside the lists are skipped', () {
      final data = AncTimelineData.fromResponses(
        timelineData: timelineWith({
          'booked_visits': [
            42,
            'junk',
            null,
            {'id': 5, 'status': 'SCHEDULED'},
          ],
          'general_vitals': [
            'junk',
            {'id': 9, 'weight_kg': 61},
          ],
        }),
        packagesData: const [],
        adviceData: const {'advice': []},
      );

      expect(data.bookedVisits, hasLength(1));
      expect(data.bookedVisits.single.id, 5);
      expect(data.generalVitals, hasLength(1));
      expect(data.generalVitals.single.weightKg, 61);
    });

    test('populated rows parse the factual fields', () {
      final data = AncTimelineData.fromResponses(
        timelineData: timelineWith({
          'booked_visits': [
            {
              'id': '501',
              'appointment_date': '2026-08-01T00:00:00.000Z',
              'appointment_time': '10:30:00',
              'status': 'CONFIRMED',
              'department': 'Obstetrics',
              'reason': 'ANC review',
              // Backend schedule decoration — must not break parsing.
              'milestone_label': 'ANC contact 5',
              'gestational_age': {'weeks': 27, 'days': 0},
            },
          ],
          'general_vitals': [
            {
              'id': 601,
              'recorded_at': '2026-07-01T09:15:00.000Z',
              'systolic_bp': 118,
              'diastolic_bp': '76',
              'weight_kg': '62.4',
              'heart_rate': 80,
              'spo2': 98,
            },
          ],
        }),
        packagesData: const [],
        adviceData: const {'advice': []},
      );

      final booked = data.bookedVisits.single;
      expect(booked.id, 501);
      expect(booked.appointmentDate, '2026-08-01T00:00:00.000Z');
      expect(booked.appointmentTime, '10:30:00');
      expect(booked.status, 'CONFIRMED');
      expect(booked.department, 'Obstetrics');
      expect(booked.reason, 'ANC review');

      final vital = data.generalVitals.single;
      expect(vital.id, 601);
      expect(vital.recordedAt, '2026-07-01T09:15:00.000Z');
      expect(vital.systolicBp, 118);
      expect(vital.diastolicBp, 76);
      expect(vital.weightKg, 62.4);
    });

    test('partial rows parse with null fields and no throw', () {
      final data = AncTimelineData.fromResponses(
        timelineData: timelineWith({
          'booked_visits': [
            {'status': 'SCHEDULED'},
          ],
          'general_vitals': [
            {'id': 610},
          ],
        }),
        packagesData: const [],
        adviceData: const {'advice': []},
      );

      final booked = data.bookedVisits.single;
      expect(booked.id, isNull);
      expect(booked.appointmentDate, isNull);
      expect(booked.department, isNull);

      final vital = data.generalVitals.single;
      expect(vital.systolicBp, isNull);
      expect(vital.weightKg, isNull);
      expect(vital.hasDisplayableReading, isFalse);
    });

    test('copyWith preserves and replaces the new fields', () {
      const original = AncTimelineData(
        pregnancy: null,
        visits: [],
        supplements: [],
        fetalKicks: [],
        packages: [],
        advice: [],
        bookedVisits: [AncBookedVisit(id: 1, status: 'SCHEDULED')],
        generalVitals: [AncGeneralVital(id: 2, weightKg: 60)],
      );

      final untouched = original.copyWith();
      expect(untouched.bookedVisits, hasLength(1));
      expect(untouched.generalVitals, hasLength(1));

      final replaced = original.copyWith(bookedVisits: const []);
      expect(replaced.bookedVisits, isEmpty);
      expect(replaced.generalVitals, hasLength(1));
    });
  });

  group('AncBookedVisit.isUpcomingOrActive', () {
    final now = DateTime(2026, 7, 13, 10, 30);

    AncBookedVisit visit({String? status, String? date}) {
      return AncBookedVisit(status: status, appointmentDate: date);
    }

    test('future scheduled/confirmed bookings are shown', () {
      expect(
        visit(status: 'SCHEDULED', date: '2026-07-20').isUpcomingOrActive(now),
        isTrue,
      );
      expect(
        visit(
          status: 'CONFIRMED',
          date: '2026-08-01T00:00:00.000Z',
        ).isUpcomingOrActive(now),
        isTrue,
      );
    });

    test('today counts as upcoming', () {
      expect(
        visit(status: 'SCHEDULED', date: '2026-07-13').isUpcomingOrActive(now),
        isTrue,
      );
    });

    test('status match is case-insensitive', () {
      expect(
        visit(status: 'scheduled', date: '2026-07-20').isUpcomingOrActive(now),
        isTrue,
      );
    });

    test('completed bookings are hidden even when future-dated', () {
      expect(
        visit(status: 'COMPLETED', date: '2026-07-20').isUpcomingOrActive(now),
        isFalse,
      );
    });

    test('cancelled, no-show, and unknown statuses are hidden', () {
      expect(
        visit(status: 'CANCELLED', date: '2026-07-20').isUpcomingOrActive(now),
        isFalse,
      );
      expect(
        visit(status: 'NO_SHOW', date: '2026-07-20').isUpcomingOrActive(now),
        isFalse,
      );
      expect(
        visit(
          status: 'RESCHEDULED',
          date: '2026-07-20',
        ).isUpcomingOrActive(now),
        isFalse,
      );
      expect(
        visit(status: 'garbage', date: '2026-07-20').isUpcomingOrActive(now),
        isFalse,
      );
      expect(
        visit(status: null, date: '2026-07-20').isUpcomingOrActive(now),
        isFalse,
      );
    });

    test('stale past bookings are hidden', () {
      expect(
        visit(status: 'SCHEDULED', date: '2026-07-12').isUpcomingOrActive(now),
        isFalse,
      );
    });

    test('in-progress bookings stay visible regardless of date', () {
      expect(
        visit(
          status: 'IN_PROGRESS',
          date: '2026-07-12',
        ).isUpcomingOrActive(now),
        isTrue,
      );
      expect(visit(status: 'IN_PROGRESS').isUpcomingOrActive(now), isTrue);
    });

    test('missing or unparseable dates fail closed for scheduled rows', () {
      expect(visit(status: 'SCHEDULED').isUpcomingOrActive(now), isFalse);
      expect(
        visit(status: 'SCHEDULED', date: 'not-a-date').isUpcomingOrActive(now),
        isFalse,
      );
    });
  });

  group('AncGeneralVital readings', () {
    test('BP requires both systolic and diastolic', () {
      const systolicOnly = AncGeneralVital(systolicBp: 118);
      expect(systolicOnly.hasBloodPressure, isFalse);
      expect(systolicOnly.hasDisplayableReading, isFalse);

      const both = AncGeneralVital(systolicBp: 118, diastolicBp: 76);
      expect(both.hasBloodPressure, isTrue);
      expect(both.hasDisplayableReading, isTrue);
    });

    test('weight alone is displayable', () {
      const weightOnly = AncGeneralVital(weightKg: 62.4);
      expect(weightOnly.hasBloodPressure, isFalse);
      expect(weightOnly.hasDisplayableReading, isTrue);
    });

    test('empty rows are not displayable', () {
      const empty = AncGeneralVital();
      expect(empty.hasDisplayableReading, isFalse);
    });

    test('malformed numeric values parse to null instead of throwing', () {
      final vital = AncGeneralVital.fromJson(const {
        'id': 'abc',
        'systolic_bp': 'high',
        'diastolic_bp': true,
        'weight_kg': 'heavy',
      });
      expect(vital.id, isNull);
      expect(vital.systolicBp, isNull);
      expect(vital.diastolicBp, isNull);
      expect(vital.weightKg, isNull);
      expect(vital.hasDisplayableReading, isFalse);
    });
  });
}
