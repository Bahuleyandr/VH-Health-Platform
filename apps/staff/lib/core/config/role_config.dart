import 'package:flutter/material.dart';

// ─── Staff Role Enum ────────────────────────────────────────────────────────

enum StaffRole {
  doctor('DOCTOR'),
  dutyDoctor('DUTY_DOCTOR'),
  medicalSuperintendent('MEDICAL_SUPERINTENDENT'),
  nursingSuperintendent('CNO'),
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
  billingStaff('BILLING_STAFF'),
  billingIncharge('BILLING_INCHARGE'),
  financeIncharge('FINANCE_INCHARGE'),
  admissionOfficer('ADMISSION_OFFICER'),
  insuranceCoordinator('INSURANCE_COORDINATOR'),
  ipdCounsellor('IPD_COUNSELLOR'),
  driver('DRIVER'),
  maintenance('MAINTENANCE'),
  general('GENERAL_STAFF');

  final String value;
  const StaffRole(this.value);

  static StaffRole fromString(String role) {
    final normalized = role.trim().toUpperCase();
    if (const {
      'CONSULTANT',
      'CONSULTANT_PHYSICIAN',
      'JUNIOR_DOCTOR',
      'SENIOR_DOCTOR',
      'RESIDENT',
    }.contains(normalized)) {
      return StaffRole.doctor;
    }
    if (const {
      'DMO',
      'DUTY_MEDICAL_OFFICER',
      'FLOOR_DOCTOR',
    }.contains(normalized)) {
      return StaffRole.dutyDoctor;
    }
    if (const {
      'ICU_NURSE',
      'NURSE',
      'OT_NURSE',
      'REGISTERED_NURSE',
      'STAFF_NURSE',
      'WARD_NURSE',
    }.contains(normalized)) {
      return StaffRole.nurse;
    }
    if (const {
      'CHIEF_NURSING_OFFICER',
      'NURSING_SUPERINTENDENT',
    }.contains(normalized)) {
      return StaffRole.nursingSuperintendent;
    }
    if (const {
      'CHIEF_MEDICAL_OFFICER',
      'CMO',
      'MEDICAL_SUPERINTENDANT',
      'MEDICAL_SUPERINTENDENT_ROLE',
    }.contains(normalized)) {
      return StaffRole.medicalSuperintendent;
    }
    if (const {
      'NURSING_IN_CHARGE',
      'NURSING_INCHARGE_ROLE',
      'NURSING_SUPERVISOR',
      'WARD_NURSING_INCHARGE',
    }.contains(normalized)) {
      return StaffRole.nursingIncharge;
    }
    if (const {'HOUSEKEEPING', 'HOUSEKEEPING_ATTENDANT'}.contains(normalized)) {
      return StaffRole.housekeeping;
    }
    return StaffRole.values.firstWhere(
      (r) => r.value == normalized,
      orElse: () => StaffRole.general,
    );
  }

  String get displayName => switch (this) {
    StaffRole.doctor => 'Doctor',
    StaffRole.dutyDoctor => 'Duty Doctor',
    StaffRole.medicalSuperintendent => 'Medical Superintendent',
    StaffRole.nursingSuperintendent => 'Nursing Superintendent',
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
    StaffRole.billingStaff => 'Billing Staff',
    StaffRole.billingIncharge => 'Billing Incharge',
    StaffRole.financeIncharge => 'Finance Incharge',
    StaffRole.admissionOfficer => 'Admission Officer',
    StaffRole.insuranceCoordinator => 'Insurance Coordinator',
    StaffRole.ipdCounsellor => 'IPD Counsellor',
    StaffRole.driver => 'Driver',
    StaffRole.maintenance => 'Maintenance',
    StaffRole.general => 'Staff',
  };

  Color get badgeColor => switch (this) {
    StaffRole.doctor => const Color(0xFF1565C0),
    StaffRole.dutyDoctor => const Color(0xFF1565C0),
    StaffRole.medicalSuperintendent => const Color(0xFF0D47A1),
    StaffRole.nursingSuperintendent => const Color(0xFF004D40),
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
    StaffRole.billingStaff ||
    StaffRole.billingIncharge ||
    StaffRole.financeIncharge => const Color(0xFF1565C0),
    StaffRole.admissionOfficer ||
    StaffRole.insuranceCoordinator ||
    StaffRole.ipdCounsellor => const Color(0xFF6A1B9A),
    StaffRole.driver => const Color(0xFF5D4037),
    StaffRole.maintenance => const Color(0xFFF9A825),
    StaffRole.general => const Color(0xFF37474F),
  };

