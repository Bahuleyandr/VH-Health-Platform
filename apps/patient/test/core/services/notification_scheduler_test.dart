import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:timezone/data/latest_all.dart' as tz;
import 'package:timezone/timezone.dart' as tz;
import 'package:vhhealth/core/services/deep_link_service.dart';
import 'package:vhhealth/core/services/notification_scheduler.dart';

void main() {
  test('normal reminder notification IDs keep the legacy mapping', () {
    expect(NotificationScheduler.notificationIdForReminderSlot(42, 3), 4203);
  });

  test('ANC supplement projection IDs use a safe local namespace', () {
    final projectedId =
        NotificationScheduler.ancSupplementReminderIdOffset + 42;
    final notificationId = NotificationScheduler.notificationIdForReminderSlot(
      projectedId,
      3,
    );

    expect(notificationId, 700004203);
    expect(notificationId, lessThan(1 << 31));
  });

  group('boundedReminderInstances (end-dated reminders)', () {
    late tz.Location kolkata;

    setUpAll(() {
      tz.initializeTimeZones();
      kolkata = tz.getLocation('Asia/Kolkata');
    });

    tz.TZDateTime at(
      int year,
      int month,
      int day, [
      int hour = 0,
      int minute = 0,
    ]) => tz.TZDateTime(kolkata, year, month, day, hour, minute);

    test('schedules one-shot instances through the end date inclusive', () {
      final instances = NotificationScheduler.boundedReminderInstances(
        id: 7,
        reminderTimes: ['09:00', '21:00'],
        endDate: '2026-08-20',
        now: at(2026, 8, 18, 10, 0),
      );

      // 09:00 today already passed; 21:00 today + both slots on the
      // 19th and 20th remain. Nothing beyond the end date.
      expect(instances, hasLength(5));
      expect(instances.map((i) => i.scheduledDate).toList(), [
        at(2026, 8, 18, 21, 0),
        at(2026, 8, 19, 9, 0),
        at(2026, 8, 19, 21, 0),
        at(2026, 8, 20, 9, 0),
        at(2026, 8, 20, 21, 0),
      ]);
      for (final instance in instances) {
        expect(instance.scheduledDate.isBefore(at(2026, 8, 21)), isTrue);
      }
    });

    test('instance IDs stay inside the reminder\'s 0..99 cancel sweep', () {
      final instances = NotificationScheduler.boundedReminderInstances(
        id: 7,
        reminderTimes: ['09:00', '21:00'],
        endDate: '2026-08-20',
        now: at(2026, 8, 18, 10, 0),
      );

      // daysCap = 3 → slot 0 uses indices 0..2, slot 1 uses 3..5.
      expect(instances.map((i) => i.notificationId).toSet(), {
        701,
        702,
        703,
        704,
        705,
      });
      for (final instance in instances) {
        expect(instance.notificationId - 700, inInclusiveRange(0, 99));
      }
    });

    test('returns nothing once the end date has passed', () {
      final instances = NotificationScheduler.boundedReminderInstances(
        id: 7,
        reminderTimes: ['09:00'],
        endDate: '2026-08-17',
        now: at(2026, 8, 18, 10, 0),
      );

      expect(instances, isEmpty);
    });

    test('returns nothing when every slot on the end date has passed', () {
      final instances = NotificationScheduler.boundedReminderInstances(
        id: 7,
        reminderTimes: ['09:00'],
        endDate: '2026-08-18',
        now: at(2026, 8, 18, 10, 0),
      );

      expect(instances, isEmpty);
    });

    test('still fires the remaining slot on the end date itself', () {
      final instances = NotificationScheduler.boundedReminderInstances(
        id: 7,
        reminderTimes: ['09:00', '21:00'],
        endDate: '2026-08-18',
        now: at(2026, 8, 18, 10, 0),
      );

      expect(instances, hasLength(1));
      expect(instances.single.scheduledDate, at(2026, 8, 18, 21, 0));
    });

    test('caps long courses and keeps every ID under the sweep bound', () {
      final instances = NotificationScheduler.boundedReminderInstances(
        id: 7,
        reminderTimes: ['06:00', '12:00', '18:00', '00:00'],
        endDate: '2027-08-18',
        now: at(2026, 8, 18, 5, 0),
      );

      // 56 ~/ 4 slots = 14 days; the 00:00 slot on day 0 has passed.
      expect(instances, hasLength(55));
      for (final instance in instances) {
        expect(instance.notificationId - 700, inInclusiveRange(0, 99));
        expect(instance.scheduledDate.isBefore(at(2026, 9, 2)), isTrue);
      }
    });

    test('ANC projected reminder instances stay inside int32', () {
      final projectedId =
          NotificationScheduler.ancSupplementReminderIdOffset + 42;
      final instances = NotificationScheduler.boundedReminderInstances(
        id: projectedId,
        reminderTimes: ['09:00'],
        endDate: '2026-08-25',
        now: at(2026, 8, 18, 5, 0),
      );

      expect(instances, hasLength(8));
      for (final instance in instances) {
        expect(instance.notificationId, lessThan(1 << 31));
        expect(instance.notificationId, greaterThanOrEqualTo(700004200));
        expect(instance.notificationId, lessThan(700004300));
      }
    });

    test('unparseable end dates and empty time lists yield no instances', () {
      expect(
        NotificationScheduler.boundedReminderInstances(
          id: 7,
          reminderTimes: ['09:00'],
          endDate: 'not-a-date',
          now: at(2026, 8, 18, 5, 0),
        ),
        isEmpty,
      );
      expect(
        NotificationScheduler.boundedReminderInstances(
          id: 7,
          reminderTimes: ['garbage', '9'],
          endDate: '2026-08-20',
          now: at(2026, 8, 18, 5, 0),
        ),
        isEmpty,
      );
    });
  });

  group('a medication reminder tap resolves to a screen that shows it', () {
    // The scheduled body says "Time for your medication. Open the app for
    // details." The payload used to be `{'reminderId': id}` alone, which
    // `DeepLinkService.parseNotificationRoute` resolves to null (no `route`,
    // no `type`), so `PatientNotificationTapGate.open` returned false and the
    // tap did nothing — the notification told the patient to open the app and
    // then refused to.
    test('the payload resolves through the real tap-path resolver', () {
      final payload = jsonDecode(
        NotificationScheduler.medicationReminderPayload(42),
      ) as Map<String, dynamic>;

      expect(payload['reminderId'], 42);
      expect(DeepLinkService.parseNotificationRoute(payload), '/reminders');
    });

    test('both schedule call sites use that payload', () {
      // Bounded (one-shot) and open-ended (daily repeat) reminders are
      // scheduled by two separate zonedSchedule calls. A fix applied to one
      // leaves the other inert, and neither can be observed without the
      // platform channel — so pin the source.
      final source = File('lib/core/services/notification_scheduler.dart')
          .readAsStringSync();

      expect(
        'payload: medicationReminderPayload(id),'.allMatches(source).length,
        2,
        reason: 'both zonedSchedule calls must carry the routable payload',
      );
      expect(
        source.contains("jsonEncode({'reminderId': id})"),
        isFalse,
        reason: 'the unroutable payload must not survive anywhere',
      );
    });

    test('/reminders is a real route whose screen lists the reminders', () {
      final router = File('lib/core/navigation/app_router.dart')
          .readAsStringSync();

      expect(
        RegExp(
          r"path: '/reminders',[\s\S]{0,200}?MedicationRemindersScreen\(\)",
        ).hasMatch(router),
        isTrue,
        reason:
            '/reminders must still resolve to MedicationRemindersScreen — the '
            'screen that actually renders the medication, dosage and times the '
            'notification body promises',
      );
      expect(DeepLinkService.debugAllowedRoutes, contains('/reminders'));
    });
  });
}
