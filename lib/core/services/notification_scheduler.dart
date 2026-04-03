// ─── Platform Setup Required ─────────────────────────────────────────────────
//
// Android (AndroidManifest.xml):
//   <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />
//   <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
//   <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />  (Android 13+)
//
// iOS:
//   No extra setup needed beyond the permission request in initialize().
//   flutter_local_notifications handles iOS notification permissions via the
//   DarwinInitializationSettings requestAlertPermission/requestSoundPermission.
// ─────────────────────────────────────────────────────────────────────────────

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:timezone/data/latest_all.dart' as tz;
import 'package:timezone/timezone.dart' as tz;

class NotificationScheduler {
  NotificationScheduler._();

  static final _plugin = FlutterLocalNotificationsPlugin();
  static bool _initialized = false;

  /// Call once at app startup.
  static Future<void> initialize() async {
    if (_initialized) return;

    // Initialize timezone data
    tz.initializeTimeZones();
    // Use UTC as fallback — the device local timezone is set by the OS
    // and TZDateTime.now(tz.local) will use the correct local zone.

    const androidSettings =
        AndroidInitializationSettings('@mipmap/ic_launcher');
    const iosSettings = DarwinInitializationSettings(
      requestAlertPermission: true,
      requestBadgePermission: true,
      requestSoundPermission: true,
    );
    const initSettings = InitializationSettings(
      android: androidSettings,
      iOS: iosSettings,
    );

    await _plugin.initialize(initSettings);

    // Request permissions on Android 13+
    await _plugin
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.requestNotificationsPermission();

    // Create Android notification channel
    await _plugin
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(
          const AndroidNotificationChannel(
            'medication_reminders',
            'Medication Reminders',
            description: 'Reminders to take your medications on time',
            importance: Importance.high,
          ),
        );

    _initialized = true;
  }

  /// Schedule daily notifications for a medication reminder.
  ///
  /// [id] — unique reminder ID from backend.
  /// [medicationName] — name of the medication.
  /// [dosage] — dosage string (e.g. "500mg").
  /// [reminderTimes] — list of "HH:mm" strings.
  /// [endDate] — optional end date in "YYYY-MM-DD" format.
  /// [isActive] — whether the reminder is active.
  static Future<void> scheduleReminder({
    required int id,
    required String medicationName,
    required String dosage,
    required List<String> reminderTimes,
    String? endDate,
    required bool isActive,
  }) async {
    if (!isActive) return;

    // Skip if endDate is in the past
    if (endDate != null && endDate.isNotEmpty) {
      final end = DateTime.tryParse(endDate);
      if (end != null && end.isBefore(DateTime.now())) return;
    }

    const notificationDetails = NotificationDetails(
      android: AndroidNotificationDetails(
        'medication_reminders',
        'Medication Reminders',
        channelDescription: 'Reminders to take your medications on time',
        importance: Importance.high,
        priority: Priority.high,
      ),
      iOS: DarwinNotificationDetails(),
    );

    for (var i = 0; i < reminderTimes.length; i++) {
      final parts = reminderTimes[i].split(':');
      if (parts.length != 2) continue;

      final hour = int.tryParse(parts[0]);
      final minute = int.tryParse(parts[1]);
      if (hour == null || minute == null) continue;

      final notificationId = id * 100 + i;
      final scheduledTime = _nextInstanceOfTime(hour, minute);

      try {
        await _plugin.zonedSchedule(
          notificationId,
          'Medication Reminder',
          'Time to take $medicationName - $dosage',
          scheduledTime,
          notificationDetails,
          androidScheduleMode: AndroidScheduleMode.exactAllowWhileIdle,
          matchDateTimeComponents: DateTimeComponents.time,
          payload: jsonEncode({'reminderId': id}),
        );
      } catch (e) {
        if (kDebugMode) debugPrint('Failed to schedule notification $notificationId: $e');
      }
    }
  }

  /// Cancel all notifications for a given reminder.
  static Future<void> cancelReminder(int reminderId) async {
    for (var i = 0; i < 100; i++) {
      await _plugin.cancel(reminderId * 100 + i);
    }
  }

  /// Cancel all then reschedule active reminders.
  /// Each map should have: id, medication_name, dosage, reminder_times,
  /// end_date, is_active (matching the backend JSON shape).
  static Future<void> rescheduleAll(List<Map<String, dynamic>> reminders) async {
    await cancelAll();
    for (final r in reminders) {
      await scheduleReminder(
        id: r['id'] as int,
        medicationName: (r['medication_name'] as String?) ?? '',
        dosage: (r['dosage'] as String?) ?? '',
        reminderTimes: (r['reminder_times'] as List<dynamic>?)
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
    await _plugin.cancelAll();
  }

  /// Get the next occurrence of [hour]:[minute] from now.
  static tz.TZDateTime _nextInstanceOfTime(int hour, int minute) {
    final now = tz.TZDateTime.now(tz.local);
    var scheduled =
        tz.TZDateTime(tz.local, now.year, now.month, now.day, hour, minute);
    if (scheduled.isBefore(now)) {
      scheduled = scheduled.add(const Duration(days: 1));
    }
    return scheduled;
  }
}
