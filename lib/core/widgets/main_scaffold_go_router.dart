// lib/core/widgets/main_scaffold_go_router.dart
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';
import 'package:badges/badges.dart' as badges;
import 'package:vhhealth/core/providers/notification_provider.dart';

class MainScaffoldGoRouter extends StatefulWidget {
  final Widget child;
  final String phone;
  final String name;

  const MainScaffoldGoRouter({
    super.key,
    required this.child,
    required this.phone,
    required this.name,
  });

  @override
  State<MainScaffoldGoRouter> createState() => _MainScaffoldGoRouterState();
}

class _MainScaffoldGoRouterState extends State<MainScaffoldGoRouter> {
  @override
  void initState() {
    super.initState();
    // Fetch notifications
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        context.read<NotificationProvider>().fetchUnreadCount(widget.phone);
      }
    });
  }

  int _calculateSelectedIndex(BuildContext context) {
    final String location = GoRouterState.of(context).matchedLocation;
    if (location.startsWith('/home')) return 0;
    if (location.startsWith('/health')) return 1;
    if (location.startsWith('/notifications')) return 2;
    if (location.startsWith('/settings')) return 3;
    return 0;
  }

  void _onItemTapped(int index, BuildContext context) {
    switch (index) {
      case 0:
        context.go('/home');
        break;
      case 1:
        context.go('/health');
        break;
      case 2:
        context.go('/notifications');
        // Mark as read
        context.read<NotificationProvider>().markAllAsRead(widget.phone);
        break;
      case 3:
        context.go('/settings');
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final unread = context.watch<NotificationProvider>().unreadCount;
    final selectedIndex = _calculateSelectedIndex(context);

    return Scaffold(
      body: widget.child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: selectedIndex,
        onDestinationSelected: (index) => _onItemTapped(index, context),
        destinations: [
          const NavigationDestination(
            icon: Icon(LucideIcons.home),
            selectedIcon: Icon(LucideIcons.home, size: 26),
            label: 'Home',
          ),
          const NavigationDestination(
            icon: Icon(LucideIcons.heartPulse),
            selectedIcon: Icon(LucideIcons.heartPulse, size: 26),
            label: 'Your Health',
          ),
          NavigationDestination(
            icon: badges.Badge(
              position: badges.BadgePosition.topEnd(top: -12, end: -8),
              showBadge: unread > 0,
              badgeStyle: badges.BadgeStyle(
                badgeColor: theme.colorScheme.error,
                padding: const EdgeInsets.all(4),
              ),
              badgeContent: Text(
                unread > 99 ? '99+' : unread.toString(),
                style: const TextStyle(
                  fontSize: 10,
                  color: Colors.white,
                  fontWeight: FontWeight.bold,
                ),
              ),
              child: const Icon(LucideIcons.bell),
            ),
            selectedIcon: badges.Badge(
              position: badges.BadgePosition.topEnd(top: -12, end: -8),
              showBadge: unread > 0,
              badgeStyle: badges.BadgeStyle(
                badgeColor: theme.colorScheme.error,
                padding: const EdgeInsets.all(4),
              ),
              badgeContent: Text(
                unread > 99 ? '99+' : unread.toString(),
                style: const TextStyle(
                  fontSize: 10,
                  color: Colors.white,
                  fontWeight: FontWeight.bold,
                ),
              ),
              child: const Icon(LucideIcons.bell, size: 26),
            ),
            label: 'Notifications',
          ),
          const NavigationDestination(
            icon: Icon(LucideIcons.settings),
            selectedIcon: Icon(LucideIcons.settings, size: 26),
            label: 'Settings',
          ),
        ],
      ),
    );
  }
}