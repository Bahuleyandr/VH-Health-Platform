// Unit tests for status enum parsing + classification.
// Pure Dart, no Flutter/Firebase/backend dependencies — run with `flutter test`.

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/models/status_enums.dart';

void main() {
  group('AppointmentStatus.fromString', () {
    test('parses canonical uppercase values', () {
      expect(
        AppointmentStatus.fromString('SCHEDULED'),
        AppointmentStatus.scheduled,
      );
      expect(
        AppointmentStatus.fromString('CONFIRMED'),
        AppointmentStatus.confirmed,
      );
      expect(
        AppointmentStatus.fromString('IN_PROGRESS'),
        AppointmentStatus.inProgress,
      );
      expect(
        AppointmentStatus.fromString('COMPLETED'),
        AppointmentStatus.completed,
      );
      expect(
        AppointmentStatus.fromString('CANCELLED'),
        AppointmentStatus.cancelled,
      );
      expect(AppointmentStatus.fromString('NO_SHOW'), AppointmentStatus.noShow);
      expect(
        AppointmentStatus.fromString('RESCHEDULED'),
        AppointmentStatus.rescheduled,
      );
    });

    test('covers exactly the backend canonical status list', () {
      // Mirror of APPOINTMENT_STATUS in apps/backend/src/config/userConfig.js
      // (same list as APPOINTMENT_CONFIG.STATUSES in appointmentConfig.js).
      // If the backend adds a status, add it to AppointmentStatus and here.
      const backendStatuses = {
        'SCHEDULED',
        'CONFIRMED',
        'IN_PROGRESS',
        'COMPLETED',
        'CANCELLED',
        'NO_SHOW',
        'RESCHEDULED',
      };
      expect(
        AppointmentStatus.values.map((e) => e.value).toSet(),
        backendStatuses,
      );
    });

    test('non-canonical flow states stay fail-closed', () {
      // CHECKED_IN / WAITING can appear in stored rows but are not part of
      // the backend's canonical appointment status list — callers that care
      // (e.g. the ANC timeline) handle them locally.
      expect(AppointmentStatus.fromString('CHECKED_IN'), isNull);
      expect(AppointmentStatus.fromString('WAITING'), isNull);
    });

    test('accepts lowercase + mixed case', () {
      expect(
        AppointmentStatus.fromString('scheduled'),
        AppointmentStatus.scheduled,
      );
      expect(
        AppointmentStatus.fromString('In_Progress'),
        AppointmentStatus.inProgress,
      );
    });

    test('returns null for null input', () {
      expect(AppointmentStatus.fromString(null), isNull);
    });

    test('returns null for unknown string', () {
      expect(AppointmentStatus.fromString('BOGUS'), isNull);
      expect(AppointmentStatus.fromString(''), isNull);
    });

    test('isActive + isTerminal classifications', () {
      expect(AppointmentStatus.scheduled.isActive, isTrue);
      expect(AppointmentStatus.confirmed.isActive, isTrue);
      expect(AppointmentStatus.inProgress.isActive, isTrue);
      expect(AppointmentStatus.completed.isActive, isFalse);
      expect(AppointmentStatus.cancelled.isActive, isFalse);

      expect(AppointmentStatus.rescheduled.isActive, isFalse);

      expect(AppointmentStatus.completed.isTerminal, isTrue);
      expect(AppointmentStatus.cancelled.isTerminal, isTrue);
      expect(AppointmentStatus.noShow.isTerminal, isTrue);
      expect(AppointmentStatus.rescheduled.isTerminal, isTrue);
      expect(AppointmentStatus.scheduled.isTerminal, isFalse);
    });
  });

  group('PharmacyOrderStatus.fromString', () {
    test('parses the 7 canonical statuses', () {
      expect(
        PharmacyOrderStatus.fromString('PENDING'),
        PharmacyOrderStatus.pending,
      );
      expect(
        PharmacyOrderStatus.fromString('CONFIRMED'),
        PharmacyOrderStatus.confirmed,
      );
      expect(
        PharmacyOrderStatus.fromString('PREPARING'),
        PharmacyOrderStatus.preparing,
      );
      expect(
        PharmacyOrderStatus.fromString('READY'),
        PharmacyOrderStatus.ready,
      );
      expect(
        PharmacyOrderStatus.fromString('DISPATCHED'),
        PharmacyOrderStatus.dispatched,
      );
      expect(
        PharmacyOrderStatus.fromString('DELIVERED'),
        PharmacyOrderStatus.delivered,
      );
      expect(
        PharmacyOrderStatus.fromString('CANCELLED'),
        PharmacyOrderStatus.cancelled,
      );
    });

    test(
      'legacy PLACED folds into pending (backend lifecycle renamed 2026-04-14)',
      () {
        expect(
          PharmacyOrderStatus.fromString('PLACED'),
          PharmacyOrderStatus.pending,
        );
        expect(
          PharmacyOrderStatus.fromString('placed'),
          PharmacyOrderStatus.pending,
        );
      },
    );

    test('isActive includes every non-terminal state', () {
      expect(PharmacyOrderStatus.pending.isActive, isTrue);
      expect(PharmacyOrderStatus.confirmed.isActive, isTrue);
      expect(PharmacyOrderStatus.preparing.isActive, isTrue);
      expect(PharmacyOrderStatus.ready.isActive, isTrue);
      expect(PharmacyOrderStatus.dispatched.isActive, isTrue);
      expect(PharmacyOrderStatus.delivered.isActive, isFalse);
      expect(PharmacyOrderStatus.cancelled.isActive, isFalse);
    });

    test('orderedSteps reflects canonical lifecycle (no PLACED)', () {
      expect(PharmacyOrderStatus.orderedSteps, contains('PENDING'));
      expect(PharmacyOrderStatus.orderedSteps, isNot(contains('PLACED')));
      expect(PharmacyOrderStatus.orderedSteps.first, 'PENDING');
      expect(PharmacyOrderStatus.orderedSteps.last, 'DELIVERED');
    });

    test('returns null for unknown strings', () {
      expect(PharmacyOrderStatus.fromString(null), isNull);
      expect(PharmacyOrderStatus.fromString('BOGUS'), isNull);
    });
  });

  group('InvestigationStatus.fromString', () {
    test('parses canonical statuses', () {
      expect(
        InvestigationStatus.fromString('PENDING'),
        InvestigationStatus.pending,
      );
      expect(
        InvestigationStatus.fromString('SAMPLE_COLLECTED'),
        InvestigationStatus.sampleCollected,
      );
      expect(
        InvestigationStatus.fromString('REPORT_READY'),
        InvestigationStatus.reportReady,
      );
    });

    test('reportReady is not isActive but is not isTerminal either', () {
      // Nuance: report ready means patient still has to pick it up; shown in active list
      // until marked as "viewed" or completed. Keep the classification explicit.
      expect(InvestigationStatus.reportReady.isActive, isFalse);
      expect(InvestigationStatus.reportReady.isTerminal, isFalse);
    });

    test('terminal states', () {
      expect(InvestigationStatus.completed.isTerminal, isTrue);
      expect(InvestigationStatus.cancelled.isTerminal, isTrue);
    });
  });
}
