import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../config/role_config.dart';
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
  final StaffRole? role;

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
    this.role,
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
    final navItems = _getNavItems(role ?? StaffRole.general);
    return BottomNavigationBar(
      currentIndex: currentIndex ?? 0,
      type: BottomNavigationBarType.fixed,
      onTap: (index) {
        if (index < navItems.length) {
          context.go(navItems[index].route);
        }
      },
      items: navItems.map((item) => BottomNavigationBarItem(
        icon: Icon(item.icon),
        activeIcon: Icon(item.activeIcon),
        label: item.label,
      )).toList(),
    );
  }

  List<_NavItem> _getNavItems(StaffRole role) {
    switch (role) {
      case StaffRole.doctor:
        return [
          const _NavItem('Home', Icons.dashboard_outlined, Icons.dashboard, '/dashboard'),
          const _NavItem('Queue', Icons.queue_outlined, Icons.queue, '/queue'),
          const _NavItem('Records', Icons.folder_shared_outlined, Icons.folder_shared, '/patient-records'),
          const _NavItem('Profile', Icons.person_outlined, Icons.person, '/profile'),
        ];
      case StaffRole.nurse:
        return [
          const _NavItem('Home', Icons.dashboard_outlined, Icons.dashboard, '/dashboard'),
          const _NavItem('Vitals', Icons.monitor_heart_outlined, Icons.monitor_heart, '/vitals'),
          const _NavItem('Notes', Icons.note_alt_outlined, Icons.note_alt, '/nursing-notes'),
          const _NavItem('Profile', Icons.person_outlined, Icons.person, '/profile'),
        ];
      case StaffRole.hr:
        return [
          const _NavItem('Home', Icons.dashboard_outlined, Icons.dashboard, '/dashboard'),
          const _NavItem('HR Hub', Icons.groups_outlined, Icons.groups, '/hr-dashboard'),
          const _NavItem('Leave', Icons.event_available_outlined, Icons.event_available, '/leave'),
          const _NavItem('Profile', Icons.person_outlined, Icons.person, '/profile'),
        ];
      case StaffRole.admin || StaffRole.superAdmin:
        return [
          const _NavItem('Home', Icons.dashboard_outlined, Icons.dashboard, '/dashboard'),
          const _NavItem('Staff', Icons.groups_outlined, Icons.groups, '/staff-management'),
          const _NavItem('Directory', Icons.contacts_outlined, Icons.contacts, '/directory'),
          const _NavItem('Settings', Icons.settings_outlined, Icons.settings, '/settings'),
        ];
      case StaffRole.pharmacy:
        return [
          const _NavItem('Home', Icons.dashboard_outlined, Icons.dashboard, '/dashboard'),
          const _NavItem('Orders', Icons.medication_outlined, Icons.medication, '/pharmacy'),
          const _NavItem('Attendance', Icons.fingerprint_outlined, Icons.fingerprint, '/attendance'),
          const _NavItem('Profile', Icons.person_outlined, Icons.person, '/profile'),
        ];
      case StaffRole.lab:
        return [
          const _NavItem('Home', Icons.dashboard_outlined, Icons.dashboard, '/dashboard'),
          const _NavItem('Lab', Icons.science_outlined, Icons.science, '/investigations'),
          const _NavItem('Attendance', Icons.fingerprint_outlined, Icons.fingerprint, '/attendance'),
          const _NavItem('Profile', Icons.person_outlined, Icons.person, '/profile'),
        ];
      case StaffRole.general:
        return [
          const _NavItem('Home', Icons.dashboard_outlined, Icons.dashboard, '/dashboard'),
          const _NavItem('Tasks', Icons.checklist_outlined, Icons.checklist, '/tasks'),
          const _NavItem('Attendance', Icons.fingerprint_outlined, Icons.fingerprint, '/attendance'),
          const _NavItem('Profile', Icons.person_outlined, Icons.person, '/profile'),
        ];
    }
  }
}

class _NavItem {
  final String label;
  final IconData icon;
  final IconData activeIcon;
  final String route;
  const _NavItem(this.label, this.icon, this.activeIcon, this.route);
}
