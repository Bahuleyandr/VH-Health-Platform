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

class NotificationScheduler {
  NotificationScheduler._();

  static final _plugin = FlutterLocalNotificationsPlugin();
  static bool _initialized = false;

  /// Call once at app startup.
  static Future<void> initialize() async {
    if (_initialized) return;

    tz.initializeTimeZones();

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

    await _plugin
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.requestNotificationsPermission();

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
    if (!isActive) return;

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
          // Generic message to prevent PHI on lock screen
          'Time for your medication. Open the app for details.',
          scheduledTime,
          notificationDetails,
          androidScheduleMode: AndroidScheduleMode.exactAllowWhileIdle,
          uiLocalNotificationDateInterpretation:
              UILocalNotificationDateInterpretation.absoluteTime,
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
