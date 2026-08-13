import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/vhhealth_core.dart' show RealtimeProvider;

import '../../l10n/app_strings.dart';
import '../providers/clinical_inbox_provider.dart';
import '../providers/message_unread_provider.dart';
import '../providers/notification_provider.dart';
import '../providers/session_timeout_provider.dart';
import '../providers/websocket_provider.dart';
import '../services/auth_service.dart';
import '../services/recent_patients_service.dart';
import '../services/staff_local_notifications.dart';
import '../services/staff_notification_session.dart';
import '../theme/app_theme.dart';
import 'offline_sync_badge.dart';

/// End every session-scoped realtime/push surface and clear its cached PHI.
/// Call on EVERY logout path — explicit logout, forced/revoked logout, and
/// idle timeout — before local identity is cleared. Provider lookups are
/// best-effort so focused widget-test hosts can omit production providers.
Future<void> stopStaffRealtimePollers(
  BuildContext context, {
  bool unregisterNotificationBackend = false,
  bool requireVerifiedNotificationTeardown = false,
  StaffRecentPatientsClear? recentPatientsClear,
}) => captureStaffRealtimePollerStopper(
  context,
  unregisterNotificationBackend: unregisterNotificationBackend,
  requireVerifiedNotificationTeardown: requireVerifiedNotificationTeardown,
  recentPatientsClear: recentPatientsClear,
)();

/// Captures session-owned providers while their authenticated route is still
/// mounted, allowing a server action to await and then deterministically tear
/// down that same session even if its originating sheet is disposed.
Future<void> Function() captureStaffRealtimePollerStopper(
  BuildContext context, {
  bool unregisterNotificationBackend = false,
  bool requireVerifiedNotificationTeardown = false,
  StaffRecentPatientsClear? recentPatientsClear,
}) {
  final messageProvider = _readProvider<MessageUnreadProvider>(context);
  final clinicalProvider = _readProvider<ClinicalInboxProvider>(context);
  final webSocketProvider = _readProvider<WebSocketProvider>(context);
  final notificationProvider = _readProvider<NotificationProvider>(context);
  final realtimeProvider = _readProvider<RealtimeProvider>(context);
  return () => _endStaffAuthenticatedSession(
    messageProvider: messageProvider,
    clinicalProvider: clinicalProvider,
    webSocketProvider: webSocketProvider,
    notificationProvider: notificationProvider,
    realtimeProvider: realtimeProvider,
    unregisterNotificationBackend: unregisterNotificationBackend,
    requireVerifiedNotificationTeardown: requireVerifiedNotificationTeardown,
    recentPatientsClear: recentPatientsClear,
  );
}

Future<void> _endStaffAuthenticatedSession({
  MessageUnreadProvider? messageProvider,
  ClinicalInboxProvider? clinicalProvider,
  WebSocketProvider? webSocketProvider,
  NotificationProvider? notificationProvider,
  RealtimeProvider? realtimeProvider,
  required bool unregisterNotificationBackend,
  required bool requireVerifiedNotificationTeardown,
  StaffRecentPatientsClear? recentPatientsClear,
}) async {
  messageProvider?.stop();
  clinicalProvider?.stop();

  // Start every session gate before the first await. In particular,
  // WebSocketProvider flips its generation synchronously and the notification
  // provider starts delivered-notification cancellation synchronously. A Code
  // Blue arriving after this point therefore cannot reach a dialog or OS toast
  // while slower backend, queue, and transport cleanup is still in progress.
  final webSocketCleanup = _settleStaffSessionCleanup(
    webSocketProvider?.endAuthenticatedSession(),
    failureLabel: 'Realtime adapter teardown failed',
  );
  final notificationCleanup = notificationProvider == null
      ? Future<bool>.value(false)
      : _verifyStaffSessionCleanup(
          notificationProvider.endAuthenticatedSession(
            unregisterBackend: unregisterNotificationBackend,
          ),
          failureLabel: 'Notification teardown remains unverified',
        );
  final localNotificationCleanup = notificationProvider == null
      ? _settleStaffSessionCleanup(
          StaffLocalNotifications.instance.cancelSessionNotifications(),
          failureLabel: 'Delivered notification cleanup failed',
        )
      : Future<void>.value();

  // Complete operating-system notification cancellation before any slower
  // queue, cache, transport, or credential cleanup can advance.
  final notificationTeardownVerified = await notificationCleanup;
  await localNotificationCleanup;
  await webSocketCleanup;
  if (notificationProvider != null && !notificationTeardownVerified) {
    try {
      await StaffNotificationSessionStore.instance.markInactive();
    } catch (e) {
      debugPrint('Notification session marker cleanup failed: $e');
    }
    try {
      await StaffLocalNotifications.instance.cancelSessionNotifications();
    } catch (e) {
      debugPrint('Delivered notification cleanup failed: $e');
    }
  }
  await _settleStaffSessionCleanup(
    (recentPatientsClear ?? RecentPatientsService.clear)(),
    failureLabel: 'Recent-patient cleanup failed',
  );
  await _settleStaffSessionCleanup(
    realtimeProvider?.disconnect(),
    failureLabel: 'Realtime transport teardown failed',
  );
  if (notificationProvider != null &&
      requireVerifiedNotificationTeardown &&
      !notificationTeardownVerified) {
    throw StateError('Notification session teardown could not be verified.');
  }
}

Future<void> _settleStaffSessionCleanup(
  Future<void>? cleanup, {
  required String failureLabel,
}) async {
  try {
    await cleanup;
  } catch (e) {
    debugPrint('$failureLabel: $e');
  }
}

Future<bool> _verifyStaffSessionCleanup(
  Future<void> cleanup, {
  required String failureLabel,
}) async {
  try {
    await cleanup;
    return true;
  } catch (e) {
    debugPrint('$failureLabel: $e');
    return false;
  }
}

