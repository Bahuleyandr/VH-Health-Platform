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
          _NavItem('Home', Icons.dashboard_outlined, Icons.dashboard, '/dashboard'),
          _NavItem('Patients', Icons.medical_information_outlined, Icons.medical_information, '/patient-records'),
          _NavItem('Schedule', Icons.calendar_month_outlined, Icons.calendar_month, '/appointments'),
          _NavItem('Profile', Icons.person_outlined, Icons.person, '/profile'),
        ];
      case StaffRole.nurse:
        return [
          _NavItem('Home', Icons.dashboard_outlined, Icons.dashboard, '/dashboard'),
          _NavItem('Vitals', Icons.monitor_heart_outlined, Icons.monitor_heart, '/vitals'),
          _NavItem('Notes', Icons.note_alt_outlined, Icons.note_alt, '/nursing-notes'),
          _NavItem('Profile', Icons.person_outlined, Icons.person, '/profile'),
        ];
      case StaffRole.hr:
        return [
          _NavItem('Home', Icons.dashboard_outlined, Icons.dashboard, '/dashboard'),
          _NavItem('HR Hub', Icons.groups_outlined, Icons.groups, '/hr-dashboard'),
          _NavItem('Leave', Icons.event_available_outlined, Icons.event_available, '/leave'),
          _NavItem('Profile', Icons.person_outlined, Icons.person, '/profile'),
        ];
      case StaffRole.admin || StaffRole.superAdmin:
        return [
          _NavItem('Home', Icons.dashboard_outlined, Icons.dashboard, '/dashboard'),
          _NavItem('Staff', Icons.groups_outlined, Icons.groups, '/staff-management'),
          _NavItem('Directory', Icons.contacts_outlined, Icons.contacts, '/directory'),
          _NavItem('Settings', Icons.settings_outlined, Icons.settings, '/settings'),
        ];
      case StaffRole.pharmacy:
        return [
          _NavItem('Home', Icons.dashboard_outlined, Icons.dashboard, '/dashboard'),
          _NavItem('Orders', Icons.medication_outlined, Icons.medication, '/pharmacy'),
          _NavItem('Attendance', Icons.fingerprint_outlined, Icons.fingerprint, '/attendance'),
          _NavItem('Profile', Icons.person_outlined, Icons.person, '/profile'),
        ];
      case StaffRole.lab:
        return [
          _NavItem('Home', Icons.dashboard_outlined, Icons.dashboard, '/dashboard'),
          _NavItem('Lab', Icons.science_outlined, Icons.science, '/investigations'),
          _NavItem('Attendance', Icons.fingerprint_outlined, Icons.fingerprint, '/attendance'),
          _NavItem('Profile', Icons.person_outlined, Icons.person, '/profile'),
        ];
      case StaffRole.general:
      default:
        return [
          _NavItem('Home', Icons.dashboard_outlined, Icons.dashboard, '/dashboard'),
          _NavItem('Tasks', Icons.checklist_outlined, Icons.checklist, '/tasks'),
          _NavItem('Attendance', Icons.fingerprint_outlined, Icons.fingerprint, '/attendance'),
          _NavItem('Profile', Icons.person_outlined, Icons.person, '/profile'),
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