  /// Whether this role has admin-level access (ADMIN or SUPER_ADMIN)
  bool get isAdminTier =>
      this == StaffRole.admin || this == StaffRole.superAdmin;

  String? get rosterDepartment => switch (this) {
    StaffRole.doctor ||
    StaffRole.dutyDoctor ||
    StaffRole.medicalSuperintendent => 'medical',
    StaffRole.nurse ||
    StaffRole.nursingIncharge ||
    StaffRole.nursingSuperintendent => 'nursing',
    StaffRole.opStaffNurse || StaffRole.opIncharge => 'op_nursing',
    StaffRole.pharmacy => 'pharmacy',
    StaffRole.housekeeping || StaffRole.housekeepingIncharge => 'housekeeping',
    StaffRole.receptionist ||
    StaffRole.receptionIncharge ||
    StaffRole.admissionOfficer ||
    StaffRole.insuranceCoordinator ||
    StaffRole.ipdCounsellor => 'reception',
    StaffRole.billingStaff ||
    StaffRole.billingIncharge ||
    StaffRole.financeIncharge => 'billing',
    StaffRole.driver => 'ambulance',
    StaffRole.maintenance => 'maintenance',
    StaffRole.hr ||
    StaffRole.admin ||
    StaffRole.superAdmin ||
    StaffRole.lab ||
    StaffRole.general => null,
  };

  String get rosterDepartmentLabel => switch (rosterDepartment) {
    'medical' => 'Duty Doctors',
    'nursing' => 'Nursing',
    'op_nursing' => 'OP Staff Nursing',
    'pharmacy' => 'Pharmacy',
    'housekeeping' => 'Housekeeping',
    'reception' => 'Reception',
    'billing' => 'Billing',
    'ambulance' => 'Ambulance / Drivers',
    'maintenance' => 'Maintenance',
    _ => 'Not configured',
  };
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

class WorkbenchNavItem {
  final String label;
  final IconData icon;
  final IconData selectedIcon;
  final String route;