T? _readProvider<T>(BuildContext context) {
  try {
    return context.read<T>();
  } catch (_) {
    return null;
  }
}

typedef StaffLogoutOperation = Future<StaffLogoutResult> Function();
typedef StaffSyncStatusOpener = Future<void> Function(BuildContext context);
typedef StaffRecentPatientsClear = Future<void> Function();
typedef ForcedSessionCleanup = Future<int> Function();
typedef PreservedItemReporter = void Function(int count);
typedef StaffSessionStopper = FutureOr<void> Function();

class ForcedLogoutFlow {
  ForcedLogoutFlow._();

  static Future<void>? _inFlight;

  static Future<void> run({
    ForcedSessionCleanup? forcedLogout,
    StaffSessionStopper? stopSessionTracking,
    required VoidCallback navigateToLogin,
    required PreservedItemReporter reportPreservedItems,
  }) {
    final existing = _inFlight;
    if (existing != null) return existing;

    final operation = _run(
      forcedLogout: forcedLogout ?? AuthService.forceLogoutForRevocation,
      stopSessionTracking: stopSessionTracking,
      navigateToLogin: navigateToLogin,
      reportPreservedItems: reportPreservedItems,
    );
    _inFlight = operation;
    return operation.whenComplete(() {
      if (identical(_inFlight, operation)) _inFlight = null;
    });
  }

  static Future<void> _run({
    required ForcedSessionCleanup forcedLogout,
    required StaffSessionStopper? stopSessionTracking,
    required VoidCallback navigateToLogin,
    required PreservedItemReporter reportPreservedItems,
  }) async {
    try {
      await stopSessionTracking?.call();
    } catch (error) {
      debugPrint('Forced session UI teardown failed: $error');
    }
    final preservedCount = await forcedLogout();
    navigateToLogin();
    reportPreservedItems(preservedCount);
  }
}

class LogoutFlow {
  LogoutFlow._();

  static Future<bool> start(
    BuildContext context, {
    required String confirmationTitle,
    required String confirmationBody,
    @visibleForTesting StaffLogoutOperation? logoutOperation,
    @visibleForTesting StaffSyncStatusOpener? syncStatusOpener,
    @visibleForTesting StaffRecentPatientsClear? recentPatientsClear,
  }) async {
    final strings = AppStrings.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(confirmationTitle),
        content: Text(confirmationBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(strings.actionCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            style: FilledButton.styleFrom(backgroundColor: AppTheme.errorRed),
            child: Text(strings.actionLogout),
          ),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return false;

    final timeoutProvider = _readProvider<SessionTimeoutProvider>(context);
    final messageProvider = _readProvider<MessageUnreadProvider>(context);
    final clinicalProvider = _readProvider<ClinicalInboxProvider>(context);
    final webSocketProvider = _readProvider<WebSocketProvider>(context);
    final notificationProvider = _readProvider<NotificationProvider>(context);
    final realtimeProvider = _readProvider<RealtimeProvider>(context);
    Future<void> endAuthenticatedSession({
      required bool unregisterNotificationBackend,
      required bool requireVerifiedNotificationTeardown,
    }) => _endStaffAuthenticatedSession(
      messageProvider: messageProvider,
      clinicalProvider: clinicalProvider,
      webSocketProvider: webSocketProvider,
      notificationProvider: notificationProvider,
      realtimeProvider: realtimeProvider,
      unregisterNotificationBackend: unregisterNotificationBackend,
      requireVerifiedNotificationTeardown: requireVerifiedNotificationTeardown,
      recentPatientsClear: recentPatientsClear,
    );
    final result =
        await (logoutOperation ??
            () => AuthService.logout(
              beforeSessionRevocation: () => endAuthenticatedSession(
                unregisterNotificationBackend: true,
                requireVerifiedNotificationTeardown: true,
              ),
            ))();
    if (result.isSignedOut) {
      timeoutProvider?.stopTracking();
      messageProvider?.stop();
      clinicalProvider?.stop();
      if (logoutOperation != null) {
        // Test-injected/custom logout operations do not receive the production
        // pre-revocation hook. Complete local teardown without making an
        // authenticated API call after that operation may have cleared auth.
        try {
          await endAuthenticatedSession(
            unregisterNotificationBackend: false,
            requireVerifiedNotificationTeardown: false,
          );
        } catch (_) {}
      }
    }
    if (!context.mounted) return result.isSignedOut;

    if (result.isBlocked) {
      final review = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          icon: const Icon(Icons.health_and_safety_outlined),
          title: Text(strings.logoutBlockedTitle),
          content: Text(strings.logoutBlockedBody(result.blockingWriteCount)),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: Text(strings.logoutStaySignedIn),
            ),
            FilledButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: Text(strings.logoutReviewOfflineWork),
            ),
          ],
        ),
      );
      if (review == true && context.mounted) {
        await (syncStatusOpener ?? showStaffSyncStatusSheet)(context);
      }
      return false;
    }

    final warning = switch ((
      result.serverRevocationFailed,
      result.notificationTeardownFailed,
    )) {
      (true, true) => strings.logoutCombinedTeardownFailed,
      (true, false) => strings.logoutServerRevocationFailed,
      (false, true) => strings.logoutNotificationTeardownFailed,
      (false, false) => null,
    };
    final messenger = warning == null
        ? null
        : ScaffoldMessenger.maybeOf(context);
    context.go('/login');
    // Local sign-out is complete, but the bearer token may still be live —
    // say so rather than letting the staff member assume the session is dead.
    if (messenger != null && warning != null) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(warning),
          backgroundColor: AppTheme.errorRed,
          duration: const Duration(seconds: 6),
        ),
      );
    }
    return true;
  }
}
