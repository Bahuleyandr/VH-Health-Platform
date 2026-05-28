import 'package:flutter/material.dart';

// ─── Staff Role Enum ────────────────────────────────────────────────────────

enum StaffRole {
  doctor('DOCTOR'),
  dutyDoctor('DUTY_DOCTOR'),
  medicalSuperintendent('MEDICAL_SUPERINTENDENT'),
  nurse('NURSING_STAFF'),
  nursingIncharge('NURSING_INCHARGE'),
  opStaffNurse('OP_STAFF_NURSE'),
  opIncharge('OP_INCHARGE'),
  hr('HR_STAFF'),
  admin('ADMIN'),
  superAdmin('SUPER_ADMIN'),
  pharmacy('PHARMACY_STAFF'),
  lab('LAB_STAFF'),
  housekeeping('HOUSEKEEPING_STAFF'),
  housekeepingIncharge('HOUSEKEEPING_INCHARGE'),
  receptionist('RECEPTIONIST'),
  receptionIncharge('RECEPTION_INCHARGE'),
  driver('DRIVER'),
  maintenance('MAINTENANCE'),
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
    StaffRole.dutyDoctor => 'Duty Doctor',
    StaffRole.medicalSuperintendent => 'Medical Superintendent',
    StaffRole.nurse => 'Nurse',
    StaffRole.nursingIncharge => 'Nursing Incharge',
    StaffRole.opStaffNurse => 'OP Staff Nurse',
    StaffRole.opIncharge => 'OP Incharge',
    StaffRole.hr => 'HR Staff',
    StaffRole.admin => 'Admin',
    StaffRole.superAdmin => 'Super Admin',
    StaffRole.pharmacy => 'Pharmacy',
    StaffRole.lab => 'Lab Technician',
    StaffRole.housekeeping => 'Housekeeping',
    StaffRole.housekeepingIncharge => 'Housekeeping Incharge',
    StaffRole.receptionist => 'Receptionist',
    StaffRole.receptionIncharge => 'Reception Incharge',
    StaffRole.driver => 'Driver',
    StaffRole.maintenance => 'Maintenance',
    StaffRole.general => 'Staff',
  };

  Color get badgeColor => switch (this) {
    StaffRole.doctor => const Color(0xFF1565C0),
    StaffRole.dutyDoctor => const Color(0xFF1565C0),
    StaffRole.medicalSuperintendent => const Color(0xFF0D47A1),
    StaffRole.nurse => const Color(0xFF00796B),
    StaffRole.nursingIncharge => const Color(0xFF00695C),
    StaffRole.opStaffNurse => const Color(0xFF00838F),
    StaffRole.opIncharge => const Color(0xFF006064),
    StaffRole.hr => const Color(0xFF6A1B9A),
    StaffRole.admin || StaffRole.superAdmin => const Color(0xFFC62828),
    StaffRole.pharmacy => const Color(0xFFE65100),
    StaffRole.lab => const Color(0xFF0097A7),
    StaffRole.housekeeping => const Color(0xFF007A64),
    StaffRole.housekeepingIncharge => const Color(0xFF00695C),
    StaffRole.receptionist => const Color(0xFF455A64),
    StaffRole.receptionIncharge => const Color(0xFF37474F),
    StaffRole.driver => const Color(0xFF5D4037),
    StaffRole.maintenance => const Color(0xFFF9A825),
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
  static const DashboardFeature _organizationHierarchy = DashboardFeature(
    id: 'organization_hierarchy',
    title: 'Hierarchy',
    icon: Icons.account_tree_outlined,
    route: '/organization-hierarchy',
    color: Color(0xFF00695C),
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
  static const DashboardFeature _housekeepingCommand = DashboardFeature(
    id: 'housekeeping_command',
    title: 'HK Command',
    icon: Icons.supervisor_account,
    route: '/housekeeping-command',
    color: Color(0xFF00695C),
  );
  static const DashboardFeature _housekeepingRoster = DashboardFeature(
    id: 'housekeeping_roster',
    title: 'Shift Roster',
    icon: Icons.calendar_month,
    route: '/staff-roster/housekeeping',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _dutyPreference = DashboardFeature(
    id: 'duty_preference',
    title: 'Duty Request',
    icon: Icons.how_to_reg,
    route: '/duty-preference',
    color: Color(0xFF00796B),
  );
  static const DashboardFeature _nursingRoster = DashboardFeature(
    id: 'nursing_roster',
    title: 'Nursing Roster',
    icon: Icons.assignment_ind,
    route: '/staff-roster/nursing',
    color: Color(0xFF00695C),
  );
  static const DashboardFeature _opNursingRoster = DashboardFeature(
    id: 'op_nursing_roster',
    title: 'OP Roster',
    icon: Icons.event_note,
    route: '/staff-roster/op_nursing',
    color: Color(0xFF00838F),
  );
  static const DashboardFeature _receptionRoster = DashboardFeature(
    id: 'reception_roster',
    title: 'Reception Roster',
    icon: Icons.support_agent,
    route: '/staff-roster/reception',
    color: Color(0xFF455A64),
  );
  static const DashboardFeature _driverRoster = DashboardFeature(
    id: 'driver_roster',
    title: 'Driver Roster',
    icon: Icons.local_shipping_outlined,
    route: '/staff-roster/ambulance',
    color: Color(0xFF5D4037),
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
  static const DashboardFeature _clinicalAiReviewQueue = DashboardFeature(
    id: 'clinical_ai_review_queue',
    title: 'AI Review',
    icon: Icons.fact_check_outlined,
    route: '/clinical-ai/queue',
    color: Color(0xFF00838F),
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
  static const DashboardFeature _dischargeHub = DashboardFeature(
    id: 'discharge_hub',
    title: 'Discharge Hub',
    icon: Icons.rule_folder,
    route: '/emr/discharge-hub',
    color: Color(0xFFD84315),
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
  static const DashboardFeature _theatre = DashboardFeature(
    id: 'theatre',
    title: 'Operating Theatre',
    icon: Icons.local_hospital,
    route: '/theatre',
    color: Color(0xFF6A1B9A),
  );
  static const DashboardFeature _radiology = DashboardFeature(
    id: 'radiology',
    title: 'Radiology',
    icon: Icons.biotech,
    route: '/radiology',
    color: Color(0xFF0277BD),
  );

  /// Returns ordered list of dashboard features for the given role.
  static List<DashboardFeature> getFeaturesForRole(StaffRole role) {
    return switch (role) {
      StaffRole.doctor || StaffRole.dutyDoctor => [
        _attendance,
        _schedule,
        _dutyPreference,
        if (role == StaffRole.dutyDoctor) _nursingRoster,
        _queue,
        _clinicalAiReviewQueue,
        _appointments,
        _appointmentQueue,
        _patientRecords,
        _prescriptions,
        _investigationResults,
        _theatre,
        _radiology,
        _bedBoard,
        _dischargeHub,
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
        _dutyPreference,
        _appointments,
        _appointmentQueue,
        _clinicalAiReviewQueue,
        _patientRecords,
        _pharmacyOrders,
        _vitals,
        _nursingNotes,
        _handover,
        _investigationResults,
        _labBookings,
        _theatre,
        _radiology,
        _bedBoard,
        _dischargeHub,
        _bloodBank,
        _dietary,
        _leave,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.nursingIncharge => [
        _attendance,
        _schedule,
        _dutyPreference,
        _nursingRoster,
        _opNursingRoster,
        _appointments,
        _appointmentQueue,
        _clinicalAiReviewQueue,
        _patientRecords,
        _vitals,
        _nursingNotes,
        _handover,
        _bedBoard,
        _dischargeHub,
        _leave,
        _organizationHierarchy,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.opStaffNurse => [
        _attendance,
        _schedule,
        _dutyPreference,
        _appointments,
        _appointmentQueue,
        _patientRecords,
        _vitals,
        _leave,
        _organizationHierarchy,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.opIncharge => [
        _attendance,
        _schedule,
        _dutyPreference,
        _opNursingRoster,
        _appointments,
        _appointmentQueue,
        _patientRecords,
        _vitals,
        _leave,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.hr => [
        _attendance,
        _schedule,
        _nursingRoster,
        _opNursingRoster,
        _receptionRoster,
        _driverRoster,
        _housekeepingRoster,
        _hrDashboard,
        _staffManagement,
        _organizationHierarchy,
        _performance,
        _leave,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.medicalSuperintendent => [
        _attendance,
        _schedule,
        _nursingRoster,
        _opNursingRoster,
        _receptionRoster,
        _driverRoster,
        _appointments,
        _appointmentQueue,
        _clinicalAiReviewQueue,
        _patientRecords,
        _prescriptions,
        _pharmacyOrders,
        _investigationsUpload,
        _investigationResults,
        _labBookings,
        _theatre,
        _radiology,
        _bedBoard,
        _dischargeHub,
        _bloodBank,
        _dietary,
        _leave,
        _hrDashboard,
        _staffManagement,
        _organizationHierarchy,
        _performance,
        _housekeepingRoster,
        _housekeepingCommand,
        _housekeepingHub,
        _housekeepingTasks,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.pharmacy => [
        _attendance,
        _schedule,
        _dutyPreference,
        _pharmacyOrders,
        _dischargeHub,
        _clinicalAiReviewQueue,
        _leave,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.lab => [
        _attendance,
        _schedule,
        _dutyPreference,
        _investigationsUpload,
        _investigationResults,
        _labBookings,
        _leave,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.housekeeping => [
        _schedule,
        _dutyPreference,
        _bedBoard,
        _housekeepingHub,
        _housekeepingTasks,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.housekeepingIncharge => [
        _schedule,
        _dutyPreference,
        _bedBoard,
        _housekeepingRoster,
        _housekeepingCommand,
        _housekeepingHub,
        _housekeepingTasks,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.receptionist => [
        _attendance,
        _schedule,
        _dutyPreference,
        _appointments,
        _appointmentQueue,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.receptionIncharge => [
        _attendance,
        _schedule,
        _dutyPreference,
        _receptionRoster,
        _appointments,
        _appointmentQueue,
        _organizationHierarchy,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.driver => [
        _schedule,
        _dutyPreference,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.maintenance => [
        _schedule,
        _dutyPreference,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.general => [
        _attendance,
        _schedule,
        _dutyPreference,
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
      StaffRole.doctor || StaffRole.dutyDoctor => [
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
      StaffRole.nurse ||
      StaffRole.nursingIncharge ||
      StaffRole.opStaffNurse ||
      StaffRole.opIncharge => [
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
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.medicalSuperintendent => [
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
      StaffRole.housekeeping => [
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
            icon: Icon(Icons.local_hotel_outlined),
            activeIcon: Icon(Icons.local_hotel),
            label: 'Beds',
          ),
          route: '/beds',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.cleaning_services_outlined),
            activeIcon: Icon(Icons.cleaning_services),
            label: 'Cleaning',
          ),
          route: '/housekeeping',
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
      StaffRole.housekeepingIncharge => [
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
            icon: Icon(Icons.local_hotel_outlined),
            activeIcon: Icon(Icons.local_hotel),
            label: 'Beds',
          ),
          route: '/beds',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.supervisor_account_outlined),
            activeIcon: Icon(Icons.supervisor_account),
            label: 'Command',
          ),
          route: '/housekeeping-command',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.cleaning_services_outlined),
            activeIcon: Icon(Icons.cleaning_services),
            label: 'Cleaning',
          ),
          route: '/housekeeping',
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
      StaffRole.receptionist ||
      StaffRole.receptionIncharge ||
      StaffRole.driver ||
      StaffRole.maintenance => [
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
            icon: Icon(Icons.build_outlined),
            activeIcon: Icon(Icons.build),
            label: 'Work',
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
