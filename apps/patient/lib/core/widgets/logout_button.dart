import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/services/logout_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';

enum LogoutButtonStyle {
  iconOnly, // for AppBar
  listTile, // for SettingsScreen
}

class LogoutButton extends StatelessWidget {
  final LogoutButtonStyle style;
  final IconData icon;
  final String label;
  final Color? color;

  const LogoutButton({
    super.key,
    this.style = LogoutButtonStyle.listTile,
    this.icon = Icons.logout,
    this.label = 'Logout',
    this.color,
  });

  /// Public entry point for the confirm-and-logout flow. Lives here so
  /// the dashboard overflow menu (and any future caller) can reuse the
  /// exact same dialog + cleanup sequence without duplicating it.
  static Future<void> confirmAndLogout(BuildContext context) =>
      _confirmAndLogout(context);

  static Future<void> _confirmAndLogout(BuildContext context) async {
    final confirm = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => AlertDialog(
        title: Text(AppLocalizations.of(dialogContext)!.logoutConfirmTitle),
        content: Text(AppLocalizations.of(dialogContext)!.logoutConfirmBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(AppLocalizations.of(dialogContext)!.commonCancelButton),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.red,
              foregroundColor: Colors.white,
            ),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Logout'),
          ),
        ],
      ),
    );

    if (confirm != true || !context.mounted) return;

    try {
      // Centralised teardown: unregisters this device + deletes its FCM token,
      // disconnects the realtime + WebSocket PHI channels, cancels local
      // notifications, revokes the VH JWT server-side, wipes secure storage +
      // API cache + downloaded-file cache (raw PHI) + plaintext cycle data,
      // clears the identity + dependents providers, and signs out of Firebase
      // as its final step. Single source of truth so a new teardown step added
      // to logout can't be missed here — the device unregister and provider
      // clears this button used to do itself now live inside the service so
      // the automatic logout paths get them too.
      final outcome = await LogoutService.logout();

      if (context.mounted) {
        context.go('/login');
      }

      // Local sign-out succeeded either way, but if the backend never revoked
      // the token we must not let the user believe every device is signed out.
      if (!outcome.serverSessionRevoked && context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Signed out on this device. We could not reach the server, so '
              'other devices may stay signed in until you retry.',
            ),
            backgroundColor: Colors.orange,
            duration: Duration(seconds: 6),
          ),
        );
      }
    } catch (e) {
      debugPrint('Logout error: $e');
      // If navigation fails, show error
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          LiveRegionSnackBar.build(
            message: 'Logout failed: ${e.toString()}',
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    switch (style) {
      case LogoutButtonStyle.iconOnly:
        return IconButton(
          tooltip: label,
          icon: Icon(icon, color: color ?? theme.colorScheme.onSurface),
          onPressed: () => confirmAndLogout(context),
        );

      case LogoutButtonStyle.listTile:
        return ListTile(
          leading: Icon(icon, color: theme.colorScheme.error),
          title: Text(label, style: TextStyle(color: theme.colorScheme.error)),
          onTap: () => confirmAndLogout(context),
        );
    }
  }
}
