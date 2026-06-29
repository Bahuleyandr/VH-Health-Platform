/**
 * Centralized role group helpers.
 * Use these instead of inline role arrays to keep role logic DRY.
 * When a new role is added, update the group here and it propagates everywhere.
 */

// Individual role constants (re-exported for convenience)
export const ROLES = {
  PATIENT: 'PATIENT',
  DOCTOR: 'DOCTOR',
  DUTY_DOCTOR: 'DUTY_DOCTOR',
  MEDICAL_SUPERINTENDENT: 'MEDICAL_SUPERINTENDENT',
  NURSING_STAFF: 'NURSING_STAFF',
  NURSING_INCHARGE: 'NURSING_INCHARGE',
  OP_STAFF_NURSE: 'OP_STAFF_NURSE',
  OP_INCHARGE: 'OP_INCHARGE',
  IP_STAFF_NURSE: 'IP_STAFF_NURSE',
  IP_INCHARGE: 'IP_INCHARGE',
  OT_NURSE: 'OT_NURSE',
  OT_INCHARGE: 'OT_INCHARGE',
  CATH_LAB_STAFF: 'CATH_LAB_STAFF',
  CATH_LAB_INCHARGE: 'CATH_LAB_INCHARGE',
  PHARMACY_STAFF: 'PHARMACY_STAFF',
  PHARMACY_INCHARGE: 'PHARMACY_INCHARGE',
  STORES_PURCHASE_INCHARGE: 'STORES_PURCHASE_INCHARGE',
  LAB_STAFF: 'LAB_STAFF',
  HR_STAFF: 'HR_STAFF',
  GENERAL_STAFF: 'GENERAL_STAFF',
  HOUSEKEEPING_STAFF: 'HOUSEKEEPING_STAFF',
  HOUSEKEEPING_INCHARGE: 'HOUSEKEEPING_INCHARGE',
  MAINTENANCE: 'MAINTENANCE',
  DELIVERY_STAFF: 'DELIVERY_STAFF',
  MEDICAL_RECORDS: 'MEDICAL_RECORDS',
  ADMIN: 'ADMIN',
  RECEPTIONIST: 'RECEPTIONIST',
  RECEPTION_INCHARGE: 'RECEPTION_INCHARGE',
  DRIVER: 'DRIVER',
  // New roles
  SECURITY: 'SECURITY',
  EMERGENCY_RESPONDER: 'EMERGENCY_RESPONDER',
  RADIOLOGIST: 'RADIOLOGIST',
  ANESTHETIST: 'ANESTHETIST',
  DIETITIAN: 'DIETITIAN',
  PHYSIOTHERAPIST: 'PHYSIOTHERAPIST',
  SOCIAL_WORKER: 'SOCIAL_WORKER',
  BILLING_STAFF: 'BILLING_STAFF',
  BILLING_INCHARGE: 'BILLING_INCHARGE',
  FINANCE_INCHARGE: 'FINANCE_INCHARGE',
  INSURANCE_COORDINATOR: 'INSURANCE_COORDINATOR',
  ADMISSION_OFFICER: 'ADMISSION_OFFICER',
  IPD_COUNSELLOR: 'IPD_COUNSELLOR',
  QUALITY_OFFICER: 'QUALITY_OFFICER',
  INFECTION_CONTROL_OFFICER: 'INFECTION_CONTROL_OFFICER',
  OT_STAFF: 'OT_STAFF',
  BLOOD_BANK_TECHNICIAN: 'BLOOD_BANK_TECHNICIAN',
  DEPARTMENT_HEAD: 'DEPARTMENT_HEAD',
  CMO: 'CMO',
  CNO: 'CNO',
  // Phase F1 — formal roles for spec gaps (2026-04-30)
  // Doctor seniority tiers — sit alongside DOCTOR (which remains the catch-all)
  CONSULTANT: 'CONSULTANT',
  JUNIOR_DOCTOR: 'JUNIOR_DOCTOR',
  RESIDENT: 'RESIDENT',
  // Specialty clinical
  COUNSELLOR: 'COUNSELLOR',
  CARE_COORDINATOR: 'CARE_COORDINATOR',
  // Operations
  CLAIMS_MANAGER: 'CLAIMS_MANAGER',
  AMBULANCE_COORDINATOR: 'AMBULANCE_COORDINATOR',
  // Platform / governance
  INTEGRATION_ADMIN: 'INTEGRATION_ADMIN',
  WEBHOOK_CLIENT: 'WEBHOOK_CLIENT',
  AI_GOVERNANCE_ADMIN: 'AI_GOVERNANCE_ADMIN',
  DATA_PROTECTION_OFFICER: 'DATA_PROTECTION_OFFICER'
};

