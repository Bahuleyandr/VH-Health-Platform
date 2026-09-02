import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class PermissionsService {
  // ────────────────────────────────────────────────
  // 1. Request all key permissions needed in app
  // ────────────────────────────────────────────────
  static Future<void> requestAllRequiredPermissions(
    BuildContext context,
  ) async {
    await requestStartupPermissions(context);
    if (!context.mounted) return; // Add mounted check after each await

    await requestCameraPermission(context);
    if (!context.mounted) return; // Add mounted check

    await requestPhotoPermission(context);
    if (!context.mounted) return; // Add mounted check

    await requestLocationPermission(context);
    if (!context.mounted) return; // Add mounted check

    await requestCalendarPermission(context);
    if (!context.mounted) return; // Add mounted check
  }

  // ────────────────────────────────────────────────
  // 2. Minimal startup permission (notification only)
  // ────────────────────────────────────────────────
  static Future<bool> requestStartupPermissions(BuildContext context) async {
    final l10n = AppLocalizations.of(context)!;
    return _requestPermissionWithExplanation(
      context,
      Permission.notification,
      l10n.permissionsNotificationsName,
      l10n.permissionsNotificationsExplanation,
    );
  }

  // ────────────────────────────────────────────────
  // 3. Individual permissions with explanation
  // ────────────────────────────────────────────────
  static Future<bool> requestCameraPermission(BuildContext context) async {
    final l10n = AppLocalizations.of(context)!;
    return _requestPermissionWithExplanation(
      context,
      Permission.camera,
      l10n.permissionsCameraName,
      l10n.permissionsCameraExplanation,
    );
  }

  static Future<bool> requestPhotoPermission(BuildContext context) async {
    final l10n = AppLocalizations.of(context)!;
    return _requestPermissionWithExplanation(
      context,
      Permission.photos,
      l10n.permissionsPhotosName,
      l10n.permissionsPhotosExplanation,
    );
  }

  static Future<bool> requestLocationPermission(BuildContext context) async {
    final l10n = AppLocalizations.of(context)!;
    return _requestPermissionWithExplanation(
      context,
      Permission.locationWhenInUse,
      l10n.permissionsLocationName,
      l10n.permissionsLocationExplanation,
    );
  }

  static Future<bool> requestCalendarPermission(BuildContext context) async {
    final l10n = AppLocalizations.of(context)!;
    return _requestPermissionWithExplanation(
      context,
      Permission.calendarFullAccess,
      l10n.permissionsCalendarName,
      l10n.permissionsCalendarExplanation,
    );
  }

  // Optional backward-compatible alias
  static Future<bool> ensurePermission(
    BuildContext context,
    Permission permission,
  ) async {
    final l10n = AppLocalizations.of(context)!;
    final permissionName = permission
        .toString()
        .split('.')
        .last
        .replaceAll(RegExp(r'([A-Z])'), ' \$1')
        .trim();
    return _requestPermissionWithExplanation(
      context,
      permission,
      l10n.permissionsGenericName(permissionName),
      l10n.permissionsGenericExplanation,
    );
  }

  // ────────────────────────────────────────────────
  // 4. Internal handler with UI dialog
  // ────────────────────────────────────────────────
  static Future<bool> _requestPermissionWithExplanation(
    BuildContext context,
    Permission permission,
    String title,
    String explanation,
  ) async {
    var status = await permission.status;
    if (!context.mounted) return false; // Check 1: After initial status check

    if (status.isGranted || status.isLimited) {
      return true;
    }

    if (status.isPermanentlyDenied) {
      final openSettings = await _showSettingsDialog(context, title);
      if (!context.mounted) {
        return false; // Check 2: After showing settings dialog
      }

      if (openSettings) {
        await openAppSettings();
        if (!context.mounted) {
          return false; // Check 3: After opening app settings
        }
        status = await permission.status;
        if (!context.mounted) {
          return false; // Check 4: After getting updated status
        }
        return status.isGranted || status.isLimited;
      }
      return false; // User chose not to open settings
    }

    final shouldRequest = await _showPermissionExplanationDialog(
      context,
      title,
      explanation,
    );
    if (!context.mounted) {
      return false; // Check 5: After showing explanation dialog
    }

    if (!shouldRequest) {
      return false; // User chose not to request permission
    }

    status = await permission.request();
    if (!context.mounted) return false; // Check 6: After requesting permission

    if (status.isGranted || status.isLimited) {
      return true;
    }

    if (status.isDenied || status.isPermanentlyDenied) {
      final openSettings = await _showSettingsDialog(context, title);
      if (!context.mounted) {
        return false; // Check 7: After showing settings dialog again
      }

      if (openSettings) {
        await openAppSettings();
        if (!context.mounted) {
          return false; // Check 8: After opening app settings again
        }
        status = await permission.status;
        if (!context.mounted) {
          return false; // Check 9: After getting updated status again
        }
        return status.isGranted || status.isLimited;
      }
    }

    return false;
  }

  // ────────────────────────────────────────────────
  // 5. Dialogs for explanation and settings
  // ────────────────────────────────────────────────
  static Future<bool> _showPermissionExplanationDialog(
    BuildContext context,
    String permissionName,
    String explanation,
  ) async {
    // The context is used synchronously inside the builder, which is safe.
    // The `await showDialog` itself is an async gap, so the caller needs to check mounted.
    return await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (dialogCtx) {
            final l10n = AppLocalizations.of(dialogCtx)!;
            return AlertDialog(
              title: Text(l10n.permissionsRequiredTitle(permissionName)),
              content: Text(explanation),
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(dialogCtx).pop(false),
                  child: Text(
                    AppLocalizations.of(dialogCtx)!.permissionsNotNow,
                  ),
                ),
                ElevatedButton(
                  onPressed: () => Navigator.of(dialogCtx).pop(true),
                  child: Text(l10n.commonContinueButton),
                ),
              ],
            );
          },
        ) ??
        false;
  }

  static Future<bool> _showSettingsDialog(
    BuildContext context,
    String permissionName,
  ) async {
    // The context is used synchronously inside the builder, which is safe.
    // The `await showDialog` itself is an async gap, so the caller needs to check mounted.
    return await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (dialogCtx) {
            final l10n = AppLocalizations.of(dialogCtx)!;
            return AlertDialog(
              title: Text(l10n.permissionsDisabledTitle(permissionName)),
              content: Text(l10n.permissionsDisabledBody(permissionName)),
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(dialogCtx).pop(false),
                  child: Text(l10n.commonCancelButton),
                ),
                ElevatedButton(
                  onPressed: () => Navigator.of(dialogCtx).pop(true),
                  child: Text(
                    AppLocalizations.of(dialogCtx)!.permissionsOpenSettings,
                  ),
                ),
              ],
            );
          },
        ) ??
        false;
  }
}
