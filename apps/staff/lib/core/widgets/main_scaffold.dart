import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/vhhealth_core.dart' show RealtimeProvider;
import '../config/api_config.dart';
import '../config/role_config.dart';
import '../platform_info.dart';
import '../providers/clinical_inbox_provider.dart';
import '../providers/message_unread_provider.dart';
import '../providers/notification_provider.dart';
import '../providers/session_timeout_provider.dart';
import '../services/clinical_platform_api_service.dart';
import 'message_unread_badge.dart';

@visibleForTesting
bool shouldPushWorkbenchNav({
  required String currentRoute,
  required String targetRoute,
}) {
  if (currentRoute == targetRoute) return false;
  return targetRoute != '/dashboard';
}

@visibleForTesting
bool shouldNavigateWorkbenchNav({
  required String currentRoute,
  required String targetRoute,
}) {
  if (targetRoute == '/dashboard') return true;
  return currentRoute != targetRoute;
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
  Set<String>? _policyFeatureIds;

  @override
  void initState() {
    super.initState();
    _loadRole();
  }

  Future<void> _loadRole() async {
    final roleStr = await ApiConfig.getRole();
    final role = StaffRole.fromString(roleStr);
    if (!mounted) return;
    setState(() => _role = role);
    unawaited(_loadRolePolicyFeatures(role));
    unawaited(context.read<RealtimeProvider>().ensureConnected());
    unawaited(context.read<MessageUnreadProvider>().refresh());
    unawaited(context.read<NotificationProvider>().fetchNotifications());
  }

  Future<void> _loadRolePolicyFeatures(StaffRole role) async {
    try {
      final policy = await ClinicalPlatformApiService.getRolePolicySnapshot();
      final featureIds =
          policy.featuresByRole[role.value] ??
          policy.featuresByRole[role.value.toUpperCase()] ??
          const <String>[];
      if (!mounted || featureIds.isEmpty) return;
      setState(() => _policyFeatureIds = featureIds.toSet());
    } catch (_) {
      // Keep the static role map as the offline/stale-policy fallback.
    }
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
    if (!shouldNavigateWorkbenchNav(
      currentRoute: currentRoute,
      targetRoute: targetRoute,
    )) {
      return;
    }
    if (targetRoute == '/dashboard') {
      context.go(targetRoute);
      return;
    }
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
    final unreadAlerts = context.watch<NotificationProvider>().unreadCount;
    final pendingClinicalTasks =
        context.watch<ClinicalInboxProvider?>()?.pendingCount ?? 0;
    if (mode.isWorkbench) {
      final navItems = RoleFeatures.getWorkbenchNavForRole(
        _role,
        policyFeatureIds: _policyFeatureIds,
      );
      final selectedIndex = _currentRailIndex(navItems);
      return Scaffold(
        body: Row(
          children: [
            NavigationRail(
              selectedIndex: selectedIndex,
              minWidth: 76,
              groupAlignment: -0.92,
              scrollable: true,
              labelType: NavigationRailLabelType.all,
              onDestinationSelected: (index) =>
                  _navigateWorkbench(navItems, index),
              destinations: navItems
                  .map(
                    (item) => NavigationRailDestination(
                      icon: _badgeAwareIcon(
                        item.icon,
                        item.route,
                        unreadMessages,
                        unreadAlerts,
                        pendingClinicalTasks,
                      ),
                      selectedIcon: _badgeAwareIcon(
                        item.selectedIcon,
                        item.route,
                        unreadMessages,
                        unreadAlerts,
                        pendingClinicalTasks,
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
          if (!shouldNavigateWorkbenchNav(
            currentRoute: currentRoute,
            targetRoute: targetRoute,
          )) {
            return;
          }
          if (targetRoute == '/dashboard') {
            context.go(targetRoute);
            return;
          }
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
            .map(
              (n) => _badgeAwareBottomItem(
                n,
                unreadMessages,
                unreadAlerts,
                pendingClinicalTasks,
              ),
            )
            .toList(),
      ),
    );
  }

  Widget _badgeAwareIcon(
    IconData icon,
    String route,
    int unreadMessages,
    int unreadAlerts,
    int pendingClinicalTasks,
  ) {
    final child = Icon(icon);
    if (route == '/messaging') {
      return MessageUnreadBadge(unreadCount: unreadMessages, child: child);
    }
    if (route == '/notifications') {
      return MessageUnreadBadge(
        unreadCount: unreadAlerts,
        semanticLabel: 'unread alerts',
        child: child,
      );
    }
    if (route == '/clinical-inbox') {
      return MessageUnreadBadge(
        unreadCount: pendingClinicalTasks,
        semanticLabel: 'pending clinical tasks',
        child: child,
      );
    }
    return child;
  }

  BottomNavigationBarItem _badgeAwareBottomItem(
    BottomNavItem navItem,
    int unreadMessages,
    int unreadAlerts,
    int pendingClinicalTasks,
  ) {
    if (navItem.route != '/messaging' &&
        navItem.route != '/notifications' &&
        navItem.route != '/clinical-inbox') {
      return navItem.item;
    }
    final count = navItem.route == '/messaging'
        ? unreadMessages
        : navItem.route == '/notifications'
        ? unreadAlerts
        : pendingClinicalTasks;
    final semanticLabel = navItem.route == '/messaging'
        ? 'unread messages'
        : navItem.route == '/notifications'
        ? 'unread alerts'
        : 'pending clinical tasks';
    return BottomNavigationBarItem(
      icon: MessageUnreadBadge(
        unreadCount: count,
        semanticLabel: semanticLabel,
        child: navItem.item.icon,
      ),
      activeIcon: MessageUnreadBadge(
        unreadCount: count,
        semanticLabel: semanticLabel,
        child: navItem.item.activeIcon,
      ),
      label: navItem.item.label,
      tooltip: navItem.item.tooltip,
      backgroundColor: navItem.item.backgroundColor,
    );
  }
}
