import 'package:flutter/material.dart';

// ─── Staff Role Enum ────────────────────────────────────────────────────────

enum StaffRole {
  doctor('DOCTOR'),
  nurse('NURSING_STAFF'),
  hr('HR_STAFF'),
  admin('ADMIN'),
  superAdmin('SUPER_ADMIN'),
  pharmacy('PHARMACY_STAFF'),
  lab('LAB_STAFF'),
  general('GENERAL_STAFF');

  final String value;
  const StaffRole(this.value);

  static StaffRole fromString(String role) {
    return StaffRole.values.firstWhere(
      (r) => r.value == role.trim().toUpperCase(),
      orElse: () => StaffRole.general,
    );
  }

  String get displayName => switch (this) {
        StaffRole.doctor => 'Doctor',
        StaffRole.nurse => 'Nurse',
        StaffRole.hr => 'HR Staff',
        StaffRole.admin => 'Admin',
        StaffRole.superAdmin => 'Super Admin',
        StaffRole.pharmacy => 'Pharmacy',
        StaffRole.lab => 'Lab Technician',
        StaffRole.general => 'Staff',
      };

  Color get badgeColor => switch (this) {
        StaffRole.doctor => const Color(0xFF1565C0),
        StaffRole.nurse => const Color(0xFF00796B),
        StaffRole.hr => const Color(0xFF6A1B9A),
        StaffRole.admin || StaffRole.superAdmin => const Color(0xFFC62828),
        StaffRole.pharmacy => const Color(0xFFE65100),
        StaffRole.lab => const Color(0xFF0097A7),
        StaffRole.general => const Color(0xFF37474F),
      };

  /// Whether this role has admin-level access (ADMIN or SUPER_ADMIN)
  bool get isAdminTier =>
      this == StaffRole.admin || this == StaffRole.superAdmin;
}

// ─── Dashboard Feature ──────────────────────────────────────────────────────

class DashboardFeature {
  final String id;
  final String title;
  final IconData icon;
  final String route;
  final Color color;

  const DashboardFeature({
    required this.id,
    required this.title,
    required this.icon,
    required this.route,
    required this.color,
  });
}

// ─── Bottom Nav Config ──────────────────────────────────────────────────────

class BottomNavItem {
  final BottomNavigationBarItem item;
  final String route;

  const BottomNavItem({required this.item, required this.route});
}

// ─── Role Features ──────────────────────────────────────────────────────────

class RoleFeatures {
  RoleFeatures._();

