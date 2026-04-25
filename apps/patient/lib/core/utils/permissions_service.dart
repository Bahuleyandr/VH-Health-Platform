import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

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
    return _requestPermissionWithExplanation(
      context,
      Permission.notification,
      'Notifications',
      'We need notification permission to send you appointment reminders and health updates.',
    );
  }

  // ────────────────────────────────────────────────
  // 3. Individual permissions with explanation
  // ────────────────────────────────────────────────
  static Future<bool> requestCameraPermission(BuildContext context) async {
    return _requestPermissionWithExplanation(
      context,
      Permission.camera,
      'Camera Access',
      'We need camera access to scan documents and take photos for your health records.',
    );
  }

  static Future<bool> requestPhotoPermission(BuildContext context) async {
    return _requestPermissionWithExplanation(
      context,
      Permission.photos,
      'Photo Library Access',
      'We need access to your photos to upload medical documents and prescriptions.',
    );
  }

  static Future<bool> requestLocationPermission(BuildContext context) async {
    return _requestPermissionWithExplanation(
      context,
      Permission.locationWhenInUse,
      'Location Access',
      'We need your location for emergency SOS features and to find nearby hospitals.',
    );
  }

  static Future<bool> requestCalendarPermission(BuildContext context) async {
    return _requestPermissionWithExplanation(
      context,
      Permission.calendarFullAccess,
      'Calendar Access',
      'We need calendar access to display your appointments and health-related events.',
    );
  }

  // Optional backward-compatible alias
  static Future<bool> ensurePermission(
    BuildContext context,
    Permission permission,
  ) async {
    return _requestPermissionWithExplanation(
      context,
      permission,
      permission
          .toString()
          .split('.')
          .last
          .replaceAll(RegExp(r'([A-Z])'), ' \$1')
          .trim(),
      'This permission is required for proper functionality.',
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
          builder: (dialogCtx) => AlertDialog(
            title: Text('$permissionName Required'),
            content: Text(explanation),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(dialogCtx).pop(false),
                child: const Text('Not Now'),
              ),
              ElevatedButton(
                onPressed: () => Navigator.of(dialogCtx).pop(true),
                child: const Text('Continue'),
              ),
            ],
          ),
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
          builder: (dialogCtx) => AlertDialog(
            title: Text('$permissionName Disabled'),
            content: Text(
              '$permissionName has been disabled. '
              'Please enable it in Settings to use this feature.',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(dialogCtx).pop(false),
                child: const Text('Cancel'),
              ),
              ElevatedButton(
                onPressed: () => Navigator.of(dialogCtx).pop(true),
                child: const Text('Open Settings'),
              ),
            ],
          ),
        ) ??
        false;
  }
}