// Doctor seniority tiers — every tier counts as a DOCTOR for downstream
// gating, but the explicit role lets routes target a specific seniority
// (e.g. only a CONSULTANT can sign discharge summaries, RESIDENTs cannot
// override prescriptions).
export const DOCTOR_TIERS = [
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT'
];

// Role groups
export const CLINICAL_ROLES = [
  ROLES.DOCTOR,
  ROLES.CONSULTANT,
  ROLES.JUNIOR_DOCTOR,
  ROLES.RESIDENT,
  ROLES.DUTY_DOCTOR,
  ROLES.NURSING_STAFF,
  ROLES.NURSING_INCHARGE,
  ROLES.OP_STAFF_NURSE,
  ROLES.OP_INCHARGE,
  ROLES.IP_STAFF_NURSE,
  ROLES.IP_INCHARGE,
  ROLES.OT_NURSE,
  ROLES.OT_INCHARGE,
  ROLES.CATH_LAB_STAFF,
  ROLES.CATH_LAB_INCHARGE,
  ROLES.RADIOLOGIST,
  ROLES.ANESTHETIST,
  ROLES.PHYSIOTHERAPIST,
  ROLES.DIETITIAN,
  ROLES.COUNSELLOR
];
export const LEADERSHIP_ROLES = [
  ROLES.CMO,
  ROLES.CNO,
  ROLES.DEPARTMENT_HEAD,
  ROLES.MEDICAL_SUPERINTENDENT
];
export const SUPPORT_ROLES = [
  ROLES.SOCIAL_WORKER,
  ROLES.SECURITY,
  ROLES.BILLING_STAFF,
  ROLES.BILLING_INCHARGE,
  ROLES.FINANCE_INCHARGE,
  ROLES.INSURANCE_COORDINATOR,
  ROLES.ADMISSION_OFFICER,
  ROLES.IPD_COUNSELLOR,
  ROLES.QUALITY_OFFICER,
  ROLES.INFECTION_CONTROL_OFFICER,
  ROLES.CARE_COORDINATOR,
  ROLES.CLAIMS_MANAGER,
  ROLES.AMBULANCE_COORDINATOR,
  ROLES.STORES_PURCHASE_INCHARGE,
  ROLES.RECEPTION_INCHARGE,
  ROLES.DRIVER,
  ROLES.HOUSEKEEPING_STAFF,
  ROLES.HOUSEKEEPING_INCHARGE,
  ROLES.MAINTENANCE
];
export const PLATFORM_ROLES = [
  ROLES.INTEGRATION_ADMIN,
  ROLES.AI_GOVERNANCE_ADMIN,
  ROLES.DATA_PROTECTION_OFFICER
];
// Machine-account role for inbound webhook clients authenticating with
// API key + signature; never assigned to a human.
export const MACHINE_ROLES = [ROLES.WEBHOOK_CLIENT];

