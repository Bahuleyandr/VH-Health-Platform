// lib/core/services/notification_scheduler.dart
//
// Platform Setup Required:
// Android: SCHEDULE_EXACT_ALARM, RECEIVE_BOOT_COMPLETED, POST_NOTIFICATIONS
// iOS: No extra setup needed.

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:timezone/data/latest_all.dart' as tz;
import 'package:timezone/timezone.dart' as tz;
import 'package:vhhealth/core/services/patient_notification_privacy.dart';

typedef NotificationPayloadHandler = void Function(String payload);

/// One planned local-notification firing for a medication reminder with an
/// end date: bounded reminders are scheduled as individual one-shot
/// notifications (never an unbounded daily repeat), so nothing keeps firing
/// after the course ends.
@immutable
class ReminderNotificationInstance {
  const ReminderNotificationInstance({
    required this.notificationId,
    required this.scheduledDate,
  });

  final int notificationId;
  final tz.TZDateTime scheduledDate;
}

class NotificationScheduler {
  NotificationScheduler._();

  // Must match the backend medicationReminderService ANC projection offset.
  // Android notification IDs are int32; use a safe local namespace when the
  // backend sends projected ANC supplement IDs such as 1,000,000,042.
  static const int ancSupplementReminderIdOffset = 1000000000;
  static const int _ancSupplementLocalIdOffset = 7000000;
  static const int _ancSupplementLocalIdModulo = 10000000;

  /// Cap on one-shot notifications scheduled per bounded (end-dated)
  /// reminder. Two constraints:
  /// - every instance index must stay < 100 so [cancelReminder]'s
  ///   0..99 sweep clears them and IDs never collide across reminders;
  /// - iOS keeps at most 64 pending local notifications app-wide, so a
  ///   single course must leave headroom for other reminders. Each
  ///   resync ([rescheduleAll] on cold start / reminders-screen visit)
  ///   tops the window up, so a long course keeps rolling forward; if
  ///   the app is never opened the notifications stop early rather
  ///   than firing past the end date.
  static const int _maxBoundedInstancesPerReminder = 56;

  static const _patientPushChannelId = 'patient_push';
  static const _patientPushChannelName = 'Patient Updates';
  static const _patientPushChannelDescription =
      'Appointment, result, pharmacy, portal, and hospital updates';

  static final _plugin = FlutterLocalNotificationsPlugin();
  static NotificationPayloadHandler? _payloadHandler;

  /// Shared one-shot init future. The first caller kicks off [_doInitialize];
  /// every later caller — and every public method below, via [initialize] —
  /// awaits the same future. Methods are therefore safe to call in any order
  /// without remembering to initialize first, and `main()` can kick init off
  /// the critical path.
  static Future<void>? _initFuture;

  /// Idempotent and concurrency-safe; cheap to await once initialised.
  static Future<void> initialize() => _initFuture ??= _doInitialize();

  /// Register a callback for notification payload taps. Safe to call before or
  /// after [initialize]; the initialized plugin callback reads this latest
  /// handler when a user taps a local notification.
  static void setPayloadHandler(NotificationPayloadHandler handler) {
    _payloadHandler = handler;
  }

  static Future<void> _doInitialize() async {
    tz.initializeTimeZones();
    // Anchor tz.local to the clinic timezone. Without this, tz.local stays UTC
    // and scheduled reminders fire at the wrong wall-clock time (IST is UTC+5:30,
    // so reminders would fire ~5.5h late). The whole platform assumes IST
    // (APP_TIMEZONE, offset-less = IST) and the hospital is in Chennai. If the
    // app ever serves multiple regions, source this from the device timezone.
    tz.setLocalLocation(tz.getLocation('Asia/Kolkata'));

    const androidSettings = AndroidInitializationSettings(
      '@mipmap/ic_launcher',
    );
    const iosSettings = DarwinInitializationSettings(
      requestAlertPermission: true,
      requestBadgePermission: true,
      requestSoundPermission: true,
    );
    const initSettings = InitializationSettings(
      android: androidSettings,
      iOS: iosSettings,
    );

    await _plugin.initialize(
      settings: initSettings,
      onDidReceiveNotificationResponse: (response) {
        final payload = response.payload;
        if (payload == null || payload.isEmpty) return;
        _payloadHandler?.call(payload);
      },
    );

    await _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.requestNotificationsPermission();

    await _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.createNotificationChannel(
          const AndroidNotificationChannel(
            'medication_reminders',
            'Medication Reminders',
            description: 'Reminders to take your medications on time',
            importance: Importance.high,
          ),
        );

    await _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.createNotificationChannel(
          const AndroidNotificationChannel(
            _patientPushChannelId,
            _patientPushChannelName,
            description: _patientPushChannelDescription,
            importance: Importance.high,
          ),
        );
  }

