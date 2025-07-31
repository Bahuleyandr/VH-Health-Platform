import 'package:flutter/material.dart';

class TabNavigator extends StatelessWidget {
  final GlobalKey<NavigatorState> navigatorKey;
  final Widget child;

  const TabNavigator({
    super.key,
    required this.navigatorKey,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    return Navigator(
      key: navigatorKey,
      initialRoute: '/dashboard',
      onGenerateRoute: (settings) {
        // Always return the child widget regardless of the route name
        // This ensures the Navigator has at least one route in its history
        return MaterialPageRoute(
          settings: settings,
          builder: (_) => child,
        );
      },
    );
  }
}