export const ALL_STAFF_ROLES = [
  ...CLINICAL_ROLES,
  ROLES.PHARMACY_STAFF,
  ROLES.PHARMACY_INCHARGE,
  ROLES.STORES_PURCHASE_INCHARGE,
  ROLES.LAB_STAFF,
  ROLES.HR_STAFF,
  ROLES.GENERAL_STAFF,
  ROLES.DELIVERY_STAFF,
  ROLES.DRIVER,
  ROLES.HOUSEKEEPING_STAFF,
  ROLES.HOUSEKEEPING_INCHARGE,
  ROLES.MAINTENANCE,
  ROLES.RECEPTIONIST,
  ROLES.RECEPTION_INCHARGE,
  ROLES.MEDICAL_RECORDS,
  ROLES.OT_STAFF,
  ROLES.BLOOD_BANK_TECHNICIAN,
  ROLES.EMERGENCY_RESPONDER,
  ...SUPPORT_ROLES,
  ...LEADERSHIP_ROLES,
  ...PLATFORM_ROLES
];
export const ADMIN_ROLES = [ROLES.ADMIN];
export const PATIENT_AND_CLINICAL = [ROLES.PATIENT, ...CLINICAL_ROLES];

// Roles that can view/edit/generate discharge summaries
export const DISCHARGE_SUMMARY_VIEW_ROLES = [
  ROLES.DOCTOR,
  ROLES.DUTY_DOCTOR,
  ROLES.CONSULTANT,
  ROLES.JUNIOR_DOCTOR,
  ROLES.RESIDENT,
  ROLES.NURSING_STAFF,
  ROLES.NURSING_INCHARGE,
  ROLES.IP_STAFF_NURSE,
  ROLES.IP_INCHARGE,
  ROLES.MEDICAL_RECORDS,
  ROLES.ADMIN
];
export const DISCHARGE_SUMMARY_EDIT_ROLES = [
  ROLES.DOCTOR,
  ROLES.CONSULTANT,
  ROLES.JUNIOR_DOCTOR,
  ROLES.MEDICAL_RECORDS,
  ROLES.ADMIN
];
// Only fully-qualified doctors sign — RESIDENTs cannot. ADMIN/SUPER_ADMIN
// can override via the existing audit-tracked path.
export const DISCHARGE_SUMMARY_SIGN_ROLES = [ROLES.DOCTOR, ROLES.CONSULTANT, ROLES.JUNIOR_DOCTOR];

// Role check helpers
export const isAdmin = role => role === ROLES.ADMIN;
export const isPatient = role => role === ROLES.PATIENT;
export const isDoctor = role => DOCTOR_TIERS.includes(role);
export const isClinical = role => CLINICAL_ROLES.includes(role);
export const isMedicalRecords = role => role === ROLES.MEDICAL_RECORDS;
export const isStaff = role => ALL_STAFF_ROLES.includes(role) || isAdmin(role);
export const isStaffOrAdmin = role => isStaff(role);
export const isLeadership = role => LEADERSHIP_ROLES.includes(role) || role === ROLES.ADMIN;
export const isSupportStaff = role => SUPPORT_ROLES.includes(role);
export const isPlatformRole = role => PLATFORM_ROLES.includes(role);
export const isMachineRole = role => MACHINE_ROLES.includes(role);

// Specialty-role predicates (Phase F1)
export const isConsultant = role => role === ROLES.CONSULTANT;
export const isResident = role => role === ROLES.RESIDENT;
export const isCounsellor = role => role === ROLES.COUNSELLOR;
export const isCareCoordinator = role => role === ROLES.CARE_COORDINATOR;
export const isClaimsManager = role => role === ROLES.CLAIMS_MANAGER;
export const isAmbulanceCoordinator = role => role === ROLES.AMBULANCE_COORDINATOR;
export const isStoresPurchaseIncharge = role => role === ROLES.STORES_PURCHASE_INCHARGE;
export const isIntegrationAdmin = role => role === ROLES.INTEGRATION_ADMIN;
export const isWebhookClient = role => role === ROLES.WEBHOOK_CLIENT;
export const isAiGovernanceAdmin = role => role === ROLES.AI_GOVERNANCE_ADMIN;
export const isDataProtectionOfficer = role => role === ROLES.DATA_PROTECTION_OFFICER;
// B-3 — pathologist tier. Only these roles can sign off lab results
// to flip status='final'. LAB_STAFF (techs) can record + flag for
// signoff but not finalise — that's the audit boundary the regulator
// expects. ADMIN/SUPER_ADMIN keep an override path for late
// corrections, with the existing audit trail capturing it.
// Uses string literals because PATHOLOGIST / LAB_INCHARGE /
// SUPER_ADMIN aren't on the ROLES enum yet (declared in userConfig.js;
// adding them to ROLES is a separate cleanup PR).
export const PATHOLOGIST_SIGN_ROLES = ['PATHOLOGIST', 'LAB_INCHARGE', ROLES.ADMIN, 'SUPER_ADMIN'];
export const canSignOffLabResults = role => PATHOLOGIST_SIGN_ROLES.includes(role);