  static Future<void> showPushNotification({
    required String title,
    required String body,
    required Map<String, dynamic> payload,
  }) async {
    await initialize();

    if (title.trim().isEmpty && body.trim().isEmpty) return;

    final safePayload = <String, String>{};
    for (final entry in patientNotificationPayload(payload).entries) {
      final value = entry.value;
      if (value == null) continue;
      safePayload[entry.key] = value.toString();
    }

    await _plugin.show(
      id: DateTime.now().millisecondsSinceEpoch.remainder(1 << 31),
      title: title.trim().isEmpty ? 'VH Health' : title.trim(),
      body: body.trim(),
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails(
          _patientPushChannelId,
          _patientPushChannelName,
          channelDescription: _patientPushChannelDescription,
          importance: Importance.high,
          priority: Priority.high,
          visibility: NotificationVisibility.private,
        ),
        iOS: DarwinNotificationDetails(),
      ),
      payload: jsonEncode(safePayload),
    );
  }

  /// Payload for a locally-scheduled medication reminder.
  ///
  /// The `type` is what makes the notification TAPPABLE. The tap path is
  /// `_handleLocalNotificationPayload` → PatientNotificationTapGate.open →
  /// `DeepLinkService.parseNotificationRoute`, and that resolver needs either
  /// an allowlisted `route` or a known `type` — a payload carrying only
  /// `reminderId` resolves to null, so the gate returns false and the tap does
  /// nothing at all. `MEDICATION_REMINDER` resolves to `/reminders`
  /// (MedicationRemindersScreen), which lists every reminder — active and
  /// toggled-off — with its medication name, dosage and times. That is the
  /// "details" the body text promises, and the pinning test in
  /// `notification_scheduler_test.dart` asserts both the resolution and that
  /// `/reminders` is a real route in `app_router.dart`.
  ///
  /// `reminderId` is kept: it identifies the reminder for any future
  /// per-reminder destination and is inert to the resolver today.
  @visibleForTesting
  static String medicationReminderPayload(int reminderId) =>
      jsonEncode({'type': 'MEDICATION_REMINDER', 'reminderId': reminderId});

  static const NotificationDetails _medicationNotificationDetails =
      NotificationDetails(
        android: AndroidNotificationDetails(
          'medication_reminders',
          'Medication Reminders',
          channelDescription: 'Reminders to take your medications on time',
          importance: Importance.high,
          priority: Priority.high,
        ),
        iOS: DarwinNotificationDetails(),
      );

  /// Schedule notifications for a medication reminder.
  ///
  /// Reminders WITHOUT an end date use an OS-level daily repeat
  /// ([DateTimeComponents.time]). Reminders WITH an end date are
  /// scheduled as bounded one-shot instances up to (and including) the
  /// end date — an OS daily repeat never stops on its own, so an
  /// end-dated course scheduled that way kept firing "Time for your
  /// medication" every day after the course finished until the next
  /// resync happened to run.
  ///
  /// SECURITY: Notification body uses generic text to prevent PHI
  /// exposure on lock screens. Actual medication details are only
  /// shown when the user opens the app.
  static Future<void> scheduleReminder({
    required int id,
    required String medicationName,
    required String dosage,
    required List<String> reminderTimes,
    String? endDate,
    required bool isActive,
  }) async {
    await initialize();
    if (!isActive) return;

    if (endDate != null &&
        endDate.isNotEmpty &&
        DateTime.tryParse(endDate) != null) {
      // Bounded course: one-shot instances through the end date only.
      final instances = boundedReminderInstances(
        id: id,
        reminderTimes: reminderTimes,
        endDate: endDate,
      );
      for (final instance in instances) {
        try {
          await _plugin.zonedSchedule(
            id: instance.notificationId,
            title: 'Medication Reminder',
            // Generic message to prevent PHI on lock screen
            body: 'Time for your medication. Open the app for details.',
            scheduledDate: instance.scheduledDate,
            notificationDetails: _medicationNotificationDetails,
            androidScheduleMode: AndroidScheduleMode.exactAllowWhileIdle,
            payload: medicationReminderPayload(id),
          );
        } catch (e) {
          if (kDebugMode) {
            debugPrint(
              'Failed to schedule notification ${instance.notificationId}: $e',
            );
          }
        }
      }
      return;
    }

    // Open-ended reminder: unbounded OS-level daily repeat.
    for (var i = 0; i < reminderTimes.length; i++) {
      final parts = reminderTimes[i].split(':');
      if (parts.length != 2) continue;

      final hour = int.tryParse(parts[0]);
      final minute = int.tryParse(parts[1]);
      if (hour == null || minute == null) continue;

      final notificationId = notificationIdForReminderSlot(id, i);
      final scheduledTime = _nextInstanceOfTime(hour, minute);

      try {
        await _plugin.zonedSchedule(
          id: notificationId,
          title: 'Medication Reminder',
          // Generic message to prevent PHI on lock screen
          body: 'Time for your medication. Open the app for details.',
          scheduledDate: scheduledTime,
          notificationDetails: _medicationNotificationDetails,
          androidScheduleMode: AndroidScheduleMode.exactAllowWhileIdle,
          matchDateTimeComponents: DateTimeComponents.time,
          payload: medicationReminderPayload(id),
        );
      } catch (e) {
        if (kDebugMode) {
          debugPrint('Failed to schedule notification $notificationId: $e');
        }
      }
    }
  }

  /// Plan the bounded one-shot instances for an end-dated reminder.
  ///
  /// The end date is INCLUSIVE (a course "ending 2026-08-20" still
  /// fires on the 20th). Instances are capped at
  /// [_maxBoundedInstancesPerReminder]; each resync tops the window up
  /// for long courses. Instance indices are packed slot-major
  /// (`slot * daysCap + day`) and always stay < 100, so
  /// [cancelReminder]'s 0..99 sweep cancels every pending instance and
  /// IDs never collide with another reminder's namespace.
  @visibleForTesting
  static List<ReminderNotificationInstance> boundedReminderInstances({
    required int id,
    required List<String> reminderTimes,
    required String endDate,
    tz.TZDateTime? now,
  }) {
    final nowTz = now ?? tz.TZDateTime.now(tz.local);
    final location = nowTz.location;
    final end = DateTime.tryParse(endDate);
    if (end == null) return const [];

    final today = tz.TZDateTime(location, nowTz.year, nowTz.month, nowTz.day);
    final endDay = tz.TZDateTime(location, end.year, end.month, end.day);
    final remainingDays = endDay.difference(today).inDays + 1;
    if (remainingDays <= 0) return const [];

    // Parse valid HH:mm slots first so the index space stays packed.
    final slots = <(int, int)>[];
    for (final time in reminderTimes) {
      final parts = time.split(':');
      if (parts.length != 2) continue;
      final hour = int.tryParse(parts[0]);
      final minute = int.tryParse(parts[1]);
      if (hour == null || minute == null) continue;
      slots.add((hour, minute));
    }
    if (slots.isEmpty) return const [];

    final maxDays = _maxBoundedInstancesPerReminder ~/ slots.length;
    final daysCap = remainingDays < maxDays ? remainingDays : maxDays;
    if (daysCap <= 0) return const [];

    final instances = <ReminderNotificationInstance>[];
    for (var slot = 0; slot < slots.length; slot++) {
      final (hour, minute) = slots[slot];
      for (var day = 0; day < daysCap; day++) {
        final scheduled = tz.TZDateTime(
          location,
          today.year,
          today.month,
          today.day + day,
          hour,
          minute,
        );
        // Skip today's already-passed times.
        if (!scheduled.isAfter(nowTz)) continue;
        instances.add(
          ReminderNotificationInstance(
            notificationId: notificationIdForReminderSlot(
              id,
              slot * daysCap + day,
            ),
            scheduledDate: scheduled,
          ),
        );
      }
    }
    // Chronological order, so the soonest firings are registered first
    // if the platform ever truncates the pending set.
    instances.sort((a, b) => a.scheduledDate.compareTo(b.scheduledDate));
    return instances;
  }

  /// Cancel all notifications for a given reminder.
  static Future<void> cancelReminder(int reminderId) async {
    await initialize();
    for (var i = 0; i < 100; i++) {
      await _plugin.cancel(id: notificationIdForReminderSlot(reminderId, i));
    }
  }

  /// Cancel all then reschedule active reminders.
  static Future<void> rescheduleAll(
    List<Map<String, dynamic>> reminders,
  ) async {
    await initialize();
    await cancelAll();
    for (final r in reminders) {
      await scheduleReminder(
        id: r['id'] as int,
        medicationName: (r['medication_name'] as String?) ?? '',
        dosage: (r['dosage'] as String?) ?? '',
        reminderTimes:
            (r['reminder_times'] as List<dynamic>?)
                ?.map((e) => e.toString())
                .toList() ??
            [],
        endDate: r['end_date']?.toString().split('T').first,
        isActive: r['is_active'] as bool? ?? true,
      );
    }
  }

  /// Cancel all scheduled notifications.
  static Future<void> cancelAll() async {
    await initialize();
    await _plugin.cancelAll();
  }

  static tz.TZDateTime _nextInstanceOfTime(int hour, int minute) {
    final now = tz.TZDateTime.now(tz.local);
    var scheduled = tz.TZDateTime(
      tz.local,
      now.year,
      now.month,
      now.day,
      hour,
      minute,
    );
    if (scheduled.isBefore(now)) {
      scheduled = scheduled.add(const Duration(days: 1));
    }
    return scheduled;
  }

  @visibleForTesting
  static int notificationIdForReminderSlot(int reminderId, int slot) {
    final base = reminderId >= ancSupplementReminderIdOffset
        ? _ancSupplementLocalIdOffset +
              ((reminderId - ancSupplementReminderIdOffset) %
                  _ancSupplementLocalIdModulo)
        : reminderId;
    return base * 100 + slot;
  }
}
