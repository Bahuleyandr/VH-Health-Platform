import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../theme/app_theme.dart';
import 'sos_button.dart';

class StaffScaffold extends StatelessWidget {
  final String title;
  final Widget body;
  final List<Widget>? actions;
  final Widget? floatingActionButton;
  final bool showSos;
  final int? currentIndex;
  final bool showBottomNav;
  final Widget? bottomSheet;

  const StaffScaffold({
    super.key,
    required this.title,
    required this.body,
    this.actions,
    this.floatingActionButton,
    this.showSos = false,
    this.currentIndex,
    this.showBottomNav = false,
    this.bottomSheet,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        title: Text(title),
        actions: [
          if (showSos) const SosButton(),
          ...?actions,
        ],
      ),
      body: body,
      floatingActionButton: floatingActionButton,
      bottomNavigationBar: showBottomNav ? _buildBottomNav(context) : null,
      bottomSheet: bottomSheet,
    );
  }

  Widget _buildBottomNav(BuildContext context) {
    return BottomNavigationBar(
      currentIndex: currentIndex ?? 0,
      onTap: (index) {
        switch (index) {
          case 0:
            context.go('/dashboard');
            break;
          case 1:
            context.go('/attendance');
            break;
          case 2:
            context.go('/leave');
            break;
          case 3:
            context.go('/profile');
            break;
          case 4:
            context.go('/settings');
            break;
        }
      },
      items: const [
        BottomNavigationBarItem(
          icon: Icon(Icons.dashboard_outlined),
          activeIcon: Icon(Icons.dashboard),
          label: 'Home',
        ),
        BottomNavigationBarItem(
          icon: Icon(Icons.fingerprint_outlined),
          activeIcon: Icon(Icons.fingerprint),
          label: 'Attendance',
        ),
        BottomNavigationBarItem(
          icon: Icon(Icons.event_available_outlined),
          activeIcon: Icon(Icons.event_available),
          label: 'Leave',
        ),
        BottomNavigationBarItem(
          icon: Icon(Icons.person_outlined),
          activeIcon: Icon(Icons.person),
          label: 'Profile',
        ),
        BottomNavigationBarItem(
          icon: Icon(Icons.settings_outlined),
          activeIcon: Icon(Icons.settings),
          label: 'Settings',
        ),
      ],
    );
  }
}
