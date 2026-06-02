import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter/services.dart';

/// AppBar leading action for staff screens.
///
/// GoRouter owns most Staff navigation, so check its route stack before
/// falling back to the dashboard. The plain Navigator fallback still keeps
/// dialogs and locally pushed routes behaving like normal Flutter screens.
class NavigationBackAction extends StatelessWidget {
  final String fallbackRoute;
  final bool closeOnFallback;

  const NavigationBackAction({
    super.key,
    this.fallbackRoute = '/dashboard',
    this.closeOnFallback = false,
  });

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: const Icon(Icons.arrow_back),
      tooltip: MaterialLocalizations.of(context).backButtonTooltip,
      onPressed: () async {
        final router = GoRouter.of(context);
        if (router.canPop()) {
          router.pop();
          return;
        }

        final navigator = Navigator.of(context);
        if (navigator.canPop()) {
          await navigator.maybePop();
          return;
        }

        final currentRoute = GoRouterState.of(context).matchedLocation;
        if (currentRoute != fallbackRoute && context.mounted) {
          context.go(fallbackRoute);
          return;
        }

        if (closeOnFallback) {
          await SystemNavigator.pop();
        }
      },
    );
  }
}
