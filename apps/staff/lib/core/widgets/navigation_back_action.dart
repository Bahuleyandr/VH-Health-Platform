import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter/services.dart';

/// AppBar leading action for staff screens.
///
/// Many screens use `context.go(...)`, so there is often no native
/// Navigator stack to pop. In that case, the safest shared fallback is
/// the staff dashboard.
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
