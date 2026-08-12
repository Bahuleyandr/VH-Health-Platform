import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_strings.dart';
import '../providers/clinical_inbox_provider.dart';
import '../providers/message_unread_provider.dart';
import '../providers/notification_provider.dart';
import '../providers/session_timeout_provider.dart';
import '../services/auth_service.dart';
import '../services/staff_local_notifications.dart';
import '../services/staff_notification_session.dart';
import '../theme/app_theme.dart';
import 'offline_sync_badge.dart';

/// Stop the message-unread and clinical-inbox pollers (realtime
/// subscriptions + periodic HTTP polls) and clear their cached PHI. Call on
/// EVERY logout path — explicit logout, forced/revoked logout, and idle
/// timeout — so nothing keeps polling or popping snackbars on the login
/// screen of a shared ward device (STF-1). Provider lookups are best-effort:
/// hosts that don't mount these providers (tests) are a no-op.
Future<void> stopStaffRealtimePollers(
  BuildContext context, {
  bool unregisterNotificationBackend = false,
}) async {
  try {
    context.read<MessageUnreadProvider>().stop();
  } catch (_) {}
  try {
    context.read<ClinicalInboxProvider>().stop();
  } catch (_) {}
  late final NotificationProvider notificationProvider;
  try {
    notificationProvider = context.read<NotificationProvider>();
  } catch (_) {
    return;
  }

  var notificationTeardownVerified = false;
  try {
    await notificationProvider.endAuthenticatedSession(
      unregisterBackend: unregisterNotificationBackend,
    );
    notificationTeardownVerified = true;
  } catch (e) {
    debugPrint('Notification teardown remains unverified: $e');
  }
  if (!notificationTeardownVerified) {
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
    final preservedCount = await forcedLogout();
    await stopSessionTracking?.call();
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
    final notificationProvider = _readProvider<NotificationProvider>(context);
    final result =
        await (logoutOperation ??
            () => AuthService.logout(
              beforeSessionRevocation:
                  notificationProvider?.endAuthenticatedSession,
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
          await notificationProvider?.endAuthenticatedSession(
            unregisterBackend: false,
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

    final messenger =
        result.serverRevocationFailed || result.notificationTeardownFailed
        ? ScaffoldMessenger.maybeOf(context)
        : null;
    context.go('/login');
    // Local sign-out is complete, but the bearer token may still be live —
    // say so rather than letting the staff member assume the session is dead.
    messenger?.showSnackBar(
      SnackBar(
        content: Text(
          result.notificationTeardownFailed
              ? strings.logoutNotificationTeardownFailed
              : strings.logoutServerRevocationFailed,
        ),
        backgroundColor: AppTheme.errorRed,
        duration: const Duration(seconds: 6),
      ),
    );
    return true;
  }
}
