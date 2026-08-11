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

typedef NotificationPayloadHandler = void Function(String payload);

class NotificationScheduler {
  NotificationScheduler._();

  // Must match the backend medicationReminderService ANC projection offset.
  // Android notification IDs are int32; use a safe local namespace when the
  // backend sends projected ANC supplement IDs such as 1,000,000,042.
  static const int ancSupplementReminderIdOffset = 1000000000;
  static const int _ancSupplementLocalIdOffset = 7000000;
  static const int _ancSupplementLocalIdModulo = 10000000;

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
    for (final entry in payload.entries) {
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
    await initialize();
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

      final notificationId = notificationIdForReminderSlot(id, i);
      final scheduledTime = _nextInstanceOfTime(hour, minute);

      try {
        await _plugin.zonedSchedule(
          id: notificationId,
          title: 'Medication Reminder',
          // Generic message to prevent PHI on lock screen
          body: 'Time for your medication. Open the app for details.',
          scheduledDate: scheduledTime,
          notificationDetails: notificationDetails,
          androidScheduleMode: AndroidScheduleMode.exactAllowWhileIdle,
          matchDateTimeComponents: DateTimeComponents.time,
          payload: jsonEncode({'reminderId': id}),
        );
      } catch (e) {
        if (kDebugMode) {
          debugPrint('Failed to schedule notification $notificationId: $e');
        }
      }
    }
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
