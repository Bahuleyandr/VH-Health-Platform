import 'package:flutter/material.dart';

// ─── Staff Role Enum ────────────────────────────────────────────────────────

enum StaffRole {
  doctor('DOCTOR'),
  dutyDoctor('DUTY_DOCTOR'),
  anaesthetist('ANESTHETIST'),
  medicalSuperintendent('MEDICAL_SUPERINTENDENT'),
  nursingSuperintendent('CNO'),
  nurse('NURSING_STAFF'),
  nursingIncharge('NURSING_INCHARGE'),
  opStaffNurse('OP_STAFF_NURSE'),
  opIncharge('OP_INCHARGE'),
  ipStaffNurse('IP_STAFF_NURSE'),
  ipIncharge('IP_INCHARGE'),
  otNurse('OT_NURSE'),
  otIncharge('OT_INCHARGE'),
  cathLabStaff('CATH_LAB_STAFF'),
  cathLabIncharge('CATH_LAB_INCHARGE'),
  hr('HR_STAFF'),
  admin('ADMIN'),
  superAdmin('SUPER_ADMIN'),
  pharmacy('PHARMACY_STAFF'),
  pharmacyIncharge('PHARMACY_INCHARGE'),
  storesPurchaseIncharge('STORES_PURCHASE_INCHARGE'),
  lab('LAB_STAFF'),
  radiologyStaff('RADIOLOGY_STAFF'),
  physiotherapist('PHYSIOTHERAPIST'),
  biomedicalStaff('BIOMEDICAL_STAFF'),
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
  security('SECURITY'),
  emergencyResponder('EMERGENCY_RESPONDER'),
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
      'ANAESTHETIST',
      'ANESTHESIOLOGIST',
      'ANAESTHESIOLOGIST',
      'ANESTHETIST',
    }.contains(normalized)) {
      return StaffRole.anaesthetist;
    }
    if (const {
      'RADIOLOGIST',
      'RADIOLOGY',
      'RADIOLOGY_TECHNICIAN',
    }.contains(normalized)) {
      return StaffRole.radiologyStaff;
    }
    if (const {
      'PHYSIO',
      'PHYSIOTHERAPY',
      'PHYSIOTHERAPIST',
      'PHYSICAL_THERAPIST',
      'REHAB_THERAPIST',
    }.contains(normalized)) {
      return StaffRole.physiotherapist;
    }
    if (const {
      'BIOMED',
      'BIOMEDICAL',
      'BIOMEDICAL_ENGINEER',
      'BIOMEDICAL_TECHNICIAN',
      'BIOMEDICAL_TECH',
      'BIOMED_TECHNICIAN',
      'BIOMED_TECH',
    }.contains(normalized)) {
      return StaffRole.biomedicalStaff;
    }
    if (const {
      'DMO',
      'DUTY_MEDICAL_OFFICER',
      'FLOOR_DOCTOR',
    }.contains(normalized)) {
      return StaffRole.dutyDoctor;
    }
    if (const {
      'NURSE',
      'REGISTERED_NURSE',
      'STAFF_NURSE',
    }.contains(normalized)) {
      return StaffRole.nurse;
    }
    if (const {
      'ICU_NURSE',
      'IP_NURSE',
      'IP_STAFF',
      'IPD_NURSE',
      'IPD_STAFF_NURSE',
      'WARD_NURSE',
    }.contains(normalized)) {
      return StaffRole.ipStaffNurse;
    }
    if (const {
      'IPD_INCHARGE',
      'IP_NURSING_INCHARGE',
      'WARD_NURSING_INCHARGE',
    }.contains(normalized)) {
      return StaffRole.ipIncharge;
    }
    if (const {
      'OT_IN_CHARGE',
      'OT_NURSING_INCHARGE',
      'THEATRE_INCHARGE',
      'THEATRE_NURSING_INCHARGE',
    }.contains(normalized)) {
      return StaffRole.otIncharge;
    }
    if (const {
      'OT_NURSE',
      'OT_STAFF',
      'THEATRE_NURSE',
      'THEATRE_STAFF',
    }.contains(normalized)) {
      return StaffRole.otNurse;
    }
    if (const {
      'CATHLAB_NURSE',
      'CATHLAB_STAFF',
      'CATH_LAB_NURSE',
      'CATH_LAB_TECH',
      'CATH_LAB_TECHNICIAN',
    }.contains(normalized)) {
      return StaffRole.cathLabStaff;
    }
    if (const {'CATHLAB_INCHARGE', 'CATH_LAB_IN_CHARGE'}.contains(normalized)) {
      return StaffRole.cathLabIncharge;
    }
    if (const {
      'PHARMACY_IN_CHARGE',
      'PHARMACY_SUPERVISOR',
      'PHARMACIST_INCHARGE',
    }.contains(normalized)) {
      return StaffRole.pharmacyIncharge;
    }
    if (const {
      'STORES_INCHARGE',
      'STORE_INCHARGE',
      'PURCHASE_INCHARGE',
      'PURCHASE_MANAGER',
      'MATERIALS_INCHARGE',
      'MATERIALS_MANAGER',
      'INVENTORY_INCHARGE',
    }.contains(normalized)) {
      return StaffRole.storesPurchaseIncharge;
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

  String get displayNameKey => 'role.display.${value.toLowerCase()}';

  Color get badgeColor => switch (this) {
    StaffRole.doctor => const Color(0xFF1565C0),
    StaffRole.dutyDoctor => const Color(0xFF1565C0),
    StaffRole.anaesthetist => const Color(0xFF1565C0),
    StaffRole.medicalSuperintendent => const Color(0xFF0D47A1),
    StaffRole.nursingSuperintendent => const Color(0xFF004D40),
    StaffRole.nurse => const Color(0xFF00796B),
    StaffRole.nursingIncharge => const Color(0xFF00695C),
    StaffRole.opStaffNurse => const Color(0xFF00838F),
    StaffRole.opIncharge => const Color(0xFF006064),
    StaffRole.ipStaffNurse => const Color(0xFF00796B),
    StaffRole.ipIncharge => const Color(0xFF004D40),
    StaffRole.otNurse => const Color(0xFF6A1B9A),
    StaffRole.otIncharge => const Color(0xFF4A148C),
    StaffRole.cathLabStaff => const Color(0xFFAD1457),
    StaffRole.cathLabIncharge => const Color(0xFF880E4F),
    StaffRole.hr => const Color(0xFF6A1B9A),
    StaffRole.admin || StaffRole.superAdmin => const Color(0xFFC62828),
    StaffRole.pharmacy => const Color(0xFFE65100),
    StaffRole.pharmacyIncharge => const Color(0xFFBF360C),
    StaffRole.storesPurchaseIncharge => const Color(0xFF7C2D12),
    StaffRole.lab => const Color(0xFF0097A7),
    StaffRole.radiologyStaff => const Color(0xFF0277BD),
    StaffRole.physiotherapist => const Color(0xFF2E7D32),
    StaffRole.biomedicalStaff => const Color(0xFF1565C0),
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
    StaffRole.security => const Color(0xFF455A64),
    StaffRole.emergencyResponder => const Color(0xFFC62828),
    StaffRole.maintenance => const Color(0xFFF9A825),
    StaffRole.general => const Color(0xFF37474F),
  };

  /// Whether this role has admin-level access (ADMIN or SUPER_ADMIN)
  bool get isAdminTier =>
      this == StaffRole.admin || this == StaffRole.superAdmin;

  String? get rosterDepartment => switch (this) {
    StaffRole.doctor ||
    StaffRole.dutyDoctor ||
    StaffRole.anaesthetist ||
    StaffRole.medicalSuperintendent => 'medical',
    StaffRole.nurse ||
    StaffRole.nursingIncharge ||
    StaffRole.nursingSuperintendent ||
    StaffRole.ipStaffNurse ||
    StaffRole.ipIncharge => 'nursing',
    StaffRole.opStaffNurse || StaffRole.opIncharge => 'op_nursing',
    StaffRole.otNurse || StaffRole.otIncharge => 'ot_nursing',
    StaffRole.cathLabStaff || StaffRole.cathLabIncharge => 'cath_lab',
    StaffRole.pharmacy || StaffRole.pharmacyIncharge => 'pharmacy',
    StaffRole.storesPurchaseIncharge => 'stores_purchase',
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
    StaffRole.maintenance || StaffRole.biomedicalStaff => 'maintenance',
    StaffRole.emergencyResponder => 'ambulance',
    StaffRole.hr ||
    StaffRole.admin ||
    StaffRole.superAdmin ||
    StaffRole.lab ||
    StaffRole.radiologyStaff ||
    StaffRole.security ||
    StaffRole.general => null,
    StaffRole.physiotherapist => 'physiotherapy',
  };

  String get rosterDepartmentLabelKey =>
      rosterDepartmentLabelKeyFor(rosterDepartment);

  static String rosterDepartmentLabelKeyFor(String? department) =>
      switch (department) {
        'medical' => 'role.roster_department.medical',
        'nursing' => 'role.roster_department.nursing',
        'op_nursing' => 'role.roster_department.op_nursing',
        'ot_nursing' => 'role.roster_department.ot_nursing',
        'cath_lab' => 'role.roster_department.cath_lab',
        'pharmacy' => 'role.roster_department.pharmacy',
        'stores_purchase' => 'role.roster_department.stores_purchase',
        'housekeeping' => 'role.roster_department.housekeeping',
        'reception' => 'role.roster_department.reception',
        'billing' => 'role.roster_department.billing',
        'ambulance' => 'role.roster_department.ambulance',
        'maintenance' => 'role.roster_department.maintenance',
        'physiotherapy' => 'role.roster_department.physiotherapy',
        _ => 'role.roster_department.not_configured',
      };
}