export const canViewMedicalData = role =>
  isClinical(role) || isAdmin(role) || isMedicalRecords(role);
export const canViewDischargeSummary = role => DISCHARGE_SUMMARY_VIEW_ROLES.includes(role);
export const canEditDischargeSummary = role => DISCHARGE_SUMMARY_EDIT_ROLES.includes(role);
export const canSignDischargeSummary = role => DISCHARGE_SUMMARY_SIGN_ROLES.includes(role);
export const canAccessRadiology = role =>
  [
    ROLES.DOCTOR,
    ROLES.DUTY_DOCTOR,
    ROLES.CONSULTANT,
    ROLES.JUNIOR_DOCTOR,
    ROLES.RESIDENT,
    ROLES.RADIOLOGIST,
    ROLES.ADMIN,
    ROLES.CMO
  ].includes(role);
export const canAccessOT = role =>
  [
    ROLES.DOCTOR,
    ROLES.DUTY_DOCTOR,
    ROLES.CONSULTANT,
    ROLES.JUNIOR_DOCTOR,
    ROLES.OT_STAFF,
    ROLES.OT_NURSE,
    ROLES.OT_INCHARGE,
    ROLES.ANESTHETIST,
    ROLES.ADMIN,
    ROLES.CMO
  ].includes(role);
export const canAccessCathLab = role =>
  [
    ROLES.DOCTOR,
    ROLES.DUTY_DOCTOR,
    ROLES.CONSULTANT,
    ROLES.JUNIOR_DOCTOR,
    ROLES.RESIDENT,
    ROLES.CATH_LAB_STAFF,
    ROLES.CATH_LAB_INCHARGE,
    ROLES.ADMIN,
    'SUPER_ADMIN',
    ROLES.CMO
  ].includes(role);
export const canAccessBloodBank = role =>
  [
    ROLES.DOCTOR,
    ROLES.DUTY_DOCTOR,
    ROLES.CONSULTANT,
    ROLES.JUNIOR_DOCTOR,
    ROLES.NURSING_STAFF,
    ROLES.IP_STAFF_NURSE,
    ROLES.OT_NURSE,
    ROLES.OT_INCHARGE,
    ROLES.CATH_LAB_STAFF,
    ROLES.BLOOD_BANK_TECHNICIAN,
    ROLES.ADMIN
  ].includes(role);

// Stage-4-C — ICU/CCU bed allocation requires physician sign-off or an
// admission-officer override. NURSING_STAFF can move a patient within
// general/semi/private/deluxe wards (the broader `requireRole` gate
// catches that), but cannot independently allocate an ICU bed — that
// step belongs to the doctor or the admission counter. Backed by the
// hospital's standing-order policy and the regulator's ICU-admission
// audit trail expectations.
// Finding: 2026-05-09-emergency-walk-in-admission-no-icu-rbac-tier
export const ICU_BED_TYPES = new Set(['icu', 'ccu']);
export const canAllocateIcu = role => isDoctor(role) || isAdmin(role) || role === 'SUPER_ADMIN';

// Specialty-role gates (Phase F1)
export const canManageIntegrations = role => isIntegrationAdmin(role) || isAdmin(role);
export const canManageAiGovernance = role => isAiGovernanceAdmin(role) || isAdmin(role);
export const canManageDataProtection = role => isDataProtectionOfficer(role) || isAdmin(role);
export const canDispatchAmbulance = role =>
  isAmbulanceCoordinator(role) || isAdmin(role) || role === ROLES.EMERGENCY_RESPONDER;
export const canManageClaims = role =>
  isClaimsManager(role) || isAdmin(role) || role === ROLES.INSURANCE_COORDINATOR;
