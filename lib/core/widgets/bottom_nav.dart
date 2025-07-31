import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:badges/badges.dart' as badges;
import 'package:provider/provider.dart';

import 'package:vhhealth/core/providers/notification_provider.dart';
import 'package:vhhealth/core/widgets/tab_navigator.dart';
import 'package:vhhealth/core/widgets/error_boundary.dart';

import 'package:vhhealth/features/dashboard/screens/dashboard_screen.dart';
import 'package:vhhealth/features/your_health/screens/your_health_screen.dart';
import 'package:vhhealth/features/notifications/screens/notifications_screen.dart';
import 'package:vhhealth/features/settings/screens/settings_screen.dart';

class BottomTabNavigator extends StatefulWidget {
  final String phone;
  final String name;

  const BottomTabNavigator({
    super.key,
    required this.phone,
    required this.name,
  });

  @override
  State<BottomTabNavigator> createState() => _BottomTabNavigatorState();
}

class _BottomTabNavigatorState extends State<BottomTabNavigator> 
    with WidgetsBindingObserver {
  int _selectedIndex = 0;
  final _navigatorKeys = List.generate(4, (_) => GlobalKey<NavigatorState>());
  
  // Cache tab widgets to prevent recreation
  late final List<Widget> _tabCache;
  
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _initializeTabs();
    _fetchNotifications();
  }
  
  void _initializeTabs() {
    _tabCache = [
      DashboardScreen(phone: widget.phone, name: widget.name),
      YourHealthScreen(phone: widget.phone),
      NotificationsScreen(phone: widget.phone),
      SettingsScreen(phone: widget.phone, name: widget.name),
    ];
  }
  
  void _fetchNotifications() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        context.read<NotificationProvider>().fetchUnreadCount(widget.phone);
      }
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
  
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && mounted) {
      // Refresh notifications when app returns to foreground
      context.read<NotificationProvider>().fetchUnreadCount(widget.phone);
    }
  }

  void _onItemTapped(int index) {
    if (_selectedIndex == index) {
      // Pop to root of current tab
      _navigatorKeys[index].currentState?.popUntil((route) => route.isFirst);
    } else {
      setState(() => _selectedIndex = index);
      if (index == 2) {
        // Mark notifications as read when tab is selected
        context.read<NotificationProvider>().markAllAsRead(widget.phone);
      }
    }
  }

  Future<bool> _onWillPop() async {
    final currentNavigator = _navigatorKeys[_selectedIndex].currentState;
    
    // If current tab has navigation history, pop it
    if (currentNavigator != null && currentNavigator.canPop()) {
      currentNavigator.pop();
      return false;
    }
    
    // If not on dashboard (index 0), go back to dashboard
    if (_selectedIndex != 0) {
      setState(() => _selectedIndex = 0);
      return false;
    }
    
    // If already on dashboard with no history, allow app exit
    return true;
  }

  @override
  Widget build(BuildContext context) {
    final unread = context.watch<NotificationProvider>().unreadCount;
    final theme = Theme.of(context);

    return WillPopScope(
      onWillPop: _onWillPop,
      child: Scaffold(
        body: IndexedStack(
          index: _selectedIndex,
          children: List.generate(4, (index) => 
            ErrorBoundary(
              fallback: _buildErrorFallback(index),
              child: TabNavigator(
                navigatorKey: _navigatorKeys[index],
                child: _tabCache[index],
              ),
            ),
          ),
        ),
        bottomNavigationBar: Theme(
          data: theme.copyWith(
            splashColor: Colors.transparent,
            highlightColor: Colors.transparent,
          ),
          child: BottomNavigationBar(
            currentIndex: _selectedIndex,
            onTap: _onItemTapped,
            type: BottomNavigationBarType.fixed,
            selectedItemColor: Colors.teal,
            unselectedItemColor: Colors.grey,
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
      ),
    );
  }
  
  Widget _buildErrorFallback(int index) {
    final labels = ['Home', 'Your Health', 'Notifications', 'Settings'];
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.error_outline,
            size: 64,
            color: Colors.red[300],
          ),
          const SizedBox(height: 16),
          Text(
            'Error loading ${labels[index]}',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          ElevatedButton(
            onPressed: () => setState(() {
              // Force rebuild of tab
              _initializeTabs();
            }),
            child: const Text('Retry'),
          ),
        ],
      ),
    );
  }
}

// Error boundary widget (add to core/widgets/error_boundary.dart)
class ErrorBoundary extends StatefulWidget {
  final Widget child;
  final Widget Function(Object error, StackTrace? stack)? errorBuilder;
  final Widget? fallback;

  const ErrorBoundary({
    super.key,
    required this.child,
    this.errorBuilder,
    this.fallback,
  });

  @override
  State<ErrorBoundary> createState() => _ErrorBoundaryState();
}

class _ErrorBoundaryState extends State<ErrorBoundary> {
  Object? _error;
  StackTrace? _stackTrace;

  @override
  void initState() {
    super.initState();
    // Catch errors in child widget tree
    FlutterError.onError = (FlutterErrorDetails details) {
      if (mounted) {
        setState(() {
          _error = details.exception;
          _stackTrace = details.stack;
        });
      }
    };
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      if (widget.errorBuilder != null) {
        return widget.errorBuilder!(_error!, _stackTrace);
      } else if (widget.fallback != null) {
        return widget.fallback!;
      } else {
        return Center(
          child: Text('Error: $_error'),
        );
      }
    }
    
    return widget.child;
  }
}