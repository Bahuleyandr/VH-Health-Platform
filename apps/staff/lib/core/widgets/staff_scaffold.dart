import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../config/role_config.dart';
import '../theme/app_theme.dart';
import 'code_blue_listener.dart';
import 'logout_action.dart';
import 'offline_sync_badge.dart';
import 'patient_search_action.dart';
import 'theme_toggle_action.dart';

class StaffScaffold extends StatelessWidget {
  final String title;
  final Widget body;
  final List<Widget>? actions;
  final Widget? floatingActionButton;
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
    this.currentIndex,
    this.showBottomNav = false,
    this.bottomSheet,
    this.role,
  });

  @override
  Widget build(BuildContext context) {
    return CodeBlueListener(
      child: Scaffold(
        backgroundColor: AppTheme.backgroundGrey,
        appBar: AppBar(
          leading: const NavigationBackAction(),
          title: Text(title),
          actions: [
            const OfflineSyncBadge(),
            const ThemeToggleAction(),
            ...?actions,
            // Global patient picker — magnifier next to logout. Open
            // from any StaffScaffold screen via this icon (or Cmd+K
            // when shortcuts are wired). Non-clinical roles will get
            // a 403 displayed inside the sheet, not a crash.
            if (role != StaffRole.housekeeping &&
                role != StaffRole.housekeepingIncharge &&
                role != StaffRole.maintenance)
              const PatientSearchAction(),
            // Universal logout — visible from every screen so the user
            // doesn't have to navigate to Settings (the nurse / doctor /
            // pharmacy bottom-nav variants don't include Settings, so
            // without this the only logout path was to fully reinstall).
            const LogoutAction(),
          ],
        ),
        body: body,
        floatingActionButton: floatingActionButton,
        bottomNavigationBar: showBottomNav ? _buildBottomNav(context) : null,
        bottomSheet: bottomSheet,
      ),
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
      items: navItems
          .map(
            (item) => BottomNavigationBarItem(
              icon: Icon(item.icon),
              activeIcon: Icon(item.activeIcon),
              label: item.label,
            ),
          )
          .toList(),
    );
  }

  List<_NavItem> _getNavItems(StaffRole role) {
    switch (role) {
      case StaffRole.doctor:
      case StaffRole.dutyDoctor:
        return [
          const _NavItem(
            'Home',
            Icons.dashboard_outlined,
            Icons.dashboard,
            '/dashboard',
          ),
          const _NavItem('Queue', Icons.queue_outlined, Icons.queue, '/queue'),
          const _NavItem(
            'Records',
            Icons.folder_shared_outlined,
            Icons.folder_shared,
            '/patient-records',
          ),
          const _NavItem(
            'Profile',
            Icons.person_outlined,
            Icons.person,
            '/profile',
          ),
        ];
      case StaffRole.nurse:
      case StaffRole.nursingSuperintendent:
      case StaffRole.nursingIncharge:
      case StaffRole.opStaffNurse:
      case StaffRole.opIncharge:
        return [
          const _NavItem(
            'Home',
            Icons.dashboard_outlined,
            Icons.dashboard,
            '/dashboard',
          ),
          const _NavItem(
            'My Roster',
            Icons.schedule_outlined,
            Icons.schedule,
            '/schedule',
          ),
          const _NavItem(
            'Notes',
            Icons.note_alt_outlined,
            Icons.note_alt,
            '/nursing-notes',
          ),
          const _NavItem(
            'Profile',
            Icons.person_outlined,
            Icons.person,
            '/profile',
          ),
        ];
      case StaffRole.hr:
        return [
          const _NavItem(
            'Home',
            Icons.dashboard_outlined,
            Icons.dashboard,
            '/dashboard',
          ),
          const _NavItem(
            'Staff Roster',
            Icons.calendar_month_outlined,
            Icons.calendar_month,
            '/staff-rosters',
          ),
          const _NavItem(
            'HR Hub',
            Icons.groups_outlined,
            Icons.groups,
            '/hr-dashboard',
          ),
          const _NavItem(
            'Profile',
            Icons.person_outlined,
            Icons.person,
            '/profile',
          ),
        ];
      case StaffRole.admin || StaffRole.superAdmin:
        return [
          const _NavItem(
            'Home',
            Icons.dashboard_outlined,
            Icons.dashboard,
            '/dashboard',
          ),
          const _NavItem(
            'Staff Roster',
            Icons.calendar_month_outlined,
            Icons.calendar_month,
            '/staff-rosters',
          ),
          const _NavItem(
            'Onboarding',
            Icons.manage_accounts_outlined,
            Icons.manage_accounts,
            '/staff-management',
          ),
          const _NavItem(
            'Settings',
            Icons.settings_outlined,
            Icons.settings,
            '/settings',
          ),
        ];
      case StaffRole.medicalSuperintendent:
        return [
          const _NavItem(
            'Home',
            Icons.dashboard_outlined,
            Icons.dashboard,
            '/dashboard',
          ),
          const _NavItem(
            'Staff Roster',
            Icons.calendar_month_outlined,
            Icons.calendar_month,
            '/staff-rosters',
          ),
          const _NavItem(
            'Directory',
            Icons.contacts_outlined,
            Icons.contacts,
            '/staff-directory',
          ),
          const _NavItem(
            'Settings',
            Icons.settings_outlined,
            Icons.settings,
            '/settings',
          ),
        ];
      case StaffRole.pharmacy:
        return [
          const _NavItem(
            'Home',
            Icons.dashboard_outlined,
            Icons.dashboard,
            '/dashboard',
          ),
          const _NavItem(
            'Orders',
            Icons.medication_outlined,
            Icons.medication,
            '/pharmacy',
          ),
          const _NavItem(
            'Attendance',
            Icons.fingerprint_outlined,
            Icons.fingerprint,
            '/attendance',
          ),
          const _NavItem(
            'Profile',
            Icons.person_outlined,
            Icons.person,
            '/profile',
          ),
        ];
      case StaffRole.lab:
        return [
          const _NavItem(
            'Home',
            Icons.dashboard_outlined,
            Icons.dashboard,
            '/dashboard',
          ),
          const _NavItem(
            'Lab',
            Icons.science_outlined,
            Icons.science,
            '/investigations',
          ),
          const _NavItem(
            'Attendance',
            Icons.fingerprint_outlined,
            Icons.fingerprint,
            '/attendance',
          ),
          const _NavItem(
            'Profile',
            Icons.person_outlined,
            Icons.person,
            '/profile',
          ),
        ];
      case StaffRole.housekeeping:
        return [
          const _NavItem(
            'Home',
            Icons.dashboard_outlined,
            Icons.dashboard,
            '/dashboard',
          ),
          const _NavItem(
            'Beds',
            Icons.local_hotel_outlined,
            Icons.local_hotel,
            '/beds',
          ),
          const _NavItem(
            'Cleaning',
            Icons.cleaning_services_outlined,
            Icons.cleaning_services,
            '/housekeeping',
          ),
          const _NavItem(
            'Profile',
            Icons.person_outlined,
            Icons.person,
            '/profile',
          ),
        ];
      case StaffRole.housekeepingIncharge:
        return [
          const _NavItem(
            'Home',
            Icons.dashboard_outlined,
            Icons.dashboard,
            '/dashboard',
          ),
          const _NavItem(
            'Beds',
            Icons.local_hotel_outlined,
            Icons.local_hotel,
            '/beds',
          ),
          const _NavItem(
            'Command',
            Icons.supervisor_account_outlined,
            Icons.supervisor_account,
            '/housekeeping-command',
          ),
          const _NavItem(
            'Cleaning',
            Icons.cleaning_services_outlined,
            Icons.cleaning_services,
            '/housekeeping',
          ),
          const _NavItem(
            'Profile',
            Icons.person_outlined,
            Icons.person,
            '/profile',
          ),
        ];
      case StaffRole.receptionist:
      case StaffRole.receptionIncharge:
        return [
          const _NavItem(
            'Home',
            Icons.dashboard_outlined,
            Icons.dashboard,
            '/dashboard',
          ),
          const _NavItem(
            'Front Desk',
            Icons.space_dashboard_outlined,
            Icons.space_dashboard,
            '/front-office',
          ),
          const _NavItem(
            'My Roster',
            Icons.schedule_outlined,
            Icons.schedule,
            '/schedule',
          ),
          const _NavItem(
            'Messages',
            Icons.chat_outlined,
            Icons.chat,
            '/messaging',
          ),
          const _NavItem(
            'Profile',
            Icons.person_outlined,
            Icons.person,
            '/profile',
          ),
        ];
      case StaffRole.billingStaff:
      case StaffRole.billingIncharge:
      case StaffRole.financeIncharge:
        return [
          const _NavItem(
            'Home',
            Icons.dashboard_outlined,
            Icons.dashboard,
            '/dashboard',
          ),
          const _NavItem(
            'Billing',
            Icons.receipt_long_outlined,
            Icons.receipt_long,
            '/billing-desk',
          ),
          const _NavItem(
            'Front Desk',
            Icons.space_dashboard_outlined,
            Icons.space_dashboard,
            '/front-office',
          ),
          const _NavItem(
            'Messages',
            Icons.chat_outlined,
            Icons.chat,
            '/messaging',
          ),
          const _NavItem(
            'Profile',
            Icons.person_outlined,
            Icons.person,
            '/profile',
          ),
        ];
      case StaffRole.admissionOfficer:
      case StaffRole.insuranceCoordinator:
      case StaffRole.ipdCounsellor:
        return [
          const _NavItem(
            'Home',
            Icons.dashboard_outlined,
            Icons.dashboard,
            '/dashboard',
          ),
          const _NavItem(
            'Front Desk',
            Icons.space_dashboard_outlined,
            Icons.space_dashboard,
            '/front-office',
          ),
          const _NavItem(
            'Admissions',
            Icons.local_hospital_outlined,
            Icons.local_hospital,
            '/emr/admissions',
          ),
          const _NavItem(
            'Messages',
            Icons.chat_outlined,
            Icons.chat,
            '/messaging',
          ),
          const _NavItem(
            'Profile',
            Icons.person_outlined,
            Icons.person,
            '/profile',
          ),
        ];
      case StaffRole.driver:
      case StaffRole.maintenance:
        return [
          const _NavItem(
            'Home',
            Icons.dashboard_outlined,
            Icons.dashboard,
            '/dashboard',
          ),
          const _NavItem(
            'Work',
            Icons.build_outlined,
            Icons.build,
            '/dashboard',
          ),
          const _NavItem(
            'Messages',
            Icons.chat_outlined,
            Icons.chat,
            '/messaging',
          ),
          const _NavItem(
            'Profile',
            Icons.person_outlined,
            Icons.person,
            '/profile',
          ),
        ];
      case StaffRole.general:
        return [
          const _NavItem(
            'Home',
            Icons.dashboard_outlined,
            Icons.dashboard,
            '/dashboard',
          ),
          const _NavItem(
            'Tasks',
            Icons.checklist_outlined,
            Icons.checklist,
            '/tasks',
          ),
          const _NavItem(
            'Attendance',
            Icons.fingerprint_outlined,
            Icons.fingerprint,
            '/attendance',
          ),
          const _NavItem(
            'Profile',
            Icons.person_outlined,
            Icons.person,
            '/profile',
          ),
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

// _LogoutAction lifted to lib/core/widgets/logout_action.dart so screens
// that use a raw Scaffold (instead of StaffScaffold) can drop the same
// widget into their AppBar.actions list.
