import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../services/auth_service.dart';
import '../theme/app_theme.dart';

/// AppBar logout action — drop into any `AppBar.actions` list to show a
/// universal logout button on screens that don't wrap with [StaffScaffold].
///
/// Tap → confirmation dialog → on confirm: [AuthService.logout] (clears
/// JWT + refresh + role + employeeId from secure storage) → `context.go('/login')`.
/// The auth-redirect guard in `app_router.dart` would handle this on its
/// own once the JWT is cleared, but pushing `/login` explicitly avoids a
/// stale-state flash on slow devices.
///
/// Used directly by [StaffScaffold]; also added piecemeal to every screen
/// that uses a raw [Scaffold]+[AppBar] (the role-specific bottom-nav
/// variants don't always include Settings, so without this on every
/// screen the only logout path was a fresh install).
class LogoutAction extends StatelessWidget {
  const LogoutAction({super.key});

  Future<void> _logout(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Logout?'),
        content: const Text(
          'You will need to sign in again with your employee ID and password.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: FilledButton.styleFrom(backgroundColor: AppTheme.errorRed),
            child: const Text('Logout'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await AuthService.logout();
    if (!context.mounted) return;
    context.go('/login');
  }

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: const Icon(Icons.logout),
      tooltip: 'Logout',
      onPressed: () => _logout(context),
    );
  }
}
