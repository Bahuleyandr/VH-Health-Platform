import 'package:flutter/material.dart';
import '../../l10n/app_strings.dart';
import 'logout_flow.dart';

export 'navigation_back_action.dart';

/// AppBar logout action — drop into any `AppBar.actions` list to show a
/// universal logout button on screens that don't wrap with [StaffScaffold].
///
/// Tap opens the ordinary sign-out flow. Unresolved offline clinical work
/// blocks sign-out and routes the user to Sync status for reconciliation.
///
/// Used directly by [StaffScaffold]; also added piecemeal to every screen
/// that uses a raw [Scaffold]+[AppBar] (the role-specific bottom-nav
/// variants don't always include Settings, so without this on every
/// screen the only logout path was a fresh install).
class LogoutAction extends StatelessWidget {
  const LogoutAction({super.key});

  Future<void> _logout(BuildContext context) async {
    final strings = AppStrings.of(context);
    await LogoutFlow.start(
      context,
      confirmationTitle: strings.logoutDialogTitle,
      confirmationBody: strings.logoutDialogBody,
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return IconButton(
      icon: const Icon(Icons.logout),
      tooltip: s.logoutTooltip,
      onPressed: () => _logout(context),
    );
  }
}