  const WorkbenchNavItem({
    required this.label,
    required this.icon,
    required this.selectedIcon,
    required this.route,
  });
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
  static const DashboardFeature _admissions = DashboardFeature(
    id: 'admissions',
    title: 'IP Admissions',
    icon: Icons.local_hospital,
    route: '/emr/admissions',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _frontOfficeWorkbench = DashboardFeature(
    id: 'front_office_workbench',
    title: 'Front Office',
    icon: Icons.space_dashboard_outlined,
    route: '/front-office',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _billingDesk = DashboardFeature(
    id: 'billing_desk',
    title: 'Billing Desk',
    icon: Icons.receipt_long,
    route: '/billing-desk',
    color: Color(0xFF1565C0),
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
  static const DashboardFeature _leaveApprovals = DashboardFeature(
    id: 'leave_approvals',
    title: 'Leave Approvals',
    icon: Icons.fact_check_outlined,
    route: '/leave-approvals',
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
  static const DashboardFeature _maintenanceRoster = DashboardFeature(
    id: 'maintenance_roster',
    title: 'Maintenance Roster',
    icon: Icons.engineering_outlined,
    route: '/staff-roster/maintenance',
    color: Color(0xFFF9A825),
  );
  static const DashboardFeature _pharmacyRoster = DashboardFeature(
    id: 'pharmacy_roster',
    title: 'Pharmacy Roster',
    icon: Icons.local_pharmacy_outlined,
    route: '/staff-roster/pharmacy',
    color: Color(0xFFE65100),
  );
  static const DashboardFeature _medicalRoster = DashboardFeature(
    id: 'medical_roster',
    title: 'Doctor Roster',
    icon: Icons.medical_services_outlined,
    route: '/staff-roster/medical',
    color: Color(0xFF0D47A1),
  );
  static const DashboardFeature _staffRosterHub = DashboardFeature(
    id: 'staff_roster',
    title: 'Staff Roster',
    icon: Icons.calendar_month_outlined,
    route: '/staff-rosters',
    color: Color(0xFF1565C0),
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
  static const DashboardFeature _opAiAssist = DashboardFeature(
    id: 'op_ai_assist',
    title: 'OP AI Assist',
    icon: Icons.auto_awesome,
    route: '/op-ai-assist',
    color: Color(0xFF5E35B1),
  );
  static const DashboardFeature _schedule = DashboardFeature(
    id: 'schedule',
    title: 'My Roster',
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
  static const DashboardFeature _patientCommandBoard = DashboardFeature(
    id: 'patient_command_board',
    title: 'Command Board',
    icon: Icons.view_timeline_outlined,
    route: '/patient-command-board',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _wardMode = DashboardFeature(
    id: 'ward_mode',
    title: 'Ward Mode',
    icon: Icons.local_hospital_outlined,
    route: '/ward-mode',
    color: Color(0xFF00796B),
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
        _frontOfficeWorkbench,
        _queue,
        _clinicalAiReviewQueue,
        _opAiAssist,
        _appointments,
        _patientRecords,
        _prescriptions,
        _investigationResults,
        _theatre,
        _radiology,
        _patientCommandBoard,
        _bedBoard,
        _wardMode,
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
        _frontOfficeWorkbench,
        _appointments,
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
        _patientCommandBoard,
        _bedBoard,
        _wardMode,
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
        _frontOfficeWorkbench,
        _appointments,
        _clinicalAiReviewQueue,
        _patientRecords,
        _vitals,
        _nursingNotes,
        _handover,
        _patientCommandBoard,
        _bedBoard,
        _wardMode,
        _dischargeHub,
        _leave,
        _organizationHierarchy,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.nursingSuperintendent => [
        _attendance,
        _schedule,
        _dutyPreference,
        _nursingRoster,
        _opNursingRoster,
        _frontOfficeWorkbench,
        _appointments,
        _clinicalAiReviewQueue,
        _patientRecords,
        _vitals,
        _nursingNotes,
        _handover,
        _patientCommandBoard,
        _bedBoard,
        _wardMode,
        _dischargeHub,
        _leave,
        _organizationHierarchy,
        _performance,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.opStaffNurse => [
        _attendance,
        _schedule,
        _dutyPreference,
        _frontOfficeWorkbench,
        _appointments,
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
        _frontOfficeWorkbench,
        _appointments,
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
        _staffRosterHub,
        _hrDashboard,
        _staffManagement,
        _organizationHierarchy,
        _performance,
        _leaveApprovals,
        _leave,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.medicalSuperintendent => [
        _attendance,
        _schedule,
        _medicalRoster,
        _nursingRoster,
        _opNursingRoster,
        _frontOfficeWorkbench,
        _appointments,
        _clinicalAiReviewQueue,
        _opAiAssist,
        _patientRecords,
        _prescriptions,
        _investigationResults,
        _labBookings,
        _theatre,
        _radiology,
        _patientCommandBoard,
        _bedBoard,
        _wardMode,
        _dischargeHub,
        _bloodBank,
        _dietary,
        _leave,
        _organizationHierarchy,
        _performance,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.admin || StaffRole.superAdmin => [
        _attendance,
        _schedule,
        _staffRosterHub,
        _frontOfficeWorkbench,
        _billingDesk,
        _appointments,
        _clinicalAiReviewQueue,
        _opAiAssist,
        _patientRecords,
        _prescriptions,
        _pharmacyOrders,
        _investigationsUpload,
        _investigationResults,
        _labBookings,
        _theatre,
        _radiology,
        _patientCommandBoard,
        _bedBoard,
        _wardMode,
        _dischargeHub,
        _bloodBank,
        _dietary,
        _leave,
        _hrDashboard,
        _staffManagement,
        _organizationHierarchy,
        _performance,
        _leaveApprovals,
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
        _pharmacyRoster,
        _pharmacyOrders,
        _patientCommandBoard,
        _bedBoard,
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
        _frontOfficeWorkbench,
        _billingDesk,
        _appointments,
        _admissions,
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
        _frontOfficeWorkbench,
        _billingDesk,
        _appointments,
        _admissions,
        _organizationHierarchy,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.billingStaff ||
      StaffRole.billingIncharge ||
      StaffRole.financeIncharge => [
        _schedule,
        _frontOfficeWorkbench,
        _billingDesk,
        _appointments,
        _admissions,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.admissionOfficer ||
      StaffRole.insuranceCoordinator ||
      StaffRole.ipdCounsellor => [
        _schedule,
        _frontOfficeWorkbench,
        _billingDesk,
        _appointments,
        _admissions,
        _patientRecords,
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
        _maintenanceRoster,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.general => [
        _attendance,
        _schedule,
        _dutyPreference,
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
      StaffRole.nursingSuperintendent ||
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
            icon: Icon(Icons.schedule_outlined),
            activeIcon: Icon(Icons.schedule),
            label: 'My Roster',
          ),
          route: '/schedule',
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
            icon: Icon(Icons.schedule_outlined),
            activeIcon: Icon(Icons.schedule),
            label: 'My Roster',
          ),
          route: '/schedule',
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
      StaffRole.receptionist || StaffRole.receptionIncharge => [
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
            icon: Icon(Icons.space_dashboard_outlined),
            activeIcon: Icon(Icons.space_dashboard),
            label: 'Front Desk',
          ),
          route: '/front-office',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.schedule_outlined),
            activeIcon: Icon(Icons.schedule),
            label: 'My Roster',
          ),
          route: '/schedule',
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
      StaffRole.billingStaff ||
      StaffRole.billingIncharge ||
      StaffRole.financeIncharge => [
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
            icon: Icon(Icons.receipt_long_outlined),
            activeIcon: Icon(Icons.receipt_long),
            label: 'Billing',
          ),
          route: '/billing-desk',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.space_dashboard_outlined),
            activeIcon: Icon(Icons.space_dashboard),
            label: 'Front Desk',
          ),
          route: '/front-office',
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
      StaffRole.admissionOfficer ||
      StaffRole.insuranceCoordinator ||
      StaffRole.ipdCounsellor => [
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
            icon: Icon(Icons.space_dashboard_outlined),
            activeIcon: Icon(Icons.space_dashboard),
            label: 'Front Desk',
          ),
          route: '/front-office',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.local_hospital_outlined),
            activeIcon: Icon(Icons.local_hospital),
            label: 'Admissions',
          ),
          route: '/emr/admissions',
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
      StaffRole.driver || StaffRole.maintenance => [
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

  static List<BottomNavItem> getPhoneSelfServiceNavForRole(StaffRole _) {
    return const [
      BottomNavItem(
        item: BottomNavigationBarItem(
          icon: Icon(Icons.dashboard_outlined),
          activeIcon: Icon(Icons.dashboard),
          label: 'Home',
        ),
        route: '/dashboard',
      ),
      BottomNavItem(
        item: BottomNavigationBarItem(
          icon: Icon(Icons.fingerprint_outlined),
          activeIcon: Icon(Icons.fingerprint),
          label: 'Attendance',
        ),
        route: '/attendance',
      ),
      BottomNavItem(
        item: BottomNavigationBarItem(
          icon: Icon(Icons.schedule_outlined),
          activeIcon: Icon(Icons.schedule),
          label: 'Roster',
        ),
        route: '/schedule',
      ),
      BottomNavItem(
        item: BottomNavigationBarItem(
          icon: Icon(Icons.event_available_outlined),
          activeIcon: Icon(Icons.event_available),
          label: 'Leave',
        ),
        route: '/leave',
      ),
      BottomNavItem(
        item: BottomNavigationBarItem(
          icon: Icon(Icons.person_outlined),
          activeIcon: Icon(Icons.person),
          label: 'Profile',
        ),
        route: '/profile',
      ),
    ];
  }

  static bool hasFrontOfficeWorkbench(StaffRole role) {
    return switch (role) {
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.medicalSuperintendent ||
      StaffRole.doctor ||
      StaffRole.dutyDoctor ||
      StaffRole.nurse ||
      StaffRole.nursingIncharge ||
      StaffRole.nursingSuperintendent ||
      StaffRole.opStaffNurse ||
      StaffRole.opIncharge ||
      StaffRole.receptionist ||
      StaffRole.receptionIncharge ||
      StaffRole.billingStaff ||
      StaffRole.billingIncharge ||
      StaffRole.financeIncharge ||
      StaffRole.admissionOfficer ||
      StaffRole.insuranceCoordinator ||
      StaffRole.ipdCounsellor => true,
      _ => false,
    };
  }

  static bool hasBillingDesk(StaffRole role) {
    return switch (role) {
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.receptionist ||
      StaffRole.receptionIncharge ||
      StaffRole.billingStaff ||
      StaffRole.billingIncharge ||
      StaffRole.financeIncharge ||
      StaffRole.admissionOfficer ||
      StaffRole.insuranceCoordinator ||
      StaffRole.ipdCounsellor => true,
      _ => false,
    };
  }

  static bool hasClinicalEntry(StaffRole role) {
    return switch (role) {
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.medicalSuperintendent ||
      StaffRole.doctor ||
      StaffRole.dutyDoctor ||
      StaffRole.nurse ||
      StaffRole.nursingIncharge ||
      StaffRole.nursingSuperintendent ||
      StaffRole.opStaffNurse ||
      StaffRole.opIncharge => true,
      _ => false,
    };
  }

  static bool hasPatientLookup(StaffRole role) {
    return switch (role) {
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.medicalSuperintendent ||
      StaffRole.nursingSuperintendent ||
      StaffRole.doctor ||
      StaffRole.dutyDoctor ||
      StaffRole.nurse ||
      StaffRole.nursingIncharge ||
      StaffRole.opStaffNurse ||
      StaffRole.opIncharge ||
      StaffRole.receptionist ||
      StaffRole.receptionIncharge ||
      StaffRole.billingStaff ||
      StaffRole.billingIncharge ||
      StaffRole.financeIncharge ||
      StaffRole.admissionOfficer ||
      StaffRole.insuranceCoordinator ||
      StaffRole.ipdCounsellor => true,
      _ => false,
    };
  }

  static bool hasPatientRegistryWrite(StaffRole role) {
    return switch (role) {
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.receptionist ||
      StaffRole.receptionIncharge ||
      StaffRole.billingStaff ||
      StaffRole.billingIncharge ||
      StaffRole.financeIncharge ||
      StaffRole.admissionOfficer ||
      StaffRole.insuranceCoordinator ||
      StaffRole.ipdCounsellor => true,
      _ => false,
    };
  }

  static List<WorkbenchNavItem> getWorkbenchNavForRole(StaffRole role) {
    final items = <WorkbenchNavItem>[
      const WorkbenchNavItem(
        label: 'Home',
        icon: Icons.dashboard_outlined,
        selectedIcon: Icons.dashboard,
        route: '/dashboard',
      ),
    ];

    if (hasFrontOfficeWorkbench(role)) {
      items.add(
        const WorkbenchNavItem(
          label: 'Front Office',
          icon: Icons.space_dashboard_outlined,
          selectedIcon: Icons.space_dashboard,
          route: '/front-office',
        ),
      );
      items.add(
        const WorkbenchNavItem(
          label: 'Admissions',
          icon: Icons.local_hospital_outlined,
          selectedIcon: Icons.local_hospital,
          route: '/emr/admissions',
        ),
      );
    }

    if (hasBillingDesk(role)) {
      items.add(
        const WorkbenchNavItem(
          label: 'Billing',
          icon: Icons.receipt_long_outlined,
          selectedIcon: Icons.receipt_long,
          route: '/billing-desk',
        ),
      );
    }

    if (hasClinicalEntry(role)) {
      items.add(
        const WorkbenchNavItem(
          label: 'Patients',
          icon: Icons.folder_shared_outlined,
          selectedIcon: Icons.folder_shared,
          route: '/patient-records',
        ),
      );
    }

    if (role == StaffRole.housekeeping ||
        role == StaffRole.housekeepingIncharge) {
      items.addAll(const [
        WorkbenchNavItem(
          label: 'Beds',
          icon: Icons.local_hotel_outlined,
          selectedIcon: Icons.local_hotel,
          route: '/beds',
        ),
        WorkbenchNavItem(
          label: 'Housekeeping',
          icon: Icons.cleaning_services_outlined,
          selectedIcon: Icons.cleaning_services,
          route: '/housekeeping',
        ),
      ]);
    }

    items.addAll(const [
      WorkbenchNavItem(
        label: 'Roster',
        icon: Icons.schedule_outlined,
        selectedIcon: Icons.schedule,
        route: '/schedule',
      ),
      WorkbenchNavItem(
        label: 'Messages',
        icon: Icons.chat_outlined,
        selectedIcon: Icons.chat,
        route: '/messaging',
      ),
      WorkbenchNavItem(
        label: 'Profile',
        icon: Icons.person_outlined,
        selectedIcon: Icons.person,
        route: '/profile',
      ),
    ]);

    return items;
  }
}
