import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/vhhealth_core.dart' show RealtimeProvider;
import '../config/api_config.dart';
import '../config/role_config.dart';
import '../platform_info.dart';
import '../providers/message_unread_provider.dart';
import '../providers/session_timeout_provider.dart';
import 'message_unread_badge.dart';

@visibleForTesting
bool shouldPushWorkbenchNav({
  required String currentRoute,
  required String targetRoute,
}) {
  if (currentRoute == targetRoute) return false;
  return targetRoute != '/dashboard';
}

/// Shell scaffold that provides persistent bottom navigation.
/// Used as the ShellRoute builder in app_router.dart.
class MainScaffold extends StatefulWidget {
  final Widget child;
  const MainScaffold({super.key, required this.child});

  @override
  State<MainScaffold> createState() => _MainScaffoldState();
}

class _MainScaffoldState extends State<MainScaffold> {
  StaffRole _role = StaffRole.general;

  @override
  void initState() {
    super.initState();
    _loadRole();
  }

  Future<void> _loadRole() async {
    final roleStr = await ApiConfig.getRole();
    if (!mounted) return;
    setState(() => _role = StaffRole.fromString(roleStr));
    unawaited(context.read<RealtimeProvider>().ensureConnected());
    unawaited(context.read<MessageUnreadProvider>().refresh());
  }

  int _currentIndex(List<BottomNavItem> navItems) {
    final location = GoRouterState.of(context).matchedLocation;
    for (int i = 0; i < navItems.length; i++) {
      if (navItems[i].route == location) return i;
    }
    return 0;
  }

  int _currentRailIndex(List<WorkbenchNavItem> navItems) {
    final location = GoRouterState.of(context).matchedLocation;
    for (int i = 0; i < navItems.length; i++) {
      final route = navItems[i].route;
      if (route == location ||
          (route != '/dashboard' && location.startsWith(route))) {
        return i;
      }
    }
    return 0;
  }

  void _navigateWorkbench(List<WorkbenchNavItem> navItems, int index) {
    if (index >= navItems.length) return;
    final currentRoute = GoRouterState.of(context).matchedLocation;
    final targetRoute = navItems[index].route;
    if (shouldPushWorkbenchNav(
      currentRoute: currentRoute,
      targetRoute: targetRoute,
    )) {
      context.push(targetRoute);
      return;
    }
    if (currentRoute != targetRoute) context.go(targetRoute);
  }

  @override
  Widget build(BuildContext context) {
    final mode = appDeviceModeForContext(context);
    context.read<SessionTimeoutProvider>().configureForDeviceMode(mode);
    final unreadMessages = context.watch<MessageUnreadProvider>().unreadCount;
    if (mode.isWorkbench) {
      final navItems = RoleFeatures.getWorkbenchNavForRole(_role);
      final selectedIndex = _currentRailIndex(navItems);
      return Scaffold(
        body: Row(
          children: [
            NavigationRail(
              selectedIndex: selectedIndex,
              minWidth: 76,
              groupAlignment: -0.92,
              labelType: NavigationRailLabelType.all,
              onDestinationSelected: (index) =>
                  _navigateWorkbench(navItems, index),
              destinations: navItems
                  .map(
                    (item) => NavigationRailDestination(
                      icon: _messagesAwareIcon(
                        item.icon,
                        item.route,
                        unreadMessages,
                      ),
                      selectedIcon: _messagesAwareIcon(
                        item.selectedIcon,
                        item.route,
                        unreadMessages,
                      ),
                      label: Text(item.label),
                    ),
                  )
                  .toList(),
            ),
            const VerticalDivider(width: 1),
            Expanded(child: widget.child),
          ],
        ),
      );
    }

    final navItems = mode == AppDeviceMode.mobile
        ? RoleFeatures.getPhoneSelfServiceNavForRole(_role)
        : RoleFeatures.getBottomNavForRole(_role);

    return Scaffold(
      body: widget.child,
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _currentIndex(navItems),
        type: BottomNavigationBarType.fixed,
        onTap: (i) {
          if (i >= navItems.length) return;
          final currentRoute = GoRouterState.of(context).matchedLocation;
          final targetRoute = navItems[i].route;
          if (shouldPushWorkbenchNav(
            currentRoute: currentRoute,
            targetRoute: targetRoute,
          )) {
            context.push(targetRoute);
            return;
          }
          if (currentRoute != targetRoute) context.go(targetRoute);
        },
        items: navItems
            .map((n) => _messagesAwareBottomItem(n, unreadMessages))
            .toList(),
      ),
    );
  }

  Widget _messagesAwareIcon(IconData icon, String route, int unreadMessages) {
    final child = Icon(icon);
    if (route != '/messaging') return child;
    return MessageUnreadBadge(unreadCount: unreadMessages, child: child);
  }

  BottomNavigationBarItem _messagesAwareBottomItem(
    BottomNavItem navItem,
    int unreadMessages,
  ) {
    if (navItem.route != '/messaging') return navItem.item;
    return BottomNavigationBarItem(
      icon: MessageUnreadBadge(
        unreadCount: unreadMessages,
        child: navItem.item.icon,
      ),
      activeIcon: MessageUnreadBadge(
        unreadCount: unreadMessages,
        child: navItem.item.activeIcon,
      ),
      label: navItem.item.label,
      tooltip: navItem.item.tooltip,
      backgroundColor: navItem.item.backgroundColor,
    );
  }
}
