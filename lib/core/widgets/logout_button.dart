import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/navigation/app_router.dart';
import 'package:vhhealth/core/services/device_service.dart';
import 'package:vhhealth/core/services/firebase_session_service.dart';

enum LogoutButtonStyle {
  iconOnly,   // for AppBar
  listTile,   // for SettingsScreen
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

  Future<void> _confirmAndLogout(BuildContext context) async {
    final confirm = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Confirm Logout'),
        content: const Text('Are you sure you want to logout?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
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
      // Unregister device and revoke session before clearing storage
      const storage = FlutterSecureStorage();
      final phone = await storage.read(key: 'phone') ?? '';
      try {
        await Future.wait([
          DeviceService.unregisterDevice(phone),
          FirebaseSessionService.revokeSession(),
        ]);
      } catch (_) {}

      // Clear storage
      await storage.deleteAll();
      
      // ✅ FIXED: Use root navigator to navigate to login
      if (context.mounted) {
        AppRouter.clearUserData();
context.go('/login');
      }
      
      // Sign out after navigation
      await Future.delayed(const Duration(milliseconds: 300));
      await FirebaseAuth.instance.signOut();
      
    } catch (e) {
      debugPrint('Logout error: $e');
      // If navigation fails, show error
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Logout failed: ${e.toString()}'),
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
          onPressed: () => _confirmAndLogout(context),
        );
      
      case LogoutButtonStyle.listTile:
      default:
        return ListTile(
          leading: Icon(icon, color: theme.colorScheme.error),
          title: Text(
            label,
            style: TextStyle(color: theme.colorScheme.error),
          ),
          onTap: () => _confirmAndLogout(context),
        );
    }
  }
}