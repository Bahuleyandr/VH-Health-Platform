import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_strings.dart';
import '../providers/session_timeout_provider.dart';
import '../services/auth_service.dart';
import '../theme/app_theme.dart';
import 'offline_sync_badge.dart';

typedef StaffLogoutOperation = Future<StaffLogoutResult> Function();
typedef StaffSyncStatusOpener = Future<void> Function(BuildContext context);
typedef ForcedSessionCleanup = Future<int> Function();
typedef PreservedItemReporter = void Function(int count);

class ForcedLogoutFlow {
  ForcedLogoutFlow._();

  static Future<void>? _inFlight;

  static Future<void> run({
    ForcedSessionCleanup? forcedLogout,
    VoidCallback? stopSessionTracking,
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
    required VoidCallback? stopSessionTracking,
    required VoidCallback navigateToLogin,
    required PreservedItemReporter reportPreservedItems,
  }) async {
    final preservedCount = await forcedLogout();
    stopSessionTracking?.call();
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

    final result = await (logoutOperation ?? AuthService.logout)();
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

    context.read<SessionTimeoutProvider>().stopTracking();
    if (!context.mounted) return true;
    context.go('/login');
    return true;
  }
}