  // All available features
  static const DashboardFeature _attendance = DashboardFeature(
    id: 'attendance',
    title: 'Attendance',
    icon: Icons.fingerprint,
    route: '/attendance',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _appointments = DashboardFeature(
    id: 'appointments',
    title: 'Appointments',
    icon: Icons.calendar_month,
    route: '/appointments',
    color: Color(0xFF6A1B9A),
  );
  static const DashboardFeature _patientRecords = DashboardFeature(
    id: 'patient_records',
    title: 'Patient Records',
    icon: Icons.folder_shared,
    route: '/patient-records',
    color: Color(0xFF0277BD),
  );
  static const DashboardFeature _prescriptions = DashboardFeature(
    id: 'prescriptions',
    title: 'Prescriptions',
    icon: Icons.medication_liquid,
    route: '/prescriptions',
    color: Color(0xFF00838F),
  );
  static const DashboardFeature _pharmacyOrders = DashboardFeature(
    id: 'pharmacy_orders',
    title: 'Pharmacy',
    icon: Icons.medication,
    route: '/pharmacy',
    color: Color(0xFFE65100),
  );
  static const DashboardFeature _investigationsUpload = DashboardFeature(
    id: 'investigations_upload',
    title: 'Upload Results',
    icon: Icons.upload_file,
    route: '/investigations',
    color: Color(0xFF0097A7),
  );
  static const DashboardFeature _investigationResults = DashboardFeature(
    id: 'investigation_results',
    title: 'Lab Results',
    icon: Icons.biotech,
    route: '/investigations',
    color: Color(0xFF0097A7),
  );
  static const DashboardFeature _labBookings = DashboardFeature(
    id: 'lab_bookings',
    title: 'Lab Bookings',
    icon: Icons.science,
    route: '/lab-bookings',
    color: Color(0xFF00838F),
  );
  static const DashboardFeature _leave = DashboardFeature(
    id: 'leave',
    title: 'Leave',
    icon: Icons.event_available,
    route: '/leave',
    color: Color(0xFF00796B),
  );
  static const DashboardFeature _staffDirectory = DashboardFeature(
    id: 'staff_directory',
    title: 'Staff Directory',
    icon: Icons.people,
    route: '/staff-directory',
    color: Color(0xFF455A64),
  );
  static const DashboardFeature _hrDashboard = DashboardFeature(
    id: 'hr_dashboard',
    title: 'HR Dashboard',
    icon: Icons.analytics,
    route: '/hr-dashboard',
    color: Color(0xFF6A1B9A),
  );
  static const DashboardFeature _staffManagement = DashboardFeature(
    id: 'staff_management',
    title: 'Staff Mgmt',
    icon: Icons.manage_accounts,
    route: '/staff-management',
    color: Color(0xFF4527A0),
  );
  static const DashboardFeature _performance = DashboardFeature(
    id: 'performance',
    title: 'Performance',
    icon: Icons.star_rate,
    route: '/performance',
    color: Color(0xFFF57F17),
  );
  static const DashboardFeature _housekeepingTasks = DashboardFeature(
    id: 'housekeeping_tasks',
    title: 'My Tasks',
    icon: Icons.checklist,
    route: '/housekeeping-tasks',
    color: Color(0xFF2E7D32),
  );
  static const DashboardFeature _housekeepingHub = DashboardFeature(
    id: 'housekeeping_hub',
    title: 'Housekeeping',
    icon: Icons.cleaning_services_outlined,
    route: '/housekeeping',
    color: Color(0xFF007A64),
  );
  static const DashboardFeature _vitals = DashboardFeature(
    id: 'vitals',
    title: 'Vitals Entry',
    icon: Icons.monitor_heart,
    route: '/vitals',
    color: Color(0xFFC62828),
  );
  static const DashboardFeature _nursingNotes = DashboardFeature(
    id: 'nursing_notes',
    title: 'Nursing Notes',
    icon: Icons.edit_note,
    route: '/nursing-notes',
    color: Color(0xFF00695C),
  );
  static const DashboardFeature _queue = DashboardFeature(
    id: 'queue',
    title: 'Patient Queue',
    icon: Icons.queue,
    route: '/queue',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _appointmentQueue = DashboardFeature(
    id: 'appointment_queue',
    title: 'Appt Queue',
    icon: Icons.event_available,
    route: '/appointment-queue',
    color: Color(0xFF00796B),
  );
  static const DashboardFeature _schedule = DashboardFeature(
    id: 'schedule',
    title: 'Shift Schedule',
    icon: Icons.schedule,
    route: '/schedule',
    color: Color(0xFF00838F),
  );
  static const DashboardFeature _handover = DashboardFeature(
    id: 'handover',
    title: 'Handover',
    icon: Icons.swap_horiz,
    route: '/handover',
    color: Color(0xFF00695C),
  );
  static const DashboardFeature _profile = DashboardFeature(
    id: 'profile',
    title: 'Profile',
    icon: Icons.person,
    route: '/profile',
    color: Color(0xFF37474F),
  );
  static const DashboardFeature _settings = DashboardFeature(
    id: 'settings',
    title: 'Settings',
    icon: Icons.settings,
    route: '/settings',
    color: Color(0xFF546E7A),
  );
  static const DashboardFeature _messaging = DashboardFeature(
    id: 'messaging',
    title: 'Messages',
    icon: Icons.chat_outlined,
    route: '/messaging',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _bedBoard = DashboardFeature(
    id: 'bed_board',
    title: 'Bed Board',
    icon: Icons.local_hotel,
    route: '/beds',
    color: Color(0xFF0277BD),
  );
  static const DashboardFeature _bloodBank = DashboardFeature(
    id: 'blood_bank',
    title: 'Blood Bank',
    icon: Icons.bloodtype,
    route: '/blood-bank',
    color: Color(0xFFC62828),
  );
  static const DashboardFeature _dietary = DashboardFeature(
    id: 'dietary',
    title: 'Dietary',
    icon: Icons.restaurant_menu,
    route: '/dietary',
    color: Color(0xFF00796B),
  );

  /// Returns ordered list of dashboard features for the given role.
  static List<DashboardFeature> getFeaturesForRole(StaffRole role) {
    return switch (role) {
      StaffRole.doctor => [
          _attendance,
          _schedule,
          _queue,
          _appointments,
          _appointmentQueue,
          _patientRecords,
          _prescriptions,
          _investigationResults,
          _bedBoard,
          _bloodBank,
          _leave,
          _staffDirectory,
          _messaging,
          _profile,
          _settings,
        ],
      StaffRole.nurse => [
          _attendance,
          _schedule,
          _appointments,
          _patientRecords,
          _vitals,
          _nursingNotes,
          _handover,
          _investigationResults,
          _labBookings,
          _bedBoard,
          _bloodBank,
          _dietary,
          _leave,
          _staffDirectory,
          _messaging,
          _profile,
          _settings,
        ],
      StaffRole.hr => [
          _attendance,
          _schedule,
          _hrDashboard,
          _staffManagement,
          _performance,
          _leave,
          _staffDirectory,
          _messaging,
          _profile,
          _settings,
        ],
      StaffRole.admin || StaffRole.superAdmin => [
          _attendance,
          _schedule,
          _appointments,
          _appointmentQueue,
          _patientRecords,
          _prescriptions,
          _pharmacyOrders,
          _investigationsUpload,
          _investigationResults,
          _labBookings,
          _bedBoard,
          _bloodBank,
          _dietary,
          _leave,
          _hrDashboard,
          _staffManagement,
          _performance,
          _housekeepingTasks,
          _staffDirectory,
          _messaging,
          _profile,
          _settings,
        ],
      StaffRole.pharmacy => [
          _attendance,
          _schedule,
          _pharmacyOrders,
          _leave,
          _staffDirectory,
          _messaging,
          _profile,
          _settings,
        ],
      StaffRole.lab => [
          _attendance,
          _schedule,
          _investigationsUpload,
          _investigationResults,
          _labBookings,
          _leave,
          _staffDirectory,
          _messaging,
          _profile,
          _settings,
        ],
      StaffRole.general => [
          _attendance,
          _schedule,
          _appointmentQueue,
          _housekeepingHub,
          _housekeepingTasks,
          _leave,
          _staffDirectory,
          _messaging,
          _profile,
          _settings,
        ],
    };
  }

  /// Returns role-specific bottom nav items with their routes.
  static List<BottomNavItem> getBottomNavForRole(StaffRole role) {
    return switch (role) {
      StaffRole.doctor => [
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.dashboard_outlined),
              activeIcon: Icon(Icons.dashboard),
              label: 'Home',
            ),
            route: '/dashboard',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.queue_outlined),
              activeIcon: Icon(Icons.queue),
              label: 'Queue',
            ),
            route: '/queue',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.folder_shared_outlined),
              activeIcon: Icon(Icons.folder_shared),
              label: 'Records',
            ),
            route: '/patient-records',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.chat_outlined),
              activeIcon: Icon(Icons.chat),
              label: 'Messages',
            ),
            route: '/messaging',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.person_outlined),
              activeIcon: Icon(Icons.person),
              label: 'Profile',
            ),
            route: '/profile',
          ),
        ],
      StaffRole.nurse => [
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.dashboard_outlined),
              activeIcon: Icon(Icons.dashboard),
              label: 'Home',
            ),
            route: '/dashboard',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.calendar_month_outlined),
              activeIcon: Icon(Icons.calendar_month),
              label: 'Appointments',
            ),
            route: '/appointments',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.monitor_heart_outlined),
              activeIcon: Icon(Icons.monitor_heart),
              label: 'Vitals',
            ),
            route: '/vitals',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.chat_outlined),
              activeIcon: Icon(Icons.chat),
              label: 'Messages',
            ),
            route: '/messaging',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.person_outlined),
              activeIcon: Icon(Icons.person),
              label: 'Profile',
            ),
            route: '/profile',
          ),
        ],
      StaffRole.hr => [
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.dashboard_outlined),
              activeIcon: Icon(Icons.dashboard),
              label: 'Home',
            ),
            route: '/dashboard',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.analytics_outlined),
              activeIcon: Icon(Icons.analytics),
              label: 'HR Hub',
            ),
            route: '/hr-dashboard',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.event_available_outlined),
              activeIcon: Icon(Icons.event_available),
              label: 'Leave',
            ),
            route: '/leave',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.chat_outlined),
              activeIcon: Icon(Icons.chat),
              label: 'Messages',
            ),
            route: '/messaging',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.person_outlined),
              activeIcon: Icon(Icons.person),
              label: 'Profile',
            ),
            route: '/profile',
          ),
        ],
      StaffRole.admin || StaffRole.superAdmin => [
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.dashboard_outlined),
              activeIcon: Icon(Icons.dashboard),
              label: 'Home',
            ),
            route: '/dashboard',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.apps_outlined),
              activeIcon: Icon(Icons.apps),
              label: 'Features',
            ),
            route: '/dashboard',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.chat_outlined),
              activeIcon: Icon(Icons.chat),
              label: 'Messages',
            ),
            route: '/messaging',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.settings_outlined),
              activeIcon: Icon(Icons.settings),
              label: 'Settings',
            ),
            route: '/settings',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.person_outlined),
              activeIcon: Icon(Icons.person),
              label: 'Profile',
            ),
            route: '/profile',
          ),
        ],
      StaffRole.pharmacy => [
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.dashboard_outlined),
              activeIcon: Icon(Icons.dashboard),
              label: 'Home',
            ),
            route: '/dashboard',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.medication_outlined),
              activeIcon: Icon(Icons.medication),
              label: 'Orders',
            ),
            route: '/pharmacy',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.chat_outlined),
              activeIcon: Icon(Icons.chat),
              label: 'Messages',
            ),
            route: '/messaging',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.person_outlined),
              activeIcon: Icon(Icons.person),
              label: 'Profile',
            ),
            route: '/profile',
          ),
        ],
      StaffRole.lab => [
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.dashboard_outlined),
              activeIcon: Icon(Icons.dashboard),
              label: 'Home',
            ),
            route: '/dashboard',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.biotech_outlined),
              activeIcon: Icon(Icons.biotech),
              label: 'Investigations',
            ),
            route: '/investigations',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.chat_outlined),
              activeIcon: Icon(Icons.chat),
              label: 'Messages',
            ),
            route: '/messaging',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.person_outlined),
              activeIcon: Icon(Icons.person),
              label: 'Profile',
            ),
            route: '/profile',
          ),
        ],
      StaffRole.general => [
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.dashboard_outlined),
              activeIcon: Icon(Icons.dashboard),
              label: 'Home',
            ),
            route: '/dashboard',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.checklist_outlined),
              activeIcon: Icon(Icons.checklist),
              label: 'Tasks',
            ),
            route: '/housekeeping-tasks',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.chat_outlined),
              activeIcon: Icon(Icons.chat),
              label: 'Messages',
            ),
            route: '/messaging',
          ),
          const BottomNavItem(
            item: BottomNavigationBarItem(
              icon: Icon(Icons.person_outlined),
              activeIcon: Icon(Icons.person),
              label: 'Profile',
            ),
            route: '/profile',
          ),
        ],
    };
  }
}