// ─── Dashboard Feature ──────────────────────────────────────────────────────

class DashboardFeature {
  final String id;
  final String titleKey;
  final IconData icon;
  final String route;
  final Color color;

  const DashboardFeature({
    required this.id,
    required this.titleKey,
    required this.icon,
    required this.route,
    required this.color,
  });
}

// ─── Bottom Nav Config ──────────────────────────────────────────────────────

class BottomNavItem {
  final BottomNavigationBarItem item;
  final String labelKey;
  final String route;

  const BottomNavItem({
    required this.item,
    required this.labelKey,
    required this.route,
  });
}

class WorkbenchNavItem {
  final String labelKey;
  final IconData icon;
  final IconData selectedIcon;
  final String route;
  final String? featureId;

  const WorkbenchNavItem({
    required this.labelKey,
    required this.icon,
    required this.selectedIcon,
    required this.route,
    this.featureId,
  });
}

// ─── Role Features ──────────────────────────────────────────────────────────

class RoleFeatures {
  RoleFeatures._();

  // All available features
  static const DashboardFeature _attendance = DashboardFeature(
    id: 'attendance',
    titleKey: 'role.feature.attendance',
    icon: Icons.fingerprint,
    route: '/attendance',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _appointments = DashboardFeature(
    id: 'appointments',
    titleKey: 'role.feature.appointments',
    icon: Icons.calendar_month,
    route: '/appointments',
    color: Color(0xFF6A1B9A),
  );
  static const DashboardFeature _admissions = DashboardFeature(
    id: 'admissions',
    titleKey: 'role.feature.admissions',
    icon: Icons.local_hospital,
    route: '/emr/admissions',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _frontOfficeWorkbench = DashboardFeature(
    id: 'front_office_workbench',
    titleKey: 'role.feature.front_office_workbench',
    icon: Icons.space_dashboard_outlined,
    route: '/front-office',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _edTraumaWorkbench = DashboardFeature(
    id: 'ed_trauma_workbench',
    titleKey: 'role.feature.ed_trauma_workbench',
    icon: Icons.emergency_share_outlined,
    route: '/ed-trauma',
    color: Color(0xFFC62828),
  );
  static const DashboardFeature _billingDesk = DashboardFeature(
    id: 'billing_desk',
    titleKey: 'role.feature.billing_desk',
    icon: Icons.receipt_long,
    route: '/billing-desk',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _patientRecords = DashboardFeature(
    id: 'patient_records',
    titleKey: 'role.feature.patient_records',
    icon: Icons.folder_shared,
    route: '/patient-records',
    color: Color(0xFF0277BD),
  );
  static const DashboardFeature _prescriptions = DashboardFeature(
    id: 'prescriptions',
    titleKey: 'role.feature.prescriptions',
    icon: Icons.medication_liquid,
    route: '/prescriptions',
    color: Color(0xFF00838F),
  );
  static const DashboardFeature _pharmacyOrders = DashboardFeature(
    id: 'pharmacy_orders',
    titleKey: 'role.feature.pharmacy_orders',
    icon: Icons.medication,
    route: '/pharmacy',
    color: Color(0xFFE65100),
  );
  static const DashboardFeature _investigationsUpload = DashboardFeature(
    id: 'investigations_upload',
    titleKey: 'role.feature.investigations_upload',
    icon: Icons.upload_file,
    route: '/investigations',
    color: Color(0xFF0097A7),
  );
  static const DashboardFeature _investigationResults = DashboardFeature(
    id: 'investigation_results',
    titleKey: 'role.feature.investigation_results',
    icon: Icons.biotech,
    route: '/investigations',
    color: Color(0xFF0097A7),
  );
  static const DashboardFeature _labBookings = DashboardFeature(
    id: 'lab_bookings',
    titleKey: 'role.feature.lab_bookings',
    icon: Icons.science,
    route: '/lab-bookings',
    color: Color(0xFF00838F),
  );
  static const DashboardFeature _leave = DashboardFeature(
    id: 'leave',
    titleKey: 'role.feature.leave',
    icon: Icons.event_available,
    route: '/leave',
    color: Color(0xFF00796B),
  );
  static const DashboardFeature _payroll = DashboardFeature(
    id: 'payroll',
    titleKey: 'role.feature.payroll',
    icon: Icons.payments_outlined,
    route: '/payroll',
    color: Color(0xFF00695C),
  );
  static const DashboardFeature _leaveApprovals = DashboardFeature(
    id: 'leave_approvals',
    titleKey: 'role.feature.leave_approvals',
    icon: Icons.fact_check_outlined,
    route: '/leave-approvals',
    color: Color(0xFF00796B),
  );
  static const DashboardFeature _reportsGrievances = DashboardFeature(
    id: 'reports_grievances',
    titleKey: 'role.feature.reports_grievances',
    icon: Icons.report_problem_outlined,
    route: '/reports-grievances',
    color: Color(0xFF00796B),
  );
  static const DashboardFeature _staffDirectory = DashboardFeature(
    id: 'staff_directory',
    titleKey: 'role.feature.staff_directory',
    icon: Icons.people,
    route: '/staff-directory',
    color: Color(0xFF455A64),
  );
  static const DashboardFeature _hrDashboard = DashboardFeature(
    id: 'hr_dashboard',
    titleKey: 'role.feature.hr_dashboard',
    icon: Icons.analytics,
    route: '/hr-dashboard',
    color: Color(0xFF6A1B9A),
  );
  static const DashboardFeature _staffManagement = DashboardFeature(
    id: 'staff_management',
    titleKey: 'role.feature.staff_management',
    icon: Icons.manage_accounts,
    route: '/staff-management',
    color: Color(0xFF4527A0),
  );
  static const DashboardFeature _organizationHierarchy = DashboardFeature(
    id: 'organization_hierarchy',
    titleKey: 'role.feature.organization_hierarchy',
    icon: Icons.account_tree_outlined,
    route: '/organization-hierarchy',
    color: Color(0xFF00695C),
  );
  static const DashboardFeature _performance = DashboardFeature(
    id: 'performance',
    titleKey: 'role.feature.performance',
    icon: Icons.star_rate,
    route: '/performance',
    color: Color(0xFFF57F17),
  );
  static const DashboardFeature _housekeepingTasks = DashboardFeature(
    id: 'housekeeping_tasks',
    titleKey: 'role.feature.housekeeping_tasks',
    icon: Icons.checklist,
    route: '/housekeeping-tasks',
    color: Color(0xFF2E7D32),
  );
  static const DashboardFeature _housekeepingHub = DashboardFeature(
    id: 'housekeeping_hub',
    titleKey: 'role.feature.housekeeping_hub',
    icon: Icons.cleaning_services_outlined,
    route: '/housekeeping',
    color: Color(0xFF007A64),
  );
  static const DashboardFeature _housekeepingCommand = DashboardFeature(
    id: 'housekeeping_command',
    titleKey: 'role.feature.housekeeping_command',
    icon: Icons.supervisor_account,
    route: '/housekeeping-command',
    color: Color(0xFF00695C),
  );
  static const DashboardFeature _housekeepingRoster = DashboardFeature(
    id: 'housekeeping_roster',
    titleKey: 'role.feature.housekeeping_roster',
    icon: Icons.calendar_month,
    route: '/staff-roster/housekeeping',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _dutyPreference = DashboardFeature(
    id: 'duty_preference',
    titleKey: 'role.feature.duty_preference',
    icon: Icons.how_to_reg,
    route: '/duty-preference',
    color: Color(0xFF00796B),
  );
  static const DashboardFeature _nursingRoster = DashboardFeature(
    id: 'nursing_roster',
    titleKey: 'role.feature.nursing_roster',
    icon: Icons.assignment_ind,
    route: '/staff-roster/nursing',
    color: Color(0xFF00695C),
  );
  static const DashboardFeature _opNursingRoster = DashboardFeature(
    id: 'op_nursing_roster',
    titleKey: 'role.feature.op_nursing_roster',
    icon: Icons.event_note,
    route: '/staff-roster/op_nursing',
    color: Color(0xFF00838F),
  );
  static const DashboardFeature _opNursingDashboard = DashboardFeature(
    id: 'op_nursing_dashboard',
    titleKey: 'role.feature.op_nursing_dashboard',
    icon: Icons.fact_check_outlined,
    route: '/op/nursing-dashboard',
    color: Color(0xFF00838F),
  );
  static const DashboardFeature _receptionRoster = DashboardFeature(
    id: 'reception_roster',
    titleKey: 'role.feature.reception_roster',
    icon: Icons.support_agent,
    route: '/staff-roster/reception',
    color: Color(0xFF455A64),
  );
  static const DashboardFeature _maintenanceRoster = DashboardFeature(
    id: 'maintenance_roster',
    titleKey: 'role.feature.maintenance_roster',
    icon: Icons.engineering_outlined,
    route: '/staff-roster/maintenance',
    color: Color(0xFFF9A825),
  );
  static const DashboardFeature _biomedWorkOrders = DashboardFeature(
    id: 'biomed_work_orders',
    titleKey: 'role.feature.biomed_work_orders',
    icon: Icons.build_circle_outlined,
    route: '/biomed-work-orders',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _pharmacyRoster = DashboardFeature(
    id: 'pharmacy_roster',
    titleKey: 'role.feature.pharmacy_roster',
    icon: Icons.local_pharmacy_outlined,
    route: '/staff-roster/pharmacy',
    color: Color(0xFFE65100),
  );
  static const DashboardFeature _staffRosterHub = DashboardFeature(
    id: 'staff_roster',
    titleKey: 'role.feature.staff_roster',
    icon: Icons.calendar_month_outlined,
    route: '/staff-rosters',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _nursingNotes = DashboardFeature(
    id: 'nursing_notes',
    titleKey: 'role.feature.nursing_notes',
    icon: Icons.edit_note,
    route: '/nursing-notes',
    color: Color(0xFF00695C),
  );
  static const DashboardFeature _clinicalAiReviewQueue = DashboardFeature(
    id: 'clinical_ai_review_queue',
    titleKey: 'role.feature.clinical_ai_review_queue',
    icon: Icons.fact_check_outlined,
    route: '/clinical-ai/queue',
    color: Color(0xFF00838F),
  );
  static const DashboardFeature _clinicalInbox = DashboardFeature(
    id: 'clinical_inbox',
    titleKey: 'role.feature.clinical_inbox',
    icon: Icons.assignment_late_outlined,
    route: '/clinical-inbox',
    color: Color(0xFFC62828),
  );
  static const DashboardFeature _opAiAssist = DashboardFeature(
    id: 'op_ai_assist',
    titleKey: 'role.feature.op_ai_assist',
    icon: Icons.auto_awesome,
    route: '/op-ai-assist',
    color: Color(0xFF5E35B1),
  );
  static const DashboardFeature _opDoctorWorkspace = DashboardFeature(
    id: 'op_doctor_workspace',
    titleKey: 'role.feature.op_doctor_workspace',
    icon: Icons.fact_check_outlined,
    route: '/appointments?context=op&scope=my&workspace=doctor',
    color: Color(0xFF00838F),
  );
  static const DashboardFeature _schedule = DashboardFeature(
    id: 'schedule',
    titleKey: 'role.feature.schedule',
    icon: Icons.schedule,
    route: '/schedule',
    color: Color(0xFF00838F),
  );
  static const DashboardFeature _handover = DashboardFeature(
    id: 'handover',
    titleKey: 'role.feature.handover',
    icon: Icons.swap_horiz,
    route: '/handover',
    color: Color(0xFF00695C),
  );
  static const DashboardFeature _profile = DashboardFeature(
    id: 'profile',
    titleKey: 'role.feature.profile',
    icon: Icons.person,
    route: '/profile',
    color: Color(0xFF37474F),
  );
  static const DashboardFeature _settings = DashboardFeature(
    id: 'settings',
    titleKey: 'role.feature.settings',
    icon: Icons.settings,
    route: '/settings',
    color: Color(0xFF546E7A),
  );
  static const DashboardFeature _messaging = DashboardFeature(
    id: 'messaging',
    titleKey: 'role.feature.messaging',
    icon: Icons.chat_outlined,
    route: '/messaging',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _safetyCenter = DashboardFeature(
    id: 'safety_center',
    titleKey: 'role.feature.safety_center',
    icon: Icons.health_and_safety_outlined,
    route: '/safety-center',
    color: Color(0xFFC62828),
  );
  static const DashboardFeature _auditLogs = DashboardFeature(
    id: 'audit_logs',
    titleKey: 'role.feature.audit_logs',
    icon: Icons.manage_search,
    route: '/audit-logs',
    color: Color(0xFFC62828),
  );
  static const DashboardFeature _staffDiagnostics = DashboardFeature(
    id: 'staff_diagnostics',
    titleKey: 'role.feature.staff_diagnostics',
    icon: Icons.monitor_heart_outlined,
    route: '/staff-diagnostics',
    color: Color(0xFF546E7A),
  );
  static const DashboardFeature _bedBoard = DashboardFeature(
    id: 'bed_board',
    titleKey: 'role.feature.bed_board',
    icon: Icons.local_hotel,
    route: '/beds',
    color: Color(0xFF0277BD),
  );
  static const DashboardFeature _patientCommandBoard = DashboardFeature(
    id: 'patient_command_board',
    titleKey: 'role.feature.patient_command_board',
    icon: Icons.view_timeline_outlined,
    route: '/patient-command-board',
    color: Color(0xFF1565C0),
  );
  static const DashboardFeature _referrals = DashboardFeature(
    id: 'referrals',
    titleKey: 'role.feature.referrals',
    icon: Icons.medical_services_outlined,
    route: '/referrals',
    color: Color(0xFF00838F),
  );
  static const DashboardFeature _wardMode = DashboardFeature(
    id: 'ward_mode',
    titleKey: 'role.feature.ward_mode',
    icon: Icons.local_hospital_outlined,
    route: '/ward-mode',
    color: Color(0xFF00796B),
  );
  static const DashboardFeature _dischargeHub = DashboardFeature(
    id: 'discharge_hub',
    titleKey: 'role.feature.discharge_hub',
    icon: Icons.rule_folder,
    route: '/emr/discharge-hub',
    color: Color(0xFFD84315),
  );
  static const DashboardFeature _bloodBank = DashboardFeature(
    id: 'blood_bank',
    titleKey: 'role.feature.blood_bank',
    icon: Icons.bloodtype,
    route: '/blood-bank',
    color: Color(0xFFC62828),
  );
  static const DashboardFeature _dietary = DashboardFeature(
    id: 'dietary',
    titleKey: 'role.feature.dietary',
    icon: Icons.restaurant_menu,
    route: '/dietary',
    color: Color(0xFF00796B),
  );
  static const DashboardFeature _dentalCharting = DashboardFeature(
    id: 'dental_charting',
    titleKey: 'role.feature.dental_charting',
    icon: Icons.medical_services_outlined,
    route: '/dental',
    color: Color(0xFF00838F),
  );
  static const DashboardFeature _theatre = DashboardFeature(
    id: 'theatre',
    titleKey: 'role.feature.theatre',
    icon: Icons.local_hospital,
    route: '/theatre',
    color: Color(0xFF6A1B9A),
  );
  static const DashboardFeature _cathLab = DashboardFeature(
    id: 'cath_lab',
    titleKey: 'role.feature.cath_lab',
    icon: Icons.monitor_heart_outlined,
    route: '/cath-lab',
    color: Color(0xFFAD1457),
  );
  static const DashboardFeature _oncology = DashboardFeature(
    id: 'oncology',
    titleKey: 'role.feature.oncology',
    icon: Icons.biotech_outlined,
    route: '/oncology',
    color: Color(0xFF455A64),
  );
  static const DashboardFeature _radiology = DashboardFeature(
    id: 'radiology',
    titleKey: 'role.feature.radiology',
    icon: Icons.biotech,
    route: '/radiology',
    color: Color(0xFF0277BD),
  );
  static const DashboardFeature _strokePathway = DashboardFeature(
    id: 'stroke_pathway',
    titleKey: 'role.feature.stroke_pathway',
    icon: Icons.emergency_outlined,
    route: '/stroke-pathway',
    color: Color(0xFFC62828),
  );
  static const DashboardFeature _ophthalmology = DashboardFeature(
    id: 'ophthalmology',
    titleKey: 'role.feature.ophthalmology',
    icon: Icons.visibility_outlined,
    route: '/ophthalmology',
    color: Color(0xFF00897B),
  );
  static const DashboardFeature _physiotherapy = DashboardFeature(
    id: 'physiotherapy',
    titleKey: 'role.feature.physiotherapy',
    icon: Icons.accessibility_new,
    route: '/physiotherapy',
    color: Color(0xFF2E7D32),
  );
  static const DashboardFeature _transplantProgram = DashboardFeature(
    id: 'transplant_program',
    titleKey: 'role.feature.transplant_program',
    icon: Icons.health_and_safety_outlined,
    route: '/transplant',
    color: Color(0xFF00695C),
  );
  static const DashboardFeature _maternity = DashboardFeature(
    id: 'maternity',
    titleKey: 'role.feature.maternity',
    icon: Icons.pregnant_woman,
    route: '/maternity',
    color: Color(0xFFAD1457),
  );
  static const DashboardFeature _calculators = DashboardFeature(
    id: 'calculators',
    titleKey: 'role.feature.calculators',
    icon: Icons.calculate_outlined,
    route: '/calculators',
    color: Color(0xFF5E35B1),
  );
  static const DashboardFeature _radiationOncology = DashboardFeature(
    id: 'radiation_oncology',
    titleKey: 'role.feature.radiation_oncology',
    icon: Icons.radar_outlined,
    route: '/radiation-oncology',
    color: Color(0xFF455A64),
  );

  /// Returns ordered list of dashboard features for the given role.
  static List<DashboardFeature> getFeaturesForRole(StaffRole role) {
    final features = switch (role) {
      StaffRole.doctor || StaffRole.dutyDoctor => [
        _attendance,
        _schedule,
        _dutyPreference,
        if (role == StaffRole.dutyDoctor) _nursingRoster,
        _edTraumaWorkbench,
        _opDoctorWorkspace,
        _dentalCharting,
        _clinicalInbox,
        _clinicalAiReviewQueue,
        _opAiAssist,
        _calculators,
        _ophthalmology,
        _transplantProgram,
        _oncology,
        _radiationOncology,
        _strokePathway,
        _patientRecords,
        _patientCommandBoard,
        _maternity,
        _referrals,
        _cathLab,
        _bedBoard,
        _wardMode,
        _dischargeHub,
        _leave,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.anaesthetist => [
        _attendance,
        _schedule,
        _dutyPreference,
        _clinicalInbox,
        _clinicalAiReviewQueue,
        _edTraumaWorkbench,
        _patientRecords,
        _investigationResults,
        _theatre,
        _patientCommandBoard,
        _referrals,
        _bedBoard,
        _wardMode,
        _bloodBank,
        _leave,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.nurse || StaffRole.ipStaffNurse => [
        _attendance,
        _schedule,
        _dutyPreference,
        _clinicalInbox,
        _clinicalAiReviewQueue,
        _calculators,
        _edTraumaWorkbench,
        _patientRecords,
        _pharmacyOrders,
        _nursingNotes,
        _handover,
        _investigationResults,
        _labBookings,
        _radiology,
        _strokePathway,
        _ophthalmology,
        _oncology,
        _radiationOncology,
        if (role == StaffRole.nurse) _cathLab,
        _patientCommandBoard,
        _maternity,
        _referrals,
        _bedBoard,
        _wardMode,
        _dischargeHub,
        _bloodBank,
        _dietary,
        _biomedWorkOrders,
        _leave,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.nursingIncharge || StaffRole.ipIncharge => [
        _attendance,
        _schedule,
        _dutyPreference,
        _nursingRoster,
        _opNursingRoster,
        _clinicalInbox,
        _clinicalAiReviewQueue,
        _calculators,
        _edTraumaWorkbench,
        _patientRecords,
        _nursingNotes,
        _handover,
        _oncology,
        _radiationOncology,
        _patientCommandBoard,
        _maternity,
        _referrals,
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
        _clinicalInbox,
        _clinicalAiReviewQueue,
        _edTraumaWorkbench,
        _patientRecords,
        _nursingNotes,
        _handover,
        _oncology,
        _radiationOncology,
        _patientCommandBoard,
        _referrals,
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
        _opNursingDashboard,
        _dentalCharting,
        _clinicalInbox,
        _edTraumaWorkbench,
        _frontOfficeWorkbench,
        _appointments,
        _ophthalmology,
        _oncology,
        _radiationOncology,
        _patientRecords,
        _pharmacyOrders,
        _nursingNotes,
        _investigationResults,
        _labBookings,
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
        _opNursingDashboard,
        _dentalCharting,
        _clinicalInbox,
        _edTraumaWorkbench,
        _frontOfficeWorkbench,
        _appointments,
        _ophthalmology,
        _oncology,
        _radiationOncology,
        _patientRecords,
        _pharmacyOrders,
        _nursingNotes,
        _investigationResults,
        _labBookings,
        _leave,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.otNurse || StaffRole.otIncharge => [
        _attendance,
        _schedule,
        _dutyPreference,
        _nursingRoster,
        _clinicalInbox,
        _edTraumaWorkbench,
        _theatre,
        _patientRecords,
        _investigationResults,
        _labBookings,
        _bloodBank,
        _leave,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.cathLabStaff || StaffRole.cathLabIncharge => [
        _attendance,
        _schedule,
        _dutyPreference,
        _clinicalInbox,
        _cathLab,
        _patientRecords,
        _investigationResults,
        _labBookings,
        _bloodBank,
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
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.medicalSuperintendent => [
        _attendance,
        _schedule,
        _staffRosterHub,
        _frontOfficeWorkbench,
        _edTraumaWorkbench,
        _appointments,
        _admissions,
        _opDoctorWorkspace,
        _dentalCharting,
        _clinicalInbox,
        _clinicalAiReviewQueue,
        _opAiAssist,
        _patientRecords,
        _prescriptions,
        _investigationResults,
        _labBookings,
        _cathLab,
        _theatre,
        _ophthalmology,
        _physiotherapy,
        _transplantProgram,
        _radiology,
        _strokePathway,
        _radiationOncology,
        _patientCommandBoard,
        _referrals,
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
        _edTraumaWorkbench,
        _billingDesk,
        _appointments,
        _admissions,
        _opDoctorWorkspace,
        _dentalCharting,
        _clinicalInbox,
        _clinicalAiReviewQueue,
        _calculators,
        _patientRecords,
        _prescriptions,
        _pharmacyOrders,
        _investigationsUpload,
        _investigationResults,
        _labBookings,
        _cathLab,
        _theatre,
        _ophthalmology,
        _physiotherapy,
        _transplantProgram,
        _radiology,
        _strokePathway,
        _radiationOncology,
        _patientCommandBoard,
        _maternity,
        _referrals,
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
        _biomedWorkOrders,
        _messaging,
        _auditLogs,
        _staffDiagnostics,
        _profile,
        _settings,
      ],
      StaffRole.pharmacy || StaffRole.pharmacyIncharge => [
        _attendance,
        _schedule,
        _dutyPreference,
        _pharmacyRoster,
        _pharmacyOrders,
        _patientCommandBoard,
        _bedBoard,
        _dischargeHub,
        _clinicalInbox,
        _clinicalAiReviewQueue,
        _leave,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.storesPurchaseIncharge => [
        _attendance,
        _schedule,
        _dutyPreference,
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
      StaffRole.radiologyStaff => [
        _attendance,
        _schedule,
        _dutyPreference,
        _radiology,
        _strokePathway,
        _investigationsUpload,
        _investigationResults,
        _leave,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.physiotherapist => [
        _attendance,
        _schedule,
        _dutyPreference,
        _physiotherapy,
        _clinicalInbox,
        _patientRecords,
        _patientCommandBoard,
        _referrals,
        _dischargeHub,
        _leave,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.biomedicalStaff => [
        _schedule,
        _dutyPreference,
        _maintenanceRoster,
        _biomedWorkOrders,
        _clinicalAiReviewQueue,
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
        _cathLab,
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
        if (role != StaffRole.insuranceCoordinator) _clinicalInbox,
        _patientRecords,
        _staffDirectory,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.driver ||
      StaffRole.security ||
      StaffRole.emergencyResponder => [
        _schedule,
        _dutyPreference,
        if (role == StaffRole.emergencyResponder) _edTraumaWorkbench,
        _messaging,
        _profile,
        _settings,
      ],
      StaffRole.maintenance => [
        _schedule,
        _dutyPreference,
        _maintenanceRoster,
        _biomedWorkOrders,
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
    return [
      ..._withPayrollSelfService(role, features),
      _safetyCenter,
      _reportsGrievances,
    ];
  }

  static List<DashboardFeature> _withPayrollSelfService(
    StaffRole role,
    List<DashboardFeature> features,
  ) {
    if (!hasPayrollSelfService(role) ||
        features.any((feature) => feature.id == _payroll.id)) {
      return features;
    }
    final result = [...features];
    final leaveIndex = result.indexWhere((feature) => feature.id == _leave.id);
    final dutyIndex = result.indexWhere(
      (feature) => feature.id == _dutyPreference.id,
    );
    final scheduleIndex = result.indexWhere(
      (feature) => feature.id == _schedule.id,
    );
    final insertAt = leaveIndex >= 0
        ? leaveIndex + 1
        : dutyIndex >= 0
        ? dutyIndex + 1
        : scheduleIndex >= 0
        ? scheduleIndex + 1
        : result.length;
    result.insert(insertAt, _payroll);
    return result;
  }

  /// Returns role-specific bottom nav items with their routes.
  static List<BottomNavItem> getBottomNavForRole(StaffRole role) {
    return switch (role) {
      StaffRole.doctor || StaffRole.dutyDoctor => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.fact_check_outlined),
            activeIcon: Icon(Icons.fact_check),
          ),
          labelKey: 'role.nav.op_workspace',
          route: '/appointments?context=op&scope=my&workspace=doctor',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.folder_shared_outlined),
            activeIcon: Icon(Icons.folder_shared),
          ),
          labelKey: 'role.nav.records',
          route: '/patient-records',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.anaesthetist => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.local_hospital_outlined),
            activeIcon: Icon(Icons.local_hospital),
          ),
          labelKey: 'role.nav.theatre',
          route: '/theatre',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.folder_shared_outlined),
            activeIcon: Icon(Icons.folder_shared),
          ),
          labelKey: 'role.nav.records',
          route: '/patient-records',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.nurse ||
      StaffRole.nursingSuperintendent ||
      StaffRole.nursingIncharge ||
      StaffRole.ipStaffNurse ||
      StaffRole.ipIncharge => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.view_timeline_outlined),
            activeIcon: Icon(Icons.view_timeline),
          ),
          labelKey: 'role.nav.command',
          route: '/patient-command-board',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.schedule_outlined),
            activeIcon: Icon(Icons.schedule),
          ),
          labelKey: 'role.nav.my_roster',
          route: '/schedule',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.otNurse || StaffRole.otIncharge => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.local_hospital_outlined),
            activeIcon: Icon(Icons.local_hospital),
          ),
          labelKey: 'role.nav.theatre',
          route: '/theatre',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.schedule_outlined),
            activeIcon: Icon(Icons.schedule),
          ),
          labelKey: 'role.nav.my_roster',
          route: '/schedule',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.cathLabStaff || StaffRole.cathLabIncharge => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.monitor_heart_outlined),
            activeIcon: Icon(Icons.monitor_heart),
          ),
          labelKey: 'role.nav.cath_lab',
          route: '/cath-lab',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.schedule_outlined),
            activeIcon: Icon(Icons.schedule),
          ),
          labelKey: 'role.nav.my_roster',
          route: '/schedule',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.opStaffNurse || StaffRole.opIncharge => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.fact_check_outlined),
            activeIcon: Icon(Icons.fact_check),
          ),
          labelKey: 'role.nav.op_nursing',
          route: '/op/nursing-dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.schedule_outlined),
            activeIcon: Icon(Icons.schedule),
          ),
          labelKey: 'role.nav.my_roster',
          route: '/schedule',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.hr => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.analytics_outlined),
            activeIcon: Icon(Icons.analytics),
          ),
          labelKey: 'role.nav.hr_hub',
          route: '/hr-dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.schedule_outlined),
            activeIcon: Icon(Icons.schedule),
          ),
          labelKey: 'role.nav.my_roster',
          route: '/schedule',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
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
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.apps_outlined),
            activeIcon: Icon(Icons.apps),
          ),
          labelKey: 'role.nav.features',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.settings_outlined),
            activeIcon: Icon(Icons.settings),
          ),
          labelKey: 'role.nav.settings',
          route: '/settings',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.pharmacy || StaffRole.pharmacyIncharge => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.medication_outlined),
            activeIcon: Icon(Icons.medication),
          ),
          labelKey: 'role.nav.orders',
          route: '/pharmacy',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.storesPurchaseIncharge => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.inventory_2_outlined),
            activeIcon: Icon(Icons.inventory_2),
          ),
          labelKey: 'role.nav.inventory',
          route: '/pharmacy',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.lab || StaffRole.radiologyStaff => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.biotech_outlined),
            activeIcon: Icon(Icons.biotech),
          ),
          labelKey: 'role.nav.investigations',
          route: '/investigations',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.physiotherapist => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.accessibility_new_outlined),
            activeIcon: Icon(Icons.accessibility_new),
          ),
          labelKey: 'role.nav.physiotherapy',
          route: '/physiotherapy',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.view_timeline_outlined),
            activeIcon: Icon(Icons.view_timeline),
          ),
          labelKey: 'role.nav.command',
          route: '/patient-command-board',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.housekeeping => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.local_hotel_outlined),
            activeIcon: Icon(Icons.local_hotel),
          ),
          labelKey: 'role.nav.beds',
          route: '/beds',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.cleaning_services_outlined),
            activeIcon: Icon(Icons.cleaning_services),
          ),
          labelKey: 'role.nav.cleaning',
          route: '/housekeeping',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.housekeepingIncharge => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.local_hotel_outlined),
            activeIcon: Icon(Icons.local_hotel),
          ),
          labelKey: 'role.nav.beds',
          route: '/beds',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.supervisor_account_outlined),
            activeIcon: Icon(Icons.supervisor_account),
          ),
          labelKey: 'role.nav.command',
          route: '/housekeeping-command',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.cleaning_services_outlined),
            activeIcon: Icon(Icons.cleaning_services),
          ),
          labelKey: 'role.nav.cleaning',
          route: '/housekeeping',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.receptionist || StaffRole.receptionIncharge => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.space_dashboard_outlined),
            activeIcon: Icon(Icons.space_dashboard),
          ),
          labelKey: 'role.nav.front_desk',
          route: '/front-office',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.schedule_outlined),
            activeIcon: Icon(Icons.schedule),
          ),
          labelKey: 'role.nav.my_roster',
          route: '/schedule',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
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
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.receipt_long_outlined),
            activeIcon: Icon(Icons.receipt_long),
          ),
          labelKey: 'role.nav.billing',
          route: '/billing-desk',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.space_dashboard_outlined),
            activeIcon: Icon(Icons.space_dashboard),
          ),
          labelKey: 'role.nav.front_desk',
          route: '/front-office',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
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
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.space_dashboard_outlined),
            activeIcon: Icon(Icons.space_dashboard),
          ),
          labelKey: 'role.nav.front_desk',
          route: '/front-office',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.local_hospital_outlined),
            activeIcon: Icon(Icons.local_hospital),
          ),
          labelKey: 'role.nav.admissions',
          route: '/emr/admissions',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.biomedicalStaff || StaffRole.maintenance => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.build_outlined),
            activeIcon: Icon(Icons.build),
          ),
          labelKey: 'role.nav.work',
          route: '/biomed-work-orders',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.schedule_outlined),
            activeIcon: Icon(Icons.schedule),
          ),
          labelKey: 'role.nav.my_roster',
          route: '/schedule',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.emergencyResponder => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.build_outlined),
            activeIcon: Icon(Icons.emergency_share),
          ),
          labelKey: 'role.nav.work',
          route: '/ed-trauma',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.driver || StaffRole.security => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.build_outlined),
            activeIcon: Icon(Icons.build),
          ),
          labelKey: 'role.nav.work',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
      StaffRole.general => [
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
          ),
          labelKey: 'role.nav.home',
          route: '/dashboard',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.checklist_outlined),
            activeIcon: Icon(Icons.checklist),
          ),
          labelKey: 'role.nav.tasks',
          route: '/housekeeping-tasks',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.chat_outlined),
            activeIcon: Icon(Icons.chat),
          ),
          labelKey: 'role.nav.messages',
          route: '/messaging',
        ),
        const BottomNavItem(
          item: BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
          ),
          labelKey: 'role.nav.profile',
          route: '/profile',
        ),
      ],
    };
  }

  static List<BottomNavItem> getPhoneSelfServiceNavForRole(StaffRole _) {
    return const [
      BottomNavItem(
        item: BottomNavigationBarItem(
          icon: Icon(Icons.home_outlined),
          activeIcon: Icon(Icons.home),
        ),
        labelKey: 'role.nav.home',
        route: '/dashboard',
      ),
      BottomNavItem(
        item: BottomNavigationBarItem(
          icon: Icon(Icons.notifications_outlined),
          activeIcon: Icon(Icons.notifications),
        ),
        labelKey: 'role.nav.alerts',
        route: '/notifications',
      ),
      BottomNavItem(
        item: BottomNavigationBarItem(
          icon: Icon(Icons.chat_bubble_outline),
          activeIcon: Icon(Icons.chat_bubble),
        ),
        labelKey: 'role.nav.messages',
        route: '/messaging',
      ),
      BottomNavItem(
        item: BottomNavigationBarItem(
          icon: Icon(Icons.fingerprint_outlined),
          activeIcon: Icon(Icons.fingerprint),
        ),
        labelKey: 'role.nav.attendance',
        route: '/attendance',
      ),
      BottomNavItem(
        item: BottomNavigationBarItem(
          icon: Icon(Icons.more_horiz),
          activeIcon: Icon(Icons.more),
        ),
        labelKey: 'role.nav.more',
        route: '/phone/more',
      ),
    ];
  }

  static bool hasFrontOfficeWorkbench(StaffRole role) {
    return switch (role) {
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.medicalSuperintendent ||
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

  static bool hasIpAdmissionAccess(StaffRole role) {
    return switch (role) {
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.medicalSuperintendent ||
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
      StaffRole.ipStaffNurse ||
      StaffRole.ipIncharge ||
      StaffRole.opStaffNurse ||
      StaffRole.opIncharge ||
      StaffRole.otNurse ||
      StaffRole.otIncharge ||
      StaffRole.cathLabStaff ||
      StaffRole.cathLabIncharge ||
      StaffRole.physiotherapist => true,
      _ => false,
    };
  }

  static bool hasDentalCharting(StaffRole role) {
    return switch (role) {
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.medicalSuperintendent ||
      StaffRole.doctor ||
      StaffRole.dutyDoctor ||
      StaffRole.opStaffNurse ||
      StaffRole.opIncharge => true,
      _ => false,
    };
  }

  static bool hasOncology(StaffRole role) {
    return switch (role) {
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.medicalSuperintendent ||
      StaffRole.doctor ||
      StaffRole.dutyDoctor ||
      StaffRole.nurse ||
      StaffRole.nursingIncharge ||
      StaffRole.nursingSuperintendent ||
      StaffRole.ipStaffNurse ||
      StaffRole.ipIncharge ||
      StaffRole.opStaffNurse ||
      StaffRole.opIncharge => true,
      _ => false,
    };
  }

  /// Clinical membership of the backend `ip_flow` capability group, minus the
  /// non-clinical admission-desk roles it also carries. `/api/v1/maternity`
  /// and `/api/v1/productivity` both gate on that group, so tiles guarded by
  /// this never 403 at the backend.
  static bool _hasIpFlowClinicalAccess(StaffRole role) {
    return switch (role) {
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.doctor ||
      StaffRole.dutyDoctor ||
      StaffRole.nurse ||
      StaffRole.nursingIncharge ||
      StaffRole.ipStaffNurse ||
      StaffRole.ipIncharge => true,
      _ => false,
    };
  }

  static bool hasMaternity(StaffRole role) => _hasIpFlowClinicalAccess(role);

  static bool hasClinicalCalculators(StaffRole role) =>
      _hasIpFlowClinicalAccess(role);

  /// Read-only radiation-oncology coordination board. The backend mount is
  /// the broad clinical-staff set, so mirroring [hasOncology] keeps the tile
  /// on oncology-adjacent roles without exceeding the backend gate.
  static bool hasRadiationOncology(StaffRole role) => hasOncology(role);

  static bool hasClinicalInbox(StaffRole role) {
    return switch (role) {
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.medicalSuperintendent ||
      StaffRole.nursingSuperintendent ||
      StaffRole.doctor ||
      StaffRole.dutyDoctor ||
      StaffRole.anaesthetist ||
      StaffRole.nurse ||
      StaffRole.nursingIncharge ||
      StaffRole.ipStaffNurse ||
      StaffRole.ipIncharge ||
      StaffRole.opStaffNurse ||
      StaffRole.opIncharge ||
      StaffRole.otNurse ||
      StaffRole.otIncharge ||
      StaffRole.cathLabStaff ||
      StaffRole.cathLabIncharge ||
      StaffRole.physiotherapist ||
      StaffRole.pharmacy ||
      StaffRole.pharmacyIncharge ||
      StaffRole.admissionOfficer ||
      StaffRole.ipdCounsellor => true,
      _ => false,
    };
  }

  static bool hasOpAiAssist(StaffRole role) {
    return switch (role) {
      StaffRole.doctor ||
      StaffRole.dutyDoctor ||
      StaffRole.medicalSuperintendent => true,
      _ => false,
    };
  }

  static bool hasPhoneReadOnlyPatientLookup(StaffRole role) {
    return switch (role) {
      StaffRole.doctor ||
      StaffRole.dutyDoctor ||
      StaffRole.anaesthetist ||
      StaffRole.medicalSuperintendent => true,
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
      StaffRole.anaesthetist ||
      StaffRole.dutyDoctor ||
      StaffRole.nurse ||
      StaffRole.nursingIncharge ||
      StaffRole.ipStaffNurse ||
      StaffRole.ipIncharge ||
      StaffRole.opStaffNurse ||
      StaffRole.opIncharge ||
      StaffRole.otNurse ||
      StaffRole.otIncharge ||
      StaffRole.cathLabStaff ||
      StaffRole.cathLabIncharge ||
      StaffRole.physiotherapist ||
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

  static bool hasPatientRegistryCreate(StaffRole role) {
    return hasPatientRegistryWrite(role);
  }

  static bool hasStaffRosterHub(StaffRole role) {
    return switch (role) {
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.hr ||
      StaffRole.medicalSuperintendent => true,
      _ => false,
    };
  }

  static bool hasStaffOnboarding(StaffRole role) {
    return switch (role) {
      StaffRole.admin || StaffRole.superAdmin || StaffRole.hr => true,
      _ => false,
    };
  }

  static bool hasPayrollSelfService(StaffRole role) {
    return switch (role) {
      StaffRole.admin ||
      StaffRole.superAdmin ||
      StaffRole.hr ||
      StaffRole.housekeepingIncharge ||
      StaffRole.nursingIncharge ||
      StaffRole.opIncharge ||
      StaffRole.ipIncharge ||
      StaffRole.nursingSuperintendent ||
      StaffRole.medicalSuperintendent ||
      StaffRole.general ||
      StaffRole.housekeeping ||
      StaffRole.biomedicalStaff ||
      StaffRole.maintenance ||
      StaffRole.nurse ||
      StaffRole.ipStaffNurse ||
      StaffRole.opStaffNurse ||
      StaffRole.otNurse ||
      StaffRole.otIncharge ||
      StaffRole.cathLabStaff ||
      StaffRole.cathLabIncharge ||
      StaffRole.doctor ||
      StaffRole.anaesthetist ||
      StaffRole.dutyDoctor ||
      StaffRole.pharmacy ||
      StaffRole.pharmacyIncharge ||
      StaffRole.storesPurchaseIncharge ||
      StaffRole.lab ||
      StaffRole.radiologyStaff ||
      StaffRole.physiotherapist ||
      StaffRole.receptionist ||
      StaffRole.receptionIncharge ||
      StaffRole.billingStaff ||
      StaffRole.insuranceCoordinator ||
      StaffRole.admissionOfficer ||
      StaffRole.ipdCounsellor ||
      StaffRole.driver ||
      StaffRole.security ||
      StaffRole.emergencyResponder => true,
      StaffRole.billingIncharge || StaffRole.financeIncharge => false,
    };
  }

  static List<WorkbenchNavItem> getWorkbenchNavForRole(
    StaffRole role, {
    Set<String>? policyFeatureIds,
  }) {
    final items = <WorkbenchNavItem>[
      const WorkbenchNavItem(
        labelKey: 'role.nav.home',
        icon: Icons.dashboard_outlined,
        selectedIcon: Icons.dashboard,
        route: '/dashboard',
      ),
    ];

    if (hasStaffRosterHub(role)) {
      items.add(
        const WorkbenchNavItem(
          labelKey: 'role.nav.staff_roster',
          icon: Icons.calendar_month_outlined,
          selectedIcon: Icons.calendar_month,
          route: '/staff-rosters',
          featureId: 'staff_roster_hub',
        ),
      );
    }

    if (hasStaffOnboarding(role)) {
      items.add(
        const WorkbenchNavItem(
          labelKey: 'role.nav.onboarding',
          icon: Icons.manage_accounts_outlined,
          selectedIcon: Icons.manage_accounts,
          route: '/staff-management',
          featureId: 'staff_management',
        ),
      );
    }

    if (hasClinicalInbox(role)) {
      items.add(
        const WorkbenchNavItem(
          labelKey: 'role.nav.clinical_inbox',
          icon: Icons.assignment_late_outlined,
          selectedIcon: Icons.assignment_late,
          route: '/clinical-inbox',
        ),
      );
    }

    if (hasFrontOfficeWorkbench(role)) {
      items.add(
        const WorkbenchNavItem(
          labelKey: 'role.nav.front_office',
          icon: Icons.space_dashboard_outlined,
          selectedIcon: Icons.space_dashboard,
          route: '/front-office',
          featureId: 'front_office_workbench',
        ),
      );
    }

    if (role == StaffRole.opStaffNurse || role == StaffRole.opIncharge) {
      items.add(
        const WorkbenchNavItem(
          labelKey: 'role.nav.op_nursing',
          icon: Icons.fact_check_outlined,
          selectedIcon: Icons.fact_check,
          route: '/op/nursing-dashboard',
          featureId: 'appointments',
        ),
      );
    }

    if (role == StaffRole.doctor || role == StaffRole.dutyDoctor) {
      items.add(
        const WorkbenchNavItem(
          labelKey: 'role.nav.op_workspace',
          icon: Icons.fact_check_outlined,
          selectedIcon: Icons.fact_check,
          route: '/appointments?context=op&scope=my&workspace=doctor',
          featureId: 'appointments',
        ),
      );
    }

    if (hasDentalCharting(role)) {
      items.add(
        const WorkbenchNavItem(
          labelKey: 'role.nav.dental',
          icon: Icons.medical_services_outlined,
          selectedIcon: Icons.medical_services,
          route: '/dental',
          featureId: 'dental_charting',
        ),
      );
    }

    if (role == StaffRole.physiotherapist) {
      items.add(
        const WorkbenchNavItem(
          labelKey: 'role.nav.physiotherapy',
          icon: Icons.accessibility_new_outlined,
          selectedIcon: Icons.accessibility_new,
          route: '/physiotherapy',
          featureId: 'physiotherapy',
        ),
      );
    }

    if (role == StaffRole.doctor ||
        role == StaffRole.dutyDoctor ||
        role == StaffRole.medicalSuperintendent ||
        role == StaffRole.admin ||
        role == StaffRole.superAdmin) {
      items.add(
        const WorkbenchNavItem(
          labelKey: 'role.nav.transplant_program',
          icon: Icons.health_and_safety_outlined,
          selectedIcon: Icons.health_and_safety,
          route: '/transplant',
          featureId: 'transplant_program',
        ),
      );
    }

    if (hasIpAdmissionAccess(role)) {
      items.add(
        const WorkbenchNavItem(
          labelKey: 'role.nav.ip_admissions',
          icon: Icons.local_hospital_outlined,
          selectedIcon: Icons.local_hospital,
          route: '/emr/admissions',
          featureId: 'admissions',
        ),
      );
    }

    if (hasBillingDesk(role)) {
      items.add(
        const WorkbenchNavItem(
          labelKey: 'role.nav.billing',
          icon: Icons.receipt_long_outlined,
          selectedIcon: Icons.receipt_long,
          route: '/billing-desk',
          featureId: 'billing_desk',
        ),
      );
    }

    if (hasClinicalEntry(role)) {
      items.add(
        const WorkbenchNavItem(
          labelKey: 'role.nav.patient_records',
          icon: Icons.folder_shared_outlined,
          selectedIcon: Icons.folder_shared,
          route: '/patient-records',
          featureId: 'patient_records',
        ),
      );
    }

    if (hasOncology(role)) {
      items.add(
        const WorkbenchNavItem(
          labelKey: 'role.nav.oncology',
          icon: Icons.biotech_outlined,
          selectedIcon: Icons.biotech,
          route: '/oncology',
          featureId: 'oncology',
        ),
      );
    }

    if (role == StaffRole.housekeeping ||
        role == StaffRole.housekeepingIncharge) {
      items.addAll(const [
        WorkbenchNavItem(
          labelKey: 'role.nav.beds',
          icon: Icons.local_hotel_outlined,
          selectedIcon: Icons.local_hotel,
          route: '/beds',
          featureId: 'bed_board',
        ),
        WorkbenchNavItem(
          labelKey: 'role.nav.housekeeping',
          icon: Icons.cleaning_services_outlined,
          selectedIcon: Icons.cleaning_services,
          route: '/housekeeping',
          featureId: 'housekeeping_hub',
        ),
      ]);
    }

    if (hasPayrollSelfService(role)) {
      items.add(
        const WorkbenchNavItem(
          labelKey: 'role.nav.payroll',
          icon: Icons.payments_outlined,
          selectedIcon: Icons.payments,
          route: '/payroll',
          featureId: 'payroll',
        ),
      );
    }

    items.addAll(const [
      WorkbenchNavItem(
        labelKey: 'role.nav.my_roster',
        icon: Icons.schedule_outlined,
        selectedIcon: Icons.schedule,
        route: '/schedule',
      ),
      WorkbenchNavItem(
        labelKey: 'role.nav.messages',
        icon: Icons.chat_outlined,
        selectedIcon: Icons.chat,
        route: '/messaging',
      ),
      WorkbenchNavItem(
        labelKey: 'role.nav.alerts',
        icon: Icons.notifications_outlined,
        selectedIcon: Icons.notifications_active,
        route: '/notifications',
      ),
      WorkbenchNavItem(
        labelKey: 'role.nav.safety',
        icon: Icons.health_and_safety_outlined,
        selectedIcon: Icons.health_and_safety,
        route: '/safety-center',
      ),
    ]);

    if (role.isAdminTier) {
      items.addAll(const [
        WorkbenchNavItem(
          labelKey: 'role.nav.audit_logs',
          icon: Icons.manage_search_outlined,
          selectedIcon: Icons.manage_search,
          route: '/audit-logs',
          featureId: 'audit_logs',
        ),
        WorkbenchNavItem(
          labelKey: 'role.nav.diagnostics',
          icon: Icons.monitor_heart_outlined,
          selectedIcon: Icons.monitor_heart,
          route: '/staff-diagnostics',
        ),
      ]);
    }

    items.addAll(const [
      WorkbenchNavItem(
        labelKey: 'role.nav.profile',
        icon: Icons.person_outlined,
        selectedIcon: Icons.person,
        route: '/profile',
      ),
    ]);

    if (policyFeatureIds == null || policyFeatureIds.isEmpty) return items;
    return items
        .where((item) {
          final featureId = item.featureId;
          return featureId == null || policyFeatureIds.contains(featureId);
        })
        .toList(growable: false);
  }
}
