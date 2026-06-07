// lib/core/widgets/main_scaffold_go_router.dart
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:badges/badges.dart' as badges;
import 'package:provider/provider.dart';
import 'package:vhhealth/core/providers/notification_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';

class MainScaffoldGoRouter extends StatefulWidget {
  final Widget child;

  const MainScaffoldGoRouter({super.key, required this.child});

  @override
  State<MainScaffoldGoRouter> createState() => _MainScaffoldGoRouterState();
}

class _MainScaffoldGoRouterState extends State<MainScaffoldGoRouter>
    with WidgetsBindingObserver {
  late final String _phone;

  @override
  void initState() {
    super.initState();
    _phone = context.read<UserProvider>().phone;
    WidgetsBinding.instance.addObserver(this);
    _fetchNotifications();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && mounted) {
      context.read<NotificationProvider>().fetchUnreadCount(_phone);
    }
  }

  void _fetchNotifications() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        context.read<NotificationProvider>().fetchUnreadCount(_phone);
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

  void _showSignInPrompt() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Please sign in to use this feature.'),
        behavior: SnackBarBehavior.floating,
      ),
    );
    context.go('/login');
  }

  void _onItemTapped(int index) {
    final isGuest = context.read<UserProvider>().isGuest;
    switch (index) {
      case 0:
        context.go('/home');
        break;
      case 1:
        if (isGuest) {
          _showSignInPrompt();
          break;
        }
        context.go('/health');
        break;
      case 2:
        if (isGuest) {
          _showSignInPrompt();
          break;
        }
        context.go('/notifications');
        // Mark notifications as read
        context.read<NotificationProvider>().markAllAsRead(_phone);
        break;
      case 3:
        context.go('/settings');
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final unread = context.watch<NotificationProvider>().unreadCount;
    final selectedIndex = _calculateSelectedIndex(context);

    return Scaffold(
      body: widget.child,
      bottomNavigationBar: Theme(
        data: Theme.of(context).copyWith(
          splashColor: Colors.transparent,
          highlightColor: Colors.transparent,
        ),
        child: BottomNavigationBar(
          currentIndex: selectedIndex,
          onTap: _onItemTapped,
          type: BottomNavigationBarType.fixed,
          selectedItemColor: Theme.of(context).colorScheme.primary,
          unselectedItemColor: Theme.of(context).colorScheme.onSurfaceVariant,
          selectedFontSize: 12,
          unselectedFontSize: 12,
          items: [
            const BottomNavigationBarItem(
              icon: Icon(LucideIcons.home),
              activeIcon: Icon(LucideIcons.home, size: 28),
              label: 'Home',
            ),
            const BottomNavigationBarItem(
              icon: Icon(LucideIcons.heartPulse),
              activeIcon: Icon(LucideIcons.heartPulse, size: 28),
              label: 'Your Health',
            ),
            BottomNavigationBarItem(
              icon: badges.Badge(
                position: badges.BadgePosition.topEnd(top: -8, end: -4),
                showBadge: unread > 0,
                badgeStyle: const badges.BadgeStyle(
                  badgeColor: Colors.red,
                  elevation: 0,
                  padding: EdgeInsets.all(4),
                ),
                badgeContent: Text(
                  unread > 99 ? '99+' : unread.toString(),
                  style: const TextStyle(
                    fontSize: 10,
                    color: Colors.white,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                child: const Icon(LucideIcons.bell),
              ),
              activeIcon: badges.Badge(
                position: badges.BadgePosition.topEnd(top: -8, end: -4),
                showBadge: unread > 0,
                badgeStyle: const badges.BadgeStyle(
                  badgeColor: Colors.red,
                  elevation: 0,
                  padding: EdgeInsets.all(4),
                ),
                badgeContent: Text(
                  unread > 99 ? '99+' : unread.toString(),
                  style: const TextStyle(
                    fontSize: 10,
                    color: Colors.white,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                child: const Icon(LucideIcons.bell, size: 28),
              ),
              label: 'Notifications',
            ),
            const BottomNavigationBarItem(
              icon: Icon(LucideIcons.settings),
              activeIcon: Icon(LucideIcons.settings, size: 28),
              label: 'Settings',
            ),
          ],
        ),
      ),
    );
  }
}
